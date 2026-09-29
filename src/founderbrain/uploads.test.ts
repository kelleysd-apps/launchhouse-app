/**
 * src/founderbrain/uploads.test.ts
 *
 * Pure allocation tests always run. Everything that touches Postgres — type
 * allowlist, size/count caps, RLS isolation, download/delete, workspace
 * deletion, and artifact staleness — is behind FB_TEST_DATABASE_URL, same as
 * store.db.test.ts and gmail-isolation.test.ts.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import postgres from "postgres";

import {
  allocateDocumentContext,
  contentDispositionHeader,
  documentBudgetBytes,
  EMPTY_CORPUS_HASH,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOADS_PER_FOUNDER,
  MAX_UPLOAD_TOTAL_BYTES,
  migrateUploads,
  sanitizeUploadName,
  utf8SafeTruncate,
  type AllocationCandidate,
} from "./uploads.ts";
import {
  DOCUMENT_SAFETY_MARGIN_BYTES,
  DomainError,
  canonicalize,
  emptyBrain,
  generationPayload,
  MAX_PINNED_BODY_BYTES,
  type Brain,
} from "./domain.ts";
import { PgBrainStore } from "./store.ts";
import { BrainJobs, migrateJobs, type Provider } from "./jobs.ts";
import { buildApi } from "./server.ts";
import { migrateOpenRouterKeys, ensureOpenRouterKey } from "./openrouter-keys.ts";
import { OPENROUTER_LIFETIME_USD, openRouterKeyName } from "./openrouter-management.ts";
import type { OpenRouterManagement } from "./openrouter-management.ts";
import type { Config } from "./config.ts";
import { buildOrchestrationFromConfig } from "./orchestrate.ts";

// ---------------------------------------------------------------------------------
// Pure allocateDocumentContext / utf8SafeTruncate — no database, always run.
// ---------------------------------------------------------------------------------

function candidate(over: Partial<AllocationCandidate>): AllocationCandidate {
  return {
    id: randomUUID(),
    name: "doc.txt",
    text: "hello",
    textSha: "a".repeat(64),
    readable: "text",
    questionKey: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("allocateDocumentContext", () => {
  it("includes a small document in full when the budget has room", () => {
    const doc = candidate({ text: "Short document body." });
    const result = allocateDocumentContext([doc], 10_000);
    assert.deepEqual(result.allocations, [
      { id: doc.id, status: "full", includedChars: doc.text.length },
    ]);
    assert.deepEqual(result.documents, [{ name: doc.name, text: doc.text }]);
    assert.ok(result.usedBytes > 0 && result.usedBytes <= 10_000);
  });

  it("marks a no_text document unreadable without touching the budget", () => {
    const doc = candidate({ readable: "no_text", text: "", textSha: null });
    const result = allocateDocumentContext([doc], 10_000);
    assert.deepEqual(result.allocations, [{ id: doc.id, status: "unreadable", includedChars: 0 }]);
    assert.deepEqual(result.documents, []);
    assert.equal(result.usedBytes, 0);
  });

  it("truncates the first document that does not fit, and excludes everything after it", () => {
    const big = candidate({
      name: "big.txt",
      text: "x".repeat(500),
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const also = candidate({
      name: "also.txt",
      text: "y".repeat(500),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // Room for "big" to be truncated, but nothing left over for "also" after it.
    const result = allocateDocumentContext([big, also], 200);
    const byId = new Map(result.allocations.map((a) => [a.id, a]));
    assert.equal(byId.get(big.id)!.status, "partial");
    assert.equal(byId.get(also.id)!.status, "excluded");
    assert.equal(result.documents.length, 1);
    assert.ok(result.documents[0]!.text.endsWith("[truncated]"));
    assert.ok(result.usedBytes <= 200);
  });

  it("excludes a document outright when even a truncated excerpt would not fit", () => {
    const doc = candidate({ text: "x".repeat(500) });
    const result = allocateDocumentContext([doc], 10);
    assert.equal(result.allocations[0]!.status, "excluded");
    assert.equal(result.documents.length, 0);
  });

  it("never spends more than the available budget, across a mixed batch", () => {
    const docs = [
      candidate({ text: "a".repeat(50), createdAt: "2026-01-05T00:00:00.000Z" }),
      candidate({ text: "b".repeat(5000), createdAt: "2026-01-04T00:00:00.000Z" }),
      candidate({ text: "c".repeat(5000), createdAt: "2026-01-03T00:00:00.000Z" }),
      candidate({
        readable: "no_text",
        text: "",
        textSha: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      candidate({ text: "d".repeat(200), createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const budget = 3000;
    const result = allocateDocumentContext(docs, budget);
    assert.ok(result.usedBytes <= budget);
    const statuses = result.allocations.map((a) => a.status);
    assert.equal(statuses.filter((s) => s === "partial").length <= 1, true);
  });

  it("orders question-linked files first, then newest first", () => {
    const linkedButOld = candidate({
      name: "linked.txt",
      text: "linked content",
      questionKey: "customer_problem",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const newerUnlinked = candidate({
      name: "newer.txt",
      text: "z".repeat(400),
      questionKey: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // Budget only large enough for one document whole — the true cost (double
    // encoded, including the entry's own JSON-syntax quotes), not an estimate.
    const cost = allocateDocumentContext([linkedButOld], 10_000).usedBytes;
    const result = allocateDocumentContext([newerUnlinked, linkedButOld], cost);
    const byId = new Map(result.allocations.map((a) => [a.id, a]));
    assert.equal(byId.get(linkedButOld.id)!.status, "full");
    assert.equal(byId.get(newerUnlinked.id)!.status, "excluded");
  });

  it("produces a stable corpus hash for the same corpus, and a different one when it changes", () => {
    const doc = candidate({ text: "content" });
    const a = allocateDocumentContext([doc], 10_000);
    const b = allocateDocumentContext([doc], 10_000);
    assert.equal(a.corpusHash, b.corpusHash);
    const withMore = allocateDocumentContext([doc, candidate({ text: "more" })], 10_000);
    assert.notEqual(a.corpusHash, withMore.corpusHash);
    assert.equal(allocateDocumentContext([], 10_000).corpusHash, EMPTY_CORPUS_HASH);
  });

  it("never crosses the 32,000 byte pinned-payload cap, once callers apply the documented safety margin", () => {
    const docs = Array.from({ length: 20 }, (_unused, i) =>
      candidate({
        name: `doc-${i}.txt`,
        text: "z".repeat(5000),
        createdAt: new Date(i).toISOString(),
      }),
    );
    // This is exactly what jobs.ts/uploads.ts's documentBudgetBytes hands the
    // allocator in the worst case: the hard cap minus the safety margin. usedBytes
    // is allocateDocumentContext's own per-item JSON.stringify approximation; the
    // real, final encoding (this array, wrapped and with JSON-escaped control
    // characters in the truncation marker) is always a little larger, which is
    // exactly what that margin exists to absorb.
    const budget = MAX_PINNED_BODY_BYTES - DOCUMENT_SAFETY_MARGIN_BYTES;
    const result = allocateDocumentContext(docs, budget);
    assert.ok(result.usedBytes <= budget);
    const encoded = Buffer.byteLength(JSON.stringify(result.documents));
    assert.ok(encoded <= MAX_PINNED_BODY_BYTES, `encoded ${encoded} exceeded the hard cap`);
  });
});

// ---------------------------------------------------------------------------------
// Regression: documents are embedded via canonicalize({...brain, documents}) into
// userContent, which is itself a field of `pinned` — so canonicalize(pinned) runs
// JSON.stringify on userContent AGAIN. Every quote or newline inside a document's
// text gets escaped twice (a quote costs 4 bytes in the final body, not 2; a
// newline costs 3, not 2). A single-level JSON.stringify cost estimate badly
// undercounts this, so a CSV-like upload could allocate a "safe" excerpt that then
// blew the 32,000 byte cap once actually canonicalized — jobs.ts's
// input_too_large ("Shorten your Brain") firing purely because of an upload, never
// the Brain itself. This block runs the exact same three calls jobs.ts's enqueue()
// makes (documentBudgetBytes, allocateDocumentContext, generationPayload +
// canonicalize), with no database, so it exercises the real double-encoding path.
// ---------------------------------------------------------------------------------

const enqueueLikeConfig = {
  AI_MODEL: "anthropic/claude-sonnet-4",
  AI_INPUT_USD_PER_MILLION: 1,
  AI_OUTPUT_USD_PER_MILLION: 2,
} as unknown as Config;

/** Reproduces jobs.ts enqueue()'s pinned-body math exactly, without a database. */
function finalPinnedBody(
  config: Config,
  brain: Brain,
  candidates: readonly AllocationCandidate[],
): { bytes: number; allocation: ReturnType<typeof allocateDocumentContext> } {
  const roles = buildOrchestrationFromConfig({
    thinker: config.AI_MODEL_THINKER,
    runner: config.AI_MODEL_RUNNER ?? config.AI_MODEL,
    verifier: config.AI_MODEL_VERIFIER,
  });
  const available = documentBudgetBytes(config, brain);
  const allocation = allocateDocumentContext(candidates, available);
  const payload = generationPayload(brain, allocation.documents);
  const pinned = {
    roles,
    system: payload.system,
    userContent: payload.messages[0]!.content,
    inputRate: config.AI_INPUT_USD_PER_MILLION ?? 0,
    outputRate: config.AI_OUTPUT_USD_PER_MILLION ?? 0,
  };
  return { bytes: Buffer.byteLength(canonicalize(pinned), "utf8"), allocation };
}

