/**
 * Missions through the one-idea-per-screen Typeform shell.
 * Field screens, Yes/No-style approve screen, output last. Back crosses missions.
 */
import { useEffect, useState } from "react";
import { missions, missionCopy, type Mission } from "../mission-copy";
import { sectionWouldApprove, type Artifact, type Brain, type Config, type MissionSection } from "../types";
import { ChannelPicker } from "./ChannelPicker";
import { Output } from "./Output";
import type { QuestionIndexConfig, QuestionIndexItem } from "./QuestionIndexModal";
import { missionFieldStatus, missingMissionFields, resumeQuestion } from "../lib/mission-index";
import { toQuestionKey } from "../lib/uploads";
import { VoiceSampleGate } from "./VoiceSampleGate";
import { TypeformShell } from "./TypeformShell";
import { VoiceField } from "./VoiceField";

type ChoiceOption = { value: string; label: string };
type FieldKind = "text" | "multi" | "choice";
type FieldDef = {
  field: string;
  title: string;
  kind: FieldKind;
  maxLength: number;
  placeholder: string;
  options?: ChoiceOption[];
};

const STAGE_OPTIONS: ChoiceOption[] = [
  { value: "exploring", label: "Exploring" },
  { value: "building", label: "Building" },
  { value: "launched", label: "Launched" },
  { value: "growing", label: "Growing" },
];

const EVIDENCE_OPTIONS: ChoiceOption[] = [
  { value: "hypothesis", label: "Hypothesis" },
  { value: "supported", label: "Supported" },
];

const REVENUE_OPTIONS: ChoiceOption[] = [
  { value: "pre", label: "Pre-revenue" },
  { value: "under10k", label: "Under $10k a month" },
  { value: "10to50k", label: "$10k to $50k" },
  { value: "over50k", label: "Above $50k" },
];
const TRACK_OPTIONS: ChoiceOption[] = [
  { value: "b2b", label: "B2B" },
  { value: "b2c", label: "B2C" },
];
const MODEL_OPTIONS: ChoiceOption[] = [
  { value: "service", label: "Service" },
  { value: "ecommerce", label: "Ecommerce" },
  // Template PR #7: when neither fits, record the nearer one plus a flag,
  // never a third value.
  { value: "neither", label: "Neither - something else" },
];
const YESNO_OPTIONS: ChoiceOption[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];
const EMAIL_PROVIDER_OPTIONS: ChoiceOption[] = [
  { value: "google", label: "Google" },
  { value: "microsoft365", label: "Microsoft 365" },
  { value: "other", label: "Something else" },
];
const DOMAIN_OPTIONS: ChoiceOption[] = [
  { value: "warm", label: "Warm: real sending history" },
  { value: "fresh", label: "Fresh: needs setup" },
];
const IG_OPTIONS: ChoiceOption[] = [
  { value: "business", label: "Business or Creator" },
  { value: "personal", label: "Personal" },
];
const PRICING_OPTIONS: ChoiceOption[] = [
  { value: "one-off", label: "One-off" },
  { value: "subscription", label: "Subscription" },
  { value: "retainer", label: "Retainer" },
  { value: "per-unit", label: "Per unit" },
];

