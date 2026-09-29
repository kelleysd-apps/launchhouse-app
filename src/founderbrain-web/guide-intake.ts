/**
 * First-run Typeform questions, mapped from the original Founder Brain intake
 * onto the Brain schema. Skip a step when that field is already filled.
 */
import type { Brain } from "./types";
import { toQuestionKey } from "./lib/uploads";

export type GuideKind = "text" | "long" | "choices";
export type GuideSection = "identity" | "customer" | "offer" | "voice" | "track";

export type GuideStep = {
  id: string;
  title: string;
  placeholder?: string;
  kind: GuideKind;
  section: GuideSection;
  field: string;
  optional?: boolean;
  choices?: { value: string; label: string }[];
  empty: (brain: Brain, track: string | null) => boolean;
};

export const GUIDE_STEPS: GuideStep[] = [
  {
    id: "venture",
    title: "What is the business called?",
    placeholder: "The name customers see",
    kind: "text",
    section: "identity",
    field: "venture",
    empty: (b) => !b.identity.venture.trim(),
  },
  {
    id: "sells",
    title: "What does it sell?",
    placeholder: "The product or service, in one line",
    kind: "long",
    section: "offer",
    field: "description",
    empty: (b) => !b.offer.description.trim(),
  },
  {
    id: "buyer",
    title: "Who actually pays you?",
    placeholder: "The buyer, not a vague market",
    kind: "text",
    section: "customer",
    field: "segment",
    empty: (b) => !b.customer.segment.trim(),
  },
  {
    id: "stage",
    title: "What stage are you at?",
    kind: "choices",
    section: "identity",
    field: "stage",
    choices: [
      { value: "exploring", label: "Pre-revenue" },
      { value: "building", label: "First customers" },
      { value: "launched", label: "Under 10k a month" },
      { value: "growing", label: "10k a month or more" },
    ],
    // "" is the unanswered sentinel. "exploring" (Pre-revenue) is a real,
    // valid answer and must not be treated as still-empty (#stage-default-bug).
    empty: (b) => b.identity.stage === "",
  },
  {
    id: "price",
    title: "What do you charge, and how?",
    placeholder: "One-off, subscription, retainer, per unit",
    kind: "text",
    section: "offer",
    field: "price",
    optional: true,
    empty: (b) => !b.offer.price.trim(),
  },
  {
    id: "role",
    title: "What do you do there?",
    placeholder: "Founder, operator, builder",
    kind: "text",
    section: "identity",
    field: "role",
    empty: (b) => !b.identity.role.trim(),
  },
  {
    id: "track",
    title: "Who do you sell to?",
    kind: "choices",
    section: "track",
    field: "track",
    choices: [
      { value: "b2b", label: "Other businesses" },
      { value: "b2c", label: "Individual consumers" },
    ],
    empty: (_b, track) => !track,
  },
  {
    id: "problem",
    title: "What problem do you solve, in their words?",
    placeholder: "How they would say it",
    kind: "long",
    section: "customer",
    field: "problem",
    empty: (b) => !b.customer.problem.trim(),
  },
  {
    id: "outcome",
    title: "What do they want instead?",
    placeholder: "The result they are after",
    kind: "long",
    section: "customer",
    field: "outcome",
    empty: (b) => !b.customer.outcome.trim(),
  },
  {
    id: "why",
    title: "Why you, rather than the obvious alternative?",
    placeholder: "The reason they pick you",
    kind: "long",
    section: "offer",
    field: "why",
    empty: (b) => !b.offer.why.trim(),
  },
  {
    id: "proof",
    title: "What proof do you have?",
    placeholder: "Numbers, names, repeats. Leave blank if none.",
    kind: "long",
    section: "customer",
    field: "evidence",
    optional: true,
    empty: (b) => !b.customer.evidence.trim(),
  },
  {
    id: "goal",
    title: "What do you want more of in the next 90 days?",
    placeholder: "Leads, sales, repeats, attention",
    kind: "long",
    section: "identity",
    field: "goal",
    empty: (b) => !b.identity.goal.trim(),
  },
  {
    id: "delivery",
    title: "How do they get it?",
    placeholder: "Call, checkout, retainers, a shop",
    kind: "long",
    section: "offer",
    field: "delivery",
    empty: (b) => !b.offer.delivery.trim(),
  },
  {
    id: "cta",
    title: "What is the next step you want them to take?",
    placeholder: "Book a call, buy, reply",
    kind: "text",
    section: "offer",
    field: "cta",
    empty: (b) => !b.offer.cta.trim(),
  },
  {
    id: "workaround",
    title: "What do they do today instead?",
    placeholder: "The messy current path",
    kind: "long",
    section: "customer",
    field: "workaround",
    optional: true,
    empty: (b) => !b.customer.workaround.trim(),
  },
  {
    id: "tone",
    title: "How do you sound when you talk about this?",
    placeholder: "Direct, warm, dry, impatient",
    kind: "long",
    section: "voice",
    field: "tone",
    empty: (b) => !b.voice.tone.trim(),
  },
  {
    id: "boundaries",
    title: "What should the Brain never say?",
    placeholder: "Hype, jargon, promises you will not keep",
    kind: "long",
    section: "voice",
    field: "boundaries",
    empty: (b) => !b.voice.boundaries.trim(),
  },
  {
    id: "sample",
    title: "Say it the way you would say it to a customer.",
    placeholder: "A few sentences in your voice",
    kind: "long",
    section: "voice",
    field: "sample",
    empty: (b) => !b.voice.sample.trim(),
  },
];

export function readStepValue(brain: Brain, track: string | null, step: GuideStep): string {
  if (step.section === "track") return track ?? "";
  const bucket = brain[step.section] as unknown as Record<string, string>;
  return (bucket[step.field] ?? "").toString();
}

/**
 * First step still missing a *required* answer. Optional steps left blank
 * never block this: they are used to decide routing/completion (finishOrRoute,
 * mount resume), not step-by-step navigation, and a blank optional answer
 * (e.g. price, proof, workaround) is a valid final state.
 */
export function nextGuideStep(brain: Brain, track: string | null): GuideStep | null {
  return GUIDE_STEPS.find((step) => !step.optional && step.empty(brain, track)) ?? null;
}

export function guideIsComplete(brain: Brain, track: string | null): boolean {
  return GUIDE_STEPS.filter((step) => !step.optional).every((step) => !step.empty(brain, track));
}

/** questionKey -> founder-facing question title, for the Files screen. Covers
 *  the first-run guide steps; a mission-only field falls back to
 *  humanizeQuestionKey (lib/uploads.ts) since it has no GUIDE_STEP entry. */
export const questionKeyTitles: Record<string, string> = Object.fromEntries(
  GUIDE_STEPS.map((step) => [toQuestionKey(step.section, step.field), step.title]),
);
