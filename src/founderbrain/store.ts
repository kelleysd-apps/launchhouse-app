/**
 * src/founderbrain/store.ts
 *
 * WHAT THIS IS. Postgres-backed Brain persistence: workspace ensure, encrypted
 * blob read/write, optimistic commits, history, and restore. Every request path
 * is scoped to one founder workspace (RLS + advisory locks).
 */
import { randomBytes } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";

import {
  createFounderKey,
  openBlob,
  sealBlob,
  sha256Hex,
  unwrapDataKey,
} from "../server/storage/crypto.ts";
import {
  type Artifact,
  type Brain,
  type BrainState,
  DomainError,
  canonicalize,
  contentHash,
  emptyBrain,
  readiness,
  validateBrain,
} from "./domain.ts";
import { assertSafeRole } from "./migrations.ts";

const BRAIN_PATH = "brain.json";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PG_STORE_POOL_MAX = 8;

/** Sections summarized per version in /api/history (mission sections of the Brain). */
const SUMMARY_SECTIONS = ["identity", "customer", "offer", "voice", "context"] as const;
type SummarySection = (typeof SUMMARY_SECTIONS)[number];

export interface HistoryRow {
  version: number;
  sha: string;
  at: string;
  /** What the workspace was when this version was saved. */
  venture: string;
  track: "b2b" | "b2c";
  hybrid: boolean;
  approved: SummarySection[];
  /** Sections that differ from the version before it; all sections for the first save. */
  changed: SummarySection[];
}

function brainChangedSections(brain: Brain, previous: Brain | null): SummarySection[] {
  if (!previous) return [...SUMMARY_SECTIONS];
  return SUMMARY_SECTIONS.filter(
    (section) => JSON.stringify(brain[section]) !== JSON.stringify(previous[section]),
  );
}

type FounderRow = {
  version: number | string | bigint;
  wrapped_key: Uint8Array;
  deleted_at: Date | string | null;
};
type FileRow = {
  blob_sha: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  version: number | string | bigint;
  at: Date | string | null;
};

function fail(status: number, code: string, message: string): DomainError {
  return new DomainError(status, code, message);
}

function asVersion(value: number | string | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw fail(503, "storage_unavailable", "Saved workspace data is invalid. Please try again.");
  return n;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function validOpaque(value: string, name: string, max = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex -- rejecting control characters in opaque ids is the point
    /[\u0000-\u001f]/.test(value)
  ) {
    throw fail(422, "invalid_request", `${name} is invalid.`);
  }
  return value;
}

function workspaceId(): string {
  const bytes = randomBytes(26);
  let id = "";
  for (const b of bytes) id += CROCKFORD[b & 31];
  return id;
}

function checkedBrain(value: Brain): Brain {
  // Domain owns validation. Supporting a void return keeps this store compatible
  // with a validator that throws on invalid input and normalizes nowhere.
  const result = validateBrain(value) as unknown;
  return (result === undefined ? value : result) as Brain;
}

function canonicalBytes(brain: Brain): Buffer {
  return Buffer.from(canonicalize(brain), "utf8");
}

function requestHash(brain: Brain, expectedVersion: number): string {
  return sha256Hex(Buffer.from(canonicalize({ brain, expectedVersion }), "utf8"));
}

function safeDbError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  // Propagate the underlying cause into the log for triage; the founder still
  // sees only the friendly message.
  // eslint-disable-next-line no-console -- triage path: the cause must reach the CI log
  if (error instanceof Error && error.message) console.error("[fb] storage cause:", error.message);
  throw fail(503, "storage_unavailable", "Storage is temporarily unavailable. Please try again.");
}

/**
 * Direct encrypted Postgres storage for the FounderBrain canonical document.
 * Authorization remains at the API boundary; scoped() is intentionally explicit
 * so job code cannot accidentally perform an unscoped tenant query.
 */
export class PgBrainStore {
  private readonly sql: Sql;
  private roleCheck: Promise<void> | undefined;
  private readonly production: boolean;

  constructor(databaseUrl: string, production = false) {
    if (!databaseUrl) throw new Error("FounderBrain database URL is required");
    this.production = production;
    this.sql = postgres(databaseUrl, {
      max: PG_STORE_POOL_MAX,
      onnotice: () => undefined,
      connection: { application_name: "founderbrain-runtime" },
    });
  }

