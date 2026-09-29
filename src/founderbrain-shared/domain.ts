import { z } from "zod";

/**
 * Pure FounderBrain domain: types, schema, emptyBrain, present, readiness, canonicalize.
 * No Node imports — shared by the API (`src/founderbrain`) and the web app.
 * Hashing stays server-side (`contentHash` in domain.ts) because it needs node:crypto.
 */

const text = z.string().max(2000);
const section = { approved: z.boolean() };

export const brainSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: z
      .object({
        name: text,
        venture: text,
        role: text,
        // "" is the unanswered sentinel: distinct from "exploring" (Pre-revenue),
        // which is a real founder choice on the stage question, not a default.
        stage: z.enum(["", "exploring", "building", "launched", "growing"]).default(""),
        // Revenue band from the original intake; asked alongside the product stage.
        revenueBand: z.enum(["", "pre", "under10k", "10to50k", "over50k"]).default(""),
        goal: text,
        // Track fork from the original intake (Launchhouse founder-brain skill).
        track: z.enum(["b2b", "b2c"]).default("b2b"),
        /** Genuinely both motions: record the dominant one as track plus this flag. */
        hybrid: z.boolean().default(false),
        /** B2C only: what kind of product the founder sells. */
        model: z.enum(["", "service", "ecommerce"]).default(""),
        /** Neither service nor ecommerce fit: the model is the nearer of the two, flagged. */
        modelNearestFit: z.boolean().default(false),
        /** What the business really is, in the founder's words, when the model is a nearest fit. */
        modelNote: text.default(""),
        /** The founder's team: who runs which part of the selling, in their words. */
        team: text.default(""),
        ...section,
      })
      .strict(),
    customer: z
      .object({
        segment: text,
        problem: text,
        outcome: text,
        workaround: text,
        evidenceStatus: z.enum(["hypothesis", "supported"]),
        evidence: text,
        // Original intake audience group. B2B: buyer persona, trigger events,
        // three named best-fit accounts. B2C: attention map, adjacent purchases.
        buyer: text.default(""),
        trigger: text.default(""),
        bestFit: text.default(""),
        attention: text.default(""),
        adjacent: text.default(""),
        ...section,
      })
      .strict(),
    offer: z
      .object({
        description: text,
        delivery: text,
        outcome: text,
        cta: text,
        price: text,
        // Original intake offer-and-proof group: why them, the pricing model,
        // and the countable proof written as the founder said it.
        why: text.default(""),
        pricingModel: z.enum(["", "one-off", "subscription", "retainer", "per-unit"]).default(""),
        proof: text.default(""),
        ...section,
      })
      .strict(),
    voice: z
      .object({
        tone: text,
        boundaries: text,
        sample: text,
        /** Founder-supplied voice samples on file; approval needs at least 10. */
        sampleCount: z.number().int().min(0).max(50).default(0),
        ...section,
      })
      .strict(),
    // Original intake groups 5 (channels) and the Numbers / Source material
    // sections of founder-brain.md.
    context: z
      .object({
        channelsActive: text.default(""),
        channelsDormant: text.default(""),
        contentChannels: text.default(""),
        emailProvider: z.enum(["", "google", "microsoft365", "other"]).default(""),
        domainStatus: z.enum(["", "warm", "fresh"]).default(""),
        igAccountType: z.enum(["", "personal", "business"]).default(""),
        customersNow: text.default(""),
        avgMonthlyValue: text.default(""),
        target90: text.default(""),
        sourceMaterial: text.default(""),
        ...section,
      })
      .strict()
      // Legacy stored brains predate this section: default it so every old
      // revision still parses instead of 422ing on read.
      .default({
        channelsActive: "",
        channelsDormant: "",
        contentChannels: "",
        emailProvider: "",
        domainStatus: "",
        igAccountType: "",
        customersNow: "",
        avgMonthlyValue: "",
        target90: "",
        sourceMaterial: "",
        approved: false,
      }),
  })
  .strict();

export type Brain = z.infer<typeof brainSchema>;
export type Stage = Brain["identity"]["stage"];
export type EvidenceStatus = Brain["customer"]["evidenceStatus"];
export type MissionSection = "identity" | "customer" | "offer" | "voice" | "context";

