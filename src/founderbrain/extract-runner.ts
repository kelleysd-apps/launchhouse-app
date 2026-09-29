/**
 * src/founderbrain/extract-runner.ts
 *
 * WHAT THIS IS. Runs extract.ts's extractText off the API's main event loop,
 * inside a short-lived node:worker_threads Worker with a memory cap and a
 * hard wall-clock timeout. extract.ts is never modified — extract-worker.ts
 * imports it verbatim inside the worker; this file only spawns that worker,
 * enforces the timeout, limits how many run at once, and translates the
 * result back into the same contract calling extractText directly would give
 * (an ExtractOutcome, or a thrown ExtractRefused) — so uploads.ts's own
 * try/catch around extraction needed no change beyond the one call site.
 *
 * WHY A WORKER AT ALL. extract.ts already defends against zip bombs and path
 * escapes with byte-count and entry-count limits, but a parser bug (mammoth,
 * pdfjs-dist) or a pathological file those limits don't anticipate could still
 * loop or allocate heavily. On the main thread that stalls or OOMs the whole
 * API — every founder's request, not just the one uploading. On a worker
 * thread with its own resourceLimits and a timeout this file enforces, the
 * failure mode is "this worker gets killed," and the request that started it
 * gets a plain refusal.
 *
 * WHY CONCURRENCY IS CAPPED. Each worker thread is its own V8 isolate with its
 * own heap; letting an unbounded number spawn under load is its own DoS. At
 * most MAX_CONCURRENT_EXTRACTIONS run at once per process; anything past that
 * waits in a FIFO queue rather than spawning more workers.
 */
import { Worker } from "node:worker_threads";
import {
  ExtractRefused,
  type ExtractLimits,
  type ExtractOutcome,
  type ExtractRefusalReason,
} from "../server/uploads/extract.ts";

const MAX_CONCURRENT_EXTRACTIONS = 2;
const EXTRACT_WORKER_TIMEOUT_MS = 20_000;
const EXTRACT_WORKER_MAX_OLD_GENERATION_MB = 256;
const EXTRACT_WORKER_MAX_YOUNG_GENERATION_MB = 64;
const TIMEOUT_OR_CRASH_TEXT = "We couldn't read that file.";

type WorkerMessage =
  | { readonly ok: true; readonly outcome: ExtractOutcome }
  | {
      readonly ok: false;
      readonly refused: true;
      readonly reason: ExtractRefusalReason;
      readonly founderText: string;
    }
  | { readonly ok: false; readonly refused: false; readonly message: string };

// ---------------------------------------------------------------------------------
// A tiny FIFO semaphore. No dependency pulled in for two lines of queueing.
// ---------------------------------------------------------------------------------
let running = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT_EXTRACTIONS) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  running += 1;
}

function releaseSlot(): void {
  running -= 1;
  const next = waiters.shift();
  if (next) next();
}

/**
 * Resolves the worker's own script next to this file, under whichever
 * extension THIS module is actually running as — `.ts` in dev/tests (tsx),
 * `.js` in the compiled runtime build (dist/founderbrain-server). A raw
 * string passed to `new Worker(...)` is opaque to TypeScript's own
 * relative-import extension rewriting, so this has to be resolved at runtime
 * rather than written as a static import.
 */
function extractWorkerUrl(): URL {
  const isSource = import.meta.url.endsWith(".ts");
  return new URL(`./extract-worker${isSource ? ".ts" : ".js"}`, import.meta.url);
}

/** Worker threads do not inherit the parent's ESM loader hooks on their own;
 *  in dev/tests, where the worker script is still `.ts`, tsx's loader has to
 *  be registered again for that thread specifically. The compiled build's
 *  worker script is plain `.js` and needs no loader at all. */
function extractWorkerExecArgv(): string[] {
  return import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [];
}

function runOnce(
  input: {
    filename: string;
    bytes: Buffer;
    limits: ExtractLimits;
  },
  timeoutMs: number,
): Promise<ExtractOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(extractWorkerUrl(), {
      workerData: { filename: input.filename, bytes: input.bytes, limits: input.limits },
      execArgv: extractWorkerExecArgv(),
      resourceLimits: {
        maxOldGenerationSizeMb: EXTRACT_WORKER_MAX_OLD_GENERATION_MB,
        maxYoungGenerationSizeMb: EXTRACT_WORKER_MAX_YOUNG_GENERATION_MB,
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      reject(new ExtractRefused("timeout", TIMEOUT_OR_CRASH_TEXT));
    }, timeoutMs);
    // Node keeps the process alive for a pending timer by default; this
    // worker's own lifecycle should not do that on its own.
    timer.unref();
    worker.once("message", (msg: WorkerMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (msg.ok) resolve(msg.outcome);
      else if (msg.refused) reject(new ExtractRefused(msg.reason, msg.founderText));
      else reject(new ExtractRefused("parse-failed", TIMEOUT_OR_CRASH_TEXT));
    });
    worker.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      reject(new ExtractRefused("parse-failed", TIMEOUT_OR_CRASH_TEXT));
    });
    worker.once("exit", () => {
      // A worker that exits without ever posting a message — killed by its
      // own resourceLimits, or any other crash — is read the same as a
      // timeout: refuse, store nothing. If a message already resolved this,
      // `settled` makes this a no-op.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ExtractRefused("parse-failed", TIMEOUT_OR_CRASH_TEXT));
    });
  });
}

/**
 * Drop-in replacement for calling extract.ts's extractText directly: same
 * inputs, same contract (an ExtractOutcome, or a thrown ExtractRefused) — but
 * run on a worker thread, under a memory cap and a wall-clock timeout, with
 * at most MAX_CONCURRENT_EXTRACTIONS running at once per process.
 *
 * `timeoutMs` defaults to the real production value (20s) and exists as a
 * parameter only so tests can force the timeout path deterministically and
 * fast, without waiting out a real 20 second timer.
 */
export async function extractInWorker(
  input: {
    filename: string;
    bytes: Buffer;
    limits: ExtractLimits;
  },
  timeoutMs: number = EXTRACT_WORKER_TIMEOUT_MS,
): Promise<ExtractOutcome> {
  await acquireSlot();
  try {
    return await runOnce(input, timeoutMs);
  } finally {
    releaseSlot();
  }
}