  private async ready(): Promise<void> {
    try {
      this.roleCheck ??= assertSafeRole(this.sql, this.production);
      await this.roleCheck;
    } catch {
      throw fail(503, "storage_unavailable", "Storage is not safely configured.");
    }
  }

  async scoped<T>(workspaceId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    await this.ready();
    validOpaque(workspaceId, "workspace id", 64);
    try {
      const result = await this.sql.begin(async (tx) => {
        await tx`select set_config('app.founder_id', ${workspaceId}, true)`;
        return await fn(tx);
      });
      return result as T;
    } catch (error) {
      return safeDbError(error);
    }
  }

  async ensureWorkspace(subject: string): Promise<string> {
    await this.ready();
    validOpaque(subject, "subject");
    try {
      return await this.sql.begin(async (tx) => {
        await tx`select set_config('app.subject', ${subject}, true)`;
        const existing = await tx<{ founder_id: string; deleted_at: Date | string | null }[]>`
          select founder_id, deleted_at from fb_user where subject = ${subject} for update
        `;
        if (existing[0]) {
          if (existing[0].deleted_at !== null)
            throw fail(410, "workspace_deleted", "This workspace was deleted.");
          const membership = await tx`
            select 1 from fb_member
            where subject = ${subject}
              and founder_id = ${existing[0].founder_id}
              and revoked_at is null
          `;
          if (!membership.length)
            throw fail(403, "membership_revoked", "Workspace access was revoked.");
          return existing[0].founder_id;
        }

        const id = workspaceId();
        const { wrapped } = createFounderKey(id);
        const email = `fb-${id.toLowerCase()}@storage.invalid`;
        await tx`
          insert into founder (id, email, timezone, wrapped_key)
          values (${id}, ${email}, 'UTC', ${wrapped})
        `;
        const inserted = await tx<{ founder_id: string }[]>`
          insert into fb_user (subject, founder_id) values (${subject}, ${id})
          on conflict (subject) do nothing returning founder_id
        `;
        if (inserted.length === 0) {
          // A concurrent request won the subject binding. Remove only our unused
          // synthetic founder row before returning the durable winner.
          await tx`delete from founder where id = ${id}`;
          const winner = await tx<{ founder_id: string; deleted_at: Date | string | null }[]>`
            select founder_id, deleted_at from fb_user where subject = ${subject}
          `;
          if (!winner[0] || winner[0].deleted_at !== null)
            throw fail(410, "workspace_deleted", "This workspace was deleted.");
          return winner[0].founder_id;
        }
        await tx`
          insert into fb_member (founder_id, subject, role) values (${id}, ${subject}, 'owner')
          on conflict (founder_id, subject) do nothing
        `;
        return id;
      });
    } catch (error) {
      return safeDbError(error);
    }
  }

