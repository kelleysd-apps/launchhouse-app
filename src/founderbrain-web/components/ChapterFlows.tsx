/**
 * Later Typeform chapters: content (30 pieces / bottleneck / workflow) and outreach.
 * Maps onto existing missions without a second product surface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ContentAnswers,
  FounderTrack,
  GhlAnswers,
  OrientationPatch,
  OrientationState,
  OutreachAnswers,
} from "../../founderbrain-shared/orientation";
import type { UsageResponse } from "../types";
import type {
  GhlBookingLinkInput,
  GhlBookingLinkKey,
  GhlBookingLinkResult,
  GhlBookingLinks,
  GhlConnectionStatus,
  GhlPushResult,
} from "../../founderbrain-shared/ghl";
import { ApiError } from "../api";
import {
  contentScreens,
  contentTotal,
  ghlScreens,
  ghlTotal,
  outreachScreens,
  outreachTotal,
  type TypeformScreen,
} from "../orientation-copy";
import { TypeformShell } from "./TypeformShell";
import { ThirtyPieces } from "./ThirtyPieces";
import { MediaProvider } from "./Media";
import type { FounderBrainApi } from "../api";
import { splitPack } from "../pack";
import {
  accountLines,
  contentFieldBlock,
  contentPackBlock,
  contentSection,
  copyOk,
  emailDomainOk,
  instagramHandleOk,
  MIN_ACCOUNTS,
  MIN_PROSPECTS,
  missingPieceNumbers,
  outreachFieldBlock,
  parseContentPieces,
  piecesMissingMedia,
  prospectLines,
} from "../../founderbrain-shared/saturday-work.ts";
import { useMedia } from "./Media";
import {
  GhlConnectionPanel,
  ghlDestinationLabel,
  isVerifiedGhlIdentity,
} from "./GhlConnectionPanel";

type ChapterProps = {
  orientation: OrientationState;
  saving: boolean;
  error: string;
  onPatch: (patch: OrientationPatch) => Promise<void>;
  onFinished: () => void;
};

type PieceGate = { missingPieces: number[]; missingMedia: number[]; loaded: boolean };

function fieldValue(answers: object, key: string | undefined): string {
  if (!key) return "";
  const value = (answers as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function textReady(key: string, value: string, track: "b2b" | "b2c" | null): string | null {
  if (key === "instagramHandle") {
    if (!value.trim()) return null;
    return instagramHandleOk(value) ? null : "That handle is not usable. Leave it blank or fix it.";
  }
  if (key === "emailDomain") {
    return emailDomainOk(value) ? null : "Enter a real email domain before continuing.";
  }
  if (key === "copy") {
    return copyOk(value) ? null : "Write the outreach copy before continuing.";
  }
  if (key === "accounts") {
    const count = accountLines(value).length;
    return count >= MIN_ACCOUNTS ? null : `Enter ${MIN_ACCOUNTS} accounts. ${count} so far.`;
  }
  if (key === "prospects") {
    const count = prospectLines(value).length;
    return count >= MIN_PROSPECTS
      ? null
      : `Enter at least ${MIN_PROSPECTS} prospects with a name and an email. ${count} so far.`;
  }
  if (key === "bottleneck" && value.trim().length < 2)
    return "Name the bottleneck before continuing.";
  return track ? null : null;
}

function ThirtyGate({
  content,
  onReport,
}: {
  content: string;
  onReport: (gate: PieceGate) => void;
}) {
  const media = useMedia();
  useEffect(() => {
    const pieces = parseContentPieces(contentSection(content));
    const ready = (media?.items ?? [])
      .filter((item) => item.status === "ready" && item.pieceN)
      .map((item) => item.pieceN as number);
    onReport({
      missingPieces: missingPieceNumbers(pieces),
      missingMedia: piecesMissingMedia(pieces, ready),
      loaded: Boolean(media?.loaded),
    });
  }, [content, media?.items, media?.loaded, onReport]);
  return null;
}

function ScreenBody({
  screen,
  textValue,
  onText,
  confirmValue,
  onConfirm,
}: {
  screen: TypeformScreen;
  textValue: string;
  onText: (value: string) => void;
  confirmValue: boolean;
  onConfirm: (value: boolean) => void;
}) {
  return (
    <>
      {screen.body.map((line) => (
        <p key={line} className="entry-lede typeform-lede">
          {line}
        </p>
      ))}
      {screen.confirm ? (
        <label className="typeform-confirm">
          <input
            type="checkbox"
            checked={confirmValue}
            onChange={(event) => onConfirm(event.target.checked)}
          />
          <span>{screen.confirm.label}</span>
        </label>
      ) : null}
      {screen.textField ? (
        <label className={screen.textField.multiline ? "typeform-field wide" : "typeform-field"}>
          <span>{screen.textField.label}</span>
          {screen.textField.multiline ? (
            <textarea
              value={textValue}
              placeholder={screen.textField.placeholder}
              onChange={(event) => onText(event.target.value)}
              maxLength={screen.textField.maxLength ?? 8000}
              rows={8}
            />
          ) : (
            <input
              type="text"
              value={textValue}
              placeholder={screen.textField.placeholder}
              onChange={(event) => onText(event.target.value)}
              maxLength={screen.textField.maxLength ?? 500}
            />
          )}
          {screen.textField.hint ? <small>{screen.textField.hint}</small> : null}
        </label>
      ) : null}
      {screen.externalLink ? (
        <a
          className="typeform-external"
          href={screen.externalLink.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {screen.externalLink.label}
        </a>
      ) : null}
    </>
  );
}

export function ContentChapter({
  orientation,
  channels,
  onChannels,
  saving,
  error,
  onPatch,
  onFinished,
  artifactText = "",
  generating = false,
  revising = false,
  onGenerate,
  onRevise,
  mediaApi = null,
}: ChapterProps & {
  channels: string;
  onChannels: (next: string) => void;
  mediaApi?: FounderBrainApi | null;
  artifactText?: string;
  generating?: boolean;
  revising?: boolean;
  onGenerate?: () => void;
  onRevise?: (
    pieces: Array<{ n: number; text: string; feedback: string }>,
  ) => Promise<Array<{ n: number; text: string }>>;
}) {
  const screens = useMemo(() => contentScreens(orientation.track), [orientation.track]);
  const screen = Math.min(Math.max(orientation.contentScreen, 1), contentTotal);
  const current = screens[screen - 1]!;
  const textKey = current.textField?.key;
  const [text, setText] = useState(fieldValue(orientation.contentAnswers, textKey));
  const [confirm, setConfirm] = useState(false);
  const [localError, setLocalError] = useState("");
  const [pieceGate, setPieceGate] = useState<PieceGate>({
    missingPieces: [1],
    missingMedia: [],
    loaded: false,
  });
  const onPieceGate = useCallback((gate: PieceGate) => setPieceGate(gate), []);

  useEffect(() => {
    setText(fieldValue(orientation.contentAnswers, textKey));
    if (current.confirm) {
      const key = current.confirm.key as keyof ContentAnswers;
      setConfirm(Boolean(orientation.contentAnswers[key]));
    } else setConfirm(false);
  }, [screen, orientation.contentAnswers, current.confirm, textKey]);

  const needsConfirm = Boolean(current.confirm);
  const needsText = Boolean(current.textField);
  const isChoice = Boolean(current.choices?.length);
  const isThirty = current.id === "thirty";
  const textProblem = textKey ? textReady(textKey, text, orientation.track) : null;
  const readyNumbers = pieceGate.loaded
    ? parseContentPieces(contentSection(artifactText))
        .map((piece) => piece.n)
        .filter((n) => !pieceGate.missingMedia.includes(n))
    : [];
  const packProblem = contentPackBlock(artifactText, readyNumbers);
  const continueDisabled =
    (isThirty &&
      (Boolean(packProblem) || generating || (Boolean(mediaApi) && !pieceGate.loaded))) ||
    (needsConfirm && !confirm) ||
    (needsText && Boolean(textProblem));

  async function persist(patch: OrientationPatch) {
    setLocalError("");
    try {
      await onPatch(patch);
    } catch (err) {
      setLocalError(err instanceof ApiError ? err.message : "Could not save progress. Try again.");
      throw new Error("save_failed", { cause: err });
    }
  }

  async function continueForward() {
    try {
      if (isChoice) return;
      if (textProblem) {
        setLocalError(textProblem);
        return;
      }
      const answers: ContentAnswers = { ...orientation.contentAnswers };
      if (current.confirm) {
        (answers as Record<string, boolean | string | undefined>)[current.confirm.key] = confirm;
      }
      if (current.textField) {
        (answers as Record<string, boolean | string | undefined>)[current.textField.key] =
          text.trim();
      }
      if (screen >= contentTotal) {
        const blocked = contentFieldBlock({ ...orientation, contentAnswers: answers });
        if (blocked || packProblem) {
          setLocalError(blocked ?? packProblem ?? "Finish the content work first.");
          return;
        }
        await persist({
          contentScreen: contentTotal,
          contentComplete: true,
          contentAnswers: answers,
        });
        onFinished();
        return;
      }
      await persist({ contentScreen: screen + 1, contentAnswers: answers });
    } catch {
      /* localError set */
    }
  }

  async function choose(value: string) {
    try {
      if (current.id === "track") {
        await persist({ track: value as FounderTrack, contentScreen: screen + 1 });
        return;
      }
      if (current.id === "workflow") {
        const answers = { ...orientation.contentAnswers, workflow: value };
        const blocked = contentFieldBlock({ ...orientation, contentAnswers: answers });
        if (blocked || packProblem) {
          setLocalError(blocked ?? packProblem ?? "Finish the content work first.");
          return;
        }
        await persist({
          contentScreen: contentTotal,
          contentComplete: true,
          contentAnswers: answers,
        });
        onFinished();
        return;
      }
      await persist({
        contentScreen: screen + 1,
        contentAnswers: { ...orientation.contentAnswers, workflow: value },
      });
    } catch {
      /* localError set */
    }
  }

  async function goBack() {
    if (screen <= 1) return;
    try {
      await persist({ contentScreen: screen - 1 });
    } catch {
      /* localError set */
    }
  }

  const thirty = (
    <ThirtyPieces
      content={splitPack(artifactText).content}
      channels={channels}
      onChannels={onChannels}
      generating={generating}
      revising={revising}
      onGenerate={() => onGenerate?.()}
      onRevise={async (pieces) => (await onRevise?.(pieces)) ?? []}
      missingMedia={pieceGate.missingMedia}
    />
  );

  return (
    <TypeformShell
      kicker="Atlanta prep · Content chapter"
      screen={screen}
      total={contentTotal}
      title={current.title}
      steps={screens.map((item) => item.title)}
      onJump={(next) => void persist({ contentScreen: next }).catch(() => undefined)}
      onSkip={
        current.confirm && !confirm && screen < contentTotal
          ? () => void persist({ contentScreen: screen + 1 }).catch(() => undefined)
          : undefined
      }
      continueLabel="Continue"
      hideContinue={isChoice}
      continueDisabled={continueDisabled}
      showBack={screen > 1}
      onBack={() => void goBack()}
      onContinue={() => void continueForward()}
      saving={saving}
    >
      {mediaApi ? (
        <MediaProvider api={mediaApi}>
          <ThirtyGate content={artifactText} onReport={onPieceGate} />
          {isThirty ? thirty : null}
        </MediaProvider>
      ) : null}
      {isThirty && !mediaApi ? thirty : null}
      {isThirty ? (
        packProblem ? (
          <p className="entry-lede typeform-lede">{packProblem}</p>
        ) : null
      ) : (
        <ScreenBody
          screen={current}
          textValue={text}
          onText={setText}
          confirmValue={confirm}
          onConfirm={setConfirm}
        />
      )}
      {isChoice ? <p className="entry-lede typeform-lede">Choose below.</p> : null}
      {current.choices ? (
        <div className="typeform-choices">
          {current.choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className="typeform-choice"
              disabled={saving}
              onClick={() => void choose(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
      {(error || localError) && (
        <p className="entry-error" role="alert">
          {error || localError}
        </p>
      )}
    </TypeformShell>
  );
}

export function OutreachChapter({ orientation, saving, error, onPatch, onFinished }: ChapterProps) {
  const screens = useMemo(() => outreachScreens(orientation.track), [orientation.track]);
  const screen = Math.min(Math.max(orientation.outreachScreen, 1), outreachTotal);
  const current = screens[screen - 1]!;
  const textKey = current.textField?.key;
  const [text, setText] = useState(fieldValue(orientation.outreachAnswers, textKey));
  const [confirm, setConfirm] = useState(false);
  const lastOutreach = screen >= outreachTotal;
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    setText(fieldValue(orientation.outreachAnswers, textKey));
    if (current.confirm) {
      const key = current.confirm.key as keyof OutreachAnswers;
      setConfirm(Boolean(orientation.outreachAnswers[key]));
    } else setConfirm(false);
  }, [screen, orientation.outreachAnswers, current.confirm, textKey]);

  const textProblem = textKey ? textReady(textKey, text, orientation.track) : null;
  const continueDisabled = (Boolean(current.confirm) && !confirm) || Boolean(textProblem);

  async function persist(patch: OrientationPatch) {
    setLocalError("");
    try {
      await onPatch(patch);
    } catch (err) {
      setLocalError(err instanceof ApiError ? err.message : "Could not save progress. Try again.");
      throw new Error("save_failed", { cause: err });
    }
  }

  async function continueForward() {
    try {
      if (textProblem) {
        setLocalError(textProblem);
        return;
      }
      const answers: OutreachAnswers = { ...orientation.outreachAnswers };
      if (current.confirm) {
        (answers as Record<string, boolean | string | undefined>)[current.confirm.key] = confirm;
      }
      if (current.textField) {
        (answers as Record<string, boolean | string | undefined>)[current.textField.key] =
          text.trim();
      }
      if (screen >= outreachTotal) {
        const blocked = outreachFieldBlock({ ...orientation, outreachAnswers: answers });
        if (blocked) {
          setLocalError(blocked);
          return;
        }
        await persist({
          outreachScreen: outreachTotal,
          outreachComplete: true,
          outreachAnswers: answers,
        });
        onFinished();
        return;
      }
      await persist({ outreachScreen: screen + 1, outreachAnswers: answers });
    } catch {
      /* localError set */
    }
  }

  async function goBack() {
    if (screen <= 1) return;
    try {
      await persist({ outreachScreen: screen - 1 });
    } catch {
      /* localError set */
    }
  }

  return (
    <TypeformShell
      kicker="Atlanta prep · Outreach chapter"
      screen={screen}
      total={outreachTotal}
      title={current.title}
      steps={screens.map((item) => item.title)}
      onJump={(next) => void persist({ outreachScreen: next }).catch(() => undefined)}
      onSkip={
        current.confirm && !confirm && !lastOutreach
          ? () => void persist({ outreachScreen: screen + 1 }).catch(() => undefined)
          : current.confirm && !confirm && lastOutreach
            ? () => onFinished()
            : undefined
      }
      skipLabel={lastOutreach ? "Not yet, back to the hub" : "Skip for now"}
      continueLabel={current.continueLabel ?? "Continue"}
      continueDisabled={continueDisabled}
      showBack={screen > 1}
      onBack={() => void goBack()}
      onContinue={() => void continueForward()}
      saving={saving}
    >
      <ScreenBody
        screen={current}
        textValue={text}
        onText={setText}
        confirmValue={confirm}
        onConfirm={setConfirm}
      />
      {(error || localError) && (
        <p className="entry-error" role="alert">
          {error || localError}
        </p>
      )}
    </TypeformShell>
  );
}

const money = (microUsd: number): string => {
  const usd = microUsd / 1_000_000;
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
};

/** Metered price lines for the pre-connect summary. Text only: matches the Typeform body. */
function UsagePriceLines({ usage }: { usage: UsageResponse }) {
  const ai = usage.ai;
  const fc = usage.firecrawl;
  if (ai.events === 0 && fc.scrapes === 0) {
    return (
      <p className="entry-lede typeform-lede">
        Nothing metered yet. Your price stays $0.00 until you use AI or import a website.
      </p>
    );
  }
  return (
    <div>
      {ai.events > 0 ? (
        <p className="entry-lede typeform-lede">
          AI: {ai.inputTokens.toLocaleString()} tokens in, {ai.outputTokens.toLocaleString()} out
          across {ai.events} run{ai.events === 1 ? "" : "s"} → {money(ai.priceMicroUsd)}
        </p>
      ) : null}
      {fc.scrapes > 0 ? (
        <p className="entry-lede typeform-lede">
          Pages read from your website: {fc.credits.toLocaleString()} credit
          {fc.credits === 1 ? "" : "s"} across {fc.scrapes} import{fc.scrapes === 1 ? "" : "s"} →{" "}
          {money(fc.priceMicroUsd)}
        </p>
      ) : null}
      <p className="entry-lede typeform-lede">
        <strong>Final price: {money(usage.totalMicroUsd)}</strong>
      </p>
    </div>
  );
}

function UsagePrice({ loadUsage }: { loadUsage?: () => Promise<UsageResponse> }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!loadUsage) {
      setFailed(true);
      return;
    }
    void loadUsage().then(
      (value) => {
        if (alive) setUsage(value);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [loadUsage]);
  if (failed) {
    return (
      <p className="entry-lede typeform-lede">
        Price unavailable right now. It still carries with your account when you sync.
      </p>
    );
  }
  if (!usage) return <p className="entry-lede typeform-lede">Tallying your usage…</p>;
  return <UsagePriceLines usage={usage} />;
}

export function GhlChapter({
  orientation,
  saving,
  error,
  onPatch,
  onFinished,
  connectEnabled = false,
  connecting = false,
  disconnecting = false,
  connection,
  statusVerified = false,
  statusLoading = false,
  statusError = "",
  connectionGeneration = 0,
  bookingLinks,
  bookingLoading = false,
  bookingError = "",
  linkSavingKey = null,
  onRefreshStatus,
  onDisconnect,
  onLoadBookingLinks,
  onSaveBookingLink,
  onConnect,
  loadUsage,
  onGhlPush,
  packAccepted = false,
  packReady = false,
  onReviewPack,
}: ChapterProps & {
  connectEnabled?: boolean;
  connecting?: boolean;
  disconnecting?: boolean;
  connection: GhlConnectionStatus | null;
  statusVerified?: boolean;
  statusLoading?: boolean;
  statusError?: string;
  connectionGeneration?: number;
  bookingLinks: GhlBookingLinks | null;
  bookingLoading?: boolean;
  bookingError?: string;
  linkSavingKey?: GhlBookingLinkKey | null;
  packAccepted?: boolean;
  packReady?: boolean;
  onReviewPack?: () => void;
  onGhlPush?: () => Promise<GhlPushResult | null>;
  onConnect?: () => void | Promise<void>;
  onRefreshStatus: () => void | Promise<void>;
  onDisconnect: () => Promise<boolean>;
  onLoadBookingLinks: () => void | Promise<void>;
  onSaveBookingLink: (
    input: Omit<GhlBookingLinkInput, "connectionId">,
  ) => Promise<GhlBookingLinkResult | null>;
  loadUsage?: () => Promise<UsageResponse>;
}) {
  const screens = useMemo(
    () => ghlScreens(orientation.ghlAnswers.hasAccount),
    [orientation.ghlAnswers.hasAccount],
  );
  const screen = Math.min(Math.max(orientation.ghlScreen, 1), ghlTotal);
  const current = screens[screen - 1]!;
  const [localError, setLocalError] = useState("");
  const isChoice = Boolean(current.choices?.length);
  const isConnect = current.id === "ghl-connect";
  const identityVerified = statusVerified && isVerifiedGhlIdentity(connection);
  const [pushing, setPushing] = useState(false);
  const pushingRef = useRef<symbol | null>(null);
  const [pushResult, setPushResult] = useState<GhlPushResult | null>(null);
  const [pushError, setPushError] = useState("");

  useEffect(() => {
    pushingRef.current = null;
    setPushing(false);
    setPushResult(null);
    setPushError("");
  }, [connectionGeneration]);

  async function persist(patch: OrientationPatch) {
    setLocalError("");
    try {
      await onPatch(patch);
    } catch {
      setLocalError("Could not save progress. Try again.");
      throw new Error("save_failed");
    }
  }

  async function continueForward() {
    try {
      if (isChoice) return;
      if (screen >= ghlTotal) {
        await persist({
          ghlScreen: ghlTotal,
          ghlComplete: true,
          ghlAnswers: identityVerified
            ? { ...orientation.ghlAnswers, connected: true }
            : orientation.ghlAnswers,
        });
        onFinished();
        return;
      }
      await persist({ ghlScreen: screen + 1, ghlAnswers: orientation.ghlAnswers });
    } catch {
      /* localError set */
    }
  }

  async function choose(value: string) {
    try {
      const answers: GhlAnswers = {
        ...orientation.ghlAnswers,
        hasAccount: value === "yes",
      };
      await persist({ ghlScreen: screen + 1, ghlAnswers: answers });
    } catch {
      /* localError set */
    }
  }

  async function goBack() {
    if (screen <= 1) return;
    try {
      await persist({ ghlScreen: screen - 1 });
    } catch {
      /* localError set */
    }
  }

  async function pushCopy() {
    if (pushingRef.current) return;
    const operation = Symbol("ghl-push-ui");
    pushingRef.current = operation;
    setPushing(true);
    setPushError("");
    try {
      const result = await (onGhlPush?.() ?? Promise.reject(new Error("unavailable")));
      if (pushingRef.current !== operation || !result) return;
      setPushResult(result);
    } catch (e: unknown) {
      if (pushingRef.current !== operation) return;
      setPushError(
        e instanceof ApiError
          ? String(e.message).slice(0, 200)
          : "Something went wrong starting the push. Try again.",
      );
    } finally {
      if (pushingRef.current === operation) {
        pushingRef.current = null;
        setPushing(false);
      }
    }
  }

  const connectActionDisabled =
    isConnect &&
    (statusLoading || connecting || disconnecting || (!connection?.connected && !connectEnabled));
  const continueLabel = isConnect
    ? identityVerified
      ? "Back to Home"
      : connection?.connected === false
        ? connectEnabled
          ? "Connect GoHighLevel"
          : "Connect is not configured"
        : "Refresh status"
    : "Continue";

  return (
    <TypeformShell
      kicker="Atlanta prep · GoHighLevel"
      screen={screen}
      total={ghlTotal}
      title={current.title}
      continueLabel={continueLabel}
      hideContinue={isChoice}
      continueDisabled={connectActionDisabled}
      showBack={screen > 1}
      onBack={() => void goBack()}
      onContinue={() => {
        if (isConnect && !identityVerified) {
          if (connection?.connected === false && onConnect) void onConnect();
          else void onRefreshStatus();
          return;
        }
        void continueForward();
      }}
      saving={saving || connecting || disconnecting}
    >
      <ScreenBody
        screen={current}
        textValue=""
        onText={() => undefined}
        confirmValue={false}
        onConfirm={() => undefined}
      />
      {current.usage ? <UsagePrice loadUsage={loadUsage} /> : null}
      {isChoice ? <p className="entry-lede typeform-lede">Choose below.</p> : null}
      {isConnect ? (
        <GhlConnectionPanel
          connection={connection}
          statusVerified={statusVerified}
          statusLoading={statusLoading}
          statusError={statusError}
          connecting={connecting}
          disconnecting={disconnecting}
          connectEnabled={connectEnabled}
          generation={connectionGeneration}
          bookingLinks={bookingLinks}
          bookingLoading={bookingLoading}
          bookingError={bookingError}
          linkSavingKey={linkSavingKey}
          onRefresh={onRefreshStatus}
          onConnect={onConnect ?? (() => undefined)}
          onDisconnect={onDisconnect}
          onLoadBookingLinks={onLoadBookingLinks}
          onSaveBookingLink={onSaveBookingLink}
        />
      ) : null}
      {isConnect && identityVerified && !pushResult?.proven && !packAccepted ? (
        <div className="mission-save-row ghl-workflow-card">
          <p className="entry-lede typeform-lede">
            Review and accept the content, outreach, and 90 day plan before anything is written to
            GoHighLevel.
          </p>
          {packReady ? (
            <button type="button" className="typeform-external" onClick={onReviewPack}>
              Review the pack
            </button>
          ) : (
            <p className="entry-lede typeform-lede">
              Use Update to V2 first. That writes the pack you review here.
            </p>
          )}
        </div>
      ) : null}
      {isConnect && identityVerified && packAccepted && !pushResult?.proven ? (
        <div className="mission-save-row ghl-workflow-card">
          <button
            type="button"
            className="typeform-external"
            onClick={() => void pushCopy()}
            disabled={pushing || saving || disconnecting}
          >
            {pushing ? "Writing your copy into GoHighLevel…" : "Fill my workflow copy"}
          </button>
          <p>
            Copy goes to {ghlDestinationLabel(connection)}. Booking-link transfer is the separate
            control above and does not regenerate copy or use AI.
          </p>
        </div>
      ) : null}
      {pushResult ? (
        <div className={`ghl-push-receipt ${pushResult.proven ? "verified" : "unverified"}`}>
          <h3>{pushResult.proven ? "Workflow copy verified" : "Workflow copy needs a check"}</h3>
          <p>
            Destination: <strong>{ghlDestinationLabel(pushResult.connection)}</strong>
            {pushResult.connection.locationId ? ` (${pushResult.connection.locationId})` : ""}.
          </p>
          <p>
            Snapshot {pushResult.snapshot} · first pack {pushResult.firstPack} ·{" "}
            {pushResult.pushed.length} values written
            {pushResult.skipped.length ? ` · ${pushResult.skipped.length} existing values preserved` : ""}.
          </p>
          {!pushResult.proven ? (
            <p role="alert">
              GoHighLevel did not verify the exact copy. Refresh status, check the destination, and
              retry. This is not marked complete.
            </p>
          ) : null}
          {pushResult.clinicPaste.length ? (
            <div className="ghl-pending-links">
              <strong>Add the booking link in the form above.</strong>
              <ul>
                {pushResult.clinicPaste.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {pushResult.held.length ? (
            <div className="ghl-pending-links">
              <strong>Still held:</strong>
              <ul>
                {pushResult.held.map((item) => (
                  <li key={`${item.code}:${item.name}`}>
                    {item.name}: {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {pushError ? (
        <p className="entry-error" role="alert">
          {pushError}
        </p>
      ) : null}
      {current.choices ? (
        <div className="typeform-choices">
          {current.choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className="typeform-choice"
              disabled={saving}
              onClick={() => void choose(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
      {(error || localError) && (
        <p className="entry-error" role="alert">
          {error || localError}
        </p>
      )}
    </TypeformShell>
  );
}