describe("double-encoded pinned body stays under the 32,000 byte cap", () => {
  const brain = ((): Brain => {
    const b = emptyBrain();
    b.identity.name = "Ada";
    return b;
  })();

  it("a CSV-heavy document (the reported repro: 3,000 quoted, comma-separated rows)", () => {
    const lines = Array.from({ length: 3000 }, (_unused, i) => `"row ${i}","value"`);
    const doc = candidate({ name: "data.csv", text: lines.join("\n") });
    const { bytes, allocation } = finalPinnedBody(enqueueLikeConfig, brain, [doc]);
    assert.ok(bytes <= MAX_PINNED_BODY_BYTES, `final body was ${bytes} bytes`);
    assert.equal(allocation.allocations[0]!.status, "partial");
    // Whatever was actually included is exactly what a status of "partial" promised.
    assert.equal(allocation.documents.length, 1);
  });

  it("a document that is nothing but newlines", () => {
    const doc = candidate({ name: "lines.txt", text: "\n".repeat(40_000) });
    const { bytes, allocation } = finalPinnedBody(enqueueLikeConfig, brain, [doc]);
    assert.ok(bytes <= MAX_PINNED_BODY_BYTES, `final body was ${bytes} bytes`);
    assert.equal(allocation.allocations[0]!.status, "partial");
  });

  it("non-ASCII and emoji text, which must never be double-escaped like quotes/newlines are", () => {
    const doc = candidate({
      name: "notes.md",
      text: "Café résumé — caféño 🎉🚀 ".repeat(2000),
    });
    const { bytes, allocation } = finalPinnedBody(enqueueLikeConfig, brain, [doc]);
    assert.ok(bytes <= MAX_PINNED_BODY_BYTES, `final body was ${bytes} bytes`);
    assert.ok(["full", "partial"].includes(allocation.allocations[0]!.status));
  });

  it("several quote/newline-heavy documents together, ordered and costed independently", () => {
    const csv = (n: number) =>
      Array.from({ length: n }, (_unused, i) => `"item ${i}","${"x".repeat(20)}"`).join("\n");
    const docs = [
      candidate({ name: "a.csv", text: csv(500), createdAt: "2026-01-04T00:00:00.000Z" }),
      candidate({ name: "b.csv", text: csv(1500), createdAt: "2026-01-03T00:00:00.000Z" }),
      candidate({ name: "c.csv", text: csv(3000), createdAt: "2026-01-02T00:00:00.000Z" }),
      candidate({ name: "d.csv", text: csv(3000), createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const { bytes, allocation } = finalPinnedBody(enqueueLikeConfig, brain, docs);
    assert.ok(bytes <= MAX_PINNED_BODY_BYTES, `final body was ${bytes} bytes`);
    // Only one partial, ever, and nothing after it.
    const statuses = allocation.allocations.map((a) => a.status);
    const partialIndex = statuses.indexOf("partial");
    if (partialIndex !== -1) {
      assert.ok(statuses.slice(partialIndex + 1).every((s) => s === "excluded"));
    }
    // documents actually included == exactly the full+partial statuses, in the
    // same order — the same invariant GET /api/uploads relies on.
    const includedCount = statuses.filter((s) => s === "full" || s === "partial").length;
    assert.equal(allocation.documents.length, includedCount);
  });

  it("GET /api/uploads and the enqueue path agree, because they call the same function", () => {
    const doc = candidate({ name: "shared.csv", text: `"a","b"\n`.repeat(5000) });
    const available = documentBudgetBytes(enqueueLikeConfig, brain);
    const previewAllocation = allocateDocumentContext([doc], available);
    const { allocation: enqueueAllocation } = finalPinnedBody(enqueueLikeConfig, brain, [doc]);
    assert.deepEqual(previewAllocation.allocations, enqueueAllocation.allocations);
    assert.equal(previewAllocation.corpusHash, enqueueAllocation.corpusHash);
  });
});

describe("utf8SafeTruncate", () => {
  it("never splits a multi-byte character, and never produces a replacement character", () => {
    // Each 🎉 is 4 UTF-8 bytes; cut in the middle of the last one on purpose.
    const text = "abc🎉🎉🎉";
    const buf = Buffer.from(text, "utf8");
    for (let cut = 0; cut <= buf.length; cut++) {
      const out = utf8SafeTruncate(text, cut);
      assert.ok(!out.includes("�"), `cut=${cut} produced a replacement character`);
      assert.ok(Buffer.byteLength(out, "utf8") <= cut, `cut=${cut} exceeded the byte budget`);
    }
  });

  it("returns the whole string unchanged when it already fits", () => {
    assert.equal(utf8SafeTruncate("hello", 100), "hello");
  });

  it("returns empty string for a non-positive budget", () => {
    assert.equal(utf8SafeTruncate("hello", 0), "");
    assert.equal(utf8SafeTruncate("hello", -5), "");
  });
});

describe("sanitizeUploadName", () => {
  it("strips a path and control characters, and keeps the extension when truncating", () => {
    assert.equal(sanitizeUploadName("../../etc/passwd.txt"), "passwd.txt");
    assert.equal(sanitizeUploadName("weird\u0000name.txt"), "weirdname.txt");
    const long = "a".repeat(200) + ".pdf";
    const cleaned = sanitizeUploadName(long);
    assert.ok(cleaned.length <= 120);
    assert.ok(cleaned.endsWith(".pdf"));
  });
});

describe("contentDispositionHeader", () => {
  it("carries an ASCII fallback and a UTF-8 extended filename*", () => {
    const header = contentDispositionHeader('résumé "final".pdf');
    assert.match(header, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    assert.ok(!header.includes('""'));
  });
});

describe("documentBudgetBytes", () => {
  it("leaves room under the cap for an empty Brain, and less room as the Brain grows", () => {
    const config = {
      AI_MODEL: "anthropic/claude-sonnet-4",
      AI_INPUT_USD_PER_MILLION: 1,
      AI_OUTPUT_USD_PER_MILLION: 2,
    } as unknown as Config;
    const empty = documentBudgetBytes(config, emptyBrain());
    assert.ok(empty > 0 && empty < MAX_PINNED_BODY_BYTES);
    const grown = emptyBrain();
    grown.identity.goal = "x".repeat(2000);
    const afterGrowth = documentBudgetBytes(config, grown);
    assert.ok(afterGrowth < empty);
  });
});

// ---------------------------------------------------------------------------------
// Database-backed coverage.
// ---------------------------------------------------------------------------------

const url = process.env.FB_TEST_DATABASE_URL;
const migrationUrl = process.env.FB_TEST_MIGRATION_DATABASE_URL ?? url;
const enabled = Boolean(url);
const skip = enabled ? undefined : "Disposable database not configured";
const prefix = `uploads-test|${randomUUID()}`;

let store: PgBrainStore;
let jobs: BrainJobs;
let app: Awaited<ReturnType<typeof buildApi>>;
const tracked = new Map<string, string>();

let providerCalls = 0;
const provider: Provider = async (body) => {
  providerCalls += 1;
  if (body.system.includes("Verify"))
    return { text: "PASS", inputTokens: 5, outputTokens: 1, requestId: "t-verify" };
  return {
    text: "90 day plan\n\nSection content.",
    inputTokens: 20,
    outputTokens: 10,
    requestId: "t-run",
  };
};

const fakeManagement: OpenRouterManagement = {
  async createUserKey(email) {
    const hash = `hash-${randomUUID()}`;
    return {
      hash,
      key: `sk-or-v1-fixture-${hash}`,
      name: openRouterKeyName(email),
      limit: OPENROUTER_LIFETIME_USD,
      limitReset: null,
      expiresAt: new Date(Date.now() + 30 * 864e5).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  },
  async getKey(hash) {
    return {
      hash,
      name: "fixture",
      disabled: false,
      limit: OPENROUTER_LIFETIME_USD,
      limitRemaining: OPENROUTER_LIFETIME_USD,
      limitReset: null,
      expiresAt: new Date(Date.now() + 30 * 864e5).toISOString(),
      usage: 0,
    };
  },
  async deleteKey() {},
};

const config: Config = {
  NODE_ENV: "test",
  DATABASE_URL: url ?? "postgres://fb_runtime@127.0.0.1:1/postgres",
  PORT: 8080,
  APP_ORIGIN: "https://founderbrain.example.test",
  ORIGIN_SECRET: "test-origin-secret-not-a-live-secret-0000",
  HEXCLAVE_PROJECT_ID: "7f2d1c3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
  HEXCLAVE_API_URL: "https://api.hexclave.com",
  FOUNDERBRAIN_LOCAL_DEMO: "false",
  AI_ENABLED: "true",
  ROUTINES_ENABLED: "false",
  OPENROUTER_MANAGEMENT_KEY: "fixture-management-key-not-live",
  AI_MODEL: "anthropic/claude-sonnet-4",
  AI_MODEL_RUNNER: "anthropic/claude-sonnet-4",
  AI_MODEL_THINKER: "anthropic/claude-haiku-4.5",
  AI_MODEL_VERIFIER: "anthropic/claude-haiku-4.5",
  AI_INPUT_USD_PER_MILLION: 1,
  AI_OUTPUT_USD_PER_MILLION: 2,
  AI_WORKSPACE_DAILY_MICROUSD: 1_000_000_000,
  AI_GLOBAL_DAILY_MICROUSD: 1_000_000_000,
};

function headersFor(user: string): Record<string, string> {
  return {
    "x-test-user": user,
    "x-founderbrain-origin": config.ORIGIN_SECRET!,
    origin: config.APP_ORIGIN,
  };
}

async function workspaceFor(label: string): Promise<string> {
  const subject = `${prefix}|${label}`;
  const id = await store.ensureWorkspace(subject);
  tracked.set(subject, id);
  await ensureOpenRouterKey(store, config, id, `${label}@example.test`, fakeManagement);
  return id;
}

/** jobs.enqueue only requires a non-empty name or venture (see its "named" check) —
 *  not full section readiness — so this deliberately leaves every section
 *  unapproved rather than tripping validateBrain's incomplete_section check.
 *  A channel is selected too: jobs.enqueue also refuses to start with none
 *  selected (channels_required), and these tests are about the document
 *  budget/allocation path, not channel selection. */
function namedBrain(): Brain {
  const b = emptyBrain();
  b.identity.name = "Ada";
  b.identity.venture = "Northwind";
  b.context.contentChannels = "Instagram";
  return b;
}

/** Every text field pushed to its 2,000 char schema max, with no uploads involved
 *  at all — enough on its own to blow the 32,000 byte pinned-payload cap, so
 *  jobs.enqueue's input_too_large check still has something real to catch. */
function oversizedBrain(): Brain {
  const b = namedBrain();
  const long = "x".repeat(2000);
  b.identity.goal = long;
  b.identity.modelNote = long;
  b.identity.team = long;
  b.customer.segment = long;
  b.customer.problem = long;
  b.customer.outcome = long;
  b.customer.workaround = long;
  b.customer.evidence = long;
  b.customer.buyer = long;
  b.customer.trigger = long;
  b.customer.bestFit = long;
  b.customer.attention = long;
  b.customer.adjacent = long;
  b.offer.description = long;
  b.offer.delivery = long;
  b.offer.outcome = long;
  b.offer.cta = long;
  b.offer.price = long;
  b.offer.why = long;
  b.offer.proof = long;
  b.voice.tone = long;
  b.voice.boundaries = long;
  b.voice.sample = long;
  b.context.channelsActive = long;
  b.context.channelsDormant = long;
  b.context.customersNow = long;
  b.context.avgMonthlyValue = long;
  b.context.target90 = long;
  b.context.sourceMaterial = long;
  return b;
}

async function uploadFile(
  user: string,
  filename: string,
  bytes: Buffer,
  questionKey?: string,
): Promise<Awaited<ReturnType<typeof app.inject>>> {
  const qs = new URLSearchParams({ filename });
  if (questionKey) qs.set("questionKey", questionKey);
  return app.inject({
    method: "POST",
    url: `/api/uploads?${qs.toString()}`,
    headers: { ...headersFor(user), "content-type": "application/octet-stream" },
    payload: bytes,
  });
}

before(async () => {
  if (!enabled) return;
  process.env.GE_MASTER_KEY ??= randomBytes(32).toString("base64");
  await migrateJobs(migrationUrl!);
  await migrateOpenRouterKeys(migrationUrl!);
  await migrateUploads(migrationUrl!);
  store = new PgBrainStore(url!);
  jobs = new BrainJobs(store, config, provider);
  app = await buildApi(config, {
    store,
    jobs,
    openRouterManagement: fakeManagement,
    authenticate: async (req) => {
      const user = req.headers["x-test-user"];
      if (typeof user !== "string") throw new DomainError(401, "sign_in_required", "Sign in.");
      return { subject: `${prefix}|${user}`, email: `${user}@example.test` };
    },
  });
});

after(async () => {
  if (!enabled) return;
  for (const [subject, id] of tracked) await store.deleteWorkspace(subject, id).catch(() => {});
  await app?.close();
  await jobs?.close();
  await store?.close();
});

describe("upload type allowlist, size caps, and refusal", { skip }, () => {
  it("rejects an extension outside the allowlist with 415, storing nothing", async () => {
    const id = await workspaceFor("types");
    const res = await uploadFile("types", "malware.exe", Buffer.from("MZ..."));
    assert.equal(res.statusCode, 415);
    assert.equal(res.json().error, "upload_type");
    const rows = await store.scoped(
      id,
      (tx) => tx`select count(*)::int as n from fb_upload where founder_id=${id}`,
    );
    assert.equal(rows[0]!.n, 0);
  });

  it("accepts every extension in the allowlist", async () => {
    await workspaceFor("accept");
    const cases: Array<[string, Buffer]> = [
      ["notes.txt", Buffer.from("plain text")],
      ["notes.md", Buffer.from("# heading")],
      ["notes.markdown", Buffer.from("# heading")],
      ["data.csv", Buffer.from("a,b\n1,2")],
    ];
    for (const [name, bytes] of cases) {
      const res = await uploadFile("accept", name, bytes);
      assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
      assert.equal(res.json().item.readable, "text");
    }
  });

  it("refuses a file whose bytes do not match its claimed document type, storing nothing", async () => {
    const id = await workspaceFor("corrupt");
    const res = await uploadFile("corrupt", "fake.docx", Buffer.from("not actually a zip"));
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, "upload_unreadable");
    const rows = await store.scoped(
      id,
      (tx) => tx`select count(*)::int as n from fb_upload where founder_id=${id}`,
    );
    assert.equal(rows[0]!.n, 0);
  });

  it("rejects a file over the 10 MB per-file cap with 422, storing nothing", async () => {
    const id = await workspaceFor("toolarge");
    const bytes = Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 100, 0x61);
    const res = await uploadFile("toolarge", "big.txt", bytes);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, "upload_too_large");
    const rows = await store.scoped(
      id,
      (tx) => tx`select count(*)::int as n from fb_upload where founder_id=${id}`,
    );
    assert.equal(rows[0]!.n, 0);
  });

  it("rejects a new file once the founder has 50 files", async () => {
    const id = await workspaceFor("count-cap");
    const seeded = await uploadFile("count-cap", "seed.txt", Buffer.from("seed"));
    assert.equal(seeded.statusCode, 200, seeded.body);
    const original = await store.scoped(
      id,
      (tx) => tx`select original_sha from fb_upload where founder_id=${id} limit 1`,
    );
    const sha = original[0]!.original_sha as string;
    await store.scoped(id, async (tx) => {
      for (let i = 0; i < MAX_UPLOADS_PER_FOUNDER - 1; i++) {
        await tx`
          insert into fb_upload (id, founder_id, name, ext, size_bytes, question_key, original_sha, text_sha, text_chars, readable)
          values (${randomUUID()}, ${id}, ${"seed-" + i + ".txt"}, '.txt', 4, null, ${sha}, null, 0, 'no_text')
        `;
      }
    });
    const count = await store.scoped(
      id,
      (tx) => tx`select count(*)::int as n from fb_upload where founder_id=${id}`,
    );
    assert.equal(count[0]!.n, MAX_UPLOADS_PER_FOUNDER);
    const res = await uploadFile("count-cap", "one-too-many.txt", Buffer.from("x"));
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, "upload_limit");
  });

  it("rejects a new file once the founder's total bytes would exceed 100 MB", async () => {
    const id = await workspaceFor("total-cap");
    const seeded = await uploadFile("total-cap", "seed.txt", Buffer.from("seed"));
    assert.equal(seeded.statusCode, 200, seeded.body);
    const original = await store.scoped(
      id,
      (tx) => tx`select original_sha from fb_upload where founder_id=${id} limit 1`,
    );
    const sha = original[0]!.original_sha as string;
    const fakeSizeBytes = MAX_UPLOAD_TOTAL_BYTES - MAX_UPLOAD_FILE_BYTES / 2;
    await store.scoped(id, async (tx) => {
      await tx`
        insert into fb_upload (id, founder_id, name, ext, size_bytes, question_key, original_sha, text_sha, text_chars, readable)
        values (${randomUUID()}, ${id}, 'huge.txt', '.txt', ${fakeSizeBytes}, null, ${sha}, null, 0, 'no_text')
      `;
    });
    const bytes = Buffer.alloc(MAX_UPLOAD_FILE_BYTES, 0x62);
    const res = await uploadFile("total-cap", "another-big-one.txt", bytes);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, "upload_total_limit");
  });
});

