import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeUrl,
  CRM_OUTER_OPERATION_MAX,
  CRM_SCOPES,
  readOauthState,
  signOauthState,
  withCrmOperationLock,
} from "./crm-oauth.ts";
import type { Config } from "./config.ts";
import type { PgBrainStore } from "./store.ts";

test("oauth state round-trips the subject and rejects a truncated token", () => {
  const secret = "x".repeat(32);
  const state = signOauthState(secret, "hexclave|proj|user-1", 1_000_000);
  assert.deepEqual(readOauthState(secret, state, 1_000_000), { sub: "hexclave|proj|user-1" });
  assert.throws(() => readOauthState(secret, state.slice(0, 12), 1_000_000));
  assert.throws(() => readOauthState(secret, state, 1_000_000 + 16 * 60 * 1000));
});

test("authorize URL uses the SPA callback and never contains ghl in the redirect", () => {
  const config = {
    APP_ORIGIN: "https://oneday-founderbrain.marfi.online",
    HIGHLEVEL_CLIENT_ID: "client-id-example",
    HIGHLEVEL_VERSION_ID: "version-id-example",
  } as Config;
  const url = new URL(authorizeUrl(config, "state-token"));
  assert.equal(url.origin, "https://marketplace.gohighlevel.com");
  assert.equal(url.searchParams.get("redirect_uri"), "https://oneday-founderbrain.marfi.online/oauth/callback");
  assert.equal(url.searchParams.get("redirect_uri")?.includes("ghl"), false);
  assert.equal(url.searchParams.get("client_id"), "client-id-example");
  assert.equal(url.searchParams.get("scope"), CRM_SCOPES.join(" "));
  assert.equal(url.searchParams.get("state"), "state-token");
});


test("CRM admission reserves pool capacity before opening outer transactions", async () => {
  assert.equal(CRM_OUTER_OPERATION_MAX, 3);
  const tx = (async () => [{ locked: true }]) as never;
  const store = {
    scoped: async (_workspace: string, fn: (transaction: never) => Promise<unknown>) => fn(tx),
  } as unknown as PgBrainStore;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  let allStarted!: () => void;
  const ready = new Promise<void>((resolve) => { allStarted = resolve; });
  const held = Array.from({ length: CRM_OUTER_OPERATION_MAX }, (_, index) =>
    withCrmOperationLock(store, `workspace-held-${index}`, async () => {
      started += 1;
      if (started === CRM_OUTER_OPERATION_MAX) allStarted();
      await gate;
      return index;
    }),
  );
  await ready;

  const overflow = Array.from({ length: 5 }, (_, index) =>
    withCrmOperationLock(store, `workspace-busy-${index}`, async () => index),
  );
  const ninth = withCrmOperationLock(store, "workspace-busy-extra", async () => 9);
  const refused = await Promise.allSettled([...overflow, ninth]);
  for (const result of refused) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.equal((result.reason as { code?: string }).code, "crm_busy");
      assert.equal((result.reason as { status?: number }).status, 409);
    }
  }

  release();
  assert.deepEqual(await Promise.all(held), [0, 1, 2]);
  assert.equal(
    await withCrmOperationLock(store, "workspace-resumed", async () => "resumed"),
    "resumed",
  );

  const marker = new Error("operation failed");
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(
      withCrmOperationLock(store, `workspace-failure-${index}`, async () => { throw marker; }),
      (error) => error === marker,
    );
  }
  assert.equal(
    await withCrmOperationLock(store, "workspace-after-failures", async () => "available"),
    "available",
  );

  let scopedFailures = 4;
  const flakyStore = {
    scoped: async (_workspace: string, fn: (transaction: never) => Promise<unknown>) => {
      if (scopedFailures > 0) {
        scopedFailures -= 1;
        throw marker;
      }
      return fn(tx);
    },
  } as unknown as PgBrainStore;
  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(
      withCrmOperationLock(flakyStore, `workspace-scoped-failure-${index}`, async () => "unused"),
      (error) => error === marker,
    );
  }
  assert.equal(
    await withCrmOperationLock(flakyStore, "workspace-after-scoped-failures", async () => "available"),
    "available",
  );
});


test("provider identity uses the workspace location id and fails closed to nameUnavailable", async () => {
  const { statusForConnectionUnlocked } = await import("./crm-oauth.ts");
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response("provider unavailable", { status: 503 });
    };
    const status = await statusForConnectionUnlocked({
      accessToken: "fixture-token",
      locationId: "real-location-id",
      connectionId: "11111111-1111-4111-8111-111111111111",
    });
    assert.deepEqual(status, {
      connected: true,
      locationId: "real-location-id",
      locationName: null,
      connectionId: "11111111-1111-4111-8111-111111111111",
      nameUnavailable: true,
    });
    assert.deepEqual(calls, ["https://services.leadconnectorhq.com/locations/real-location-id"]);
  } finally {
    globalThis.fetch = original;
  }
});


test("provider identity rejects a location name returned for another location id", async () => {
  const { statusForConnectionUnlocked } = await import("./crm-oauth.ts");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      location: { id: "another-location", name: "Wrong Account" },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const status = await statusForConnectionUnlocked({
      accessToken: "fixture-token",
      locationId: "real-location-id",
      connectionId: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(status.locationId, "real-location-id");
    assert.equal(status.locationName, null);
    assert.equal(status.nameUnavailable, true);
  } finally {
    globalThis.fetch = original;
  }
});