  async read(workspaceId: string, version?: number): Promise<BrainState> {
    await this.ready();
    validOpaque(workspaceId, "workspace id", 64);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 0))
      throw fail(422, "invalid_version", "Version is invalid.");
    try {
      return await this.readInternal(workspaceId, version);
    } catch (error) {
      return safeDbError(error);
    }
  }

  private async readInternal(workspaceId: string, requestedVersion?: number): Promise<BrainState> {
    return await this.sql.begin(async (tx) => {
      const founders = await tx<FounderRow[]>`
        select version, wrapped_key, deleted_at from founder where id = ${workspaceId} limit 1
      `;
      const founder = founders[0];
      if (!founder) throw fail(404, "workspace_not_found", "Workspace was not found.");
      if (founder.deleted_at !== null)
        throw fail(410, "workspace_deleted", "This workspace was deleted.");
      const currentVersion = asVersion(founder.version);
      const target = requestedVersion ?? currentVersion;
      if (target === 0) {
        if (requestedVersion !== undefined && currentVersion > 0)
          throw fail(404, "version_not_found", "Version was not found.");
        const brain = emptyBrain();
        return {
          workspaceId,
          version: 0,
          sha: contentHash(brain),
          updatedAt: null,
          brain,
          readiness: readiness(brain),
          verified: false,
          artifact: null,
        } as BrainState;
      }
      await tx`select set_config('app.founder_id', ${workspaceId}, true)`;
      const files =
        requestedVersion === undefined
          ? await tx<FileRow[]>`
            select f.blob_sha, b.ciphertext, b.nonce, f.version, f.mtime as at
              from ge_file f join ge_blob b on b.founder_id = f.founder_id and b.sha = f.blob_sha
             where f.founder_id = ${workspaceId} and f.path = ${BRAIN_PATH}
             limit 1
          `
          : await tx<FileRow[]>`
            select v.blob_sha, b.ciphertext, b.nonce, v.version, v.at
              from ge_file_version v
              join ge_blob b
                on b.founder_id = v.founder_id and b.sha = v.blob_sha
             where v.founder_id = ${workspaceId}
               and v.path = ${BRAIN_PATH}
               and v.version = ${target}
               and v.deleted = false
             limit 1
          `;
      const file = files[0];
      if (!file) throw fail(404, "version_not_found", "Version was not found.");
      const key = unwrapDataKey(workspaceId, founder.wrapped_key);
      const bytes = openBlob(workspaceId, key, file.blob_sha, file.ciphertext, file.nonce);
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw fail(503, "storage_unavailable", "Saved workspace data could not be verified.");
      }
      const brain = checkedBrain(parsed as Brain);
      const fileVersion = asVersion(file.version);
      return {
        workspaceId,
        version: fileVersion,
        // Hash of the bytes as persisted, not of the re-parsed shape: zod
        // default-injection after schema additions would otherwise drift every
        // legacy blob's hash and falsely mark accepted artifacts stale.
        sha: file.blob_sha,
        updatedAt: iso(file.at),
        brain,
        readiness: readiness(brain, null, file.blob_sha),
        verified: true,
        artifact: null,
      } as BrainState;
    });
  }

  async commit(
    workspaceId: string,
    value: Brain,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<BrainState> {
    const brain = checkedBrain(value);
    return await this.commitWithReceipt(
      workspaceId,
      brain,
      expectedVersion,
      idempotencyKey,
      requestHash(brain, expectedVersion),
    );
  }

  private async commitWithReceipt(
    workspaceId: string,
    brain: Brain,
    expectedVersion: number,
    idempotencyKey: string,
    bodyHash: string,
  ): Promise<BrainState> {
    await this.ready();
    validOpaque(workspaceId, "workspace id", 64);
    validOpaque(idempotencyKey, "idempotency key", 200);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
      throw fail(422, "invalid_version", "Version is invalid.");
    let committedVersion: number;
    try {
      committedVersion = await this.sql.begin(async (tx) => {
        await tx`select set_config('app.founder_id', ${workspaceId}, true)`;
        const founders = await tx<FounderRow[]>`
          select version, wrapped_key, deleted_at from founder where id = ${workspaceId} for update
        `;
        const founder = founders[0];
        if (!founder) throw fail(404, "workspace_not_found", "Workspace was not found.");
        if (founder.deleted_at !== null)
          throw fail(410, "workspace_deleted", "This workspace was deleted.");
        const receipts = await tx<
          { request_hash: string; result_version: number | string | bigint }[]
        >`
          select request_hash, result_version from fb_receipt
           where founder_id = ${workspaceId} and idempotency_key = ${idempotencyKey} limit 1
        `;
        if (receipts[0]) {
          if (receipts[0].request_hash !== bodyHash)
            throw fail(
              409,
              "idempotency_mismatch",
              "This idempotency key was already used for a different save.",
            );
          return asVersion(receipts[0].result_version);
        }
        const current = asVersion(founder.version);
        if (current !== expectedVersion)
          throw fail(
            409,
            "version_conflict",
            "This workspace changed. Reload and compare before saving.",
          );
        const next = current + 1;
        const plaintext = canonicalBytes(brain);
        const key = unwrapDataKey(workspaceId, founder.wrapped_key);
        const sealed = sealBlob(workspaceId, key, plaintext);
        await tx`
          insert into ge_blob (founder_id, sha, ciphertext, nonce, size_bytes)
          values (${workspaceId}, ${sealed.sha}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sizeBytes})
          on conflict (founder_id, sha) do nothing
        `;
        await tx`
          insert into ge_file (founder_id, path, blob_sha, size_bytes, mtime, version)
          values (
            ${workspaceId}, ${BRAIN_PATH}, ${sealed.sha}, ${sealed.sizeBytes}, now(), ${next}
          )
          on conflict (founder_id, path) do update set
            blob_sha = excluded.blob_sha,
            size_bytes = excluded.size_bytes,
            mtime = excluded.mtime,
            version = excluded.version
        `;
        await tx`
          insert into ge_file_version (
            founder_id, path, version, blob_sha, size_bytes, verb, deleted
          ) values (
            ${workspaceId}, ${BRAIN_PATH}, ${next}, ${sealed.sha},
            ${sealed.sizeBytes}, 'founderbrain.save', false
          )
        `;
        const updated = await tx<{ version: number | string | bigint }[]>`
          update founder
          set version = ${next}
          where id = ${workspaceId} and version = ${current}
          returning version
        `;
        if (!updated[0])
          throw fail(
            409,
            "version_conflict",
            "This workspace changed. Reload and compare before saving.",
          );
        await tx`
          insert into ge_event (founder_id, actor, verb, subject, exit_code, version_before, version_after)
          values (${workspaceId}, 'founder', 'founderbrain.save', ${BRAIN_PATH}, 0, ${current}, ${next})
        `;
        await tx`
          insert into fb_receipt (founder_id, idempotency_key, request_hash, result_version)
          values (${workspaceId}, ${idempotencyKey}, ${bodyHash}, ${next})
        `;
        return next;
      });
    } catch (error) {
      return safeDbError(error);
    }
    try {
      return await this.readInternal(workspaceId, committedVersion);
    } catch {
      throw new DomainError(
        503,
        "verification_pending",
        `Save committed as version ${String(committedVersion)} but verification is pending.`,
        { committedVersion },
      );
    }
  }

  /** The day the Brain was first written: the timestamp of revision 1. The
   *  v3 contract keeps it on every update. */
  async firstCommittedAt(workspaceId: string): Promise<string | null> {
    await this.ready();
    validOpaque(workspaceId, "workspace id", 64);
    try {
      return await this.sql.begin(async (tx) => {
        await tx`select set_config('app.founder_id', ${workspaceId}, true)`;
        const rows = await tx<{ at: string | null }[]>`
          select min(v.at) as at from ge_file_version v
          where v.founder_id = ${workspaceId} and v.path = ${BRAIN_PATH} and v.deleted = false
        `;
        return rows[0]?.at ? new Date(rows[0].at).toISOString() : null;
      });
    } catch (error) {
      return safeDbError(error);
    }
  }

  async history(workspaceId: string): Promise<HistoryRow[]> {
    await this.ready();
    validOpaque(workspaceId, "workspace id", 64);
    try {
      return await this.sql.begin(async (tx) => {
        const founders = await tx<
          FounderRow[]
        >`select wrapped_key, version, deleted_at from founder where id = ${workspaceId} limit 1`;
        const founder = founders[0];
        if (!founder) throw fail(404, "workspace_not_found", "Workspace was not found.");
        if (founder.deleted_at !== null)
          throw fail(410, "workspace_deleted", "This workspace was deleted.");
        await tx`select set_config('app.founder_id', ${workspaceId}, true)`;
        const rows = await tx<FileRow[]>`
          select v.blob_sha, b.ciphertext, b.nonce, v.version, v.at
            from ge_file_version v join ge_blob b on b.founder_id = v.founder_id and b.sha = v.blob_sha
           where v.founder_id = ${workspaceId} and v.path = ${BRAIN_PATH} and v.deleted = false
           order by v.version desc
        `;
        const key = unwrapDataKey(workspaceId, founder.wrapped_key);
        // Rows come newest-first. Every blob is parsed anyway for validation, so
        // the founder-facing summary (what this version is, what changed in it)
        // costs no extra decryption.
        const brains = rows.map((row) =>
          checkedBrain(
            JSON.parse(
              openBlob(workspaceId, key, row.blob_sha, row.ciphertext, row.nonce).toString("utf8"),
            ) as Brain,
          ),
        );
        return brains.map((brain, index) => {
          const row = rows[index]!;
          const at = iso(row.at);
          if (!at) throw fail(503, "storage_unavailable", "Saved workspace history is invalid.");
          return {
            version: asVersion(row.version),
            sha: row.blob_sha,
            at,
            venture: brain.identity.venture,
            track: brain.identity.track,
            hybrid: brain.identity.hybrid,
            approved: SUMMARY_SECTIONS.filter((section) => brain[section].approved),
            changed: brainChangedSections(
              brain,
              index + 1 < brains.length ? brains[index + 1]! : null,
            ),
          };
        });
      });
    } catch (error) {
      return safeDbError(error);
    }
  }

  async restore(
    workspaceId: string,
    version: number,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<BrainState> {
    if (!Number.isSafeInteger(version) || version <= 0)
      throw fail(422, "invalid_version", "Version is invalid.");
    const prior = await this.read(workspaceId, version);
    // A restore is a new immutable revision. Its receipt hash carries the requested
    // source revision, so key reuse for another restore is rejected.
    return await this.commitWithReceipt(
      workspaceId,
      prior.brain,
      expectedVersion,
      idempotencyKey,
      sha256Hex(
        Buffer.from(
          canonicalize({ operation: "restore", version, brain: prior.brain, expectedVersion }),
          "utf8",
        ),
      ),
    );
  }

  async deleteWorkspace(subject: string, workspaceId: string): Promise<void> {
    await this.ready();
    validOpaque(subject, "subject");
    validOpaque(workspaceId, "workspace id", 64);
    try {
      await this.sql.begin(async (tx) => {
        await tx`select set_config('app.subject', ${subject}, true)`;
        const bindings = await tx<{ founder_id: string; deleted_at: Date | string | null }[]>`
          select founder_id, deleted_at from fb_user where subject = ${subject} for update
        `;
        const binding = bindings[0];
        if (!binding || binding.founder_id !== workspaceId)
          throw fail(404, "workspace_not_found", "Workspace was not found.");
        if (binding.deleted_at !== null) return;
        await tx`select set_config('app.founder_id', ${workspaceId}, true)`;
        await tx`select pg_advisory_xact_lock(hashtext(${workspaceId}))`;
        await tx`select id from founder where id=${workspaceId} for update`;
        // Cancel jobs before referenced blobs. Retain only pseudonymous accounting
        // metadata for ambiguous external calls, never their prompt or output.
        const jobSchema = await tx`select to_regclass('public.fb_ai_job') as present`;
        if (jobSchema[0]?.present) {
          const pending = await tx`
            select id, status, reserved, budget_day, provider_request_id
            from fb_ai_job
            where founder_id = ${workspaceId}
              and status in ('queued', 'running', 'uncertain')
            for update
          `;
          for (const job of pending) {
            if (job.status === "queued") {
              for (const scope of ["global", "workspace:" + workspaceId]) {
                await tx`
                  update fb_budget
                  set reserved = greatest(0, reserved - ${job.reserved})
                  where scope = ${scope} and day = ${job.budget_day}
                `;
              }
            } else {
              await tx`
                insert into fb_usage_reconciliation (
                  job_id, scope, budget_day, reserved, provider_request_id, reason
                ) values (
                  ${job.id},
                  ${"workspace:" + workspaceId},
                  ${job.budget_day},
                  ${job.reserved},
                  ${job.provider_request_id},
                  'workspace_deleted_during_uncertain_call'
                )
                on conflict do nothing
              `;
            }
          }
          await tx`delete from fb_ai_job where founder_id=${workspaceId}`;
        }
        const openRouterSchema =
          await tx`select to_regclass('public.fb_openrouter_key') as present`;
        if (openRouterSchema[0]?.present) {
          await tx`delete from fb_openrouter_key where founder_id = ${workspaceId}`;
        }
        const orientationSchema = await tx`select to_regclass('public.fb_orientation') as present`;
        if (orientationSchema[0]?.present) {
          await tx`delete from fb_orientation where founder_id = ${workspaceId}`;
        }
        // Uploads reference ge_blob (original and extracted-text bytes); drop them
        // before the blob wipe below or that delete would fail its foreign key.
        const uploadSchema = await tx`select to_regclass('public.fb_upload') as present`;
        if (uploadSchema[0]?.present) {
          await tx`delete from fb_upload where founder_id = ${workspaceId}`;
        }
        await tx`delete from fb_receipt where founder_id = ${workspaceId}`;
        await tx`delete from ge_file_version where founder_id = ${workspaceId}`;
        await tx`delete from ge_file where founder_id = ${workspaceId}`;
        await tx`delete from ge_blob where founder_id = ${workspaceId}`;
        await tx`delete from ge_event where founder_id = ${workspaceId}`;
        // The identity stays alive: deletion wipes content, and the next
        // sign-in lands in a fresh empty workspace instead of a permanent
        // 410 lockout.
        await tx`update founder set version = 0 where id = ${workspaceId}`;
      });
    } catch (error) {
      return safeDbError(error);
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

export type { Artifact };
