/**
 * GoHighLevel OAuth and connection control for FounderBrain.
 * Tokens remain sealed in ge_blob and are never returned to the browser.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type TransactionSql } from "postgres";
import { DomainError } from "./domain.ts";
import type { Config } from "./config.ts";
import { PG_STORE_POOL_MAX, type PgBrainStore } from "./store.ts";
import { openBlob, sealBlob, unwrapDataKey } from "../server/storage/crypto.ts";
import type { GhlConnectionStatus } from "../founderbrain-shared/ghl.ts";

export const CRM_SCOPES = [
  "contacts.readonly",
  "contacts.write",
  "locations.readonly",
  "socialplanner/post.readonly",
  "socialplanner/post.write",
  "socialplanner/account.readonly",
  "locations/customValues.readonly",
  "locations/customValues.write",
] as const;

const AUTHORIZE_HOST = "https://marketplace.gohighlevel.com/v2/oauth/chooselocation";
const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const GHL_API = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const STATE_TTL_MS = 15 * 60 * 1000;
const LOCK_CLASS = "founderbrain-crm";
/**
 * Each outer CRM operation may need a second pooled connection for refresh CAS,
 * usage, OAuth-state consumption, or orientation. Keep two connections free for
 * ordinary API traffic and admit only what the remaining pool can safely nest.
 */
export const CRM_OUTER_OPERATION_MAX = Math.max(1, Math.floor((PG_STORE_POOL_MAX - 2) / 2));
const crmOuterAdmissions = new WeakMap<PgBrainStore, number>();

type CrmTx = TransactionSql;
type StoredConnection = {
  accessToken: string;
  refreshToken: string;
  locationId: string;
  connectionId: string;
};
type ConnectionIdentity = {
  connection_id: string;
  location_id: string;
};
type ConnectionRow = ConnectionIdentity & {
  token_blob_sha: string;
  expires_at: Date | string | null;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  wrapped_key: Uint8Array;
};

export function crmOAuthConfigured(config: Config): boolean {
  return Boolean(config.HIGHLEVEL_CLIENT_ID && config.HIGHLEVEL_CLIENT_SECRET);
}

export function crmRedirectUri(config: Config): string {
  return `${config.APP_ORIGIN.replace(/\/$/, "")}/oauth/callback`;
}

export function signOauthState(secret: string, subject: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: subject,
      exp: now + STATE_TTL_MS,
      n: randomBytes(18).toString("base64url"),
    }),
    "utf8",
  ).toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function readOauthState(secret: string, state: string, now = Date.now()): { sub: string } {
  const [payload, mac] = state.split(".");
  if (!payload || !mac) throw new DomainError(400, "oauth_state_invalid", "Connect expired. Start again.");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new DomainError(400, "oauth_state_invalid", "Connect expired. Start again.");
  let body: { sub?: string; exp?: number };
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof body;
  } catch {
    throw new DomainError(400, "oauth_state_invalid", "Connect expired. Start again.");
  }
  if (!body.sub || typeof body.exp !== "number" || body.exp < now)
    throw new DomainError(400, "oauth_state_invalid", "Connect expired. Start again.");
  return { sub: body.sub };
}

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function authorizeUrl(config: Config, state: string): string {
  if (!config.HIGHLEVEL_CLIENT_ID)
    throw new DomainError(503, "crm_oauth_not_configured", "Connect is not configured yet.");
  const url = new URL(AUTHORIZE_HOST);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", crmRedirectUri(config));
  url.searchParams.set("client_id", config.HIGHLEVEL_CLIENT_ID);
  url.searchParams.set("scope", CRM_SCOPES.join(" "));
  url.searchParams.set("state", state);
  if (config.HIGHLEVEL_VERSION_ID) url.searchParams.set("version_id", config.HIGHLEVEL_VERSION_ID);
  return url.toString();
}

export async function migrateCrmOauth(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(await readFile(new URL("./crm-oauth.sql", import.meta.url), "utf8"));
    });
  } finally {
    await sql.end();
  }
}

