/**
 * src/founderbrain/uploads.ts
 *
 * WHAT THIS IS. Founder document uploads: text documents (not media — see
 * media.ts for images/video) stored encrypted in Postgres, never R2. Original
 * bytes and, when the document has one, extracted text each go through
 * extract.ts and are sealed into ge_blob under the founder's own data key,
 * exactly like every other founder blob (jobs.ts, higgsfield.ts). fb_upload
 * holds metadata and the two sha256 pointers only.
 *
 * THE ONE ALLOCATION FUNCTION. `allocateDocumentContext` is pure and is the
 * single place that decides which uploaded documents a generation reads, and
 * how much of each. jobs.ts calls it (through `computeUploadContext`) to build
 * the actual generation payload; GET /api/uploads calls the very same function
 * to show a founder the same statuses, so the UI never promises the AI will
 * read something it will not.
 *
 * WHY THE 32,000 BYTE HARD CAP NEVER MOVES. jobs.ts reserves budget for a
 * generation from the final pinned payload's byte size (domain.ts's
 * MAX_PINNED_BODY_BYTES); documents get only whatever room is left under it
 * once the Brain's own content is accounted for, minus a safety margin. See
 * documentBudgetBytes below.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type TransactionSql } from "postgres";

import {
  DomainError,
  canonicalize,
  generationPayload,
  MAX_PINNED_BODY_BYTES,
  DOCUMENT_SAFETY_MARGIN_BYTES,
  type Brain,
  type GenerationDocument,
} from "./domain.ts";
import type { Config } from "./config.ts";
import type { PgBrainStore } from "./store.ts";
import {
  openBlob,
  sealBlob,
  sha256Hex,
  unwrapDataKey,
  type DataKey,
  type SealedBlob,
} from "../server/storage/crypto.ts";
import { extensionOf, ExtractRefused, type ExtractOutcome } from "../server/uploads/extract.ts";
import { extractInWorker } from "./extract-runner.ts";
import { buildOrchestrationFromConfig } from "./orchestrate.ts";

type Tx = TransactionSql;

export const ALLOWED_UPLOAD_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
] as const;

export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOADS_PER_FOUNDER = 50;
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;

const EXTRACT_LIMITS = {
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxEntries: 2000,
  maxChars: 200_000,
  maxPages: 200,
  maxRows: 5000,
  timeoutMs: 15_000,
} as const;

export type UploadAiStatus = "full" | "partial" | "excluded" | "unreadable";

export type UploadItem = {
  id: string;
  name: string;
  ext: string;
  sizeBytes: number;
  questionKey: string | null;
  createdAt: string;
  readable: "text" | "no_text";
  textChars: number;
  ai: UploadAiStatus;
};

type UploadRow = {
  id: string;
  name: string;
  ext: string;
  size_bytes: string | number;
  question_key: string | null;
  original_sha: string;
  text_sha: string | null;
  text_chars: number;
  readable: "text" | "no_text";
  created_at: Date | string;
};

function iso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString();
}

export async function migrateUploads(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(await readFile(new URL("./uploads.sql", import.meta.url), "utf8"));
    });
  } finally {
    await sql.end();
  }
}

/**
 * Strips any path, control characters and excess length from an uploaded file's
 * claimed name, preserving its extension when truncating. Precedent: safeName in
 * media.ts, adapted for a longer (120 char) display name and no character-set
 * narrowing — a founder's document name is shown back to them, not used as a
 * storage key, so there is no reason to mangle accented or non-Latin names.
 */
export function sanitizeUploadName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const name = cleaned.length > 0 ? cleaned : "file";
  if (name.length <= 120) return name;
  const ext = extensionOf(name);
  const keepExt = ext.length > 0 && ext.length <= 20 ? ext : "";
  const stem = keepExt ? name.slice(0, name.length - keepExt.length) : name;
  return stem.slice(0, Math.max(1, 120 - keepExt.length)) + keepExt;
}