const MISSION_FIELDS: Record<Exclude<Mission, "output">, FieldDef[]> = {
  identity: [
    { field: "name", title: "Your name", kind: "text", maxLength: 40, placeholder: "Your first name" },
    { field: "venture", title: "Venture", kind: "text", maxLength: 80, placeholder: "Venture name" },
    { field: "role", title: "Role", kind: "text", maxLength: 60, placeholder: "Founder, CTO, ..." },
    { field: "team", title: "Just you, or others too?", kind: "multi", maxLength: 400, placeholder: "If there are others, who runs which part of the selling" },
    { field: "stage", title: "Stage", kind: "choice", maxLength: 20, placeholder: "", options: STAGE_OPTIONS },
    { field: "revenueBand", title: "Revenue today?", kind: "choice", maxLength: 10, placeholder: "", options: REVENUE_OPTIONS },
    { field: "track", title: "B2B or B2C?", kind: "choice", maxLength: 4, placeholder: "", options: TRACK_OPTIONS },
    { field: "hybrid", title: "Do you genuinely serve both?", kind: "choice", maxLength: 5, placeholder: "", options: YESNO_OPTIONS },
    { field: "model", title: "Service or ecommerce?", kind: "choice", maxLength: 10, placeholder: "", options: MODEL_OPTIONS },
    { field: "goal", title: "What needs to change?", kind: "multi", maxLength: 400, placeholder: "The change you are trying to make" },
  ],
  customer: [],
  offer: [
    { field: "description", title: "Offer", kind: "multi", maxLength: 600, placeholder: "What you promise" },
    { field: "delivery", title: "Delivery", kind: "multi", maxLength: 400, placeholder: "How it is delivered" },
    { field: "outcome", title: "Outcome", kind: "multi", maxLength: 400, placeholder: "What the customer gets" },
    { field: "why", title: "Why you, not the obvious alternative?", kind: "multi", maxLength: 400, placeholder: "The reason a customer picks you" },
    { field: "pricingModel", title: "How do you charge?", kind: "choice", maxLength: 14, placeholder: "", options: PRICING_OPTIONS },
    { field: "price", title: "Price", kind: "text", maxLength: 160, placeholder: "What you charge" },
    { field: "proof", title: "Proof: results, counts, customers", kind: "multi", maxLength: 600, placeholder: "The countable things, written as you said them" },
    { field: "cta", title: "Call to action", kind: "text", maxLength: 160, placeholder: "The next move" },
  ],
  context: [
    { field: "channelsActive", title: "Where do you publish today?", kind: "multi", maxLength: 400, placeholder: "Your active channels, or choose None yet below" },
    { field: "contentChannels", title: "Which channels should this pack use?", kind: "multi", maxLength: 200, placeholder: "Select the channels below" },
    { field: "channelsDormant", title: "Accounts you have but do not use?", kind: "multi", maxLength: 400, placeholder: "Dormant channels" },
    { field: "emailProvider", title: "What do you open your work email in?", kind: "choice", maxLength: 14, placeholder: "", options: EMAIL_PROVIDER_OPTIONS },
    { field: "domainStatus", title: "Is your sending domain warm?", kind: "choice", maxLength: 8, placeholder: "", options: DOMAIN_OPTIONS },
    { field: "igAccountType", title: "Is your Instagram personal?", kind: "choice", maxLength: 10, placeholder: "", options: IG_OPTIONS },
    { field: "customersNow", title: "Customers now", kind: "text", maxLength: 60, placeholder: "Count, or none yet" },
    { field: "avgMonthlyValue", title: "Average monthly value", kind: "text", maxLength: 60, placeholder: "Per customer, or none yet" },
    { field: "target90", title: "Target in 90 days", kind: "text", maxLength: 120, placeholder: "What more you want" },
    { field: "sourceMaterial", title: "Who do you read and follow?", kind: "multi", maxLength: 600, placeholder: "Five to ten accounts, competitors, newsletters" },
  ],
  voice: [
    { field: "tone", title: "Tone", kind: "multi", maxLength: 400, placeholder: "How it should sound" },
    { field: "boundaries", title: "Boundaries", kind: "multi", maxLength: 400, placeholder: "What it never says" },
    { field: "sample", title: "Sample", kind: "multi", maxLength: 600, placeholder: "One sample sentence" },
  ],
};

/**
 * Offer-to-look-first (template references/sources.md): at each big question,
 * offer to look at the founder's site before they type from memory.
 */
const LOOK_FIRST_FIELDS = new Set(["segment", "description", "why", "proof"]);

