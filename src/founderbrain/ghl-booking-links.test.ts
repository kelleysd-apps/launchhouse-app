import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { emptyBrain } from "../founderbrain-shared/domain.ts";
import {
  bookingLinkDefinitionsFor,
  transferBookingLinkAtProvider,
  validateBookingLinkUrl,
} from "./ghl-booking-links.ts";

const originalFetch = globalThis.fetch;
const connection = {
  accessToken: "provider-access-token-fixture",
  locationId: "location-real-id",
  connectionId: "11111111-1111-4111-8111-111111111111",
};
const pasted = "https://booking.example.test/danny";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function callDefinition() {
  const brain = emptyBrain();
  brain.identity.track = "b2b";
  const definitions = await bookingLinkDefinitionsFor(brain);
  const definition = definitions.find((item) => item.key === "call_booking_link");
  assert.ok(definition);
  return definition;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("booking link validation and provider transfer", () => {
  it("derives the link whitelist from the current snapshot catalogue", async () => {
    const b2b = emptyBrain();
    b2b.identity.track = "b2b";
    assert.deepEqual((await bookingLinkDefinitionsFor(b2b)).map((item) => item.key), ["call_booking_link"]);
    const b2c = emptyBrain();
    b2c.identity.track = "b2c";
    assert.deepEqual((await bookingLinkDefinitionsFor(b2c)).map((item) => item.key), ["dm_booking_link"]);
    b2b.identity.hybrid = true;
    assert.deepEqual(
      (await bookingLinkDefinitionsFor(b2b)).map((item) => item.key).sort(),
      ["call_booking_link", "dm_booking_link"],
    );
  });

  it("accepts HTTPS only, rejects credentials, and performs no request during validation", () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("must not fetch");
    };
    assert.equal(validateBookingLinkUrl(pasted), pasted);
    for (const value of [
      "http://booking.example.test/danny",
      "https://user:pass@booking.example.test/danny",
      "not a link",
      `https://booking.example.test/${"x".repeat(2050)}`,
    ]) {
      assert.throws(() => validateBookingLinkUrl(value), { code: "booking_link_invalid" });
    }
    assert.equal(calls, 0);
  });

  it("creates only the named custom value, proves the exact URL, and never fetches the pasted URL", async () => {
    const definition = await callDefinition();
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    let created = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/customValues") && method === "GET")
        return json({ customValues: created ? [{ id: "created-1", name: definition.name }] : [] });
      if (url.endsWith("/customValues") && method === "POST") {
        created = true;
        return json({ customValue: { id: "created-1", name: definition.name, value: pasted } });
      }
      if (url.endsWith("/customValues/created-1"))
        return json({ customValue: { id: "created-1", name: definition.name, locationId: connection.locationId, value: pasted } });
      if (url.endsWith("/locations/location-real-id"))
        return json({ location: { id: "location-real-id", name: "Actual Subaccount" } });
      throw new Error(`unexpected request ${method} ${url}`);
    };

    const result = await transferBookingLinkAtProvider(connection, definition, {
      connectionId: connection.connectionId,
      key: "call_booking_link",
      url: pasted,
      expectedValue: null,
      replaceExisting: false,
    });
    assert.equal(result.written, true);
    assert.equal(result.proven, true);
    assert.equal(result.link.value, pasted);
    assert.equal(result.connection.locationName, "Actual Subaccount");
    assert.ok(calls.every((call) => call.url.startsWith("https://services.leadconnectorhq.com/")));
    assert.ok(!calls.some((call) => call.url === pasted));
    const create = calls.find((call) => call.method === "POST");
    assert.deepEqual(JSON.parse(create?.body ?? "{}"), { name: definition.name, value: pasted });
  });

  it("returns identical existing values without writing", async () => {
    const definition = await callDefinition();
    const methods: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      methods.push(method);
      if (url.endsWith("/customValues"))
        return json({ customValues: [{ id: "same-1", name: definition.name }] });
      if (url.endsWith("/customValues/same-1"))
        return json({ customValue: { id: "same-1", name: definition.name, locationId: connection.locationId, value: pasted } });
      return json({ location: { id: connection.locationId, name: "Actual Subaccount" } });
    };
    const result = await transferBookingLinkAtProvider(connection, definition, {
      connectionId: connection.connectionId,
      key: "call_booking_link",
      url: pasted,
      expectedValue: pasted,
      replaceExisting: false,
    });
    assert.equal(result.written, false);
    assert.equal(result.proven, true);
    assert.ok(!methods.includes("PUT"));
    assert.ok(!methods.includes("POST"));
  });

  it("requires replacement confirmation and refuses a changed remote value", async () => {
    const definition = await callDefinition();
    const remote = "https://booking.example.test/current";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/customValues"))
        return json({ customValues: [{ id: "existing-1", name: definition.name }] });
      return json({ customValue: { id: "existing-1", name: definition.name, locationId: connection.locationId, value: remote } });
    };
    await assert.rejects(
      transferBookingLinkAtProvider(connection, definition, {
        connectionId: connection.connectionId,
        key: "call_booking_link",
        url: pasted,
        expectedValue: null,
        replaceExisting: true,
      }),
      { code: "booking_link_changed" },
    );
    await assert.rejects(
      transferBookingLinkAtProvider(connection, definition, {
        connectionId: connection.connectionId,
        key: "call_booking_link",
        url: pasted,
        expectedValue: remote,
        replaceExisting: false,
      }),
      { code: "booking_link_replace_required" },
    );
  });

  it("updates with both name and value after expected-value confirmation", async () => {
    const definition = await callDefinition();
    const remote = "https://booking.example.test/current";
    let updated = false;
    let putBody: unknown;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/customValues") && method === "GET")
        return json({ customValues: [{ id: "existing-1", name: definition.name }] });
      if (url.endsWith("/customValues/existing-1") && method === "PUT") {
        updated = true;
        putBody = JSON.parse(String(init?.body));
        return json({ customValue: { id: "existing-1", name: definition.name, locationId: connection.locationId, value: pasted } });
      }
      if (url.endsWith("/customValues/existing-1"))
        return json({ customValue: { id: "existing-1", name: definition.name, locationId: connection.locationId, value: updated ? pasted : remote } });
      return json({ location: { id: connection.locationId, name: "Actual Subaccount" } });
    };
    const result = await transferBookingLinkAtProvider(connection, definition, {
      connectionId: connection.connectionId,
      key: "call_booking_link",
      url: pasted,
      expectedValue: remote,
      replaceExisting: true,
    });
    assert.deepEqual(putBody, { name: definition.name, value: pasted });
    assert.equal(result.written, true);
    assert.equal(result.proven, true);
  });

  it("fails closed on unknown responses, duplicate names, and provider write refusal", async () => {
    const definition = await callDefinition();
    for (const malformed of [
      {},
      { customValues: null },
      { customValues: [{ id: "", name: definition.name }] },
      { customValues: [{ id: "one", name: definition.name, value: null }] },
    ]) {
      globalThis.fetch = async () => json(malformed);
      await assert.rejects(
        transferBookingLinkAtProvider(connection, definition, {
          connectionId: connection.connectionId,
          key: "call_booking_link",
          url: pasted,
          expectedValue: null,
          replaceExisting: false,
        }),
        { code: "booking_links_unavailable" },
      );
    }

    globalThis.fetch = async () => json({ customValues: [
      { id: "one", name: definition.name },
      { id: "two", name: definition.name },
    ] });
    await assert.rejects(
      transferBookingLinkAtProvider(connection, definition, {
        connectionId: connection.connectionId,
        key: "call_booking_link",
        url: pasted,
        expectedValue: null,
        replaceExisting: false,
      }),
      { code: "booking_link_ambiguous" },
    );

    globalThis.fetch = async (_input, init) =>
      (init?.method ?? "GET") === "POST" ? json({ message: "refused" }, 500) : json({ customValues: [] });
    await assert.rejects(
      transferBookingLinkAtProvider(connection, definition, {
        connectionId: connection.connectionId,
        key: "call_booking_link",
        url: pasted,
        expectedValue: null,
        replaceExisting: false,
      }),
      { code: "booking_link_write_failed" },
    );
  });

  it("fails closed on empty or mismatched detail envelopes", async () => {
    const definition = await callDefinition();
    for (const customValue of [
      undefined,
      { id: "wrong", name: definition.name, locationId: connection.locationId },
      { id: "existing-1", name: "Wrong Name", locationId: connection.locationId },
      { id: "existing-1", name: definition.name, locationId: "wrong-location" },
      { id: "existing-1", name: definition.name, locationId: connection.locationId, value: null },
    ]) {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/customValues"))
          return json({ customValues: [{ id: "existing-1", name: definition.name }] });
        return json(customValue === undefined ? {} : { customValue });
      };
      await assert.rejects(
        transferBookingLinkAtProvider(connection, definition, {
          connectionId: connection.connectionId,
          key: "call_booking_link",
          url: pasted,
          expectedValue: null,
          replaceExisting: false,
        }),
        { code: "booking_links_unavailable" },
      );
    }
  });

  it("accepts a valid exact detail with omitted value as unset", async () => {
    const definition = await callDefinition();
    let updated = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/customValues"))
        return json({ customValues: [{ id: "empty-1", name: definition.name }] });
      if (url.endsWith("/customValues/empty-1") && method === "PUT") {
        updated = true;
        return json({ ok: true });
      }
      if (url.endsWith("/customValues/empty-1"))
        return json({ customValue: {
          id: "empty-1",
          name: definition.name,
          locationId: connection.locationId,
          ...(updated ? { value: pasted } : {}),
        } });
      return json({ location: { id: connection.locationId, name: "Actual Subaccount" } });
    };
    const result = await transferBookingLinkAtProvider(connection, definition, {
      connectionId: connection.connectionId,
      key: "call_booking_link",
      url: pasted,
      expectedValue: null,
      replaceExisting: false,
    });
    assert.equal(result.proven, true);
    assert.equal(updated, true);
  });

  it("returns written but unproven when exact read-back never matches", async () => {
    const definition = await callDefinition();
    let created = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/customValues") && method === "GET")
        return json({ customValues: created ? [{ id: "created-1", name: definition.name }] : [] });
      if (url.endsWith("/customValues") && method === "POST") {
        created = true;
        return json({ customValue: { id: "created-1", name: definition.name } });
      }
      if (url.endsWith("/customValues/created-1"))
        return json({ customValue: { id: "created-1", name: definition.name, locationId: connection.locationId, value: "https://booking.example.test/other" } });
      return json({ location: { name: "Actual Subaccount" } });
    };
    const result = await transferBookingLinkAtProvider(connection, definition, {
      connectionId: connection.connectionId,
      key: "call_booking_link",
      url: pasted,
      expectedValue: null,
      replaceExisting: false,
    });
    assert.equal(result.written, true);
    assert.equal(result.proven, false);
    assert.equal(result.link.value, null);
  });
});
