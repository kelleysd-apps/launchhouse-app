export type GhlAsyncEpochs = {
  session: number;
  workspace: number;
  connection: number;
};

export type GhlAsyncScope = "workspace" | "connection";

/** Capture immutable epochs before an async GHL request starts. */
export function captureGhlAsyncGuard(epochs: GhlAsyncEpochs): GhlAsyncEpochs {
  return { ...epochs };
}

/**
 * Workspace reads survive unrelated connection refreshes. Connection reads and
 * every external write require all three epochs to remain unchanged.
 */
export function isGhlAsyncGuardCurrent(
  captured: GhlAsyncEpochs,
  current: GhlAsyncEpochs,
  scope: GhlAsyncScope = "connection",
): boolean {
  if (captured.session !== current.session || captured.workspace !== current.workspace) {
    return false;
  }
  return scope === "workspace" || captured.connection === current.connection;
}