export interface Artifact {
  id: string;
  text: string;
  sourceVersion: number;
  sourceHash: string;
  inputHash: string;
  /** sha256 over the uploaded documents this artifact was generated with (ids, their
   *  text sha, and allocation status), or null/absent for an artifact generated
   *  before uploads existed — treated as the empty-corpus hash when compared for
   *  staleness. Optional so existing artifact-shaped fixtures stay valid. */
  uploadsHash?: string | null;
  acceptedAt: string | null;
  createdAt: string;
}
export interface Readiness {
  identity: boolean;
  customer: boolean;
  offer: boolean;
  voice: boolean;
  context: boolean;
  output: boolean;
}
export interface BrainState {
  workspaceId: string;
  version: number;
  sha: string;
  updatedAt: string | null;
  brain: Brain;
  readiness: Readiness;
  verified: boolean;
  artifact?: Artifact | null;
}

export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function emptyBrain(): Brain {
  return {
    schemaVersion: 1,
    identity: {
      name: "",
      venture: "",
      role: "",
      stage: "",
      revenueBand: "",
      goal: "",
      track: "b2b",
      hybrid: false,
      model: "",
      modelNearestFit: false,
      modelNote: "",
      team: "",
      approved: false,
    },
    customer: {
      segment: "",
      problem: "",
      outcome: "",
      workaround: "",
      evidenceStatus: "hypothesis",
      evidence: "",
      buyer: "",
      trigger: "",
      bestFit: "",
      attention: "",
      adjacent: "",
      approved: false,
    },
    offer: {
      description: "",
      delivery: "",
      outcome: "",
      cta: "",
      price: "",
      why: "",
      pricingModel: "",
      proof: "",
      approved: false,
    },
    voice: { tone: "", boundaries: "", sample: "", sampleCount: 0, approved: false },
    context: {
      channelsActive: "",
      channelsDormant: "",
      contentChannels: "",
      emailProvider: "",
      domainStatus: "",
      igAccountType: "",
      customersNow: "",
      avgMonthlyValue: "",
      target90: "",
      sourceMaterial: "",
      approved: false,
    },
  };
}

/** Non-empty and not a placeholder the contract rejects (`unknown`, `n/a`, `tbd`, `not sure`). */
export function present(...values: string[]): boolean {
  return values.every(
    (v) => v.trim().length > 0 && !/^(unknown|n\/a|tbd|not sure)$/i.test(v.trim()),
  );
}

export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && /^(unknown|n\/a|tbd|not sure)$/i.test(trimmed);
}

export function fieldNeedsAttention(value: string): boolean {
  return !present(value);
}

/**
 * Section readiness. `sourceHash` is optional so the browser can hint without hashing;
 * when omitted, `output` is false even if an artifact exists.
 */
export function readiness(
  brain: Brain,
  artifact?: Artifact | null,
  sourceHash?: string | null,
): Readiness {
  return {
    identity:
      brain.identity.approved &&
      present(
        brain.identity.name,
        brain.identity.venture,
        brain.identity.role,
        brain.identity.goal,
      ),
    customer:
      brain.customer.approved &&
      present(brain.customer.segment, brain.customer.problem, brain.customer.outcome) &&
      (brain.customer.evidenceStatus === "hypothesis" || present(brain.customer.evidence)),
    offer:
      brain.offer.approved &&
      present(brain.offer.description, brain.offer.delivery, brain.offer.outcome, brain.offer.cta),
    voice:
      brain.voice.approved &&
      present(brain.voice.tone, brain.voice.boundaries, brain.voice.sample) &&
      brain.voice.sampleCount >= 10,
    context:
      brain.context.approved &&
      present(brain.context.channelsActive, brain.context.customersNow, brain.context.target90),
    output: Boolean(artifact?.acceptedAt && sourceHash && artifact.sourceHash === sourceHash),
  };
}

/** Would this section pass readiness if the founder marked it approved right now? */
export function sectionWouldApprove(brain: Brain, section: MissionSection): boolean {
  const probe = structuredClone(brain);
  probe[section].approved = true;
  return readiness(probe)[section];
}

export function validateBrain(value: unknown, sourceHashForOutput?: string | null): Brain {
  const result = brainSchema.safeParse(value);
  if (!result.success) {
    throw new DomainError(
      422,
      "invalid_brain",
      "Check the field types and lengths. Each field allows up to 2,000 characters.",
    );
  }
  const brain = result.data;
  const ready = readiness(brain, null, sourceHashForOutput ?? null);
  for (const key of ["identity", "customer", "offer", "voice", "context"] as const) {
    if (brain[key].approved && !ready[key]) {
      throw new DomainError(
        422,
        "incomplete_section",
        `Complete the required ${key} fields before approving, or save them as a draft.`,
      );
    }
  }
  return brain;
}

/** Stable JSON format is part of the persisted v1 contract. Never silently change it. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  return (
    "{" +
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonicalize(v))
      .join(",") +
    "}"
  );
}
