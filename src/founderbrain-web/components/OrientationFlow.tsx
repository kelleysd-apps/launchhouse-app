/**
 * First-run Typeform: name, ready, optional website, then Founder Brain intake.
 * Cursor-based so Back can reopen earlier answers.
 */
import { useEffect, useRef, useState } from "react";
import type { Brain } from "../types";
import { TypeformShell } from "./TypeformShell";
import { VoiceField } from "./VoiceField";
import type { QuestionIndexConfig } from "./QuestionIndexModal";
import {
  GUIDE_STEPS,
  nextGuideStep,
  readStepValue,
  type GuideStep,
} from "../guide-intake";
import { guideSequence, resolveInitialCursor } from "../lib/intake-navigation";
import { guideIndexItems } from "../lib/intake-index";
import { toQuestionKey } from "../lib/uploads";

const NAME_KEY_BASE = "founderbrain.what-to-call-you";
const YES_KEY_BASE = "founderbrain.welcome-yes";
const SITE_KEY_BASE = "founderbrain.website-asked";
const CURSOR_KEY_BASE = "founderbrain.guide-cursor";

/**
 * Session-storage keys must be scoped per workspace: two workspaces (or two
 * users sharing a browser profile) previously shared one global cursor/name/
 * site key, so switching workspace could resume mid-guide with the wrong
 * answers. `workspaceKey` should be the current `state.workspaceId`.
 */
function scopedKey(base: string, workspaceKey: string): string {
  return workspaceKey ? `${base}::${workspaceKey}` : base;
}