/** Customer fields fork on the track, exactly as the original intake did. */
function customerFields(track: "b2b" | "b2c"): FieldDef[] {
  return track === "b2c"
    ? [
        { field: "segment", title: "Who is this person?", kind: "multi", maxLength: 400, placeholder: "Age range, life stage, situation" },
        { field: "problem", title: "What do they want and cannot get?", kind: "multi", maxLength: 600, placeholder: "The desire, in their words" },
        { field: "outcome", title: "Desired outcome", kind: "multi", maxLength: 600, placeholder: "What better looks like" },
        { field: "attention", title: "Where do they spend attention?", kind: "multi", maxLength: 600, placeholder: "Platforms and accounts, specifically" },
        { field: "adjacent", title: "What do they already buy next to your product?", kind: "multi", maxLength: 600, placeholder: "Adjacent purchases" },
        { field: "evidenceStatus", title: "Evidence status", kind: "choice", maxLength: 12, placeholder: "", options: EVIDENCE_OPTIONS },
        { field: "evidence", title: "Evidence", kind: "multi", maxLength: 600, placeholder: "Required when evidence is supported" },
      ]
    : [
        { field: "segment", title: "Customer segment", kind: "text", maxLength: 120, placeholder: "Industry, size, revenue band, geography" },
        { field: "buyer", title: "Who is the individual you actually sell to?", kind: "text", maxLength: 160, placeholder: "Job title, seniority, department" },
        { field: "trigger", title: "What triggers them to start looking?", kind: "multi", maxLength: 400, placeholder: "The trigger events" },
        { field: "bestFit", title: "Three best-fit customers today", kind: "multi", maxLength: 400, placeholder: "Name three companies" },
        { field: "problem", title: "Problem", kind: "multi", maxLength: 600, placeholder: "The problem they hit" },
        { field: "outcome", title: "Desired outcome", kind: "multi", maxLength: 600, placeholder: "What better looks like" },
        { field: "workaround", title: "Current workaround", kind: "multi", maxLength: 600, placeholder: "How they cope today" },
        { field: "evidenceStatus", title: "Evidence status", kind: "choice", maxLength: 12, placeholder: "", options: EVIDENCE_OPTIONS },
        { field: "evidence", title: "Evidence", kind: "multi", maxLength: 600, placeholder: "Required when evidence is supported" },
      ];
}

type ScreenDef =
  | { mission: Exclude<Mission, "output">; kind: "field"; index: number }
  | { mission: Exclude<Mission, "output">; kind: "confirm" }
  | { mission: "output"; kind: "output" };

type ScreenCache = Record<"b2b" | "b2c", { screens: ScreenDef[]; fields: Record<string, FieldDef[]> }>;

const SCREEN_CACHE: ScreenCache = { b2b: { screens: [], fields: {} }, b2c: { screens: [], fields: {} } };

function visibleFields(mission: Exclude<Mission, "output">, track: "b2b" | "b2c"): FieldDef[] {
  const base = mission === "customer" ? customerFields(track) : MISSION_FIELDS[mission];
  if (mission === "identity") {
    return base.filter((f) => f.field !== "model" || track === "b2c");
  }
  if (mission === "context") {
    return base.filter((f) => {
      if (f.field === "emailProvider" || f.field === "domainStatus") return track === "b2b";
      if (f.field === "igAccountType") return track === "b2c";
      return true;
    });
  }
  return base;
}

function screensFor(track: "b2b" | "b2c") {
  const cache = SCREEN_CACHE[track];
  if (cache.screens.length) return cache;
  const screens: ScreenDef[] = [];
  for (const step of Object.entries(MISSION_FIELDS) as [Exclude<Mission, "output">, FieldDef[]][]) {
    const fields = visibleFields(step[0], track);
    cache.fields[step[0]] = fields;
    fields.forEach((_, index) => screens.push({ mission: step[0], kind: "field", index }));
    screens.push({ mission: step[0], kind: "confirm" });
  }
  screens.push({ mission: "output", kind: "output" });
  cache.screens = screens;
  return cache;
}

function screenIndexOf(mission: Mission, track: "b2b" | "b2c"): number {
  const screens = screensFor(track).screens;
  const found = screens.findIndex((screen) => screen.mission === mission);
  return found >= 0 ? found : screens.length - 1;
}

/** Open a mission on its first gap, or its confirm screen when the required answers are already in. */
function resumeIndex(mission: Mission, track: "b2b" | "b2c", brain: Brain): number {
  const { screens, fields } = screensFor(track);
  if (mission === "output") return screenIndexOf(mission, track);
  const target = resumeQuestion(brain, mission);
  const found = screens.findIndex((screen) => {
    if (screen.mission !== mission) return false;
    if (target === "confirm") return screen.kind === "confirm";
    return screen.kind === "field" && fields[mission]?.[screen.index]?.field === target;
  });
  return found >= 0 ? found : screenIndexOf(mission, track);
}

