/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { captureGhlAsyncGuard, isGhlAsyncGuardCurrent } from "./ghl-async-guard.ts";

test("connection-scoped responses are stale after logout, workspace change, or connection change", () => {
  const captured = captureGhlAsyncGuard({ session: 4, workspace: 7, connection: 2 });
  assert.equal(isGhlAsyncGuardCurrent(captured, { session: 4, workspace: 7, connection: 2 }), true);
  assert.equal(
    isGhlAsyncGuardCurrent(captured, { session: 5, workspace: 7, connection: 2 }),
    false,
  );
  assert.equal(
    isGhlAsyncGuardCurrent(captured, { session: 4, workspace: 8, connection: 2 }),
    false,
  );
  assert.equal(
    isGhlAsyncGuardCurrent(captured, { session: 4, workspace: 7, connection: 3 }),
    false,
  );
});

test("workspace-scoped cleanup ignores a connection generation bump but not logout", () => {
  const captured = captureGhlAsyncGuard({ session: 4, workspace: 7, connection: 2 });
  assert.equal(
    isGhlAsyncGuardCurrent(captured, { session: 4, workspace: 7, connection: 9 }, "workspace"),
    true,
  );
  assert.equal(
    isGhlAsyncGuardCurrent(captured, { session: 5, workspace: 7, connection: 2 }, "workspace"),
    false,
  );
});

test("captured guards are immutable copies", () => {
  const epochs = { session: 1, workspace: 1, connection: 1 };
  const captured = captureGhlAsyncGuard(epochs);
  epochs.connection = 2;
  assert.deepEqual(captured, { session: 1, workspace: 1, connection: 1 });
});
