import { DomainError } from "./domain.ts";
import type { Config } from "./config.ts";
import type { PgBrainStore } from "./store.ts";
import type { Brain } from "../founderbrain-shared/domain.ts";
import type {
  GhlBookingLink,
  GhlBookingLinkInput,
  GhlBookingLinkKey,
  GhlBookingLinkResult,
  GhlBookingLinks,
} from "../founderbrain-shared/ghl.ts";
import { loadValueCatalog, snapshotFor } from "./ghl-push.ts";
import {
  readConnectionUnlocked,
  statusForConnectionUnlocked,
  withCrmOperationLock,
} from "./crm-oauth.ts";

const GHL_API = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_MS = 250;

type GhlValue = { id: string; name: string; value?: string };
type LinkDefinition = { key: GhlBookingLinkKey; name: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function ghlFetch(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  // The URL is always a fixed provider endpoint. Founder-pasted URLs are data only
  // and are never requested, followed, previewed, or otherwise fetched.
  // eslint-disable-next-line no-restricted-globals -- bounded CRM egress to LeadConnector only.
  return fetch(`${GHL_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
}

export function validateBookingLinkUrl(value: string): string {
  if (value.length > 2048)
    throw new DomainError(422, "booking_link_invalid", "Use an https booking link under 2048 characters.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DomainError(422, "booking_link_invalid", "Use a complete https booking link.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new DomainError(422, "booking_link_invalid", "Use an https booking link without a username or password.");
  return value;
}

export async function bookingLinkDefinitionsFor(brain: Brain): Promise<LinkDefinition[]> {
  const catalog = await loadValueCatalog();
  const snapshot = snapshotFor(brain);
  const sections = snapshot === "B2B"
    ? ["B2B Discovery booking"]
    : snapshot === "B2C"
      ? ["B2C DM qualify and book"]
      : ["B2B Discovery booking", "B2C DM qualify and book"];
  const allowed = new Set<GhlBookingLinkKey>(["call_booking_link", "dm_booking_link"]);
  const definitions: LinkDefinition[] = [];
  for (const section of sections) {
    for (const entry of catalog.get(section) ?? []) {
      if (allowed.has(entry.key as GhlBookingLinkKey)) {
        definitions.push({ key: entry.key as GhlBookingLinkKey, name: entry.value });
      }
    }
  }
  return definitions;
}

async function listValues(accessToken: string, locationId: string): Promise<GhlValue[]> {
  const response = await ghlFetch(
    accessToken,
    `/locations/${encodeURIComponent(locationId)}/customValues`,
  );
  if (!response.ok)
    throw new DomainError(422, "booking_links_unavailable", "GoHighLevel did not return booking links. Try again.");
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new DomainError(422, "booking_links_unavailable", "GoHighLevel returned an unknown booking-link response. Try again.");
  }
  if (!json || typeof json !== "object" || !Array.isArray((json as { customValues?: unknown }).customValues))
    throw new DomainError(422, "booking_links_unavailable", "GoHighLevel returned an unknown booking-link response. Try again.");
  const values: GhlValue[] = [];
  for (const raw of (json as { customValues: unknown[] }).customValues) {
    if (!raw || typeof raw !== "object")
      throw new DomainError(422, "booking_links_unavailable", "GoHighLevel returned an unknown booking-link response. Try again.");
    const item = raw as { id?: unknown; name?: unknown; value?: unknown };
    if (typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name)
      throw new DomainError(422, "booking_links_unavailable", "GoHighLevel returned an unknown booking-link response. Try again.");
    if (Object.prototype.hasOwnProperty.call(item, "value") && typeof item.value !== "string")
      throw new DomainError(422, "booking_links_unavailable", "GoHighLevel returned an unknown booking-link response. Try again.");
    values.push({
      id: item.id,
      name: item.name,
      ...(typeof item.value === "string" ? { value: item.value } : {}),
    });
  }
  return values;
}

function uniqueNamed(values: GhlValue[], name: string): GhlValue | null {
  const matches = values.filter((value) => value.name === name);
  if (matches.length > 1)
    throw new DomainError(409, "booking_link_ambiguous", `GoHighLevel has more than one "${name}" value. Remove the duplicate before continuing.`);
  return matches[0] ?? null;
}

async function detailValue(
  accessToken: string,
  locationId: string,
  entry: GhlValue,
): Promise<{ known: boolean; value: string | null }> {
  const response = await ghlFetch(
    accessToken,
    `/locations/${encodeURIComponent(locationId)}/customValues/${encodeURIComponent(entry.id)}`,
  );
  if (!response.ok) return { known: false, value: null };
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { known: false, value: null };
  }
  if (!json || typeof json !== "object") return { known: false, value: null };
  const item = (json as { customValue?: unknown }).customValue;
  if (!item || typeof item !== "object") return { known: false, value: null };
  const detail = item as { id?: unknown; name?: unknown; locationId?: unknown; value?: unknown };
  if (
    detail.id !== entry.id ||
    detail.name !== entry.name ||
    detail.locationId !== locationId
  ) return { known: false, value: null };
  if (!Object.prototype.hasOwnProperty.call(detail, "value"))
    return { known: true, value: null };
  if (typeof detail.value !== "string") return { known: false, value: null };
  return { known: true, value: detail.value.length ? detail.value : null };
}

async function currentLink(
  accessToken: string,
  locationId: string,
  values: GhlValue[],
  definition: LinkDefinition,
): Promise<GhlBookingLink> {
  const entry = uniqueNamed(values, definition.name);
  if (!entry) return { ...definition, value: null };
  const detail = await detailValue(accessToken, locationId, entry);
  if (!detail.known)
    throw new DomainError(422, "booking_links_unavailable", `GoHighLevel did not return "${definition.name}". Try again.`);
  return { ...definition, value: detail.value };
}

export async function getGhlBookingLinks(
  config: Config,
  store: PgBrainStore,
  workspace: string,
  brain: Brain,
  expectedConnectionId: string,
): Promise<GhlBookingLinks> {
  const definitions = await bookingLinkDefinitionsFor(brain);
  return withCrmOperationLock(store, workspace, async (tx) => {
    const connection = await readConnectionUnlocked(store, tx, workspace, config, expectedConnectionId);
    if (!connection)
      throw new DomainError(409, "crm_not_connected", "Connect GoHighLevel before managing booking links.");
    const values = await listValues(connection.accessToken, connection.locationId);
    const links: GhlBookingLink[] = [];
    for (const definition of definitions) {
      links.push(await currentLink(connection.accessToken, connection.locationId, values, definition));
    }
    return { connection: await statusForConnectionUnlocked(connection), links };
  });
}

export async function transferBookingLinkAtProvider(
  connection: { accessToken: string; locationId: string; connectionId: string },
  definition: LinkDefinition,
  input: GhlBookingLinkInput,
  url = validateBookingLinkUrl(input.url),
): Promise<GhlBookingLinkResult> {
  const values = await listValues(connection.accessToken, connection.locationId);
  const existing = uniqueNamed(values, definition.name);
  let current: string | null = null;
  if (existing) {
    const detail = await detailValue(connection.accessToken, connection.locationId, existing);
    if (!detail.known)
      throw new DomainError(422, "booking_links_unavailable", `GoHighLevel did not return "${definition.name}". Try again.`);
    current = detail.value;
  }

  if (current !== input.expectedValue)
    throw new DomainError(409, "booking_link_changed", "This booking link changed in GoHighLevel. Reload before replacing it.");
  if (current === url) {
    return {
      connection: await statusForConnectionUnlocked(connection),
      link: { ...definition, value: current },
      written: false,
      proven: true,
    };
  }
  if (current && !input.replaceExisting)
    throw new DomainError(409, "booking_link_replace_required", "Confirm that you want to replace the existing booking link.");

  let entry = existing;
  if (entry) {
    const response = await ghlFetch(
      connection.accessToken,
      `/locations/${encodeURIComponent(connection.locationId)}/customValues/${encodeURIComponent(entry.id)}`,
      { method: "PUT", body: { name: definition.name, value: url } },
    );
    if (!response.ok)
      throw new DomainError(422, "booking_link_write_failed", "GoHighLevel refused the booking link. Nothing else was changed.");
  } else {
    const response = await ghlFetch(
      connection.accessToken,
      `/locations/${encodeURIComponent(connection.locationId)}/customValues`,
      { method: "POST", body: { name: definition.name, value: url } },
    );
    if (!response.ok)
      throw new DomainError(422, "booking_link_write_failed", "GoHighLevel refused the booking link. Nothing else was changed.");
    // Do not trust a create envelope as proof or identity. Re-list the named
    // value and validate its detail shape during the bounded verification loop.
    entry = null;
  }

  let proven = false;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS && !proven; attempt++) {
    if (attempt > 0) await sleep(VERIFY_RETRY_MS);
    if (!entry) {
      const refreshed = await listValues(connection.accessToken, connection.locationId);
      entry = uniqueNamed(refreshed, definition.name);
    }
    if (!entry) continue;
    const detail = await detailValue(connection.accessToken, connection.locationId, entry);
    proven = detail.known && detail.value === url;
  }

  return {
    connection: await statusForConnectionUnlocked(connection),
    link: { ...definition, value: proven ? url : null },
    written: true,
    proven,
  };
}

export async function putGhlBookingLink(
  config: Config,
  store: PgBrainStore,
  workspace: string,
  brain: Brain,
  input: GhlBookingLinkInput,
): Promise<GhlBookingLinkResult> {
  const url = validateBookingLinkUrl(input.url);
  const definitions = await bookingLinkDefinitionsFor(brain);
  const definition = definitions.find((item) => item.key === input.key);
  if (!definition)
    throw new DomainError(422, "booking_link_not_allowed", "That booking link is not used by this GoHighLevel setup.");

  return withCrmOperationLock(store, workspace, async (tx) => {
    // Generation validation happens before every provider write (and before any AI,
    // though this operation intentionally has no AI path at all).
    const connection = await readConnectionUnlocked(store, tx, workspace, config, input.connectionId);
    if (!connection)
      throw new DomainError(409, "crm_not_connected", "Connect GoHighLevel before managing booking links.");
    return transferBookingLinkAtProvider(connection, definition, input, url);
  });
}
