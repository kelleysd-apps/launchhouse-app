/**
 * src/founderbrain/extract-worker.ts
 *
 * WHAT THIS IS. The node:worker_threads entry point extract-runner.ts spawns
 * once per upload extraction. Reads `workerData`, calls extract.ts's
 * extractText UNMODIFIED, posts exactly one message back describing the
 * result, and lets the thread exit. Nothing else imports this file — it is
 * only ever reached via `new Worker(...)` in extract-runner.ts, which is also
 * the only place that knows the shape of the message this file posts.
 *
 * WHY A SEPARATE FILE, NOT A FUNCTION CALLED FROM THE MAIN THREAD. extractText
 * parses whatever bytes a stranger uploads — docx/xlsx/pptx are zip archives,
 * pdf runs a real PDF parser. A crafted file that makes one of those parsers
 * loop or allocate unboundedly must not stall the API event loop (every other
 * founder's request) or grow the API process's own heap. Running it on a
 * worker thread with its own resourceLimits (extract-runner.ts) means the
 * failure mode for a bad file is "this one worker gets killed," never
 * "the API process is unresponsive or OOMs."
 */
import { parentPort, workerData } from "node:worker_threads";
import { ExtractRefused, extractText, type ExtractLimits } from "../server/uploads/extract.ts";

type ExtractWorkerInput = {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly limits: ExtractLimits;
};

async function main(): Promise<void> {
  if (!parentPort) throw new Error("extract-worker.ts must run inside a worker thread");
  const { filename, bytes, limits } = workerData as ExtractWorkerInput;
  try {
    const outcome = await extractText({ filename, bytes: Buffer.from(bytes), limits });
    parentPort.postMessage({ ok: true, outcome });
  } catch (err) {
    if (err instanceof ExtractRefused) {
      parentPort.postMessage({
        ok: false,
        refused: true,
        reason: err.reason,
        founderText: err.founderText,
      });
    } else {
      parentPort.postMessage({
        ok: false,
        refused: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

void main();