/** Cross-process, fail-fast serialization for one workspace's CRM operations. */
export async function withCrmOperationLock<T>(
  store: PgBrainStore,
  workspace: string,
  operation: (tx: CrmTx) => Promise<T>,
): Promise<T> {
  // Admission happens before store.scoped() can reserve a pooled connection.
  // The WeakMap is per runtime store/pool and never queues callers in memory.
  const active = crmOuterAdmissions.get(store) ?? 0;
  if (active >= CRM_OUTER_OPERATION_MAX)
    throw new DomainError(409, "crm_busy", "GoHighLevel is already updating. Try again in a moment.");
  crmOuterAdmissions.set(store, active + 1);
  try {
    return await store.scoped(workspace, async (tx) => {
      const rows = await tx<{ locked: boolean }[]>`
        select pg_try_advisory_xact_lock(hashtext(${LOCK_CLASS}), hashtext(${workspace})) as locked
      `;
      if (rows[0]?.locked !== true)
        throw new DomainError(409, "crm_busy", "GoHighLevel is already updating. Try again in a moment.");
      return operation(tx);
    });
  } finally {
    const remaining = (crmOuterAdmissions.get(store) ?? 1) - 1;
    if (remaining <= 0) crmOuterAdmissions.delete(store);
    else crmOuterAdmissions.set(store, remaining);
  }
}

async function putBlobUnlocked(
  tx: CrmTx,
  workspace: string,
  plaintext: string,
): Promise<string> {
  const rows = await tx<{ wrapped_key: Uint8Array }[]>`
    select wrapped_key from founder where id=${workspace} and deleted_at is null
  `;
  if (!rows[0]) throw new DomainError(404, "workspace_missing", "Workspace not found.");
  const sealed = sealBlob(
    workspace,
    unwrapDataKey(workspace, rows[0].wrapped_key),
    Buffer.from(plaintext, "utf8"),
  );
  await tx`
    insert into ge_blob(founder_id, sha, ciphertext, nonce, size_bytes)
    values (${workspace}, ${sealed.sha}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sizeBytes})
    on conflict (founder_id, sha) do nothing
  `;
  return sealed.sha;
}

export async function startOauthConnection(
  store: PgBrainStore,
  workspace: string,
  config: Config,
  subject: string,
): Promise<{ url: string }> {
  const secret = config.ORIGIN_SECRET ?? config.HIGHLEVEL_CLIENT_SECRET;
  if (!crmOAuthConfigured(config) || !secret)
    throw new DomainError(503, "crm_oauth_not_configured", "Connect is not configured yet.");
  const state = signOauthState(secret, subject);
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
  await withCrmOperationLock(store, workspace, async (tx) => {
    await tx`
      insert into fb_crm_control (founder_id, pending_state_hash, pending_state_expires_at, updated_at)
      values (${workspace}, ${stateHash(state)}, ${expiresAt}, now())
      on conflict (founder_id) do update set
        pending_state_hash = excluded.pending_state_hash,
        pending_state_expires_at = excluded.pending_state_expires_at,
        updated_at = now()
    `;
  });
  return { url: authorizeUrl(config, state) };
}

async function consumeOauthStateCommitted(
  store: PgBrainStore,
  workspace: string,
  state: string,
): Promise<void> {
  // The caller already holds the workspace advisory lock. This deliberately uses
  // a separate short tenant transaction without reacquiring that lock so the
  // one-time state remains consumed if code exchange or later work fails.
  await store.scoped(workspace, async (tx) => {
    const rows = await tx<{ founder_id: string }[]>`
      update fb_crm_control
         set pending_state_hash = null,
             pending_state_expires_at = null,
             updated_at = now()
       where founder_id = ${workspace}
         and pending_state_hash = ${stateHash(state)}
         and pending_state_expires_at >= now()
      returning founder_id
    `;
    if (!rows[0])
      throw new DomainError(400, "oauth_state_invalid", "Connect expired. Start again.");
  });
}

export async function exchangeCode(
  config: Config,
  code: string,
): Promise<{ accessToken: string; refreshToken: string; locationId: string; expiresIn: number }> {
  if (!config.HIGHLEVEL_CLIENT_ID || !config.HIGHLEVEL_CLIENT_SECRET)
    throw new DomainError(503, "crm_oauth_not_configured", "Connect is not configured yet.");
  const body = new URLSearchParams({
    client_id: config.HIGHLEVEL_CLIENT_ID,
    client_secret: config.HIGHLEVEL_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    user_type: "Location",
    redirect_uri: crmRedirectUri(config),
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    locationId?: string;
    expires_in?: number;
  };
  if (!response.ok || !json.access_token || !json.locationId)
    throw new DomainError(422, "crm_oauth_failed", "GoHighLevel did not complete Connect. Try again.");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? "",
    locationId: json.locationId,
    expiresIn: json.expires_in ?? 86400,
  };
}

