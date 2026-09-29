/**
 * src/founderbrain/server.ts
 *
 * WHAT THIS IS. The FounderBrain Fastify API: health, config, Brain CRUD,
 * export, generation jobs, and artifact accept. Identity comes from auth.ts;
 * persistence from store.ts; the money path from jobs.ts.
 *
 * WHY IT EXISTS. One origin-secret-guarded surface for the edge Worker. Local
 * demo can serve the built web assets; production never uses the fb_worker DB
 * role here.
 */
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
import { z } from "zod";
import { createAuthenticator, constantEqual, type Authenticate } from "./auth.ts";
import { DomainError, exportMarkdown, readiness, validateBrain } from "./domain.ts";
import type { Config } from "./config.ts";
import { PgBrainStore } from "./store.ts";
import { BrainJobs } from "./jobs.ts";
import { createFounderBrainLogger, logJobEvent, subjectLogHash } from "./logging.ts";
import {
  API_IP_LIMIT,
  API_SUBJECT_MUTATION_LIMIT,
  MUTATION_PATHS,
  SlidingWindowLimiter,
  mutationKey,
} from "./rate-limit.ts";
import { ensureOpenRouterKey, revokeOpenRouterKey } from "./openrouter-keys.ts";
import {
  getRoutineSettings,
  listRoutineDrafts,
  setRoutineDraftStatus,
  updateRoutineSettings,
} from "./routines.ts";
import type { OpenRouterManagement } from "./openrouter-management.ts";
import { usageResponse, usageTotals } from "./usage.ts";
import { readOrientation, writeOrientation } from "./orientation.ts";
import {
  completeOauthConnection,
  connectionStatus,
  crmOAuthConfigured,
  disconnectConnection,
  hasConnectionUnlocked,
  startOauthConnection,
  withCrmOperationLock,
} from "./crm-oauth.ts";
import { importSite } from "./site-import.ts";
import { transcribeVoice } from "./voice.ts";
import {
  addVoiceSample,
  deleteVoiceSample,
  listVoiceSamples,
  MIN_VOICE_SAMPLES,
} from "./voice-samples.ts";
import {
  brainReadyForPush,
  defaultFirstPack,
  loadValueCatalog,
  pushGhlValues,
} from "./ghl-push.ts";
import { getGhlBookingLinks, putGhlBookingLink } from "./ghl-booking-links.ts";
import { revisePieces } from "./content-revise.ts";
import { hashArtifactText } from "./jobs.ts";
import {
  duplicatePieceNumbers,
  serializeContentSection,
  splitContentSection,
  replaceContentSection,
} from "../founderbrain-shared/saturday-work.ts";
import {
  UPLOAD_TYPES,
  assignMedia,
  completeUpload,
  createUpload as createMediaUpload,
  deleteMedia,
  listMedia,
  r2FromConfig,
} from "./media.ts";
import {
  connectHiggsfield,
  disconnectHiggsfield,
  estimateMedia,
  generateMedia,
  higgsfieldStatus,
  refreshMedia,
} from "./higgsfield.ts";
import {
  EMPTY_CORPUS_HASH,
  MAX_UPLOAD_FILE_BYTES,
  computeUploadContext,
  contentDispositionHeader,
  createUpload,
  currentUploadAllocation,
  deleteUpload,
  documentBudgetBytes,
  downloadUpload,
} from "./uploads.ts";

import {
  getGmailStatus,
  startGmailOAuth,
  completeGmailOAuth,
  disconnectGmail,
  listGmailSent,
  analyzeGmailVoice,
  createGmailDraft,
  listGmailDrafts,
  updateGmailDraft,
  saveGmailDraft,
  sendGmailDraft,
  updateGmailSettings,
} from "./gmail.ts";

const key = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new DomainError(422, "invalid_request", "Check the request fields and try again.");
  return r.data;
}

function clientIp(req: FastifyRequest): string {
  // trustProxy is false on purpose; the Worker is the only intended client. Prefer the
  // edge-forwarded connecting IP only when present as a single token; otherwise socket.
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && /^[0-9a-fA-F:.]+$/.test(cf)) return cf;
  return req.socket.remoteAddress ?? "unknown";
}

function tooMany(reply: FastifyReply, retryAfterSec: number) {
  reply.header("Retry-After", String(retryAfterSec));
  throw new DomainError(429, "rate_limited", "Too many requests. Wait a moment and try again.");
}