function readKey(key: string): string {
  try {
    return sessionStorage.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}
function writeKey(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

type Proposal = {
  identity?: Record<string, string>;
  customer?: Record<string, string>;
  offer?: Record<string, string>;
  voice?: Record<string, string>;
  track?: "b2b" | "b2c";
  logoUrl?: string;
};

function normalizeSiteUrl(raw: string): string {
  let value = raw.trim();
  if (!value || value === "https://" || value === "http://") return "";
  value = value.replace(/^https?:\/\//i, "");
  return `https://${value}`;
}

function ReadingSite() {
  const lines = [
    "Reading your site...",
    "Finding what you sell...",
    "Looking for who you serve...",
    "Pulling the story together...",
  ];
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setIndex((n) => (n + 1) % lines.length), 1600);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="site-reading" role="status">
      <div className="site-reading-ring" aria-hidden="true" />
      <p className="site-reading-line">{lines[index]}</p>
    </div>
  );
}

const sequence = guideSequence;

export function OrientationFlow({
  screen,
  saving,
  error,
  welcomeDone,
  brain,
  track,
  siteImportEnabled,
  workspaceKey,
  onNamed,
  onAdvance,
  onComplete,
  onDecline,
  onFill,
  onApplyIntake,
  onTrack,
  onImport,
  onTranscribe,
}: {
  screen: number;
  saving: boolean;
  error: string;
  welcomeDone: boolean;
  brain: Brain;
  track: string | null;
  siteImportEnabled: boolean;
  /** Scopes sessionStorage keys (name/yes/site/cursor) so switching workspace
   *  never resumes with another workspace's saved progress. Pass `state.workspaceId`. */
  workspaceKey: string;
  onNamed: (name: string) => void;
  onAdvance: (nextScreen: number) => void | Promise<void>;
  onComplete: () => void | Promise<void>;
  onDecline: () => void;
  /** Resolves with the freshly saved Brain (not the pre-save one) so callers
   *  right after a save never act on a stale closed-over `brain` prop. */
  onFill: (section: "identity" | "customer" | "offer" | "voice", field: string, value: string) => Promise<Brain>;
  onApplyIntake: (proposal: Proposal) => Promise<void>;
  onTrack: (value: "b2b" | "b2c") => Promise<Brain>;
  onImport: (url: string) => Promise<{ proposal: Proposal; logoUrl?: string }>;
  onTranscribe?: (blob: Blob, seconds: number) => Promise<string>;
}) {
  const NAME_KEY = scopedKey(NAME_KEY_BASE, workspaceKey);
  const YES_KEY = scopedKey(YES_KEY_BASE, workspaceKey);
  const SITE_KEY = scopedKey(SITE_KEY_BASE, workspaceKey);
  const CURSOR_KEY = scopedKey(CURSOR_KEY_BASE, workspaceKey);

  const [name, setName] = useState(() => brain.identity.name.trim() || readKey(NAME_KEY));
  const [localError, setLocalError] = useState("");
  const [wantSite, setWantSite] = useState(readKey(SITE_KEY) === "1");
  const [siteUrl, setSiteUrl] = useState("https://");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  // Bump to request the question index modal open in missing-only mode
  // (e.g. from finishOrRoute, a stale-cursor mount check, or the modal's own
  // trigger). See QuestionIndexConfig.request.
  const [indexRequest, setIndexRequest] = useState(0);
  // Set true by a direct question-index jump so the *next* successful save
  // returns to the final review/missing state instead of replaying every
  // remaining intake screen in order.
  const [returnFromIndex, setReturnFromIndex] = useState(false);
  const [cursor, setCursor] = useState(() =>
    resolveInitialCursor({
      storedCursorRaw: readKey(CURSOR_KEY),
      welcomeDone,
      yesAccepted: readKey(YES_KEY) === "1",
      screen,
      includeUrl: wantSite || readKey(SITE_KEY) === "1",
      brain,
      track,
    }),
  );

  const includeUrl = wantSite || readKey(SITE_KEY) === "1";
  const seq = sequence(includeUrl);
  const total = seq.length;
  const safe = Math.min(Math.max(cursor, 0), Math.max(total - 1, 0));
  const current = seq[safe] ?? "name";
  const guideId = current.startsWith("g:") ? current.slice(2) : "";
  const step = GUIDE_STEPS.find((item) => item.id === guideId) ?? null;
  const locked = saving || busy;
  const showBack = safe > 0;

  useEffect(() => {
    writeKey(CURSOR_KEY, String(safe));
  }, [safe]);

  useEffect(() => {
    if (!step) {
      setDraft("");
      return;
    }
    setDraft(readStepValue(brain, track, step));
  }, [step?.id]);

  // The stored cursor must never sit on a filled guide step while an earlier
  // guide step is still empty: that state only arises from a stale cursor
  // (workspace deleted, storage reset, or an import failure that shifted the
  // sequence). Previously this silently teleported back to the first empty
  // step, which could itself go stale again and loop (#66). Instead, stay put
  // and open the missing-only question index so the founder sees exactly
  // what's left and can jump to any of it directly, rather than being bounced.
  const clampedRef = useRef(false);
  useEffect(() => {
    if (clampedRef.current) return;
    clampedRef.current = true;
    const empty = nextGuideStep(brain, track);
    if (!empty || !step) return;
    if (empty.id === step.id) return;
    const emptyIdx = seq.indexOf(`g:${empty.id}`);
    if (emptyIdx >= 0 && emptyIdx < safe) {
      setIndexRequest((n) => n + 1);
    }
    // Run once on mount: brain and cursor are read before first paint.
  }, []);

  function moveTo(next: number) {
    setLocalError("");
    setProposal(null);
    const clamped = Math.min(Math.max(next, 0), Math.max(seq.length - 1, 0));
    writeKey(CURSOR_KEY, String(clamped));
    setCursor(clamped);
  }

  function goBack() {
    moveTo(safe - 1);
  }

  /** Leave the intake when the guide is complete; otherwise surface exactly
   *  what's missing instead of silently completing a partial guide (#66). */
  async function finishOrRoute(latestBrain: Brain = brain, latestTrack: string | null = track) {
    const empty = nextGuideStep(latestBrain, latestTrack);
    if (!empty && latestBrain.identity.name.trim()) {
      if (submitting.current) return;
      submitting.current = true;
      setBusy(true);
      try { await onComplete(); }
      catch { setLocalError("Could not finish setup. Your answers are saved. Try again."); }
      finally { submitting.current = false; setBusy(false); }
      return;
    }
    // Answers are still missing. Previously this bounced the founder straight
    // to the first empty step, which could itself loop (#66). Instead stay on
    // the current (final) screen and open the missing-only question index,
    // grouped by section, so every gap is visible at once and each is a
    // direct jump rather than a forced walk.
    setIndexRequest((n) => n + 1);
  }

  /** Land at the final review/complete screen after an index-driven edit,
   *  opening the missing-only index if answers are still outstanding rather
   *  than replaying the rest of the intake in sequence. */
  function landAtReview(latestBrain: Brain, latestTrack: string | null = track) {
    moveTo(seq.length - 1);
    if (nextGuideStep(latestBrain, latestTrack) || !latestBrain.identity.name.trim()) {
      setIndexRequest((n) => n + 1);
    }
  }

  // `latestBrain` lets the very last commitStep hand over the just-saved Brain
  // instead of the `brain` prop, which is still the pre-save value until the
  // parent re-renders (#final-step-stale-brain).
  function goNext(latestBrain: Brain = brain, latestTrack: string | null = track) {
    if (returnFromIndex) {
      setReturnFromIndex(false);
      landAtReview(latestBrain, latestTrack);
      return;
    }
    if (safe >= seq.length - 1) {
      finishOrRoute(latestBrain, latestTrack);
      return;
    }
    moveTo(safe + 1);
  }

  /** Direct jump from the question index. Persists any typed-but-uncommitted
   *  draft on the *current* guide step first (onFill/onTrack) so the jump
   *  never silently discards local input, and only navigates on success. On
   *  failure the error stays and the founder stays on the current screen --
   *  the index modal itself already closed immediately on click, so the
   *  error is visible right where it happened. */
  async function jumpToQuestion(id: string) {
    if (locked || submitting.current) return;
    const key = GUIDE_STEPS.some((item) => item.id === id) ? `g:${id}` : id;
    const target = seq.indexOf(key);
    if (target < 0) return;
    setReturnFromIndex(true);
    if (target === safe) return;
    if (current === "name" && name.trim() !== brain.identity.name.trim()) {
      submitting.current = true;
      setBusy(true);
      try {
        await onFill("identity", "name", name.trim());
        writeKey(NAME_KEY, name.trim());
      } catch {
        setLocalError("Could not save. Try again.");
        return;
      } finally {
        submitting.current = false;
        setBusy(false);
      }
    }
    if (step && step.kind !== "choices") {
      const next = draft.trim();
      if (next !== readStepValue(brain, track, step).trim()) {
        submitting.current = true;
        setBusy(true);
        try {
          if (step.section === "track") await onTrack(next as "b2b" | "b2c");
          else await onFill(step.section, step.field, next);
        } catch {
          setLocalError("Could not save. Try again.");
          submitting.current = false;
          setBusy(false);
          return;
        }
        submitting.current = false;
        setBusy(false);
      }
    }
    moveTo(target);
  }

  async function continueWithName() {
    const next = name.trim();
    if (!next) {
      setLocalError("Tell us what to call you.");
      return;
    }
    if (locked || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const saved = await onFill("identity", "name", next);
      writeKey(NAME_KEY, next);
      onNamed(next);
      await onAdvance(2);
      goNext(saved);
    } catch {
      setLocalError("Could not save. Try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function sayYes() {
    writeKey(YES_KEY, "1");
    try {
      await onAdvance(2);
      goNext();
    } catch {
      setLocalError("Could not save. Try again.");
    }
  }

  async function scrapeSite() {
    const url = normalizeSiteUrl(siteUrl);
    if (!url) {
      setLocalError("Add the rest of the address.");
      return;
    }
    if (!siteImportEnabled) {
      writeKey(SITE_KEY, "skip");
      setWantSite(false);
      // Dropping site-url shifts every later index; land on venture explicitly
      // so the venture question is never skipped (#66).
      moveTo(sequence(false).indexOf("g:venture"));
      return;
    }
    setBusy(true);
    setLocalError("");
    try {
      const result = await onImport(url);
      setProposal({ ...result.proposal, logoUrl: result.logoUrl });
      writeKey(SITE_KEY, "1");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Could not read that website. We'll ask instead.");
      writeKey(SITE_KEY, "skip");
      setWantSite(false);
      // Same index shift as the disabled-import path: never skip venture (#66).
      moveTo(sequence(false).indexOf("g:venture"));
    } finally {
      setBusy(false);
    }
  }

  async function applyProposal() {
    if (!proposal) return;
    setBusy(true);
    try {
      await onApplyIntake(proposal);
      if (proposal.track) await onTrack(proposal.track);
      setProposal(null);
      goNext();
    } catch {
      setLocalError("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function commitStep(stepNow: GuideStep, value: string) {
    if (locked || submitting.current) return;
    const next = value.trim();
    if (!next && !stepNow.optional) {
      setLocalError("Give us something to go on.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      // Track fresh state as we go: onFill resolves with the Brain the server
      // actually saved, which is the only reliable state to route the very
      // last step against (the `brain` prop can still be one save behind).
      let latestBrain = brain;
      // Empty optional answers must also save, so clearing a prior answer sticks.
      if (next || stepNow.optional) {
        if (stepNow.section === "track") latestBrain = await onTrack(next as "b2b" | "b2c");
        else latestBrain = await onFill(stepNow.section, stepNow.field, next);
      }
      goNext(latestBrain, stepNow.section === "track" ? next : track);
    } catch {
      setLocalError("Could not save. Try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const indexItems = guideIndexItems({
    brain,
    track,
    name,
    readyAnswered: welcomeDone || readKey(YES_KEY) === "1",
    siteAnswered: readKey(SITE_KEY) !== "",
  });
  if (includeUrl) indexItems.push({
    id: "site-url", title: "Website address", required: false,
    answered: Boolean(normalizeSiteUrl(siteUrl)), group: "Welcome",
    detail: "Optional. Read your site or continue with your own answers.",
  });
  const questionIndex: QuestionIndexConfig = {
    title: "Founder Brain questions",
    items: indexItems,
    onJump: (id) => void jumpToQuestion(id),
    request: indexRequest,
  };

  const frame = {
    screen: safe + 1,
    total,
    showBack,
    onBack: goBack,
    saving: locked,
    questionIndex,
  };

  if (current === "name") {
    return (
      <TypeformShell
        kicker=""
        title="Welcome... what should we call you?"
        continueLabel={returnFromIndex ? "Save and review" : "Continue"}
        continueDisabled={!name.trim()}
        immersive
        onContinue={() => void continueWithName()}
        {...frame}
      >
        <VoiceField
          label="What should we call you?"
          value={name}
          maxLength={40}
          placeholder="Your first name"
          serverTranscribe={onTranscribe}
          onChange={(value) => {
            setName(value);
            setLocalError("");
          }}
          onEnter={() => void continueWithName()}
          questionKey={toQuestionKey("identity", "name")}
        />
        {(error || localError) && (
          <p className="entry-error" role="alert">
            {error || localError}
          </p>
        )}
      </TypeformShell>
    );
  }

  if (current === "ready") {
    return (
      <TypeformShell
        kicker=""
        title={`Hi ${name.trim() || "there"}... ready to start?`}
        immersive
        hideContinue
        onContinue={() => void sayYes()}
        {...frame}
      >
        <div className="typeform-choices welcome-choices">
          <button className="typeform-choice yes" type="button" onClick={() => void sayYes()} disabled={locked}>
            Yes
          </button>
          <button className="typeform-choice no" type="button" onClick={onDecline} disabled={locked}>
            No
          </button>
        </div>
        {(error || localError) && (
          <p className="entry-error" role="alert">
            {error || localError}
          </p>
        )}
      </TypeformShell>
    );
  }

  if (current === "site-ask") {
    return (
      <TypeformShell
        kicker=""
        title="Do you have a website?"
        immersive
        hideContinue
        onContinue={() => undefined}
        {...frame}
      >
        <div className="typeform-choices welcome-choices">
          <button
            className="typeform-choice yes"
            type="button"
            disabled={locked}
            onClick={() => {
              writeKey(SITE_KEY, "1");
              setWantSite(true);
              moveTo(safe + 1);
            }}
          >
            Yes
          </button>
          <button
            className="typeform-choice no"
            type="button"
            disabled={locked}
            onClick={() => {
              writeKey(SITE_KEY, "skip");
              setWantSite(false);
              moveTo(safe + 1);
            }}
          >
            No
          </button>
        </div>
      </TypeformShell>
    );
  }

  if (current === "site-url" && proposal) {
    const rows = [
      ["Business", proposal.identity?.venture],
      ["Sells", proposal.offer?.description],
      ["Buyer", proposal.customer?.segment],
      ["Problem", proposal.customer?.problem],
      ["Price", proposal.offer?.price],
    ].filter((row): row is [string, string] => Boolean(row[1]));
    return (
      <TypeformShell
        kicker=""
        title="Does this look right?"
        immersive
        hideContinue
        onContinue={() => void applyProposal()}
        {...frame}
      >
        <article className="site-card">
          {proposal.logoUrl ? (
            <img className="site-card-logo" src={proposal.logoUrl} alt="" />
          ) : (
            <div className="site-card-logo fallback" aria-hidden="true">
              {(proposal.identity?.venture || "B").slice(0, 1)}
            </div>
          )}
          <div className="site-card-body">
            <h2>{proposal.identity?.venture || "Your business"}</h2>
            <dl>
              {rows.map(([label, value]) => (
                <div key={label} className="site-card-row">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </article>
        <div className="typeform-choices welcome-choices">
          <button className="typeform-choice yes" type="button" disabled={locked} onClick={() => void applyProposal()}>
            Yes
          </button>
          <button
            className="typeform-choice no"
            type="button"
            disabled={locked}
            onClick={() => {
              setProposal(null);
              writeKey(SITE_KEY, "skip");
              setWantSite(false);
            }}
          >
            No, I'll type it
          </button>
        </div>
        {(error || localError) && (
          <p className="entry-error" role="alert">
            {error || localError}
          </p>
        )}
      </TypeformShell>
    );
  }

  if (current === "site-url") {
    return (
      <TypeformShell
        kicker=""
        title="What's the address?"
        continueLabel="Continue"
        continueDisabled={busy || !normalizeSiteUrl(siteUrl)}
        immersive
        onContinue={() => void scrapeSite()}
        {...frame}
      >
        {busy ? (
          <ReadingSite />
        ) : (
          <VoiceField
            label="Website"
            value={siteUrl}
            maxLength={200}
            placeholder="your-site.com"
            serverTranscribe={onTranscribe}
            onChange={(value) => {
              if (value.startsWith("https://") || value.startsWith("http://")) setSiteUrl(value);
              else setSiteUrl(`https://${value.replace(/^\/+/, "")}`);
            }}
            onEnter={() => void scrapeSite()}
            questionKey={toQuestionKey("identity", "siteurl")}
          />
        )}
        {!siteImportEnabled && !busy ? (
          <p className="entry-lede typeform-lede">If we cannot read it, we will just ask you instead.</p>
        ) : null}
        {(error || localError) && (
          <p className="entry-error" role="alert">
            {error || localError}
          </p>
        )}
      </TypeformShell>
    );
  }

  if (!step) {
    // The explicit final confirmation also handles returning founders whose
    // answers are saved but whose first-login completion flag never persisted.
    const guideComplete = nextGuideStep(brain, track) === null && Boolean(brain.identity.name.trim());
    if (guideComplete && !welcomeDone) {
      return (
        <TypeformShell
          kicker=""
          title="Your answers are saved. Continue..."
          continueLabel="Continue"
          immersive
          onContinue={() => void finishOrRoute()}
          {...frame}
        >
          <p className="entry-lede typeform-lede">Nothing else is needed. Continue to finish setting up.</p>
          {(error || localError) && (
            <p className="entry-error" role="alert">
              {error || localError}
            </p>
          )}
        </TypeformShell>
      );
    }
    return (
      <TypeformShell
        kicker=""
        title="Review your answers."
        continueLabel={guideComplete ? "Finish review" : "Review missing answers"}
        immersive
        onContinue={() => finishOrRoute()}
        {...frame}
      >
        {(error || localError) && (
          <p className="entry-error" role="alert">
            {error || localError}
          </p>
        )}
      </TypeformShell>
    );
  }

  if (step.kind === "choices") {
    // Template PR #8: the track is confirmed from who pays, never asked cold.
    const buyer = step.id === "track" ? brain.customer.segment.trim() : "";
    const title =
      step.id === "track" && buyer
        ? `You said "${buyer}" pays you. Sell to other businesses, or individual consumers?`
        : step.title;
    return (
      <TypeformShell
        kicker=""
        title={title}
        immersive
        hideContinue
        onContinue={() => undefined}
        {...frame}
      >
        <div className="typeform-choices welcome-choices">
          {step.choices?.map((choice) => (
            <button
              key={choice.value}
              className="typeform-choice yes"
              type="button"
              disabled={locked}
              onClick={() => void commitStep(step, choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
        {(error || localError) && (
          <p className="entry-error" role="alert">
            {error || localError}
          </p>
        )}
      </TypeformShell>
    );
  }

  return (
    <TypeformShell
      kicker=""
      title={step.title}
      continueLabel={returnFromIndex ? "Save and review" : step.optional ? "Skip or continue" : "Continue"}
      continueDisabled={!step.optional && !draft.trim()}
      immersive
      onContinue={() => void commitStep(step, draft)}
      {...frame}
    >
      <VoiceField
        label={step.title}
        value={draft}
        maxLength={step.kind === "long" ? 400 : 160}
        placeholder={step.placeholder ?? ""}
        multiline={step.kind === "long"}
        serverTranscribe={onTranscribe}
        onChange={setDraft}
        onEnter={step.kind === "long" ? undefined : () => void commitStep(step, draft)}
        questionKey={step.section === "track" ? undefined : toQuestionKey(step.section, step.field)}
      />
      {(error || localError) && (
        <p className="entry-error" role="alert">
          {error || localError}
        </p>
      )}
    </TypeformShell>
  );
}