async function saveConnectionUnlocked(
  tx: CrmTx,
  workspace: string,
  tokens: { accessToken: string; refreshToken: string; locationId: string; expiresIn: number },
  connectionId: string,
): Promise<void> {
  const sha = await putBlobUnlocked(
    tx,
    workspace,
    JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
  );
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
  await tx`
    insert into fb_crm_connection
      (founder_id, location_id, token_blob_sha, expires_at, connected_at, updated_at)
    values (${workspace}, ${tokens.locationId}, ${sha}, ${expiresAt}, now(), now())
    on conflict (founder_id) do update set
      location_id = excluded.location_id,
      token_blob_sha = excluded.token_blob_sha,
      expires_at = excluded.expires_at,
      connected_at = now(),
      updated_at = now()
  `;
  await tx`
    insert into fb_crm_control
      (founder_id, connection_id, pending_state_hash, pending_state_expires_at, updated_at)
    values (${workspace}, ${connectionId}, null, null, now())
    on conflict (founder_id) do update set
      connection_id = excluded.connection_id,
      pending_state_hash = null,
      pending_state_expires_at = null,
      updated_at = now()
  `;
}

/** Compatibility helper for tests and bounded internal callers. New connections get a random generation. */
export async function saveConnection(
  store: PgBrainStore,
  workspace: string,
  tokens: { accessToken: string; refreshToken: string; locationId: string; expiresIn: number },
): Promise<string> {
  return withCrmOperationLock(store, workspace, async (tx) => {
    const connectionId = randomUUID();
    await saveConnectionUnlocked(tx, workspace, tokens, connectionId);
    return connectionId;
  });
}

async function setConnectedOrientationUnlocked(tx: CrmTx, workspace: string): Promise<void> {
  await tx`
    insert into fb_orientation (founder_id, ghl_screen, ghl_completed_at, ghl_answers, updated_at)
    values (${workspace}, 5, now(), ${tx.json({ connected: true } as never)}, now())
    on conflict (founder_id) do update set
      ghl_screen = 5,
      ghl_completed_at = coalesce(fb_orientation.ghl_completed_at, now()),
      ghl_answers = coalesce(fb_orientation.ghl_answers, '{}'::jsonb) || ${tx.json({ connected: true } as never)}::jsonb,
      updated_at = now()
  `;
}

async function setDisconnectedOrientationUnlocked(tx: CrmTx, workspace: string): Promise<void> {
  await tx`
    insert into fb_orientation (founder_id, ghl_completed_at, ghl_answers, updated_at)
    values (${workspace}, null, ${tx.json({ connected: false } as never)}, now())
    on conflict (founder_id) do update set
      ghl_completed_at = null,
      ghl_answers = coalesce(fb_orientation.ghl_answers, '{}'::jsonb) || ${tx.json({ connected: false } as never)}::jsonb,
      updated_at = now()
  `;
}

export async function completeOauthConnection(
  store: PgBrainStore,
  workspace: string,
  config: Config,
  subject: string,
  input: { code: string; state: string } | { error: string; state: string },
): Promise<GhlConnectionStatus> {
  const secret = config.ORIGIN_SECRET ?? config.HIGHLEVEL_CLIENT_SECRET;
  if (!crmOAuthConfigured(config) || !secret)
    throw new DomainError(503, "crm_oauth_not_configured", "Connect is not configured yet.");
  const claimed = readOauthState(secret, input.state);
  if (claimed.sub !== subject)
    throw new DomainError(403, "oauth_state_mismatch", "Connect belonged to a different session.");

  return withCrmOperationLock(store, workspace, async (tx) => {
    await consumeOauthStateCommitted(store, workspace, input.state);
    if ("error" in input)
      throw new DomainError(400, "oauth_cancelled", "GoHighLevel Connect was cancelled. Start again.");
    const tokens = await exchangeCode(config, input.code);
    const connectionId = randomUUID();
    await saveConnectionUnlocked(tx, workspace, tokens, connectionId);
    await setConnectedOrientationUnlocked(tx, workspace);
    return statusForConnectionUnlocked({ ...tokens, connectionId });
  });
}