function fieldValue(draft: Brain, mission: Exclude<Mission, "output">, field: string): string {
  const section = draft[mission] as unknown as Record<string, unknown>;
  const raw = section[field];
  if (typeof raw === "boolean") return raw ? "yes" : "no";
  return typeof raw === "string" ? raw : "";
}

export function MissionTypeform(props: {
  mission: Mission;
  draft: Brain;
  saving: boolean;
  changed: boolean;
  config: Config;
  artifact: Artifact | null;
  artifactText: string;
  artifactStale: boolean;
  generating: boolean;
  generationRetry: boolean;
  accepting: boolean;
  acceptRetry: boolean;
  jobNeedsReconcile: boolean;
  verified: boolean;
  canRetrySave: boolean;
  onPatch: (section: Exclude<Mission, "output">, field: string, value: string | boolean | number) => void;
  onSave: () => void;
  onRetrySave: () => void;
  onApprove: (section: MissionSection) => void;
  onFinished: () => void;
  onTranscribe?: (blob: Blob, seconds: number) => Promise<string>;
  /** Offer-to-look-first (template references/sources.md): scrape the founder's site to draft the answer. */
  onLookFirst?: (url: string) => Promise<unknown>;
  onVoiceSamples?: () => Promise<{ samples: Array<{ id: string; name: string; chars: number; createdAt: string }>; min: number }>;
  onAddVoiceSample?: (name: string, text: string) => Promise<{ count: number }>;
  onDeleteVoiceSample?: (id: string) => Promise<{ count: number }>;
  onText: (value: string) => void;
  onGenerate: () => void;
  onReconcile: () => void;
  onAccept: () => void;
}) {
  const draft = props.draft;
  const track = draft.identity.track === "b2c" ? "b2c" : "b2b";
  const { screens, fields: fieldsByMission } = screensFor(track);
  const [idx, setIdx] = useState(() => resumeIndex(props.mission, track, draft));
  // Reset only when the entry mission changes. A track flip re-forks later
  // missions but must NOT teleport the walk back to the entry mission.
  // Resume on the first gap, or the confirm screen when required answers are in,
  // so an approved Identity is not replayed from question 1.
  useEffect(() => {
    setIdx(resumeIndex(props.mission, track, props.draft));
  }, [props.mission]);
  useEffect(() => {
    setIdx((current) => Math.min(current, screens.length - 1));
  }, [screens.length]);

  const [indexRequest, setIndexRequest] = useState(0);
  const [returnToReview, setReturnToReview] = useState(false);
  const total = screens.length;
  const current = screens[Math.min(Math.max(idx, 0), total - 1)]!;
  const go = (next: number) => {
    setIndexRequest(0);
    setIdx(Math.min(Math.max(next, 0), total - 1));
  };

  // Founder-facing position (Danny, 2026-09-21): the cumulative "43 of 43" counter
  // never said where inside a mission the founder stands. Map it explicitly.
  const missionScreens = screens.filter((screen) => screen.mission === current.mission);
  const posInMission = missionScreens.indexOf(current) + 1;
  const missionNumber = missions.indexOf(current.mission as Mission) + 1;
  const progressText = `Mission ${missionNumber} of ${missions.length} · step ${posInMission} of ${missionScreens.length}`;

  // Template PR #7 "Neither fits" follow-up for the Model choice, and the
  // offer-to-look-first state (sources.md). Both reset as the walk moves.
  const [neitherMode, setNeitherMode] = useState(false);
  const [nearestPick, setNearestPick] = useState<"" | "service" | "ecommerce">("");
  const [look, setLook] = useState<"idle" | "dismissed" | "done">("idle");
  const [lookUrl, setLookUrl] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookError, setLookError] = useState("");
  useEffect(() => {
    setNeitherMode(false);
    setNearestPick("");
    setLook("idle");
    setLookError("");
  }, [idx]);

  const sectionItems = (section: MissionSection): QuestionIndexItem[] => {
    const items: QuestionIndexItem[] = (fieldsByMission[section] ?? []).map((field) => ({
      id: section + ":" + field.field,
      title: field.title,
      ...missionFieldStatus(draft, section, field.field),
      detail: field.field === "channelsActive" ? "Choose None yet if you do not publish anywhere." : undefined,
      group: missionCopy[section].title,
    }));
    if (section === "voice") items.push({
      id: "voice:sampleCount", title: "Your writing samples",
      ...missionFieldStatus(draft, "voice", "sampleCount"),
      detail: String(draft.voice.sampleCount ?? 0) + " of 10 separate writing samples saved. The sample sentence is a different answer.",
      group: "Voice",
    });
    return items;
  };
  const openMissing = () => setIndexRequest((n) => n + 1);
  const jumpToQuestion = (id: string) => {
    const [section, field] = id.split(":");
    const target = screens.findIndex((screen) => screen.mission === section &&
      (field === "sampleCount" || field === "approval" ? screen.kind === "confirm" :
        screen.kind === "field" && fieldsByMission[section]?.[screen.index]?.field === field));
    if (target >= 0) { setReturnToReview(true); go(target); }
  };
  const indexItems = current.mission === "output"
    ? missions.filter((m): m is MissionSection => m !== "output").flatMap((section) => [
        ...sectionItems(section),
        { id: section + ":approval", title: "Approve " + missionCopy[section].title.toLowerCase(),
          answered: draft[section].approved, required: true, group: missionCopy[section].title },
      ])
    : sectionItems(current.mission);
  const questionIndex: QuestionIndexConfig = {
    title: current.mission === "output" ? "Your Brain questions" : missionCopy[current.mission].title + " questions",
    items: indexItems,
    onJump: jumpToQuestion,
    request: indexRequest,
  };
  const finishField = () => {
    if (current.mission === "output") return;
    if (!returnToReview) {
      go(idx + 1);
      if (screens[idx + 1]?.kind === "confirm" && missingMissionFields(draft, current.mission).length) openMissing();
      return;
    }
    const confirm = screens.findIndex((screen) => screen.mission === current.mission && screen.kind === "confirm");
    setReturnToReview(false);
    go(confirm);
    if (missingMissionFields(draft, current.mission).length) openMissing();
  };
  const approveOrReview = () => {
    if (current.mission === "output") return;
    if (!draft[current.mission].approved && missingMissionFields(draft, current.mission).length) {
      openMissing();
      return;
    }
    props.onApprove(current.mission);
  };

  if (current.kind === "output") {
    return (
      <TypeformShell
        kicker={`Mission ${missions.indexOf("output") + 1} · ${missionCopy.output.title}`}
        screen={total}
        total={total}
        progressText={`Mission ${missions.length} of ${missions.length} · your first output`}
        title="Your first output"
        questionIndex={questionIndex}
        continueLabel={
          props.artifactStale || props.generationRetry
            ? props.generating
              ? "Building the plan…"
              : "Rebuild the plan"
            : "Done"
        }
        continueDisabled={props.generating}
        showBack
        onBack={() => go(total - 2)}
        onContinue={
          props.artifactStale || props.generationRetry ? props.onGenerate : props.onFinished
        }
        saving={props.saving}
      >
        <Output
          config={props.config}
          brain={draft}
          artifact={props.artifact}
          text={props.artifactText}
          stale={props.artifactStale}
          generating={props.generating}
          generationRetry={props.generationRetry}
          accepting={props.accepting}
          acceptRetry={props.acceptRetry}
          jobNeedsReconcile={props.jobNeedsReconcile}
          verified={props.verified}
          onText={props.onText}
          onGenerate={props.onGenerate}
          onRetryGenerate={props.onGenerate}
          onReconcile={props.onReconcile}
          onAccept={props.onAccept}
          channels={draft.context.contentChannels}
          onChannels={(next) => props.onPatch("context", "contentChannels", next)}
        />
      </TypeformShell>
    );
  }

  const active = missionCopy[current.mission];
  const index = missions.indexOf(current.mission);
  const next = missions[index + 1];
  const sectionApproved = Boolean(draft[current.mission]?.approved);
  const canApprove = sectionWouldApprove(draft, current.mission as MissionSection);

  if (current.kind === "confirm" && current.mission === "voice") {
    return (
      <VoiceSampleGate
        shell={{
          kicker: `Mission ${index + 1} · ${active.title}`,
          screen: Math.min(idx + 1, total),
          total,
          sectionApproved,
          canApprove,
          questionIndex,
          progressText,
          onReviewMissing: openMissing,
          title: sectionApproved ? `${active.title} is locked in. Keep it?` : `Lock in ${active.title.toLowerCase()}?`,
          onBack: () => go(idx - 1),
          onAdvance: () => go(idx + 1),
          saving: props.saving,
          onApprove: approveOrReview,
          onSave: props.onSave,
          canRetrySave: props.canRetrySave,
          onRetrySave: props.onRetrySave,
          changed: props.changed,
          onCount: (n: number) => props.onPatch("voice", "sampleCount", n),
        }}
        listSamples={props.onVoiceSamples}
        addSample={props.onAddVoiceSample}
        deleteSample={props.onDeleteVoiceSample}
        storedCount={draft.voice.sampleCount}
      />
    );
  }

  if (current.kind === "confirm") {
    return (
      <TypeformShell
        kicker={`Mission ${index + 1} · ${active.title}`}
        screen={Math.min(idx + 1, total)}
        total={total}
        questionIndex={questionIndex}
        progressText={progressText}
        title={sectionApproved ? `${active.title} is locked in. Keep it?` : `Lock in ${active.title.toLowerCase()}?`}
        hideContinue={!sectionApproved}
        continueLabel={next ? `Next: ${missionCopy[next].title}` : "Continue"}
        showBack
        onBack={() => go(idx - 1)}
        onContinue={() => go(idx + 1)}
        saving={props.saving}
      >
        {canApprove || sectionApproved ? null : (
          <p className="entry-lede typeform-lede">
            A required answer is missing. Choose Approve mission to see exactly what needs attention, or Not yet to keep a draft.
          </p>
        )}
        <div className="typeform-choices mission-choices">
          <button
            type="button"
            className="typeform-choice yes"
            disabled={props.saving}
            onClick={approveOrReview}
          >
            {sectionApproved ? "Remove approval" : "Approve mission"}
          </button>
          <button
            type="button"
            className="typeform-choice no"
            disabled={props.saving}
            onClick={() => go(idx + 1)}
          >
            {sectionApproved ? "Keep as is" : "Not yet"}
          </button>
        </div>
        <div className="mission-save-row">
          <button
            type="button"
            className="mission-save"
            disabled={!props.changed || props.saving}
            onClick={props.onSave}
          >
            Save draft
          </button>
          {props.canRetrySave && !props.saving ? (
            <button type="button" className="mission-save" onClick={props.onRetrySave}>
              Retry save
            </button>
          ) : null}
        </div>
      </TypeformShell>
    );
  }

  const def = fieldsByMission[current.mission]![current.index]!;
  const value = fieldValue(draft, current.mission, def.field);
  const advance = finishField;
  const patchValue = (v: string) => {
    if (def.field === "hybrid") {
      props.onPatch(current.mission, "hybrid", v === "yes");
      return;
    }
    // "Neither" never becomes a third Model value: ask for the nearest plus
    // what the business really is, then flag it (template PR #7).
    if (def.field === "model" && v === "neither") {
      setNeitherMode(true);
      return;
    }
    if (def.field === "model" && neitherMode) {
      setNeitherMode(false);
      props.onPatch(current.mission, "modelNearestFit", true);
    }
    props.onPatch(current.mission, def.field, v);
  };
  const commitNeither = () => {
    if (!nearestPick) return;
    props.onPatch("identity", "modelNearestFit", true);
    props.onPatch("identity", "model", nearestPick);
    advance();
  };
  const runLookFirst = async () => {
    if (!props.onLookFirst || !lookUrl.trim()) return;
    setLooking(true);
    setLookError("");
    try {
      await props.onLookFirst(lookUrl.trim());
      setLook("done");
    } catch {
      setLookError("Could not read that site. Type the answer instead.");
    } finally {
      setLooking(false);
    }
  };

  return (
    <TypeformShell
      kicker={`Mission ${index + 1} · ${active.title}`}
      screen={Math.min(idx + 1, total)}
      total={total}
      progressText={progressText}
      questionIndex={questionIndex}
      title={def.title}
      continueLabel={returnToReview ? "Back to review" : "Continue"}
      showBack
      onBack={() => (idx === 0 ? props.onFinished() : go(idx - 1))}
      onContinue={advance}
      saving={props.saving}
    >
      {def.field === "model" && neitherMode ? (
        <div className="mission-neither">
          <div className="typeform-choices mission-choices">
            {(["service", "ecommerce"] as const).map((pick) => (
              <button
                key={pick}
                type="button"
                className={nearestPick === pick ? "typeform-choice picked" : "typeform-choice"}
                disabled={props.saving}
                onClick={() => setNearestPick(pick)}
              >
                {pick === "service" ? "Nearest: Service" : "Nearest: Ecommerce"}
              </button>
            ))}
          </div>
          {nearestPick ? (
            <VoiceField
              label="What is the business, in a few words?"
              value={draft.identity.modelNote}
              maxLength={200}
              placeholder="For example: a subscription app"
              multiline={false}
              serverTranscribe={props.onTranscribe}
              onEnter={commitNeither}
              onChange={(next) => props.onPatch("identity", "modelNote", next)}
              questionKey={toQuestionKey("identity", "modelNote")}
            />
          ) : null}
          <p className="entry-lede typeform-lede">
            We record the nearest fit and flag it on the Brain, never a third value.
          </p>
        </div>
      ) : def.kind === "choice" && def.options ? (
        <div className="typeform-choices mission-choices">
          {def.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={option.value === value ? "typeform-choice picked" : "typeform-choice"}
              disabled={props.saving}
              onClick={() => patchValue(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <>
          {def.kind !== "choice" &&
          value.trim() === "" &&
          look === "idle" &&
          LOOK_FIRST_FIELDS.has(def.field) &&
          props.onLookFirst &&
          props.config.siteImportEnabled ? (
            <div className="mission-look-first">
              <p className="entry-lede typeform-lede">
                Before you type this from memory, want me to look? I can read your website and draft the answer for you to correct.
              </p>
              <div className="mission-look-row">
                <input
                  className="mission-look-url"
                  type="url"
                  value={lookUrl}
                  maxLength={200}
                  placeholder="https://your-site.com"
                  onChange={(e) => setLookUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runLookFirst();
                  }}
                />
                <button
                  type="button"
                  className="typeform-choice yes"
                  disabled={looking || !lookUrl.trim()}
                  onClick={() => void runLookFirst()}
                >
                  {looking ? "Looking..." : "Look"}
                </button>
                <button
                  type="button"
                  className="typeform-choice"
                  disabled={looking}
                  onClick={() => setLook("dismissed")}
                >
                  I'll type it
                </button>
              </div>
              {lookError ? <p className="entry-error">{lookError}</p> : null}
            </div>
          ) : null}
          {look === "done" ? (
            <p className="entry-lede typeform-lede">Read your site. Correct anything that is off, then continue.</p>
          ) : null}
          {def.field === "contentChannels" ? (
            <ChannelPicker
              value={value}
              disabled={props.saving}
              onChange={(next) => props.onPatch("context", "contentChannels", next)}
            />
          ) : (
            <VoiceField
              label={def.title}
              value={value}
              maxLength={def.maxLength}
              placeholder={def.placeholder}
              multiline={def.kind === "multi"}
              serverTranscribe={props.onTranscribe}
              onEnter={def.kind === "text" ? advance : undefined}
              onChange={(next) => props.onPatch(current.mission, def.field, next)}
              questionKey={toQuestionKey(current.mission, def.field)}
            />
          )}
        </>
      )}
      {def.field === "channelsActive" ? (
        <button type="button" className={value === "None yet" ? "typeform-choice picked" : "typeform-choice"}
          disabled={props.saving} aria-pressed={value === "None yet"}
          onClick={() => props.onPatch("context", "channelsActive", "None yet")}>
          None yet
        </button>
      ) : null}
      {def.field === "evidence" && draft.customer.evidenceStatus !== "supported" ? (
        <p className="entry-lede typeform-lede">Only needed when evidence is supported.</p>
      ) : null}
    </TypeformShell>
  );
}
