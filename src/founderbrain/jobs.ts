/**
 * src/founderbrain/jobs.ts
 *
 * WHAT THIS IS. Generation queue, lease, fence, budget reserve/settle, and
 * artifact accept. The money path lives here; OpenRouter inference does not
 * (see provider.ts / orchestrate.ts).
 *
 * WHY IT EXISTS. One paid attempt per job. Ambiguous outcomes quarantine as
 * `uncertain` and never auto-retry. Editing and export stay available when AI
 * is disabled or the budget is spent.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type TransactionSql } from "postgres";
import {
  DomainError,
  canonicalize,
  generationPayload,
  MAX_PINNED_BODY_BYTES,
  type Artifact,
} from "./domain.ts";
import type { Config } from "./config.ts";
import type { PgBrainStore } from "./store.ts";
import { openRouterProvider, type Provider } from "./provider.ts";
import { sealBlob, openBlob, unwrapDataKey } from "../server/storage/crypto.ts";
import { parseContentChannels } from "../founderbrain-shared/channels.ts";
import { buildOrchestrationFromConfig, orchestrateInvitation } from "./orchestrate.ts";
import { keyIsUsable, loadOpenRouterApiKey, recordOpenRouterSpend } from "./openrouter-keys.ts";
import type { OrchestrationRole, RoleModels } from "./openrouter-privacy.ts";
import { OPENROUTER_LIFETIME_USD } from "./openrouter-management.ts";
import {
  ceilMicro,
  insertUsageEvent,
  pricedUsageEvent,
  recordUsageEvent,
  type UsageEvent,
} from "./usage.ts";
import { documentBudgetBytes, currentUploadAllocation, EMPTY_CORPUS_HASH } from "./uploads.ts";

export type { Provider, ProviderResult } from "./provider.ts";

type Tx = TransactionSql;
type ArtifactRow = {
  id: string;
  accepted_sha: string | null;
  draft_sha: string;
  source_version: number | string;
  source_hash: string;
  input_hash: string;
  uploads_hash: string | null;
  accepted_at: Date | string | null;
  created_at: Date | string;
};
type JobBudgetRow = { reserved: number; budget_day: string };
interface Pinned {
  roles: Record<OrchestrationRole, RoleModels>;
  system: string;
  userContent: string;
  inputRate: number;
  outputRate: number;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Same sha256-of-plaintext scheme `sealBlob` uses for content-addressed
 * storage, so this always matches the row's own draft_sha/accepted_sha for
 * text that has not changed -- the basis for `saveLatestText`'s CAS check. */
export function hashArtifactText(text: string): string {
  return hash(text);
}
const MAX_OUTPUT = 6000;
const PACK_LIMIT = 60000;
/** Per-role lease window. Provider calls time out at 90s; renew between roles. */
function encodeProviderRequestIds(ids: string[]): string | null {
  const unique = ids.filter((id, i) => id && ids.indexOf(id) === i);
  return unique.length ? unique.join(",") : null;
}

export async function migrateJobs(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(await readFile(new URL("./jobs.sql", import.meta.url), "utf8"));
    });
  } finally {
    await sql.end();
  }
}

async function putPrivate(tx: Tx, workspace: string, text: string): Promise<string> {
  const rows =
    await tx`select wrapped_key from founder where id=${workspace} and deleted_at is null`;
  if (!rows[0]) throw new DomainError(404, "workspace_missing", "Workspace not found.");
  const sealed = sealBlob(
    workspace,
    unwrapDataKey(workspace, rows[0].wrapped_key),
    Buffer.from(text),
  );
  await tx`
    insert into ge_blob(founder_id, sha, ciphertext, nonce, size_bytes)
    values (
      ${workspace}, ${sealed.sha}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sizeBytes}
    )
    on conflict (founder_id, sha) do nothing
  `;
  return sealed.sha;
}

