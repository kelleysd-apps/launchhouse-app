import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { runMigrations } from "../server/db/migrate.ts";
import { closeDb } from "../server/db/client.ts";
import { runFounderBrainMigrations } from "./migrations.ts";
import { PgBrainStore } from "./store.ts";
import { migrateOrientation, readOrientation, writeOrientation } from "./orientation.ts";
import {
  completeOauthConnection,
  disconnectConnection,
  migrateCrmOauth,
  readConnection,
  saveConnection,
  startOauthConnection,
} from "./crm-oauth.ts";
import type { Config } from "./config.ts";
import { buildApi } from "./server.ts";
import { getGhlBookingLinks } from "./ghl-booking-links.ts";
import { emptyBrain } from "../founderbrain-shared/domain.ts";

const databaseUrl = process.env.FB_TEST_DATABASE_URL;
const migrationUrl = process.env.FB_TEST_MIGRATION_DATABASE_URL ?? databaseUrl;
const skip = databaseUrl ? undefined : "FB_TEST_DATABASE_URL is not set";
const nativeSkip = skip ?? (process.env.FB_TEST_EMBEDDED === "true"
  ? "Native Postgres is required for refresh durability proof"
  : undefined);
const prefix = `crm-control|${randomUUID()}`;
let store: PgBrainStore;
let workspaceA = "";
let workspaceB = "";
const subjects = [`${prefix}|a`, `${prefix}|b`];
const config = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgres://unused",
  PORT: 8080,
  APP_ORIGIN: "https://founderbrain.example.test",
  ORIGIN_SECRET: "fixture-origin-secret-not-live-000000",
  HIGHLEVEL_CLIENT_ID: "fixture-client-id",
  HIGHLEVEL_CLIENT_SECRET: "fixture-client-secret-not-live",
  FOUNDERBRAIN_LOCAL_DEMO: "false",
  AI_ENABLED: "false",
  ROUTINES_ENABLED: "false",
  HEXCLAVE_API_URL: "https://api.hexclave.com",
} as Config;