async function rawConnectionIdentityUnlocked(
  tx: CrmTx,
  workspace: string,
): Promise<ConnectionIdentity | null> {
  const rows = await tx<ConnectionIdentity[]>`
    select ctl.connection_id, c.location_id
      from fb_crm_connection c
      join fb_crm_control ctl on ctl.founder_id = c.founder_id and ctl.connection_id is not null
     where c.founder_id = ${workspace}
  `;
  return rows[0] ?? null;
}

async function rawConnectionRowUnlocked(
  tx: CrmTx,
  workspace: string,
): Promise<ConnectionRow | null> {
  const rows = await tx<ConnectionRow[]>`
    select ctl.connection_id, c.location_id, c.token_blob_sha, c.expires_at,
           b.ciphertext, b.nonce, f.wrapped_key
      from fb_crm_connection c
      join fb_crm_control ctl on ctl.founder_id = c.founder_id and ctl.connection_id is not null
      join ge_blob b on b.founder_id = c.founder_id and b.sha = c.token_blob_sha
      join founder f on f.id = c.founder_id
     where c.founder_id = ${workspace}
  `;
  return rows[0] ?? null;
}

export async function hasConnectionUnlocked(tx: CrmTx, workspace: string): Promise<boolean> {
  const rows = await tx<{ present: boolean }[]>`
    select exists (
      select 1 from fb_crm_connection c
      join fb_crm_control ctl on ctl.founder_id = c.founder_id and ctl.connection_id is not null
      where c.founder_id = ${workspace}
    ) as present
  `;
  return rows[0]?.present === true;
}

/**
 * Read and, when needed, refresh inside the caller's CRM advisory-lock transaction.
 * The refresh update is compare-and-swap only: it never upserts or changes connection_id.
 */
export async function readConnectionUnlocked(
  store: PgBrainStore,
  tx: CrmTx,
  workspace: string,
  config?: Config,
  expectedConnectionId?: string,
): Promise<StoredConnection | null> {
  const identity = await rawConnectionIdentityUnlocked(tx, workspace);
  if (!identity) {
    if (expectedConnectionId)
      throw new DomainError(409, "crm_connection_stale", "This GoHighLevel connection changed. Reload and try again.");
    return null;
  }
  if (expectedConnectionId && identity.connection_id !== expectedConnectionId)
    throw new DomainError(409, "crm_connection_stale", "This GoHighLevel connection changed. Reload and try again.");
  const row = await rawConnectionRowUnlocked(tx, workspace);
  if (!row)
    throw new DomainError(503, "crm_token_unavailable", "The GoHighLevel connection needs to be reconnected.");

  const plain = openBlob(
    workspace,
    unwrapDataKey(workspace, row.wrapped_key),
    row.token_blob_sha,
    row.ciphertext,
    row.nonce,
  ).toString("utf8");
  const parsed = JSON.parse(plain) as { accessToken: string; refreshToken: string };
  const current: StoredConnection = {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    locationId: row.location_id,
    connectionId: row.connection_id,
  };
  if (!config || !config.HIGHLEVEL_CLIENT_ID || !config.HIGHLEVEL_CLIENT_SECRET) return current;

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (expiresAt - 5 * 60 * 1000 > Date.now()) return current;
  if (!current.refreshToken)
    throw new DomainError(503, "crm_token_expired", "The GoHighLevel connection expired. Reconnect from the GoHighLevel chapter.");

  const body = new URLSearchParams({
    client_id: config.HIGHLEVEL_CLIENT_ID,
    client_secret: config.HIGHLEVEL_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    user_type: "Location",
  });
  let json: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new DomainError(422, "crm_token_refresh", "The GoHighLevel connection could not be refreshed. Reconnect from the GoHighLevel chapter.");
    json = (await response.json()) as typeof json;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(422, "crm_token_refresh", "The GoHighLevel connection could not be refreshed. Reconnect from the GoHighLevel chapter.");
  }
  if (!json.access_token)
    throw new DomainError(422, "crm_token_refresh", "The GoHighLevel connection could not be refreshed. Reconnect from the GoHighLevel chapter.");

  const refreshed = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? current.refreshToken,
  };
  const expiresAtNext = new Date(Date.now() + (json.expires_in ?? 86400) * 1000).toISOString();
  // GHL may rotate the refresh token immediately. Persist it in a separate short
  // transaction while this operation still holds the advisory lock, so later
  // provider/AI/readback failure cannot roll the rotated credential back.
  await store.scoped(workspace, async (refreshTx) => {
    const sha = await putBlobUnlocked(refreshTx, workspace, JSON.stringify(refreshed));
    const updated = await refreshTx<{ founder_id: string }[]>`
      update fb_crm_connection c
         set token_blob_sha = ${sha}, expires_at = ${expiresAtNext}, updated_at = now()
       where c.founder_id = ${workspace}
         and c.token_blob_sha = ${row.token_blob_sha}
         and exists (
           select 1 from fb_crm_control ctl
            where ctl.founder_id = c.founder_id
              and ctl.connection_id = ${row.connection_id}
         )
      returning c.founder_id
    `;
    if (!updated[0])
      throw new DomainError(409, "crm_connection_stale", "This GoHighLevel connection changed. Reload and try again.");
  });
  return { ...refreshed, locationId: current.locationId, connectionId: current.connectionId };
}