/** RFC 6266: an ASCII fallback plus a percent-encoded `filename*` for everyone else. */
export function contentDispositionHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function toUploadItem(row: UploadRow, ai: UploadAiStatus): UploadItem {
  return {
    id: row.id,
    name: row.name,
    ext: row.ext,
    sizeBytes: Number(row.size_bytes),
    questionKey: row.question_key,
    createdAt: iso(row.created_at),
    readable: row.readable,
    textChars: row.text_chars,
    ai,
  };
}

/**
 * The founder's data key, read once outside any write transaction. Sealing a
 * file's bytes (AES-GCM over up to 10 MB) is CPU work, not a database
 * operation; doing it here — before createUpload's short, advisory-locked
 * insert transaction — keeps that lock held only for the DB writes it
 * actually needs to serialize, not for however long encryption takes.
 */
async function founderDataKey(store: PgBrainStore, workspace: string): Promise<DataKey> {
  return store.scoped(workspace, async (tx) => {
    const rows =
      await tx`select wrapped_key from founder where id=${workspace} and deleted_at is null`;
    if (!rows[0]) throw new DomainError(404, "workspace_missing", "Workspace not found.");
    return unwrapDataKey(workspace, rows[0].wrapped_key);
  });
}

/** Inserts an already-sealed blob inside a caller-supplied transaction. Sealing
 *  itself (sealBlob) happens outside; this is just the write. */
async function insertSealedBlob(tx: Tx, workspace: string, sealed: SealedBlob): Promise<void> {
  await tx`
    insert into ge_blob(founder_id, sha, ciphertext, nonce, size_bytes)
    values (${workspace}, ${sealed.sha}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sizeBytes})
    on conflict (founder_id, sha) do nothing
  `;
}

async function openFounderBlob(tx: Tx, workspace: string, sha: string): Promise<Buffer> {
  const r = await tx`
    select b.ciphertext, b.nonce, f.wrapped_key
    from ge_blob b join founder f on f.id = b.founder_id
    where b.founder_id = ${workspace} and b.sha = ${sha}
  `;
  if (!r[0])
    throw new DomainError(503, "upload_unavailable", "The saved file could not be retrieved.");
  return openBlob(
    workspace,
    unwrapDataKey(workspace, r[0].wrapped_key),
    sha,
    r[0].ciphertext,
    r[0].nonce,
  );
}

async function countUploads(
  tx: Tx,
  workspace: string,
): Promise<{ count: number; totalBytes: number }> {
  const rows = await tx`
    select count(*)::int as count, coalesce(sum(size_bytes),0)::bigint as total
    from fb_upload where founder_id = ${workspace}
  `;
  return { count: Number(rows[0]?.count ?? 0), totalBytes: Number(rows[0]?.total ?? 0) };
}

function assertWithinQuota(count: number, totalBytes: number, addedBytes: number): void {
  if (count >= MAX_UPLOADS_PER_FOUNDER)
    throw new DomainError(
      422,
      "upload_limit",
      "You have reached 50 files. Remove some to add more.",
    );
  if (totalBytes + addedBytes > MAX_UPLOAD_TOTAL_BYTES)
    throw new DomainError(
      422,
      "upload_total_limit",
      "You have reached 100 MB of files. Remove some to add more.",
    );
}

/**
 * Stores one uploaded document: validates its extension and size against the
 * founder's caps, runs extract.ts on the bytes, seals the original (and, when
 * there is one, the extracted text) into ge_blob, and writes the fb_upload row.
 * The returned item's `ai` field is a same-request best guess (full for a
 * readable file, unreadable for a scanned PDF) — the true allocation, which
 * depends on every other file the founder has and the current Brain, is what
 * `computeUploadContext` returns, and the server.ts route uses that value
 * instead once this call returns.
 */