async function getPrivate(tx: Tx, workspace: string, sha: string): Promise<string> {
  const r = await tx`
    select b.ciphertext, b.nonce, f.wrapped_key
    from ge_blob b
    join founder f on f.id = b.founder_id
    where b.founder_id = ${workspace} and b.sha = ${sha}
  `;
  if (!r[0]) {
    throw new DomainError(
      503,
      "artifact_unavailable",
      "The saved artifact could not be retrieved.",
    );
  }
  return openBlob(
    workspace,
    unwrapDataKey(workspace, r[0].wrapped_key),
    sha,
    r[0].ciphertext,
    r[0].nonce,
  ).toString("utf8");
}

export type JobEventSink = (event: {
  jobId: string;
  workspaceId: string;
  status: string;
  providerRequestId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costMicroUsd?: number;
  errorClass?: string;
}) => void;

export class BrainJobs {
  private dispatcher: ReturnType<typeof postgres>;
  constructor(
    private store: PgBrainStore,
    private config: Config,
    private provider: Provider = openRouterProvider,
    private onEvent: JobEventSink = () => {},
  ) {
    this.dispatcher = postgres(config.DATABASE_URL, {
      max: 1,
      onnotice: () => {},
      connect_timeout: 5,
    });
  }

  async enqueue(
    workspace: string,
    expectedVersion: number,
    key: string,
    replaceStuck = false,
  ): Promise<{ id: string; status: string }> {
    if (this.config.AI_ENABLED !== "true") {
      throw new DomainError(
        503,
        "ai_disabled",
        "AI generation is not enabled. Your Brain can still be edited and exported.",
      );
    }
    const state = await this.store.read(workspace);
    const named = Boolean(
      state.brain.identity.name?.trim() || state.brain.identity.venture?.trim(),
    );
    if (!named) {
      throw new DomainError(
        422,
        "brain_incomplete",
        "Save who you are before building the 90 day plan. Missing pieces are named as gaps, not invented.",
      );
    }
    if (!parseContentChannels(state.brain.context.contentChannels).length) {
      throw new DomainError(
        422,
        "channels_required",
        "Select the channels this pack is for before generating. Choose at least one of Instagram, Facebook, LinkedIn, Reddit, TikTok, YouTube, or Threads.",
      );
    }
    const { meta } = await loadOpenRouterApiKey(this.store, workspace);
    keyIsUsable(meta);
    const roles = buildOrchestrationFromConfig({
      thinker: this.config.AI_MODEL_THINKER,
      runner: this.config.AI_MODEL_RUNNER ?? this.config.AI_MODEL,
      verifier: this.config.AI_MODEL_VERIFIER,
    });
    // Documents get only whatever room is left under the hard cap once the Brain's
    // own content (with no documents yet) is accounted for, minus a safety margin —
    // see uploads.ts's documentBudgetBytes. The cap itself never moves for them.
    const availableForDocs = documentBudgetBytes(this.config, state.brain);
    const { allocation } = await currentUploadAllocation(this.store, workspace, availableForDocs);
    let uploadsHash = allocation.corpusHash;
    let payload = generationPayload(state.brain, allocation.documents);
    let pinned: Pinned = {
      roles,
      system: payload.system,
      userContent: payload.messages[0]!.content,
      inputRate: this.config.AI_INPUT_USD_PER_MILLION!,
      outputRate: this.config.AI_OUTPUT_USD_PER_MILLION!,
    };
    let body = canonicalize(pinned);
    if (Buffer.byteLength(body) > MAX_PINNED_BODY_BYTES && allocation.documents.length > 0) {
      // Defense in depth. allocateDocumentContext costs documents against the
      // real double-encoded body size, so this should not happen — but a
      // founder must never see "shorten your Brain" over documents they
      // uploaded, only over a genuinely oversized Brain. Drop the documents
      // entirely and rebuild rather than fail the generation; GET /api/uploads
      // reflects the same corpus hash change (EMPTY_CORPUS_HASH) the next time
      // it is read, so nothing here diverges from what actually ran.
      uploadsHash = EMPTY_CORPUS_HASH;
      payload = generationPayload(state.brain, []);
      pinned = {
        roles,
        system: payload.system,
        userContent: payload.messages[0]!.content,
        inputRate: this.config.AI_INPUT_USD_PER_MILLION!,
        outputRate: this.config.AI_OUTPUT_USD_PER_MILLION!,
      };
      body = canonicalize(pinned);
    }
    if (Buffer.byteLength(body) > MAX_PINNED_BODY_BYTES) {
      throw new DomainError(
        422,
        "input_too_large",
        "Shorten your Brain before generating the 90 day plan.",
      );
    }
    // UTF-8 byte count plus framing allowance deliberately over-reserves for three roles.
    const reserve = Math.ceil(
      (Buffer.byteLength(body) + 4096) * pinned.inputRate + MAX_OUTPUT * 3 * pinned.outputRate,
    );
    return this.store.scoped(workspace, async (tx: Tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${workspace}))`;
      const prior = await tx`
        select id, status, source_version
        from fb_ai_job
        where founder_id = ${workspace} and idempotency_key = ${key}
      `;
      if (prior[0]) {
        if (Number(prior[0].source_version) !== expectedVersion) {
          throw new DomainError(
            409,
            "idempotency_conflict",
            "This retry key belongs to a different request.",
          );
        }
        return { id: prior[0].id, status: prior[0].status };
      }
      const f = await tx`select version from founder where id=${workspace} and deleted_at is null`;
      if (Number(f[0]?.version) !== expectedVersion || state.version !== expectedVersion) {
        throw new DomainError(
          409,
          "version_conflict",
          "Your Brain changed. Reload before generating.",
        );
      }
      const active = await tx`
        select id, status, reserved, budget_day from fb_ai_job
        where founder_id = ${workspace}
          and status in ('queued', 'running', 'uncertain')
        limit 1
      `;
      const blocking = active[0];
      if (blocking && replaceStuck && blocking.status === "uncertain") {
        await tx`
          update fb_ai_job
          set status = 'failed',
              error = 'Replaced after a stuck build. Its provider spend was not recorded.',
              lease_until = null
          where founder_id = ${workspace} and id = ${blocking.id}
        `;
        await tx`update fb_job_dispatch set status = 'failed', lease_until = null where job_id = ${blocking.id}`;
        // Release the stuck build's daily hold so the replacement is not refused for budget.
        await this.settle(tx, workspace, blocking as unknown as JobBudgetRow, 0);
      } else if (blocking) {
        throw new DomainError(409, "job_active", "A generation is already in progress.", {
          jobId: blocking.id,
          status: blocking.status,
        });
      }
      const day = new Date().toISOString().slice(0, 10);
      for (const [scope, cap] of [
        ["global", this.config.AI_GLOBAL_DAILY_MICROUSD!],
        ["workspace:" + workspace, this.config.AI_WORKSPACE_DAILY_MICROUSD!],
      ] as const) {
        await tx`insert into fb_budget(scope,day) values(${scope},${day}) on conflict do nothing`;
        const allowed = await tx`
          update fb_budget
          set reserved = reserved + ${reserve}
          where scope = ${scope}
            and day = ${day}
            and spent + reserved + ${reserve} <= ${cap}
          returning scope
        `;
        if (!allowed.length) {
          throw new DomainError(
            429,
            "budget_limit",
            "The generation budget is reached. Editing and exports remain available.",
          );
        }
      }
      const id = randomUUID();
      const blob = await putPrivate(tx, workspace, canonicalize(pinned));
      await tx`
        insert into fb_ai_job (
          id, founder_id, idempotency_key, source_version, source_hash,
          input_hash, input_blob_sha, status, reserved, budget_day, uploads_hash
        ) values (
          ${id}, ${workspace}, ${key}, ${state.version}, ${state.sha},
          ${hash(body)}, ${blob}, 'queued', ${reserve}, ${day}, ${uploadsHash}
        )
      `;
      await tx`
        insert into fb_job_dispatch(job_id, founder_id, status)
        values (${id}, ${workspace}, 'queued')
      `;
      return { id, status: "queued" };
    });
  }

  async read(
    workspace: string,
    id: string,
  ): Promise<{ id: string; status: string; error?: string; artifact?: Artifact }> {
    return this.store.scoped(workspace, async (tx: Tx) => {
      const r =
        await tx`select id,status,error from fb_ai_job where founder_id=${workspace} and id=${id}`;
      if (!r[0]) throw new DomainError(404, "job_missing", "Generation not found.");
      const a = await tx`select * from fb_artifact where founder_id=${workspace} and job_id=${id}`;
      return {
        id: r[0].id,
        status: r[0].status,
        ...(r[0].error ? { error: r[0].error } : {}),
        ...(a[0] ? { artifact: await this.toArtifact(tx, workspace, a[0] as ArtifactRow) } : {}),
      };
    });
  }

  private async toArtifact(tx: Tx, workspace: string, a: ArtifactRow): Promise<Artifact> {
    return {
      id: a.id,
      text: await getPrivate(tx, workspace, a.accepted_sha ?? a.draft_sha),
      sourceVersion: Number(a.source_version),
      sourceHash: a.source_hash,
      inputHash: a.input_hash,
      uploadsHash: a.uploads_hash,
      acceptedAt: a.accepted_at ? new Date(a.accepted_at).toISOString() : null,
      createdAt: new Date(a.created_at).toISOString(),
    };
  }

  async artifact(workspace: string): Promise<Artifact | null> {
    return this.store.scoped(workspace, async (tx: Tx) => {
      const r = await tx`
        select * from fb_artifact
        where founder_id = ${workspace}
        order by created_at desc
        limit 1
      `;
      return r[0] ? this.toArtifact(tx, workspace, r[0] as ArtifactRow) : null;
    });
  }

  /**
   * Optimistic compare-and-swap: `expected` is the artifact id and content
   * hash the caller read before doing any slow work (e.g. a paid AI
   * rewrite). If a newer edit or accept landed on this workspace's artifact
   * in the meantime -- a different id, or the same id but a different
   * current sha -- this refuses instead of overwriting it. The check and
   * the write happen in the same transaction, so there is no window between
   * verifying freshness and committing the new text.
   */
  async saveLatestText(
    workspace: string,
    expected: { id: string; textHash: string },
    text: string,
  ): Promise<void> {
    await this.store.scoped(workspace, async (tx: Tx) => {
      // Share the generation/accept lock so a new artifact cannot appear
      // between reading the latest artifact and writing the revision.
      await tx`select pg_advisory_xact_lock(hashtext(${workspace}))`;
      const rows = await tx`
        select id, accepted_at, draft_sha, accepted_sha from fb_artifact
        where founder_id = ${workspace}
        order by created_at desc
        limit 1
        for update
      `;
      if (!rows[0]) {
        throw new DomainError(404, "no_artifact", "There is no saved pack to update.");
      }
      const currentSha = rows[0].accepted_at ? rows[0].accepted_sha : rows[0].draft_sha;
      if (rows[0].id !== expected.id || currentSha !== expected.textHash) {
        throw new DomainError(
          409,
          "artifact_conflict",
          "This pack changed since the rewrite started. Reload and try again so nothing newer gets overwritten.",
        );
      }
      const sha = await putPrivate(tx, workspace, text);
      if (rows[0].accepted_at) {
        await tx`update fb_artifact set draft_sha = ${sha}, accepted_sha = ${sha} where founder_id = ${workspace} and id = ${rows[0].id}`;
      } else {
        await tx`update fb_artifact set draft_sha = ${sha} where founder_id = ${workspace} and id = ${rows[0].id}`;
      }
    });
  }

  async accept(
    workspace: string,
    id: string,
    text: string,
    expectedVersion: number,
    key: string,
  ): Promise<Artifact> {
    const normalized = text.trim();
    if (!normalized || normalized.length > PACK_LIMIT) {
      throw new DomainError(
        422,
        "invalid_artifact",
        "The plan pack must contain between 1 and 60,000 characters.",
      );
    }
    const requestHash = hash(canonicalize({ text: normalized, expectedVersion }));
    // Read outside the write transaction, same as enqueue() does: by the time
    // the version check below passes, the current Brain (read here, moments
    // earlier) and the Brain the transaction confirms are current are the
    // same content — a genuine race is still caught, just by that version
    // check instead, which already throws stale_proposal.
    const currentState = await this.store.read(workspace);
    const currentDocBudget = documentBudgetBytes(this.config, currentState.brain);
    const { allocation: currentAllocation } = await currentUploadAllocation(
      this.store,
      workspace,
      currentDocBudget,
    );
    await this.store.scoped(workspace, async (tx: Tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${workspace}))`;
      const r =
        await tx`select * from fb_artifact where founder_id=${workspace} and id=${id} for update`;
      const a = r[0];
      if (!a) throw new DomainError(404, "artifact_missing", "Artifact not found.");
      if (a.accepted_at) {
        if (a.accept_key === key && a.accept_hash === requestHash) return;
        throw new DomainError(
          409,
          "already_accepted",
          "This artifact was already accepted. Generate a new draft to revise it.",
        );
      }
      const f = await tx`select version from founder where id=${workspace} for update`;
      if (
        Number(f[0]?.version) !== expectedVersion ||
        Number(a.source_version) !== expectedVersion
      ) {
        throw new DomainError(
          409,
          "stale_proposal",
          "Your Brain changed since generation. Regenerate before accepting.",
        );
      }
      // The Brain version matches, but the uploaded-document corpus this
      // artifact was generated with may not match what exists now (a file
      // added, removed, or reallocated since). Reject with the same stale
      // error a Brain change would give — from the founder's side, either way
      // the artifact no longer reflects what a fresh generation would read.
      const artifactUploadsHash = (a.uploads_hash as string | null) ?? EMPTY_CORPUS_HASH;
      if (artifactUploadsHash !== currentAllocation.corpusHash) {
        throw new DomainError(
          409,
          "stale_proposal",
          "Your Brain changed since generation. Regenerate before accepting.",
        );
      }
      const sha = await putPrivate(tx, workspace, normalized);
      await tx`
        update fb_artifact
        set accepted_sha = ${sha},
            accept_key = ${key},
            accept_hash = ${requestHash},
            accepted_at = now()
        where founder_id = ${workspace} and id = ${id}
      `;
      await tx`
        insert into ge_event (
          founder_id, actor, verb, subject, version_before, version_after
        ) values (
          ${workspace}, 'founder', 'fb.artifact.accept', ${id},
          ${expectedVersion}, ${expectedVersion}
        )
      `;
    });
    return this.store.scoped(workspace, async (tx: Tx) => {
      const r = await tx`select * from fb_artifact where founder_id=${workspace} and id=${id}`;
      if (!r[0])
        throw new DomainError(
          503,
          "verification_pending",
          "Acceptance was saved; verification is pending.",
        );
      const artifact = await this.toArtifact(tx, workspace, r[0] as ArtifactRow);
      if (artifact.text !== normalized) {
        throw new DomainError(
          503,
          "verification_pending",
          "Acceptance was saved; verification is pending.",
        );
      }
      return artifact;
    });
  }

  /** One provider attempt per job. Ambiguous calls are quarantined, never automatically retried. */
  async tick(authorizedWorkspace?: string): Promise<boolean> {
    // Scoped draining is useful for operator tests; the production worker uses the
    // dedicated fb_worker role for cross-workspace dispatch. Never expose this via API.
    const candidates = authorizedWorkspace
      ? await this.store.scoped(
          authorizedWorkspace,
          async (tx: Tx) =>
            tx`
            select job_id, founder_id from fb_job_dispatch
            where founder_id = ${authorizedWorkspace}
              and (
                status = 'queued'
                or (status = 'running' and lease_until < now())
              )
            order by job_id
            limit 1
          `,
        )
      : await this.dispatcher`
          select job_id, founder_id from fb_job_dispatch
          where status = 'queued'
             or (status = 'running' and lease_until < now())
          order by job_id
          limit 1
        `;
    const c = candidates[0];
    if (!c) return false;
    const workspace = c.founder_id as string;
    const claim = await this.store.scoped(workspace, async (tx: Tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${workspace}))`;
      await tx`select id from founder where id=${workspace} for update`;
      const rows = await tx`
        select * from fb_ai_job
        where founder_id = ${workspace} and id = ${c.job_id}
        for update skip locked
      `;
      const j = rows[0];
      if (!j) return null;
      if (j.status === "running" && new Date(j.lease_until).getTime() < Date.now()) {
        await tx`
          update fb_ai_job
          set status = 'uncertain',
              fence = fence + 1,
              error = 'Generation interrupted; spend needs operator reconciliation.'
          where founder_id = ${workspace} and id = ${j.id}
        `;
        await tx`update fb_job_dispatch set status='uncertain' where job_id=${j.id}`;
        this.onEvent({
          jobId: j.id,
          workspaceId: workspace,
          status: "uncertain",
          errorClass: "lease_expired",
        });
        return null;
      }
      if (j.status !== "queued") return null;
      const f = await tx`select version from founder where id=${workspace}`;
      if (Number(f[0]?.version) !== Number(j.source_version)) {
        await this.settle(tx, workspace, j as JobBudgetRow, 0);
        await tx`
          update fb_ai_job
          set status = 'failed',
              error = 'Brain changed before generation. Generate again.'
          where founder_id = ${workspace} and id = ${j.id}
        `;
        await tx`update fb_job_dispatch set status='failed' where job_id=${j.id}`;
        return null;
      }
      // The Brain itself is unchanged, but a deleted upload must never reach a
      // running generation: recompute the current corpus hash the exact same
      // way GET /api/uploads does, against the same budget this job was
      // pinned with, and compare it to what was recorded at enqueue time.
      const priorState = await this.store.read(workspace, Number(j.source_version));
      const docBudget = documentBudgetBytes(this.config, priorState.brain);
      const { allocation: currentAllocation } = await currentUploadAllocation(
        this.store,
        workspace,
        docBudget,
      );
      const jobUploadsHash = (j.uploads_hash as string | null) ?? EMPTY_CORPUS_HASH;
      if (currentAllocation.corpusHash !== jobUploadsHash) {
        await this.settle(tx, workspace, j as JobBudgetRow, 0);
        await tx`
          update fb_ai_job
          set status = 'failed',
              error = 'Your files changed before generation. Generate again.'
          where founder_id = ${workspace} and id = ${j.id}
        `;
        await tx`update fb_job_dispatch set status='failed' where job_id=${j.id}`;
        return null;
      }
      const claimed = await tx`
        update fb_ai_job
        set status = 'running',
            fence = fence + 1,
            lease_until = now() + interval '180 seconds'
        where founder_id = ${workspace} and id = ${j.id}
        returning *
      `;
      await tx`
        update fb_job_dispatch
        set status = 'running',
            lease_until = now() + interval '180 seconds'
        where job_id = ${j.id}
      `;
      const pinned = JSON.parse(await getPrivate(tx, workspace, j.input_blob_sha)) as Pinned;
      if (hash(canonicalize(pinned)) !== j.input_hash) {
        throw new DomainError(503, "input_corrupt", "The generation input failed verification.");
      }
      const claimedJob = claimed[0];
      if (!claimedJob) return null;
      return { job: claimedJob, pinned };
    });
    if (!claim) return true;
    const { job, pinned } = claim;
    let partialRequestIds: string[] = [];
    let billedMicroUsd = 0;
    try {
      const { apiKey } = await loadOpenRouterApiKey(this.store, workspace);
      const result = await orchestrateInvitation(
        {
          roles: pinned.roles,
          system: pinned.system,
          userContent: pinned.userContent,
          reservedMicroUsd: Number(job.reserved),
          inputRate: pinned.inputRate,
          outputRate: pinned.outputRate,
        },
        apiKey,
        this.provider,
        {
          beforeRole: async () => {
            await this.extendJobLease(workspace, job.id, Number(job.fence));
          },
          afterRole: async (progress) => {
            partialRequestIds = progress.requestIds;
            billedMicroUsd = progress.spentMicroUsd;
            await this.persistJobProgress(
              workspace,
              job.id,
              Number(job.fence),
              progress.requestIds,
            );
          },
        },
      );
      const cost = ceilMicro(
        result.inputTokens * pinned.inputRate + result.outputTokens * pinned.outputRate,
      );
      billedMicroUsd = cost;
      partialRequestIds = result.requestIds.length
        ? result.requestIds
        : result.requestId
          ? [result.requestId]
          : partialRequestIds;
      const planText = result.text.includes("90 day plan")
        ? result.text
        : `90 day plan\n\n${result.text}`;
      if (
        !Number.isSafeInteger(cost) ||
        cost < 0 ||
        !planText.trim() ||
        planText.length > PACK_LIMIT
      ) {
        throw new Error("Invalid provider result");
      }
      let completed = false;
      await this.store.scoped(workspace, async (tx: Tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${workspace}))`;
        await tx`select id from founder where id=${workspace} for update`;
        const alive = await tx`
          select id from fb_ai_job
          where founder_id = ${workspace}
            and id = ${job.id}
            and fence = ${job.fence}
            and status = 'running'
            and lease_until > now()
          for update
        `;
        if (!alive.length) {
          throw new DomainError(
            503,
            "job_lease_lost",
            "Generation lost its lease after provider spend; quarantining for reconciliation.",
          );
        }
        const lifetime = await tx`
          update fb_openrouter_key
          set spent_microusd = spent_microusd + ${cost}
          where founder_id = ${workspace}
            and revoked_at is null
            and spent_microusd + ${cost} <= ${OPENROUTER_LIFETIME_USD * 1_000_000}
          returning spent_microusd
        `;
        if (!lifetime.length) {
          throw new DomainError(
            429,
            "openrouter_lifetime_limit",
            "The lifetime AI budget for this account is spent. Editing and exports remain available.",
          );
        }
        const sha = await putPrivate(tx, workspace, planText);
        // Meter actual usage alongside the settle so the pre-connect price
        // screen and any later reconciliation share one ledger.
        const usageEvent: UsageEvent = {
          kind: "ai_tokens",
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costMicroUsd: cost,
          jobId: job.id,
        };
        await insertUsageEvent(
          tx,
          workspace,
          usageEvent,
          pricedUsageEvent(this.config, usageEvent),
        );
        await tx`
          insert into fb_artifact (
            id, founder_id, job_id, source_version, source_hash, input_hash, draft_sha, uploads_hash
          ) values (
            ${randomUUID()}, ${workspace}, ${job.id}, ${job.source_version},
            ${job.source_hash}, ${job.input_hash}, ${sha}, ${job.uploads_hash}
          )
          on conflict (founder_id, job_id) do nothing
        `;
        await this.settle(tx, workspace, job as JobBudgetRow, cost);
        const requestId = encodeProviderRequestIds(partialRequestIds) ?? result.requestId;
        await tx`
          update fb_ai_job
          set status = 'completed',
              provider_request_id = ${requestId},
              lease_until = null
          where founder_id = ${workspace}
            and id = ${job.id}
            and fence = ${job.fence}
        `;
        await tx`
          update fb_job_dispatch
          set status = 'completed', lease_until = null
          where job_id = ${job.id}
        `;
        completed = true;
      });
      if (!completed) {
        throw new DomainError(
          503,
          "job_lease_lost",
          "Generation lost its lease after provider spend; quarantining for reconciliation.",
        );
      }
      // Completion succeeded; spend already applied in-tx. Clear so catch does not double-count.
      billedMicroUsd = 0;
      this.onEvent({
        jobId: job.id,
        workspaceId: workspace,
        status: "completed",
        providerRequestId: encodeProviderRequestIds(partialRequestIds) ?? result.requestId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicroUsd: cost,
      });
    } catch (e) {
      const knownNoCharge = (e as { knownNoCharge?: boolean })?.knownNoCharge === true;
      // Billed OpenRouter calls that never reached a durable completion still need
      // lifetime spend recorded (uncertain / completion-tx failure after inference).
      if (!knownNoCharge && billedMicroUsd > 0) {
        try {
          await recordOpenRouterSpend(this.store, workspace, billedMicroUsd, {
            allowOverLifetime: true,
          });
          const quarantined: UsageEvent = {
            kind: "ai_tokens",
            costMicroUsd: billedMicroUsd,
            jobId: job.id,
            meta: { reason: "quarantine_partial_spend" },
          };
          try {
            await recordUsageEvent(this.store, workspace, this.config, quarantined);
          } catch {
            // Quarantine still proceeds; operator reconcile can apply confirmed spend.
          }
          await this.store.scoped(workspace, async (tx: Tx) => {
            await tx`
              update fb_ai_job
              set openrouter_spend_recorded_microusd = ${billedMicroUsd}
              where founder_id = ${workspace}
                and id = ${job.id}
                and fence = ${job.fence}
            `;
          });
        } catch {
          // Quarantine still proceeds; operator reconcile can apply confirmed spend.
        }
      }
      await this.store.scoped(workspace, async (tx: Tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${workspace}))`;
        await tx`select id from founder where id=${workspace} for update`;
        const alive = await tx`
          select id from fb_ai_job
          where founder_id = ${workspace}
            and id = ${job.id}
            and fence = ${job.fence}
            and status = 'running'
          for update
        `;
        if (!alive.length) return;
        if (knownNoCharge) await this.settle(tx, workspace, job as JobBudgetRow, 0);
        const status = knownNoCharge ? "failed" : "uncertain";
        const error = knownNoCharge
          ? "Provider refused the request. Contact the operator."
          : "Generation could not be verified. No automatic retry; spend is reserved for reconciliation.";
        const requestId = encodeProviderRequestIds(partialRequestIds);
        await tx`
          update fb_ai_job
          set status = ${status},
              error = ${error},
              lease_until = null,
              provider_request_id = coalesce(${requestId}, provider_request_id)
          where founder_id = ${workspace}
            and id = ${job.id}
            and fence = ${job.fence}
        `;
        await tx`
          update fb_job_dispatch
          set status = ${status}, lease_until = null
          where job_id = ${job.id}
        `;
      });
      this.onEvent({
        jobId: job.id,
        workspaceId: workspace,
        status: knownNoCharge ? "failed" : "uncertain",
        providerRequestId: encodeProviderRequestIds(partialRequestIds),
        costMicroUsd: knownNoCharge ? 0 : billedMicroUsd || undefined,
        errorClass: knownNoCharge ? "provider_refused" : ((e as Error)?.name ?? "Error"),
      });
    }
    return true;
  }

  /** Renew the running job lease so multi-step orchestration cannot expire mid-flight. */
  private async extendJobLease(workspace: string, jobId: string, fence: number): Promise<void> {
    await this.store.scoped(workspace, async (tx: Tx) => {
      const extended = await tx`
        update fb_ai_job
        set lease_until = now() + interval '180 seconds'
        where founder_id = ${workspace}
          and id = ${jobId}
          and fence = ${fence}
          and status = 'running'
        returning id
      `;
      if (!extended.length) {
        throw new DomainError(
          503,
          "job_lease_lost",
          "Generation lost its lease and cannot continue safely.",
        );
      }
      await tx`
        update fb_job_dispatch
        set lease_until = now() + interval '180 seconds'
        where job_id = ${jobId}
      `;
    });
  }

  /** Persist partial provider request ids so reconcile can recover interrupted runs. */
  private async persistJobProgress(
    workspace: string,
    jobId: string,
    fence: number,
    requestIds: string[],
  ): Promise<void> {
    const encoded = encodeProviderRequestIds(requestIds);
    if (!encoded) return;
    await this.store.scoped(workspace, async (tx: Tx) => {
      await tx`
        update fb_ai_job
        set provider_request_id = ${encoded}
        where founder_id = ${workspace}
          and id = ${jobId}
          and fence = ${fence}
          and status = 'running'
      `;
    });
  }

  private async settle(tx: Tx, workspace: string, job: JobBudgetRow, cost: number): Promise<void> {
    for (const scope of ["global", "workspace:" + workspace]) {
      await tx`
        update fb_budget
        set reserved = greatest(0, reserved - ${job.reserved}),
            spent = spent + ${cost}
        where scope = ${scope} and day = ${job.budget_day}
      `;
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.end();
  }
}