describe("download and delete", { skip }, () => {
  it("download returns exactly the original bytes", async () => {
    await workspaceFor("dl");
    const original = Buffer.from("The quick brown fox jumps over the lazy dog.\néèê");
    const created = await uploadFile("dl", "fox.txt", original);
    assert.equal(created.statusCode, 200, created.body);
    const id = created.json().item.id as string;
    const downloaded = await app.inject({
      method: "GET",
      url: `/api/uploads/${id}/download`,
      headers: headersFor("dl"),
    });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.headers["content-type"], "application/octet-stream");
    assert.match(
      String(downloaded.headers["content-disposition"]),
      /^attachment; filename="fox.txt"/,
    );
    assert.ok(Buffer.from(downloaded.rawPayload).equals(original));
  });

  it("delete removes the row and its blobs, leaving no orphaned ge_blob rows", async () => {
    const id = await workspaceFor("del");
    const created = await uploadFile("del", "delete-me.txt", Buffer.from("content to delete"));
    assert.equal(created.statusCode, 200, created.body);
    const uploadId = created.json().item.id as string;
    const before = await store.scoped(
      id,
      (tx) => tx`select original_sha, text_sha from fb_upload where id=${uploadId}`,
    );
    const { original_sha: originalSha, text_sha: textSha } = before[0]!;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/uploads/${uploadId}`,
      headers: headersFor("del"),
    });
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(deleted.json(), { ok: true });

    const rows = await store.scoped(
      id,
      (tx) => tx`select count(*)::int as n from fb_upload where id=${uploadId}`,
    );
    assert.equal(rows[0]!.n, 0);
    const blobs = await store.scoped(
      id,
      (tx) =>
        tx`select sha from ge_blob where founder_id=${id} and sha in ${tx([originalSha, textSha].filter(Boolean))}`,
    );
    assert.equal(blobs.length, 0);
  });
});

describe("row level security between two founders", { skip }, () => {
  it("scopes fb_upload rows so neither founder can see or reach across into the other's", async () => {
    const idA = await workspaceFor("rls-a");
    const idB = await workspaceFor("rls-b");
    const uploadA = await uploadFile("rls-a", "a-only.txt", Buffer.from("belongs to a"));
    assert.equal(uploadA.statusCode, 200, uploadA.body);
    const aId = uploadA.json().item.id as string;

    const listB = await app.inject({
      method: "GET",
      url: "/api/uploads",
      headers: headersFor("rls-b"),
    });
    assert.equal(listB.statusCode, 200);
    assert.deepEqual(
      listB.json().items.map((i: { id: string }) => i.id),
      [],
    );

    const crossDownload = await app.inject({
      method: "GET",
      url: `/api/uploads/${aId}/download`,
      headers: headersFor("rls-b"),
    });
    assert.equal(crossDownload.statusCode, 404);
    assert.equal(crossDownload.json().error, "upload_missing");

    const crossDelete = await app.inject({
      method: "DELETE",
      url: `/api/uploads/${aId}`,
      headers: headersFor("rls-b"),
    });
    assert.equal(crossDelete.statusCode, 404);

    const admin = postgres(migrationUrl!, { max: 1, onnotice: () => {} });
    try {
      await admin`set role fb_runtime`;
      const asA = await admin.begin(async (tx) => {
        await tx`select set_config('app.founder_id', ${idA}, true)`;
        return tx`select founder_id from fb_upload`;
      });
      assert.deepEqual(
        asA.map((r) => r.founder_id),
        [idA],
      );
      const asB = await admin.begin(async (tx) => {
        await tx`select set_config('app.founder_id', ${idB}, true)`;
        return tx`select founder_id from fb_upload`;
      });
      assert.deepEqual(
        asB.map((r) => r.founder_id),
        [],
      );
    } finally {
      await admin`reset role`.catch(() => {});
      await admin.end();
    }
  });
});

describe("workspace deletion", { skip }, () => {
  it("removes every upload row for a deleted workspace", async () => {
    const subject = `${prefix}|wipe`;
    const id = await store.ensureWorkspace(subject);
    tracked.set(subject, id);
    await ensureOpenRouterKey(store, config, id, "wipe@example.test", fakeManagement);
    const created = await uploadFile("wipe", "before-delete.txt", Buffer.from("gone soon"));
    assert.equal(created.statusCode, 200, created.body);

    await store.deleteWorkspace(subject, id);
    tracked.delete(subject);

    const admin = postgres(migrationUrl!, { max: 1, onnotice: () => {} });
    try {
      await admin`set role fb_runtime`;
      const rows = await admin.begin(async (tx) => {
        await tx`select set_config('app.founder_id', ${id}, true)`;
        return tx`select count(*)::int as n from fb_upload`;
      });
      assert.equal(rows[0]!.n, 0);
    } finally {
      await admin`reset role`.catch(() => {});
      await admin.end();
    }
  });
});

describe("uploads and artifact staleness", { skip }, () => {
  it("still rejects input_too_large when the Brain alone is too big, with no uploads involved", async () => {
    const id = await workspaceFor("oversized-brain");
    await store.commit(id, oversizedBrain(), 0, "oversized-brain-source");
    await assert.rejects(jobs.enqueue(id, 1, "oversized-brain-job-key"), {
      code: "input_too_large",
    });
    // The defense-in-depth fallback in jobs.ts only ever drops documents, never
    // Brain content — confirm no job was left behind for this workspace either.
    const rows = await store.scoped(
      id,
      (tx) => tx`select count(*)::int as n from fb_ai_job where founder_id=${id}`,
    );
    assert.equal(rows[0]!.n, 0);
  });

  it("adding an upload after generation marks the artifact stale, without touching the Brain", async () => {
    const id = await workspaceFor("stale-upload");
    await store.commit(id, namedBrain(), 0, "stale-upload-source");
    const job = await jobs.enqueue(id, 1, "stale-upload-job-key");
    await jobs.tick(id);
    const read = await jobs.read(id, job.id);
    assert.equal(read.status, "completed", JSON.stringify(read));

    const before = await app.inject({
      method: "GET",
      url: "/api/artifact",
      headers: headersFor("stale-upload"),
    });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().stale, false);

    const uploaded = await uploadFile(
      "stale-upload",
      "context.txt",
      Buffer.from("Extra founder context."),
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);

    const after = await app.inject({
      method: "GET",
      url: "/api/artifact",
      headers: headersFor("stale-upload"),
    });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().stale, true);
  });

  it("artifact accept rejects stale_proposal when the upload corpus changed, even though the Brain did not", async () => {
    const id = await workspaceFor("accept-uploads-stale");
    await store.commit(id, namedBrain(), 0, "accept-uploads-stale-source");
    const uploaded = await uploadFile(
      "accept-uploads-stale",
      "ctx.txt",
      Buffer.from("Some context for the plan."),
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const uploadId = uploaded.json().item.id as string;

    const job = await jobs.enqueue(id, 1, "accept-uploads-stale-job-key");
    await jobs.tick(id);
    const read = await jobs.read(id, job.id);
    assert.equal(read.status, "completed", JSON.stringify(read));
    const artifact = read.artifact!;
    assert.notEqual(artifact.uploadsHash, null);

    // Remove the upload after generation but before accept — the Brain's own
    // version is untouched, so only the uploads_hash comparison can catch this.
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/uploads/${uploadId}`,
      headers: headersFor("accept-uploads-stale"),
    });
    assert.equal(deleted.statusCode, 200, deleted.body);

    await assert.rejects(
      jobs.accept(id, artifact.id, artifact.text, 1, "accept-uploads-stale-accept-key"),
      { code: "stale_proposal" },
    );
  });

  it("GET /api/uploads reports the same ai status the job would use, and stays under budget", async () => {
    const id = await workspaceFor("preview");
    await store.commit(id, namedBrain(), 0, "preview-source");
    const uploaded = await uploadFile(
      "preview",
      "readable.txt",
      Buffer.from("Some useful context."),
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    assert.equal(uploaded.json().item.ai, "full");

    const list = await app.inject({
      method: "GET",
      url: "/api/uploads",
      headers: headersFor("preview"),
    });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].ai, "full");
    assert.ok(typeof body.ai.budgetBytes === "number");
    assert.ok(typeof body.ai.usedBytes === "number");
    assert.ok(body.ai.usedBytes <= body.ai.budgetBytes);
  });
});