export async function createUpload(
  store: PgBrainStore,
  workspace: string,
  input: { filename: string; questionKey: string | null; bytes: Buffer },
): Promise<{ item: UploadItem }> {
  const name = sanitizeUploadName(input.filename);
  const ext = extensionOf(name);
  if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext))
    throw new DomainError(
      415,
      "upload_type",
      `We can read ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")} files. "${name}" is not one of those.`,
    );
  if (!(input.bytes.length > 0)) throw new DomainError(422, "upload_empty", "That file is empty.");
  if (input.bytes.length > MAX_UPLOAD_FILE_BYTES)
    throw new DomainError(422, "upload_too_large", "Files can be up to 10 MB.");

  // A quick, non-authoritative check so a founder already well over the cap is
  // not made to wait on extraction just to be refused anyway. The atomic,
  // advisory-locked transaction below is what actually enforces the caps —
  // this is purely an optimization, never load-bearing for correctness.
  {
    const precheck = await store.scoped(workspace, (tx) => countUploads(tx, workspace));
    assertWithinQuota(precheck.count, precheck.totalBytes, input.bytes.length);
  }

  // extract.ts dispatches on extension and does not know ".markdown" by that
  // name (only ".md"); it is the same plain-text extraction path either way, so
  // this route asks for it under the alias extract.ts recognizes. The stored
  // row keeps the founder's own ".markdown" name and ext untouched.
  const extractFilename =
    ext === ".markdown" ? `${name.slice(0, name.length - ext.length)}.md` : name;
  let outcome: ExtractOutcome;
  try {
    outcome = await extractInWorker({
      filename: extractFilename,
      bytes: input.bytes,
      limits: EXTRACT_LIMITS,
    });
  } catch (err) {
    if (err instanceof ExtractRefused)
      throw new DomainError(422, "upload_unreadable", err.founderText);
    throw err;
  }

  let readable: "text" | "no_text";
  let textContent: string | null = null;
  let textChars = 0;
  let bestGuessAi: UploadAiStatus;
  if (outcome.action === "extract") {
    readable = "text";
    textContent = outcome.result.text;
    textChars = textContent.length;
    bestGuessAi = "full";
  } else {
    // Defensive: images are never handed to extractText (ALLOWED_UPLOAD_EXTENSIONS
    // excludes them), so a passthrough outcome here must be a scanned PDF with no
    // text layer. Anything else means this route's own allow-list and extract.ts's
    // dispatch have drifted apart, which is a bug worth refusing loudly rather than
    // silently storing something this route never meant to accept.
    if (outcome.ext !== ".pdf")
      throw new DomainError(422, "upload_unreadable", "That file could not be read.");
    readable = "no_text";
    bestGuessAi = "unreadable";
  }

  // Sealing (AES-GCM over the plaintext) is CPU work, not a database
  // operation. It happens here, before the atomic insert transaction, so that
  // transaction's advisory lock is held only for the DB writes it needs to
  // serialize — never for however long encryption of a 10 MB file takes.
  const dataKey = await founderDataKey(store, workspace);
  const sealedOriginal = sealBlob(workspace, dataKey, input.bytes);
  const sealedText =
    textContent !== null ? sealBlob(workspace, dataKey, Buffer.from(textContent, "utf8")) : null;

  const id = randomUUID();
  const row = await store.scoped(workspace, async (tx) => {
    // Serializes every create for this founder: the count/total-bytes check
    // and the insert below must be read-then-written atomically, or two
    // concurrent uploads at the cap can both pass the check and both insert,
    // overshooting MAX_UPLOADS_PER_FOUNDER / MAX_UPLOAD_TOTAL_BYTES.
    await tx`select pg_advisory_xact_lock(hashtext(${"fb_upload:" + workspace}))`;
    const { count, totalBytes } = await countUploads(tx, workspace);
    assertWithinQuota(count, totalBytes, input.bytes.length);
    const originalSha = sealedOriginal.sha;
    const textSha = sealedText?.sha ?? null;
    await insertSealedBlob(tx, workspace, sealedOriginal);
    if (sealedText) await insertSealedBlob(tx, workspace, sealedText);
    const rows = await tx<UploadRow[]>`
      insert into fb_upload (
        id, founder_id, name, ext, size_bytes, question_key, original_sha, text_sha, text_chars, readable
      ) values (
        ${id}, ${workspace}, ${name}, ${ext}, ${input.bytes.length}, ${input.questionKey},
        ${originalSha}, ${textSha}, ${textChars}, ${readable}
      )
      returning *
    `;
    return rows[0]!;
  });
  return { item: toUploadItem(row, bestGuessAi) };
}