export async function buildApi(
  config: Config,
  options: {
    store?: PgBrainStore;
    jobs?: BrainJobs;
    authenticate?: Authenticate;
    serveWeb?: boolean;
    logger?: boolean;
    openRouterManagement?: OpenRouterManagement;
  } = {},
) {
  const ownsStore = options.store === undefined;
  const ownsJobs = options.jobs === undefined;
  const store =
    options.store ?? new PgBrainStore(config.DATABASE_URL, config.NODE_ENV === "production");
  if (config.NODE_ENV === "production") {
    const role = await store.scoped(
      "00000000000000000000000000",
      (tx) => tx`select current_user as role`,
    );
    if (role[0]?.role === "fb_worker")
      throw new Error("The API cannot use the cross-workspace worker database role.");
  }
  const enableLogger = options.logger ?? options.store === undefined;
  const log = createFounderBrainLogger("api", enableLogger ? "info" : "silent");
  const jobs =
    options.jobs ?? new BrainJobs(store, config, undefined, (event) => logJobEvent(log, event));
  const authenticate = options.authenticate ?? createAuthenticator(config);
  const app = Fastify({
    loggerInstance: enableLogger ? log : undefined,
    bodyLimit: 128 * 1024,
    trustProxy: false,
    requestTimeout: 20000,
    genReqId: (req) => {
      const inbound = req.headers["x-request-id"];
      return typeof inbound === "string" && inbound.length > 0 && inbound.length < 120
        ? inbound
        : `api-${Date.now().toString(16)}`;
    },
  });
  // In-memory single-instance limits (#19). Not shared across replicas.
  const ipLimiter = new SlidingWindowLimiter(API_IP_LIMIT);
  const subjectLimiter = new SlidingWindowLimiter(API_SUBJECT_MUTATION_LIMIT);
  const contexts = new WeakMap<
    FastifyRequest,
    { subject: string; email: string; workspace: string }
  >();
  const started = new WeakMap<FastifyRequest, number>();

  app.addHook("onRequest", async (req, reply) => {
    started.set(req, Date.now());
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    if (req.headers["x-request-id"])
      reply.header("X-Request-Id", String(req.headers["x-request-id"]));
    if (!req.url.startsWith("/api/")) return;

    const ip = clientIp(req);
    const ipResult = ipLimiter.take(`ip:${ip}`);
    if (!ipResult.allowed) tooMany(reply, ipResult.retryAfterSec);

    if (config.FOUNDERBRAIN_LOCAL_DEMO !== "true") {
      const supplied = req.headers["x-founderbrain-origin"];
      if (
        typeof supplied !== "string" ||
        !config.ORIGIN_SECRET ||
        !constantEqual(supplied, config.ORIGIN_SECRET)
      )
        throw new DomainError(
          403,
          "origin_denied",
          "Use the application URL to access this service.",
        );
    }
    if (req.headers.origin && req.headers.origin !== config.APP_ORIGIN)
      throw new DomainError(403, "origin_denied", "This origin is not permitted.");
    if (req.url.split("?")[0] === "/api/config") return;
    const identity = await authenticate(req);
    const workspace = await store.ensureWorkspace(identity.subject);
    contexts.set(req, { subject: identity.subject, email: identity.email, workspace });
    // Provision per-user OpenRouter key on first authenticated request (signup path).
    if (config.OPENROUTER_MANAGEMENT_KEY || options.openRouterManagement) {
      try {
        await ensureOpenRouterKey(
          store,
          config,
          workspace,
          identity.email,
          options.openRouterManagement,
        );
      } catch {
        // Soft-fail provisioning so Brain edit/export still work if OpenRouter is down.
        // A revoked key stays blocked for AI actions (keyIsUsable at spend time),
        // but it must not brick the whole app: the preHandler used to rethrow
        // openrouter_key_revoked and every API call for the account 403'd.
        log.warn(
          { errorClass: "openrouter_provision_deferred" },
          "OpenRouter key provisioning deferred.",
        );
      }
    }

    const path = req.url.split("?")[0] ?? req.url;
    const mut = mutationKey(req.method, path);
    if (MUTATION_PATHS.has(mut)) {
      const subjectResult = subjectLimiter.take(`sub:${identity.subject}:${mut}`);
      if (!subjectResult.allowed) tooMany(reply, subjectResult.retryAfterSec);
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    if (!req.url.startsWith("/api/") && !req.url.startsWith("/health/")) return;
    const ctx = contexts.get(req);
    const ms = Date.now() - (started.get(req) ?? Date.now());
    log.info(
      {
        reqId: req.id,
        method: req.method,
        path: req.url.split("?")[0],
        status: reply.statusCode,
        latencyMs: ms,
        subjectHash: ctx ? subjectLogHash(ctx.subject) : undefined,
      },
      "founderbrain.request",
    );
  });

  const context = (req: FastifyRequest) => {
    const c = contexts.get(req);
    if (!c) throw new DomainError(401, "sign_in_required", "Sign in to continue.");
    return c;
  };
  app.get("/health/live", async () => ({ ok: true, service: "founderbrain-api" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      await store.scoped("00000000000000000000000000", async (tx) => {
        await tx`select 1 from fb_ai_job limit 0`;
      });
      return { ok: true };
    } catch {
      reply.code(503);
      return { ok: false };
    }
  });
  // Process metrics only — no Brain content. Cross-workspace queue depth needs fb_worker (operator SQL).
  app.get("/health/metrics", async () => ({
    ok: true,
    service: "founderbrain-api",
    uptimeSec: Math.round(process.uptime()),
    memoryRss: process.memoryUsage().rss,
    rateLimit: {
      mode: "in-memory-single-instance",
      ip: API_IP_LIMIT,
      subjectMutations: API_SUBJECT_MUTATION_LIMIT,
    },
  }));
  app.get("/api/config", async () => {
    const local = config.FOUNDERBRAIN_LOCAL_DEMO === "true";
    return {
      authMode: local ? "local-demo" : "hexclave",
      hexclave: local
        ? null
        : {
            projectId: config.HEXCLAVE_PROJECT_ID,
            apiUrl: new URL(config.HEXCLAVE_API_URL).origin,
            publishableClientKey: config.HEXCLAVE_PUBLISHABLE_CLIENT_KEY ?? null,
          },
      aiEnabled: config.AI_ENABLED === "true",
      crmConnectEnabled: crmOAuthConfigured(config),
      siteImportEnabled: Boolean(config.FIRECRAWL_API_KEY),
      routinesEnabled: config.ROUTINES_ENABLED === "true",
      mediaEnabled: r2FromConfig(config) !== null,
      uploadsEnabled: true,
    };
  });
  app.get("/api/oauth/status", async (req) =>
    connectionStatus(store, context(req).workspace, config),
  );
  app.get("/api/oauth/start", async (req) => {
    const c = context(req);
    return startOauthConnection(store, c.workspace, config, c.subject);
  });
  app.post("/api/oauth/complete", async (req) => {
    const body = parse(
      z.union([
        z.object({ code: z.string().min(8).max(512), state: z.string().min(8).max(2000) }).strict(),
        z.object({ error: z.string().min(1).max(200), state: z.string().min(8).max(2000) }).strict(),
      ]),
      req.body,
    );
    const c = context(req);
    const status = await completeOauthConnection(store, c.workspace, config, c.subject, body);
    return { ...status, orientation: await readOrientation(store, c.workspace) };
  });
  app.delete("/api/oauth/connection", async (req) => {
    const body = parse(
      z.object({ connectionId: z.string().min(16).max(80), confirmed: z.literal(true) }).strict(),
      req.body,
    );
    const workspace = context(req).workspace;
    const status = await disconnectConnection(store, workspace, body.connectionId);
    return { ...status, orientation: await readOrientation(store, workspace) };
  });
  app.post("/api/voice", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const body = parse(
      z
        .object({
          // Base64 of the 10 MiB decoded cap lands under this limit and under the
          // 16 MiB route bodyLimit; codec parameters (audio/webm;codecs=opus) accepted.
          audioBase64: z.string().min(64).max(14_000_000),
          mime: z.string().regex(/^audio\/(webm|ogg|wav|mpeg)(;.*)?$/),
          seconds: z.coerce.number().positive().max(300),
        })
        .strict(),
      req.body,
    );
    return transcribeVoice(config, store, context(req).workspace, {
      audio: Buffer.from(body.audioBase64, "base64"),
      mime: body.mime,
      seconds: body.seconds,
    });
  });
  app.get("/api/voice-samples", async (req) => {
    await loadValueCatalog();
    return {
      samples: await listVoiceSamples(store, context(req).workspace),
      min: MIN_VOICE_SAMPLES,
    };
  });
  app.post("/api/voice-samples", async (req) => {
    const body = parse(
      z.object({ name: z.string().min(2).max(120), text: z.string().min(40).max(20_000) }).strict(),
      req.body,
    );
    return addVoiceSample(store, context(req).workspace, config, body);
  });
  app.delete("/api/voice-samples/:id", async (req) => {
    const query = parse(z.object({ id: z.string().min(36).max(36) }).strict(), req.query);
    return deleteVoiceSample(store, context(req).workspace, query.id);
  });
  app.get("/api/routines", async (req) => {
    const workspace = context(req).workspace;
    const [settings, drafts] = await Promise.all([
      getRoutineSettings(store, workspace),
      listRoutineDrafts(store, workspace),
    ]);
    return { settings, drafts };
  });
  app.post("/api/routines/settings", async (req) => {
    const body = parse(
      z
        .object({
          timezone: z.string().max(64).optional(),
          mondayPlan: z.boolean().optional(),
          contentTopUp: z.boolean().optional(),
          readinessDigest: z.boolean().optional(),
        })
        .strict(),
      req.body ?? {},
    );
    return updateRoutineSettings(store, context(req).workspace, body);
  });
  app.post("/api/routines/drafts/status", async (req) => {
    const body = parse(
      z.object({ id: z.string().min(36).max(36), status: z.enum(["read", "dismissed"]) }).strict(),
      req.body,
    );
    await setRoutineDraftStatus(store, context(req).workspace, body.id, body.status);
    return { ok: true };
  });
  const pieceN = z.number().int().min(1).max(30).nullable().optional();
  const mediaId = z.object({ id: z.string().uuid() });
  app.get("/api/media", async (req) => {
    const workspace = context(req).workspace;
    const [items, higgsfield] = await Promise.all([
      listMedia(config, store, workspace),
      higgsfieldStatus(store, workspace),
    ]);
    return { items, higgsfield };
  });
  app.post("/api/media/upload", async (req) => {
    const body = parse(
      z
        .object({
          pieceN,
          filename: z.string().min(1).max(200),
          contentType: z.string().refine((t) => t in UPLOAD_TYPES),
          size: z.number().int().positive(),
        })
        .strict(),
      req.body,
    );
    return createMediaUpload(config, store, context(req).workspace, body);
  });
  app.post("/api/media/:id/complete", async (req) => {
    const { id } = parse(mediaId, req.params);
    return { item: await completeUpload(config, store, context(req).workspace, id) };
  });
  app.post("/api/media/:id/assign", async (req) => {
    const { id } = parse(mediaId, req.params);
    const body = parse(
      z.object({ pieceN: z.number().int().min(1).max(30).nullable() }).strict(),
      req.body,
    );
    return { item: await assignMedia(config, store, context(req).workspace, id, body.pieceN) };
  });
  app.post("/api/media/:id/refresh", async (req) => {
    const { id } = parse(mediaId, req.params);
    return { item: await refreshMedia(config, store, context(req).workspace, id) };
  });
  app.delete("/api/media/:id", async (req) => {
    const { id } = parse(mediaId, req.params);
    return deleteMedia(config, store, context(req).workspace, id);
  });
  app.post("/api/higgsfield/connect", async (req) => {
    const body = parse(
      z.union([
        z.object({ apiKey: z.string().min(17).max(601) }).strict(),
        z
          .object({ keyId: z.string().min(8).max(200), keySecret: z.string().min(8).max(400) })
          .strict(),
      ]),
      req.body,
    );
    return connectHiggsfield(store, context(req).workspace, body);
  });
  app.delete("/api/higgsfield", async (req) => disconnectHiggsfield(store, context(req).workspace));
  const genBody = z
    .object({
      kind: z.enum(["image", "video"]),
      prompt: z.string().trim().min(3).max(1500),
      pieceN,
    })
    .strict();
  app.post("/api/higgsfield/estimate", async (req) => {
    const body = parse(genBody, req.body);
    return estimateMedia(store, context(req).workspace, body);
  });
  app.post("/api/higgsfield/generate", async (req) => {
    const body = parse(genBody, req.body);
    return { item: await generateMedia(config, store, context(req).workspace, body) };
  });
  const uploadId = z.object({ id: z.string().uuid() }).strict();
  const uploadQuery = z
    .object({
      filename: z.string().min(1).max(300),
      questionKey: z
        .string()
        .regex(/^[a-z0-9_-]{1,64}$/)
        .optional(),
    })
    .strict();
  app.get("/api/uploads", async (req) => {
    const ctx = await computeUploadContext(config, store, context(req).workspace);
    return { items: ctx.items, ai: { budgetBytes: ctx.budgetBytes, usedBytes: ctx.usedBytes } };
  });
  // Registered in its own encapsulated child instance so the raw-bytes content
  // type parser below applies only to this one route, never to the rest of the API.
  // Deliberately NOT awaited: a Fastify instance is itself thenable (resolving on
  // ready()), so `await app.register(...)` would trigger an early boot here and
  // freeze the error-handler chain before the routes and setErrorHandler below
  // ever register — every later route would then fall back to Fastify's own
  // default error body instead of this file's DomainError shape.
  app.register(async (instance) => {
    instance.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    instance.post(
      "/api/uploads",
      // A small margin over the per-file cap so an over-limit upload gets uploads.ts's
      // friendly "Files can be up to 10 MB" refusal instead of a bare Fastify body-too-large.
      { bodyLimit: MAX_UPLOAD_FILE_BYTES + 8192 },
      async (req) => {
        const query = parse(uploadQuery, req.query);
        if (!Buffer.isBuffer(req.body))
          throw new DomainError(422, "invalid_request", "Send the file as raw bytes.");
        const workspace = context(req).workspace;
        const { item } = await createUpload(store, workspace, {
          filename: query.filename,
          questionKey: query.questionKey ?? null,
          bytes: req.body,
        });
        // The just-inserted row's own best guess is overwritten with its true
        // allocation status once every upload (this one included) is considered.
        const ctx = await computeUploadContext(config, store, workspace);
        return { item: ctx.items.find((i) => i.id === item.id) ?? item };
      },
    );
  });
  app.get("/api/uploads/:id/download", async (req, reply) => {
    const { id } = parse(uploadId, req.params);
    const { name, bytes } = await downloadUpload(store, context(req).workspace, id);
    return reply
      .type("application/octet-stream")
      .header("Content-Disposition", contentDispositionHeader(name))
      .send(bytes);
  });
  app.delete("/api/uploads/:id", async (req) => {
    const { id } = parse(uploadId, req.params);
    return deleteUpload(store, context(req).workspace, id);
  });
  app.get("/api/gmail/status", async (req) =>
    getGmailStatus(config, store, context(req).workspace),
  );
  app.post("/api/gmail/oauth/start", async (req) =>
    startGmailOAuth(config, store, context(req).workspace),
  );
  app.post("/api/gmail/oauth/complete", async (req) => {
    const body = parse(
      z.object({ code: z.string().min(1).max(4096), state: z.string().min(20).max(512) }).strict(),
      req.body,
    );
    return completeGmailOAuth(config, store, context(req).workspace, body);
  });
  app.delete("/api/gmail", async (req) => disconnectGmail(config, store, context(req).workspace));
  app.get("/api/gmail/sent", async (req) => {
    const query = parse(
      z.object({ pageToken: z.string().min(1).max(1024).optional() }).strict(),
      req.query,
    );
    return listGmailSent(config, store, context(req).workspace, query);
  });
  app.post("/api/gmail/voice", async (req) => {
    const body = parse(
      z
        .object({
          messageIds: z
            .array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/))
            .min(5)
            .max(20),
          consent: z.literal(true),
        })
        .strict(),
      req.body,
    );
    return analyzeGmailVoice(config, store, context(req).workspace, body);
  });
  app.get("/api/gmail/drafts", async (req) =>
    listGmailDrafts(config, store, context(req).workspace),
  );
  app.post("/api/gmail/drafts", async (req) => {
    const body = parse(
      z
        .object({
          requestId: z.string().uuid(),
          recipient: z.string().email().max(254),
          brief: z.string().trim().min(10).max(6000),
          subject: z.string().max(200).optional(),
          autoSend: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    return createGmailDraft(config, store, context(req).workspace, body);
  });
  const gmailDraftId = z.object({ id: z.string().uuid() }).strict();
  app.put("/api/gmail/drafts/:id", async (req) => {
    const { id } = parse(gmailDraftId, req.params);
    const body = parse(
      z
        .object({
          subject: z.string().trim().min(1).max(200),
          body: z.string().trim().min(1).max(20000),
        })
        .strict(),
      req.body,
    );
    return updateGmailDraft(config, store, context(req).workspace, { id, ...body });
  });
  app.post("/api/gmail/drafts/:id/save", async (req) => {
    const { id } = parse(gmailDraftId, req.params);
    return saveGmailDraft(config, store, context(req).workspace, { id });
  });
  app.post("/api/gmail/drafts/:id/send", async (req) => {
    const { id } = parse(gmailDraftId, req.params);
    parse(z.object({ confirmed: z.literal(true) }).strict(), req.body);
    return sendGmailDraft(config, store, context(req).workspace, { id });
  });
  app.put("/api/gmail/settings", async (req) => {
    const body = parse(
      z
        .object({
          autoSend: z.boolean(),
          allowedRecipients: z.array(z.string().email().max(254)).max(20),
          dailyLimit: z.number().int().min(1).max(20),
          confirmed: z.boolean(),
        })
        .strict(),
      req.body,
    );
    return updateGmailSettings(config, store, context(req).workspace, body);
  });
  app.post("/api/content/regenerate", async (req) => {
    const body = parse(
      z
        .object({
          pieces: z
            .array(
              z.object({
                n: z.number().int().min(1).max(30),
                // Kept for API/client compatibility, but never trusted: the
                // "original" text used for heading/platform integrity always
                // comes from the server's own read of the persisted pack
                // below, not from whatever the client happens to send here.
                text: z.string().min(1).max(4000),
                feedback: z.string().max(1000),
              }),
            )
            .min(1)
            .max(30),
        })
        .strict(),
      req.body,
    );
    const workspace = context(req).workspace;

    // --- Preflight: every check that can refuse the request happens here,
    // before revisePieces() ever calls the paid model. ---
    const current = await jobs.artifact(workspace);
    if (!current) {
      throw new DomainError(
        422,
        "no_artifact",
        "There is no saved pack yet. Generate the 30 pieces before revising any of them.",
      );
    }
    const { preamble, pieces: existing } = splitContentSection(current.text);
    const dupes = duplicatePieceNumbers(existing);
    if (dupes.length) {
      // A pack with any duplicate piece number is not safe to patch by
      // number: which occurrence is "piece N" is ambiguous, and picking one
      // would silently drop the founder's other copy of it. Refuse instead
      // of guessing, and refuse before spending anything on the model.
      throw new DomainError(
        409,
        "duplicate_pieces",
        `This pack already has more than one piece ${dupes.join(", ")}. Regenerate the 30 pieces, or fix the duplicates by hand, before revising -- a rewrite here would have to guess which copy to keep.`,
      );
    }
    const existingByN = new Map(existing.map((piece) => [piece.n, piece]));
    const unknown = body.pieces.map((piece) => piece.n).filter((n) => !existingByN.has(n));
    if (unknown.length) {
      throw new DomainError(
        422,
        "unknown_piece",
        `Piece ${unknown.join(", ")} is not in the current pack. Reload the pieces before revising.`,
      );
    }

    // The model only ever sees the persisted, server-read original text --
    // never the client's copy of it.
    const requests = body.pieces.map((piece) => ({
      n: piece.n,
      feedback: piece.feedback,
      originalText: existingByN.get(piece.n)!.text,
    }));
    const expectedArtifact = { id: current.id, textHash: hashArtifactText(current.text) };

    // --- Only past here does anything paid happen. ---
    const pieces = await revisePieces(config, store, workspace, requests);

    const byNumber = new Map(existing.map((piece) => [piece.n, piece]));
    for (const piece of pieces) {
      if (!byNumber.has(piece.n)) continue; // already validated above; defensive only
      byNumber.set(piece.n, { n: piece.n, text: piece.text });
    }
    const nextContent = serializeContentSection(
      preamble,
      [...byNumber.values()].sort((a, b) => a.n - b.n),
    );
    const nextPack = replaceContentSection(current.text, nextContent);
    // Compare-and-swap against the artifact read at the top of this request:
    // if a slower rewrite finishes after a newer edit or accept landed, this
    // refuses instead of overwriting the founder's newer work.
    await jobs.saveLatestText(workspace, expectedArtifact, nextPack);
    return { pieces };
  });
  app.get("/api/ghl/booking-links", async (req) => {
    const query = parse(
      z.object({ connectionId: z.string().min(16).max(80) }).strict(),
      req.query,
    );
    const workspace = context(req).workspace;
    const state = await store.read(workspace);
    return getGhlBookingLinks(config, store, workspace, state.brain, query.connectionId);
  });
  app.put("/api/ghl/booking-links", async (req) => {
    const body = parse(
      z
        .object({
          connectionId: z.string().min(16).max(80),
          key: z.enum(["dm_booking_link", "call_booking_link"]),
          url: z.string().min(1).max(2048),
          expectedValue: z.string().max(2048).nullable(),
          replaceExisting: z.boolean(),
        })
        .strict(),
      req.body,
    );
    const workspace = context(req).workspace;
    const state = await store.read(workspace);
    return putGhlBookingLink(config, store, workspace, state.brain, body);
  });
  app.post("/api/ghl/push", { bodyLimit: 1024 * 1024 }, async (req) => {
    const body = parse(
      z.object({ connectionId: z.string().min(16).max(80), pack: z.string().max(40).optional() }).strict(),
      req.body,
    );
    const state = await store.read(context(req).workspace);
    if (!brainReadyForPush(state.brain))
      throw new DomainError(
        422,
        "brain_incomplete",
        "Approve all five missions before pushing to GoHighLevel.",
      );
    const reviewed = await jobs.artifact(context(req).workspace);
    const acceptedPack =
      reviewed?.acceptedAt &&
      reviewed.text.includes("## Content") &&
      reviewed.text.includes("## Outreach") &&
      reviewed.text.includes("90 day plan");
    if (!acceptedPack)
      throw new DomainError(
        422,
        "pack_unaccepted",
        "Review and accept the content, outreach, and 90 day plan before writing to GoHighLevel.",
      );
    const firstPack = body.pack ?? defaultFirstPack(state.brain);
    await loadValueCatalog();
    return pushGhlValues(
      config,
      store,
      context(req).workspace,
      body.connectionId,
      state.brain,
      firstPack,
      reviewed.text,
    );
  });
  app.post("/api/site-import", async (req) => {
    const body = parse(z.object({ url: z.string().url().max(300) }).strict(), req.body);
    if (!body.url.startsWith("https://"))
      throw new DomainError(422, "invalid_request", "Use an https website address.");
    return importSite(config, store, context(req).workspace, body.url);
  });
  app.get("/api/me", async (req) => ({ email: context(req).email }));
  app.get("/api/usage", async (req) =>
    usageResponse(config, await usageTotals(store, context(req).workspace)),
  );
  app.get("/api/orientation", async (req) => readOrientation(store, context(req).workspace));
  app.put("/api/orientation", async (req) => {
    const workspace = context(req).workspace;
    const raw = req.body as {
      ghlComplete?: unknown;
      ghlAnswers?: { connected?: unknown };
    } | null;
    const requestsConnected = raw?.ghlComplete === true || raw?.ghlAnswers?.connected === true;
    if (!requestsConnected) return writeOrientation(store, workspace, req.body);

    // Serialize the authoritative CRM check with disconnect/reconnect. A stale
    // browser save may keep its other chapter fields, but cannot resurrect GHL.
    await withCrmOperationLock(store, workspace, async (tx) => {
      const connected = await hasConnectionUnlocked(tx, workspace);
      if (connected) {
        await writeOrientation(store, workspace, req.body);
        return;
      }
      const patch = {
        ...(typeof req.body === "object" && req.body !== null ? req.body : {}),
        ghlComplete: false,
        ghlAnswers: {
          ...((typeof raw?.ghlAnswers === "object" && raw.ghlAnswers !== null)
            ? raw.ghlAnswers
            : {}),
          connected: false,
        },
      };
      await writeOrientation(store, workspace, patch);
      await tx`
        update fb_orientation
           set ghl_completed_at = null,
               ghl_answers = coalesce(ghl_answers, '{}'::jsonb) || ${tx.json({ connected: false } as never)}::jsonb,
               updated_at = now()
         where founder_id = ${workspace}
      `;
    });
    return readOrientation(store, workspace);
  });
  app.get("/api/brain", async (req) => {
    const query = parse(
      z.object({ version: z.coerce.number().int().positive().optional() }).strict(),
      req.query,
    );
    const workspace = context(req).workspace;
    const state = await store.read(workspace, query.version);
    const artifact = query.version ? null : await jobs.artifact(workspace);
    return { ...state, readiness: readiness(state.brain, artifact, state.sha), artifact };
  });
  app.put("/api/brain", async (req) => {
    const body = parse(
      z.object({ brain: z.unknown(), expectedVersion: version, idempotencyKey: key }).strict(),
      req.body,
    );
    return store.commit(
      context(req).workspace,
      validateBrain(body.brain),
      body.expectedVersion,
      body.idempotencyKey,
    );
  });
  app.get("/api/history", async (req) => ({
    versions: await store.history(context(req).workspace),
  }));
  app.post("/api/restore", async (req) => {
    const body = parse(
      z.object({ version: version.min(1), expectedVersion: version, idempotencyKey: key }).strict(),
      req.body,
    );
    return store.restore(
      context(req).workspace,
      body.version,
      body.expectedVersion,
      body.idempotencyKey,
    );
  });
  app.get("/api/export", async (req, reply) => {
    const query = parse(
      z.object({ format: z.enum(["json", "markdown"]).default("markdown") }).strict(),
      req.query,
    );
    const state = await store.read(context(req).workspace);
    if (!state.version)
      throw new DomainError(409, "not_saved", "Save your first Brain revision before exporting.");
    if (query.format === "json")
      return reply
        .type("application/json")
        .header("Content-Disposition", 'attachment; filename="founder-brain.json"')
        .send(
          JSON.stringify({ version: state.version, sha: state.sha, brain: state.brain }, null, 2),
        );
    return reply
      .type("text/markdown; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="founder-brain.md"')
      .send(
        exportMarkdown(
          state.brain,
          state.version,
          state.updatedAt,
          await store.firstCommittedAt(context(req).workspace),
        ),
      );
  });
  app.post("/api/jobs", async (req, reply) => {
    const body = parse(
      z
        .object({
          expectedVersion: version,
          idempotencyKey: key,
          replaceStuck: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    return reply
      .code(202)
      .send(
        await jobs.enqueue(
          context(req).workspace,
          body.expectedVersion,
          body.idempotencyKey,
          body.replaceStuck === true,
        ),
      );
  });
  app.get("/api/jobs/:id", async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return jobs.read(context(req).workspace, id);
  });
  app.get("/api/artifact", async (req) => {
    const workspace = context(req).workspace;
    const artifact = await jobs.artifact(workspace);
    const state = await store.read(workspace);
    let stale = !!artifact && artifact.sourceHash !== state.sha;
    if (artifact && !stale) {
      // The Brain itself did not change, but the uploaded documents it would be
      // generated with might have: a new file added, one removed, or one whose
      // allocation status shifted enough to change what the AI actually reads.
      const budget = documentBudgetBytes(config, state.brain);
      const { allocation } = await currentUploadAllocation(store, workspace, budget);
      const artifactHash = artifact.uploadsHash ?? EMPTY_CORPUS_HASH;
      stale = allocation.corpusHash !== artifactHash;
    }
    return { artifact, stale };
  });
  app.post("/api/artifact/:id/accept", async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(
      z
        .object({
          text: z.string().min(1).max(60000),
          expectedVersion: version,
          idempotencyKey: key,
        })
        .strict(),
      req.body,
    );
    return {
      artifact: await jobs.accept(
        context(req).workspace,
        id,
        body.text,
        body.expectedVersion,
        body.idempotencyKey,
      ),
      verified: true,
    };
  });
  app.delete("/api/workspace", async (req) => {
    parse(z.object({ confirmation: z.literal("DELETE") }).strict(), req.body);
    const c = context(req);
    // Fail closed: never delete local workspace while a live OpenRouter key may remain.
    await revokeOpenRouterKey(store, config, c.workspace, options.openRouterManagement);
    await store.deleteWorkspace(c.subject, c.workspace);
    return { deleted: true };
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof DomainError) {
      if (error.status >= 500)
        log.warn(
          { reqId: req.id, code: error.code, status: error.status },
          "founderbrain.domain_error",
        );
      return reply.code(error.status).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ error: "invalid_request", message: "The request could not be accepted." });
    log.error({ reqId: req.id, errName: (error as Error)?.name }, "founderbrain.unhandled");
    return reply.code(503).send({
      error: "temporarily_unavailable",
      message:
        "The service is temporarily unavailable. Your saved work has not been " +
        "discarded. Retry using the same request.",
    });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: "not_found", message: "Not found." }),
  );
  if (options.serveWeb) {
    await app.register(staticFiles, { root: resolve("dist/founderbrain-web"), prefix: "/" });
  }
  app.addHook("onClose", async () => {
    if (ownsJobs) await jobs.close();
    if (ownsStore) await store.close();
  });
  return app;
}