export async function readConnection(
  store: PgBrainStore,
  workspace: string,
  config?: Config,
  expectedConnectionId?: string,
): Promise<StoredConnection | null> {
  return withCrmOperationLock(store, workspace, (tx) =>
    readConnectionUnlocked(store, tx, workspace, config, expectedConnectionId),
  );
}

async function locationName(connection: Pick<StoredConnection, "accessToken" | "locationId">): Promise<string | null> {
  try {
    const response = await fetch(`${GHL_API}/locations/${encodeURIComponent(connection.locationId)}`, {
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        Version: GHL_VERSION,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      location?: { id?: unknown; name?: unknown };
      id?: unknown;
      name?: unknown;
    };
    const item = json.location ?? json;
    if (Object.prototype.hasOwnProperty.call(item, "id")) {
      if (typeof item.id !== "string" || item.id !== connection.locationId) return null;
    }
    return typeof item.name === "string" && item.name.trim()
      ? item.name.trim().slice(0, 300)
      : null;
  } catch {
    return null;
  }
}

export async function statusForConnectionUnlocked(
  connection: Pick<StoredConnection, "accessToken" | "locationId" | "connectionId">,
): Promise<GhlConnectionStatus> {
  const name = await locationName(connection);
  return {
    connected: true,
    locationId: connection.locationId,
    locationName: name,
    connectionId: connection.connectionId,
    ...(name === null ? { nameUnavailable: true } : {}),
  };
}

export async function connectionStatus(
  store: PgBrainStore,
  workspace: string,
  config?: Config,
): Promise<GhlConnectionStatus> {
  return withCrmOperationLock(store, workspace, async (tx) => {
    const raw = await rawConnectionIdentityUnlocked(tx, workspace);
    if (!raw)
      return { connected: false, locationId: null, locationName: null, connectionId: null };
    try {
      const connection = await readConnectionUnlocked(store, tx, workspace, config);
      if (!connection)
        return { connected: false, locationId: null, locationName: null, connectionId: null };
      return statusForConnectionUnlocked(connection);
    } catch {
      // Identity and disconnect remain available when refresh or provider reads fail.
      return {
        connected: true,
        locationId: raw.location_id,
        locationName: null,
        connectionId: raw.connection_id,
        nameUnavailable: true,
      };
    }
  });
}

export async function disconnectConnection(
  store: PgBrainStore,
  workspace: string,
  expectedConnectionId: string,
): Promise<GhlConnectionStatus> {
  await withCrmOperationLock(store, workspace, async (tx) => {
    const row = await rawConnectionIdentityUnlocked(tx, workspace);
    if (!row || row.connection_id !== expectedConnectionId)
      throw new DomainError(409, "crm_connection_stale", "This GoHighLevel connection changed. Reload and try again.");
    await tx`delete from fb_crm_connection where founder_id = ${workspace}`;
    await tx`
      update fb_crm_control
         set connection_id = null,
             pending_state_hash = null,
             pending_state_expires_at = null,
             updated_at = now()
       where founder_id = ${workspace}
         and connection_id = ${expectedConnectionId}
    `;
    await setDisconnectedOrientationUnlocked(tx, workspace);
  });
  return { connected: false, locationId: null, locationName: null, connectionId: null };
}