export async function downloadUpload(
  store: PgBrainStore,
  workspace: string,
  id: string,
): Promise<{ name: string; bytes: Buffer }> {
  return store.scoped(workspace, async (tx) => {
    const rows = await tx<UploadRow[]>`
      select * from fb_upload where founder_id = ${workspace} and id = ${id}
    `;
    const row = rows[0];
    if (!row) throw new DomainError(404, "upload_missing", "That file was not found.");
    const bytes = await openFounderBlob(tx, workspace, row.original_sha);
    return { name: row.name, bytes };
  });
}

export async function deleteUpload(
  store: PgBrainStore,
  workspace: string,
  id: string,
): Promise<{ ok: true }> {
  await store.scoped(workspace, async (tx) => {
    const rows = await tx<UploadRow[]>`
      select * from fb_upload where founder_id = ${workspace} and id = ${id}
    `;
    const row = rows[0];
    if (!row) throw new DomainError(404, "upload_missing", "That file was not found.");
    await tx`delete from fb_upload where founder_id = ${workspace} and id = ${id}`;
    // A queued job that was pinned against a non-empty document corpus must
    // never run against fewer documents than it was priced and reserved
    // for — the run-time check in jobs.ts.tick() would catch this too, but
    // failing it now means the founder sees it immediately rather than after
    // the job sits queued. Any job whose corpus did not include a document at
    // all (uploads_hash is null or the empty-corpus hash) is unaffected.
    const jobSchema = await tx`select to_regclass('public.fb_ai_job') as present`;
    if (jobSchema[0]?.present) {
      const queued = await tx<{ id: string; reserved: string | number; budget_day: string }[]>`
        select id, reserved, budget_day from fb_ai_job
        where founder_id = ${workspace}
          and status = 'queued'
          and coalesce(uploads_hash, ${EMPTY_CORPUS_HASH}) != ${EMPTY_CORPUS_HASH}
        for update
      `;
      for (const job of queued) {
        for (const scope of ["global", "workspace:" + workspace]) {
          await tx`
            update fb_budget
            set reserved = greatest(0, reserved - ${job.reserved})
            where scope = ${scope} and day = ${job.budget_day}
          `;
        }
        await tx`
          update fb_ai_job
          set status = 'failed',
              error = 'Your files changed before generation. Generate again.'
          where founder_id = ${workspace} and id = ${job.id}
        `;
        await tx`update fb_job_dispatch set status = 'failed' where job_id = ${job.id}`;
      }
    }
    const shas = new Set([row.original_sha, ...(row.text_sha ? [row.text_sha] : [])]);
    for (const sha of shas) {
      try {
        await tx`
          delete from ge_blob
          where founder_id = ${workspace} and sha = ${sha}
            and not exists (
              select 1 from fb_upload
              where founder_id = ${workspace} and (original_sha = ${sha} or text_sha = ${sha})
            )
        `;
      } catch (err) {
        // Content-addressed shas make a true collision with some other feature's
        // blob astronomically unlikely, but if a foreign key from anywhere else
        // still points at this exact sha, leave the blob in place rather than fail
        // the delete outright.
        if ((err as { code?: string }).code !== "23503") throw err;
      }
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------
// Allocation: which uploaded documents a generation reads, and how much of each.
// ---------------------------------------------------------------------------------

export type AllocationCandidate = {
  readonly id: string;
  readonly name: string;
  /** '' for a no_text (unreadable) row; never read for those. */
  readonly text: string;
  readonly textSha: string | null;
  readonly readable: "text" | "no_text";
  readonly questionKey: string | null;
  readonly createdAt: string;
};

export type DocAllocationStatus = "full" | "partial" | "excluded" | "unreadable";

export interface DocAllocation {
  readonly id: string;
  readonly status: DocAllocationStatus;
  /** Characters of the founder's own document text actually included (never
   *  counting the "[truncated]" marker). Zero for excluded and unreadable. */
  readonly includedChars: number;
}

export interface AllocationResult {
  readonly allocations: readonly DocAllocation[];
  readonly documents: readonly GenerationDocument[];
  readonly usedBytes: number;
  readonly corpusHash: string;
}

const TRUNCATION_MARKER = "\n\n[truncated]";
/** Below this many spare bytes, a truncated excerpt would carry no real content,
 *  so the document is excluded outright rather than included as a token gesture. */
const MIN_PARTIAL_TEXT_BYTES = 64;

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * The TRUE number of bytes a `{"name":...,"text":...}` document entry adds to
 * the final pinned body — not an approximation.
 *
 * WHY DOUBLE ENCODING IS REAL, NOT A CORNER CASE. `documents` is embedded via
 * `canonicalize({...brain sections, documents})` into `userContent`, a plain
 * string. `userContent` then becomes one field of `pinned`, and
 * `canonicalize(pinned)` — being a string — encodes it with a second
 * `JSON.stringify`. So every character of a document's first-level JSON
 * representation (`{"name":"a.csv","text":"row1,\"x\"\nrow2"}`) gets escaped
 * AGAIN: a quote that cost 2 bytes at level one (`\"`) costs 4 at level two
 * (`\` and `"` each escape to 2 bytes: `\\` and `\"`); a newline that cost 2
 * bytes at level one (`\n`) costs 3 at level two. A CSV or any text heavy on
 * quotes/newlines compounds this fast — this is exactly the bug that made a
 * founder's generation throw "Shorten your Brain" for documents nowhere near
 * the nominal budget.
 *
 * HOW THIS IS MEASURED. `JSON.stringify` is called on the entry, then on the
 * result of that — literally reproducing the two real encoding passes rather
 * than hand-modeling escape rules — and 2 bytes (the second call's own
 * wrapping quotes, which do not actually appear in the final body: the
 * fragment is a substring of the already-quoted `userContent`, not
 * independently quoted) are subtracted. JSON string escaping is a fixed,
 * position-independent per-character mapping, so this per-entry cost sums
 * correctly across every document in the array; the only bytes this does not
 * capture are the comma joining entries, which `allocateDocumentContext`
 * accounts for itself.
 */
function doubleEncodedEntryCost(name: string, text: string): number {
  const firstLevel = JSON.stringify({ name, text });
  return utf8ByteLength(JSON.stringify(firstLevel)) - 2;
}

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte
 * character in half. Tries the exact byte boundary first, then backs off up to
 * three bytes — the longest a UTF-8 sequence can be — until the slice decodes
 * cleanly under a strict decoder. Never throws; a maxBytes of 0 or less is "".
 */
export function utf8SafeTruncate(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  for (let back = 0; back <= 3 && maxBytes - back >= 0; back++) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, maxBytes - back));
    } catch {
      continue;
    }
  }
  return "";
}

function corpusHashFor(
  allocations: readonly DocAllocation[],
  candidates: readonly AllocationCandidate[],
): string {
  const textShaById = new Map(candidates.map((c) => [c.id, c.textSha]));
  const included = allocations
    .filter((a) => a.status === "full" || a.status === "partial")
    .map((a) => ({ id: a.id, textSha: textShaById.get(a.id) ?? null, status: a.status }));
  return sha256Hex(Buffer.from(canonicalize(included), "utf8"));
}

/** The corpus hash of no uploaded documents at all. A legacy fb_ai_job/fb_artifact
 *  row with a null uploads_hash (written before this feature existed) is treated
 *  as equal to this, so it is not spuriously marked stale by an empty corpus. */
export const EMPTY_CORPUS_HASH = corpusHashFor([], []);

/**
 * Decides which uploaded documents a generation gets to read, and how much of
 * each, given `availableBytes` of room left under the pinned payload's hard cap
 * (jobs.ts reserves that room; this function only ever spends it, never grows
 * it). Pure and deterministic: the same candidates and the same budget always
 * produce the same allocation, which is what lets GET /api/uploads show a
 * founder exactly what a generation would send — see computeUploadContext,
 * which is the one place both call this.
 *
 * ORDER. Files linked to a question (`questionKey` set) sort first, then newest
 * first — ties broken by input order. Order is decided up front and never
 * revisited: a document that does not fit does not make room by letting a
 * later, smaller document jump the queue.
 *
 * BUDGET. Each document's cost is the TRUE number of bytes it adds to the
 * final, double-JSON-encoded pinned body — see doubleEncodedEntryCost's own
 * header for why a single JSON.stringify pass badly undercounts quote- and
 * newline-heavy text (a CSV, for instance). A joining comma (1 byte, never
 * escaped) is charged for every document after the first. Costs are
 * subtracted from a running total as documents are visited in order. The
 * first document that does not fit whole is truncated: rather than estimate
 * how much text fits, this binary-searches the UTF-8-safe excerpt length
 * against the same true cost function, so the truncated entry's real cost is
 * verified, not guessed. It is marked `partial`; every document after it is
 * `excluded`, even if it would technically have fit on its own — there is
 * only ever one partial document. A `no_text` (unreadable) document — most
 * often a scanned PDF with no text layer — never touches the budget and
 * carries no text.
 */
export function allocateDocumentContext(
  candidates: readonly AllocationCandidate[],
  availableBytes: number,
): AllocationResult {
  const ordered = [...candidates].sort((a, b) => {
    const linked = Number(b.questionKey !== null) - Number(a.questionKey !== null);
    if (linked !== 0) return linked;
    return b.createdAt.localeCompare(a.createdAt);
  });

  let remaining = Math.max(0, Math.floor(availableBytes));
  const budget = remaining;
  let partialUsed = false;
  let includedCount = 0;
  const allocations: DocAllocation[] = [];
  const documents: GenerationDocument[] = [];

  for (const doc of ordered) {
    if (doc.readable === "no_text") {
      allocations.push({ id: doc.id, status: "unreadable", includedChars: 0 });
      continue;
    }
    if (remaining <= 0 || partialUsed) {
      allocations.push({ id: doc.id, status: "excluded", includedChars: 0 });
      continue;
    }
    // A joining comma appears in the JSON array for every entry but the
    // first; it is a plain ASCII byte, so it costs exactly 1 at both
    // encoding levels regardless of what surrounds it.
    const commaCost = includedCount > 0 ? 1 : 0;
    const fullCost = commaCost + doubleEncodedEntryCost(doc.name, doc.text);
    if (fullCost <= remaining) {
      documents.push({ name: doc.name, text: doc.text });
      allocations.push({ id: doc.id, status: "full", includedChars: doc.text.length });
      remaining -= fullCost;
      includedCount += 1;
      continue;
    }
    const textBudget = remaining - commaCost;
    // Binary search the largest UTF-8-safe excerpt whose true cost (excerpt +
    // truncation marker, double-encoded) fits textBudget — verified against
    // the real cost function at every step, never estimated.
    const totalBytes = utf8ByteLength(doc.text);
    let lo = 0;
    let hi = totalBytes;
    let bestExcerpt = "";
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidateExcerpt = utf8SafeTruncate(doc.text, mid);
      const cost = doubleEncodedEntryCost(doc.name, candidateExcerpt + TRUNCATION_MARKER);
      if (cost <= textBudget) {
        bestExcerpt = candidateExcerpt;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (utf8ByteLength(bestExcerpt) < MIN_PARTIAL_TEXT_BYTES) {
      allocations.push({ id: doc.id, status: "excluded", includedChars: 0 });
      continue;
    }
    const finalCost = commaCost + doubleEncodedEntryCost(doc.name, bestExcerpt + TRUNCATION_MARKER);
    documents.push({ name: doc.name, text: bestExcerpt + TRUNCATION_MARKER });
    allocations.push({ id: doc.id, status: "partial", includedChars: bestExcerpt.length });
    remaining -= finalCost;
    partialUsed = true;
    includedCount += 1;
  }

  return {
    allocations,
    documents,
    usedBytes: budget - remaining,
    corpusHash: corpusHashFor(allocations, candidates),
  };
}

/**
 * Bytes left, under domain.ts's MAX_PINNED_BODY_BYTES, for uploaded document text
 * once the Brain's own content (identity/customer/offer/voice/context, at the
 * roles/rates this Config would actually run generation with) is accounted for,
 * minus a safety margin. Zero, never negative, when the Brain alone is already
 * at or past the cap — existing behavior for an oversized Brain is unchanged;
 * see jobs.ts's own final byte check on the completed pinned body.
 */
export function documentBudgetBytes(config: Config, brain: Brain): number {
  const payload = generationPayload(brain, []);
  const roles = buildOrchestrationFromConfig({
    thinker: config.AI_MODEL_THINKER,
    runner: config.AI_MODEL_RUNNER ?? config.AI_MODEL,
    verifier: config.AI_MODEL_VERIFIER,
  });
  const pinnedBase = {
    roles,
    system: payload.system,
    userContent: payload.messages[0]!.content,
    inputRate: config.AI_INPUT_USD_PER_MILLION ?? 0,
    outputRate: config.AI_OUTPUT_USD_PER_MILLION ?? 0,
  };
  const baseBytes = Buffer.byteLength(canonicalize(pinnedBase), "utf8");
  return Math.max(0, MAX_PINNED_BODY_BYTES - baseBytes - DOCUMENT_SAFETY_MARGIN_BYTES);
}

/**
 * Loads every upload for a workspace, decrypts the readable ones' text, and runs
 * allocateDocumentContext against `availableBytes`. The one place that does the
 * (necessarily impure — it decrypts blobs) work behind the pure allocation
 * function, so jobs.ts, GET /api/uploads and the artifact staleness check in
 * server.ts all see the same answer for the same inputs.
 */
export async function currentUploadAllocation(
  store: PgBrainStore,
  workspace: string,
  availableBytes: number,
): Promise<{ rows: UploadRow[]; allocation: AllocationResult }> {
  const { rows, candidates } = await store.scoped(workspace, async (tx) => {
    const rows = await tx<UploadRow[]>`
      select * from fb_upload where founder_id = ${workspace} order by created_at desc
    `;
    const candidates: AllocationCandidate[] = [];
    for (const row of rows) {
      const text =
        row.readable === "text" && row.text_sha
          ? (await openFounderBlob(tx, workspace, row.text_sha)).toString("utf8")
          : "";
      candidates.push({
        id: row.id,
        name: row.name,
        text,
        textSha: row.text_sha,
        readable: row.readable,
        questionKey: row.question_key,
        createdAt: iso(row.created_at),
      });
    }
    return { rows, candidates };
  });
  return { rows, allocation: allocateDocumentContext(candidates, availableBytes) };
}

/**
 * Everything a caller needs about a founder's uploads right now: the list with
 * each file's true `ai` status, the documents a generation would actually send,
 * and the budget numbers GET /api/uploads reports. Reads the current Brain
 * itself (via store.read), so it always reflects the live Brain, not a stale
 * snapshot from whichever job last ran.
 */
export async function computeUploadContext(
  config: Config,
  store: PgBrainStore,
  workspace: string,
): Promise<{
  items: UploadItem[];
  documents: readonly GenerationDocument[];
  budgetBytes: number;
  usedBytes: number;
  corpusHash: string;
}> {
  const state = await store.read(workspace);
  const budgetBytes = documentBudgetBytes(config, state.brain);
  const { rows, allocation } = await currentUploadAllocation(store, workspace, budgetBytes);
  const statusById = new Map(allocation.allocations.map((a) => [a.id, a.status]));
  const items = rows.map((row) => toUploadItem(row, statusById.get(row.id) ?? "excluded"));
  return {
    items,
    documents: allocation.documents,
    budgetBytes,
    usedBytes: allocation.usedBytes,
    corpusHash: allocation.corpusHash,
  };
}