describe("a deleted upload never reaches a queued or running generation", { skip }, () => {
  it("DELETE /api/uploads/:id immediately fails a queued job pinned against that corpus, releasing its budget reservation", async () => {
    const id = await workspaceFor("delete-fails-queued");
    await store.commit(id, namedBrain(), 0, "delete-fails-queued-source");
    const uploaded = await uploadFile(
      "delete-fails-queued",
      "ctx.txt",
      Buffer.from("Some context for the plan."),
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const uploadId = uploaded.json().item.id as string;

    const job = await jobs.enqueue(id, 1, "delete-fails-queued-job-key");
    const before = await store.scoped(
      id,
      (tx) =>
        tx`select uploads_hash, reserved, budget_day, status from fb_ai_job where id=${job.id}`,
    );
    assert.notEqual(before[0]!.uploads_hash, null);
    assert.equal(before[0]!.status, "queued");
    const reserved = Number(before[0]!.reserved);
    const budgetDay = before[0]!.budget_day as string;
    const scope = "workspace:" + id;
    const budgetBefore = await store.scoped(
      id,
      (tx) => tx`select reserved from fb_budget where scope=${scope} and day=${budgetDay}`,
    );

    const providerCallsBefore = providerCalls;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/uploads/${uploadId}`,
      headers: headersFor("delete-fails-queued"),
    });
    assert.equal(deleted.statusCode, 200, deleted.body);

    const after = await store.scoped(
      id,
      (tx) => tx`select status, error from fb_ai_job where id=${job.id}`,
    );
    assert.equal(after[0]!.status, "failed");
    assert.equal(after[0]!.error, "Your files changed before generation. Generate again.");

    const budgetAfter = await store.scoped(
      id,
      (tx) => tx`select reserved from fb_budget where scope=${scope} and day=${budgetDay}`,
    );
    assert.equal(
      Number(budgetAfter[0]!.reserved),
      Math.max(0, Number(budgetBefore[0]!.reserved) - reserved),
    );

    // The job is already failed (not queued), so tick() has nothing to run —
    // confirm it stays that way and the provider is never reached.
    await jobs.tick(id);
    assert.equal(providerCalls, providerCallsBefore, "provider must never be called");
  });

  it("defense in depth: jobs.tick() itself refuses a job whose upload corpus changed, even if nothing already failed it", async () => {
    const id = await workspaceFor("tick-defense-in-depth");
    await store.commit(id, namedBrain(), 0, "tick-defense-in-depth-source");
    const uploaded = await uploadFile(
      "tick-defense-in-depth",
      "ctx.txt",
      Buffer.from("Some context for the plan."),
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const uploadId = uploaded.json().item.id as string;
    const job = await jobs.enqueue(id, 1, "tick-defense-in-depth-job-key");

    // Bypass the DELETE route's own cascade with a raw delete — simulating an
    // out-of-band removal — to prove tick() itself, independently, still
    // refuses to run a job whose corpus no longer matches what it was pinned
    // against.
    await store.scoped(
      id,
      (tx) => tx`delete from fb_upload where founder_id=${id} and id=${uploadId}`,
    );

    const providerCallsBefore = providerCalls;
    await jobs.tick(id);
    assert.equal(providerCalls, providerCallsBefore, "provider must never be called");
    const read = await jobs.read(id, job.id);
    assert.equal(read.status, "failed");
    assert.equal(read.error, "Your files changed before generation. Generate again.");
  });
});

describe("concurrent uploads at the count cap", { skip }, () => {
  it("N parallel uploads at the cap: exactly one succeeds", async () => {
    const id = await workspaceFor("concurrency-cap");
    const seeded = await uploadFile("concurrency-cap", "seed.txt", Buffer.from("seed"));
    assert.equal(seeded.statusCode, 200, seeded.body);
    const original = await store.scoped(
      id,
      (tx) => tx`select original_sha from fb_upload where founder_id=${id} limit 1`,
    );
    const sha = original[0]!.original_sha as string;
    await store.scoped(id, async (tx) => {
      for (let i = 0; i < MAX_UPLOADS_PER_FOUNDER - 2; i++) {
        await tx`
          insert into fb_upload (id, founder_id, name, ext, size_bytes, question_key, original_sha, text_sha, text_chars, readable)
          values (${randomUUID()}, ${id}, ${"seed-" + i + ".txt"}, '.txt', 4, null, ${sha}, null, 0, 'no_text')
        `;
      }
    });
    const countBefore = await store.scoped(
      id,
      (tx) => tx`select count(*)::int as n from fb_upload where founder_id=${id}`,
    );
    assert.equal(countBefore[0]!.n, MAX_UPLOADS_PER_FOUNDER - 1);

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        uploadFile("concurrency-cap", `race-${i}.txt`, Buffer.from(`race ${i}`)),
      ),
    );
    const succeeded = results.filter((r) => r.statusCode === 200);
    const rejected = results.filter((r) => r.statusCode === 422);
    assert.equal(
      succeeded.length,
      1,
      `expected exactly one success, got statuses ${JSON.stringify(results.map((r) => r.statusCode))}`,
    );
    assert.equal(rejected.length, N - 1);
    for (const r of rejected) assert.equal(r.json().error, "upload_limit");

    const countAfter = await store.scoped(
      id,
      (tx) => tx`select count(*)::int as n from fb_upload where founder_id=${id}`,
    );
    assert.equal(countAfter[0]!.n, MAX_UPLOADS_PER_FOUNDER);
  });
});

describe("/api/config advertises uploads", { skip }, () => {
  it("always reports uploadsEnabled: true", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/config",
      headers: headersFor("config-check"),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().uploadsEnabled, true);
  });
});