before(async () => {
  if (!databaseUrl || !migrationUrl) return;
  process.env.GE_MASTER_KEY ??= randomBytes(32).toString("base64");
  const prior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = migrationUrl;
  await runMigrations();
  await runFounderBrainMigrations(migrationUrl);
  await migrateOrientation(migrationUrl);
  await migrateCrmOauth(migrationUrl);
  if (prior === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prior;
  store = new PgBrainStore(databaseUrl);
  workspaceA = await store.ensureWorkspace(subjects[0]!);
  workspaceB = await store.ensureWorkspace(subjects[1]!);
});

after(async () => {
  if (!databaseUrl) return;
  await store.deleteWorkspace(subjects[0]!, workspaceA).catch(() => {});
  await store.deleteWorkspace(subjects[1]!, workspaceB).catch(() => {});
  await store.close();
  await closeDb();
});

const tokens = (locationId: string) => ({
  accessToken: `access-${locationId}`,
  refreshToken: `refresh-${locationId}`,
  locationId,
  expiresIn: 86400,
});

describe("CRM controls against disposable Postgres", () => {
  it("creates random stable generations and keeps control rows tenant-isolated", { skip }, async () => {
    const a = await saveConnection(store, workspaceA, tokens("location-a"));
    const b = await saveConnection(store, workspaceB, tokens("location-b"));
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f-]{36}$/);

    const visible = await store.scoped(workspaceA, (tx) =>
      tx<{ founder_id: string; connection_id: string }[]>`
        select founder_id, connection_id from fb_crm_control order by founder_id
      `,
    );
    assert.deepEqual(Array.from(visible), [{ founder_id: workspaceA, connection_id: a }]);
  });

  it("rejects stale generations before deletion and preserves the newer reconnect", { skip }, async () => {
    const oldId = await store.scoped(workspaceA, async (tx) => {
      const rows = await tx<{ connection_id: string }[]>`
        select connection_id from fb_crm_control where founder_id = ${workspaceA}
      `;
      return rows[0]!.connection_id;
    });
    const currentId = await saveConnection(store, workspaceA, tokens("location-a-new"));
    await assert.rejects(disconnectConnection(store, workspaceA, oldId), {
      code: "crm_connection_stale",
    });
    const current = await store.scoped(workspaceA, async (tx) => {
      const rows = await tx<{ location_id: string; connection_id: string }[]>`
        select c.location_id, ctl.connection_id
          from fb_crm_connection c join fb_crm_control ctl using (founder_id)
         where c.founder_id = ${workspaceA}
      `;
      return rows[0];
    });
    assert.deepEqual(current, { location_id: "location-a-new", connection_id: currentId });
  });

  it("serializes refresh against disconnect and preserves the same generation", { skip }, async () => {
    const connectionId = await saveConnection(store, workspaceB, {
      ...tokens("location-b-refresh"),
      expiresIn: 0,
    });
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    try {
      globalThis.fetch = async () => {
        started();
        await gate;
        return new Response(JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: 86400,
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const refreshing = readConnection(store, workspaceB, config, connectionId);
      await fetchStarted;
      await assert.rejects(disconnectConnection(store, workspaceB, connectionId), {
        code: "crm_busy",
      });
      release();
      const refreshed = await refreshing;
      assert.equal(refreshed?.connectionId, connectionId);
      assert.equal(refreshed?.accessToken, "refreshed-access");
    } finally {
      release?.();
      globalThis.fetch = originalFetch;
    }
  });

  it("durably commits a rotated refresh token before a later provider read fails", { skip: nativeSkip }, async () => {
    const connectionId = await saveConnection(store, workspaceB, {
      ...tokens("location-b-durable-refresh"),
      expiresIn: 0,
    });
    const brain = emptyBrain();
    brain.identity.track = "b2b";
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/oauth/token")) {
          return new Response(JSON.stringify({
            access_token: "durable-rotated-access",
            refresh_token: "durable-rotated-refresh",
            expires_in: 86400,
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.endsWith("/customValues"))
          return new Response(JSON.stringify({ message: "forced later failure" }), { status: 500 });
        throw new Error(`unexpected request ${url}`);
      };
      await assert.rejects(
        getGhlBookingLinks(config, store, workspaceB, brain, connectionId),
        { code: "booking_links_unavailable" },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    const persisted = await readConnection(store, workspaceB, undefined, connectionId);
    assert.equal(persisted?.connectionId, connectionId);
    assert.equal(persisted?.accessToken, "durable-rotated-access");
    assert.equal(persisted?.refreshToken, "durable-rotated-refresh");
  });

  it("disconnect atomically clears only GHL completion and invalidates delayed callbacks", { skip }, async () => {
    const currentId = await store.scoped(workspaceA, async (tx) => {
      const rows = await tx<{ connection_id: string }[]>`
        select connection_id from fb_crm_control where founder_id = ${workspaceA}
      `;
      return rows[0]!.connection_id;
    });
    await writeOrientation(store, workspaceA, {
      contentScreen: 3,
      contentAnswers: { domainReady: true },
      ghlScreen: 5,
      ghlComplete: true,
      ghlAnswers: { hasAccount: true, connected: true },
    });
    const started = await startOauthConnection(store, workspaceA, config, subjects[0]!);
    const state = new URL(started.url).searchParams.get("state");
    assert.ok(state);

    await disconnectConnection(store, workspaceA, currentId);
    const orientation = await readOrientation(store, workspaceA);
    assert.equal(orientation.ghlCompletedAt, null);
    assert.equal(orientation.ghlAnswers.connected, false);
    assert.equal(orientation.ghlAnswers.hasAccount, true);
    assert.equal(orientation.contentScreen, 3);
    assert.equal(orientation.contentAnswers.domainReady, true);

    const originalFetch = globalThis.fetch;
    let fetches = 0;
    try {
      globalThis.fetch = async () => {
        fetches += 1;
        throw new Error("cancelled callback must not reach provider");
      };
      await assert.rejects(
        completeOauthConnection(store, workspaceA, config, subjects[0]!, {
          code: "fixture-code",
          state,
        }),
        { code: "oauth_state_invalid" },
      );
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


describe("one-time OAuth state", () => {
  it("consumes a state once even when the provider refuses the authorization code", { skip }, async () => {
    const superseded = await startOauthConnection(store, workspaceB, config, subjects[1]!);
    const supersededState = new URL(superseded.url).searchParams.get("state");
    assert.ok(supersededState);
    const started = await startOauthConnection(store, workspaceB, config, subjects[1]!);
    const state = new URL(started.url).searchParams.get("state");
    assert.ok(state);
    const originalFetch = globalThis.fetch;
    let exchanges = 0;
    try {
      globalThis.fetch = async () => {
        exchanges += 1;
        return new Response(JSON.stringify({ message: "invalid code" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      };
      await assert.rejects(
        completeOauthConnection(store, workspaceB, config, subjects[1]!, {
          code: "fixture-code",
          state: supersededState,
        }),
        { code: "oauth_state_invalid" },
      );
      assert.equal(exchanges, 0);
      await assert.rejects(
        completeOauthConnection(store, workspaceB, config, subjects[1]!, {
          code: "fixture-code",
          state,
        }),
        { code: "crm_oauth_failed" },
      );
      await assert.rejects(
        completeOauthConnection(store, workspaceB, config, subjects[1]!, {
          code: "fixture-code",
          state,
        }),
        { code: "oauth_state_invalid" },
      );
      assert.equal(exchanges, 1);

      const denied = await startOauthConnection(store, workspaceB, config, subjects[1]!);
      const deniedState = new URL(denied.url).searchParams.get("state");
      assert.ok(deniedState);
      await assert.rejects(
        completeOauthConnection(store, workspaceB, config, subjects[1]!, {
          error: "access_denied",
          state: deniedState,
        }),
        { code: "oauth_cancelled" },
      );
      await assert.rejects(
        completeOauthConnection(store, workspaceB, config, subjects[1]!, {
          error: "access_denied",
          state: deniedState,
        }),
        { code: "oauth_state_invalid" },
      );
      assert.equal(exchanges, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


describe("orientation authority", () => {
  it("does not let a stale public orientation save restore disconnected GHL flags", { skip }, async () => {
    const existing = await store.scoped(workspaceA, async (tx) => {
      const rows = await tx<{ connection_id: string }[]>`
        select connection_id from fb_crm_control
         where founder_id = ${workspaceA} and connection_id is not null
      `;
      return rows[0]?.connection_id ?? null;
    });
    if (existing) await disconnectConnection(store, workspaceA, existing);
    const api = await buildApi(
      { ...config, FOUNDERBRAIN_LOCAL_DEMO: "true" },
      {
        store,
        logger: false,
        authenticate: async () => ({ subject: subjects[0]!, email: "fixture@example.test" }),
      },
    );
    try {
      const response = await api.inject({
        method: "PUT",
        url: "/api/orientation",
        payload: {
          contentScreen: 4,
          ghlScreen: 5,
          ghlComplete: true,
          ghlAnswers: { connected: true },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const state = response.json() as {
        contentScreen: number;
        ghlCompletedAt: string | null;
        ghlAnswers: { connected?: boolean };
      };
      assert.equal(state.contentScreen, 4);
      assert.equal(state.ghlCompletedAt, null);
      assert.equal(state.ghlAnswers.connected, false);
    } finally {
      await api.close();
    }
  });
});
