/**
 * FounderBrain app state machine: auth/session, workspace load, save/conflict,
 * jobs, and handlers. Presentation stays in app.tsx + ./components.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, FounderBrainApi } from "./api";
import type {
  GhlBookingLinkInput,
  GhlBookingLinkKey,
  GhlBookingLinkResult,
  GhlBookingLinks,
  GhlConnectionStatus,
  GhlPushResult,
} from "../founderbrain-shared/ghl";
import { createHexclave, type HexclaveSession } from "./hexclave";
import {
  emptyBrain,
  sectionWouldApprove,
  type Artifact,
  type Brain,
  type BrainState,
  type Config,
  type HistoryItem,
  type Job,
  type MissionSection,
  type RoutineDraft,
  type RoutineSettings,
  type UploadItem,
  type UploadsAi,
  type UsageResponse,
} from "./types";
import { MAX_DOWNLOAD_ALL_BYTES, dedupeFilename, formatBytes } from "./lib/uploads";
import { isPack, splitPack } from "./pack";
import { zipSync, strToU8 } from "fflate";
import {
  PENDING_JOB_STORAGE_KEY,
  nextSaveOperation,
  patchBrain,
  settleSaveDecision,
} from "./lib/brain-draft";
import { prepareGenerateJob, runExclusive, type LockRef } from "./lib/generate-job";
import {
  captureGhlAsyncGuard,
  isGhlAsyncGuardCurrent,
  type GhlAsyncEpochs,
} from "./lib/ghl-async-guard";
import {
  JOB_POLL_DEADLINE_MS,
  JOB_POLL_INITIAL_WAIT_MS,
  interpretJobStatus,
  interpretPollTimeout,
  nextPollWaitMs,
  stillRunningNotice,
  unresolvedJobNotice,
} from "./lib/job-poll";
import { type Mission } from "./mission-copy";
import { type View } from "./components/MissionRail";
import {
  emptyOrientationState,
  isFirstLoginComplete,
  type OrientationPatch,
  type OrientationState,
} from "../founderbrain-shared/orientation";

export function useFounderBrainApp() {
  const [config, setConfig] = useState<Config | null>(null);
  // Sign-in state is four things: which mode we are in (config), whether Hexclave has a
  // session for this browser (session: undefined while asking, null when signed out),
  // whether the API accepted that session (email), and whether it has since lapsed
  // (sessionExpired). The Hexclave SDK holds the refresh token; we never store a token.
  const [session, setSession] = useState<HexclaveSession | null | undefined>(undefined);
  const [email, setEmail] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [demoEntered, setDemoEntered] = useState(false);
  const [state, setState] = useState<BrainState | null>(null);
  const [draft, setDraft] = useState<Brain>(emptyBrain());
  const [orientation, setOrientation] = useState<OrientationState | null>(null);
  const [orientationSaving, setOrientationSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [ghlConnection, setGhlConnection] = useState<GhlConnectionStatus | null>(null);
  const [ghlStatusVerified, setGhlStatusVerified] = useState(false);
  const [ghlStatusLoading, setGhlStatusLoading] = useState(false);
  const [ghlStatusError, setGhlStatusError] = useState("");
  const [ghlConnectionGeneration, setGhlConnectionGeneration] = useState(0);
  const [ghlBookingLinks, setGhlBookingLinks] = useState<GhlBookingLinks | null>(null);
  const [ghlBookingLoading, setGhlBookingLoading] = useState(false);
  const [ghlBookingError, setGhlBookingError] = useState("");
  const [ghlLinkSavingKey, setGhlLinkSavingKey] = useState<GhlBookingLinkKey | null>(null);
  const [view, setView] = useState<View>(() =>
    window.location.pathname === "/gmail/callback" ? "gmail" : "atlanta",
  );
  const [mission, setMission] = useState<Mission>("identity");
  const [changed, setChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [routineDrafts, setRoutineDrafts] = useState<RoutineDraft[]>([]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadsAi, setUploadsAi] = useState<UploadsAi>({ budgetBytes: 0, usedBytes: 0 });
  const uploadsLoaded = useRef(false);
  // Settings are written by the routines toggle flow; the value is not rendered
  // anywhere while the feature stays draft-only (ROUTINES_ENABLED off).
  const [, setRoutineSettings] = useState<RoutineSettings | null>(null);
  const routineLoaded = useRef(false);
  const [comparison, setComparison] = useState<BrainState | null>(null);
  const [conflict, setConflict] = useState<BrainState | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [artifactText, setArtifactText] = useState("");
  const [artifactStale, setArtifactStale] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationRetry, setGenerationRetry] = useState(false);
  const [acceptRetry, setAcceptRetry] = useState(false);
  const [jobNeedsReconcile, setJobNeedsReconcile] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const latestDraft = useRef(draft);
  const sessionEpoch = useRef(0);
  const workspaceEpoch = useRef(0);
  const workspaceIdentity = useRef<string | null>(null);
  const connectionGeneration = useRef(0);
  const ghlConnectionRef = useRef<GhlConnectionStatus | null>(null);
  const ghlStatusVerifiedRef = useRef(false);
  const oauthHandled = useRef(false);
  const statusOperation = useRef<symbol | null>(null);
  const connectOperation = useRef<symbol | null>(null);
  const disconnectOperation = useRef<symbol | null>(null);
  const pushOperation = useRef<symbol | null>(null);
  const bookingLoadOperation = useRef<symbol | null>(null);
  const bookingWriteOperation = useRef<symbol | null>(null);
  // Bumped around Connect writes so an in-flight workspace GET cannot put the
  // old "not connected" orientation back on screen after OAuth succeeds.
  const orientationEpoch = useRef(0);
  const saveOperation = useRef<{ brain: Brain; expectedVersion: number; key: string } | null>(null);
  const jobOperation = useRef<{ expectedVersion: number; key: string } | null>(null);
  // Synchronous duplicate-call guard for generate(); see lib/generate-job.ts.
  const generatingRef: LockRef = useRef(false);
  const acceptOperation = useRef<{
    id: string;
    text: string;
    expectedVersion: number;
    key: string;
  } | null>(null);
  const closeConflict = useRef<HTMLButtonElement | null>(null);
  const hexclave = useMemo(
    () => (config?.hexclave ? createHexclave(config.hexclave) : null),
    [config],
  );
  const api = useMemo(() => {
    if (!config) return null;
    if (config.authMode === "local-demo") return new FounderBrainApi(null, true);
    return session ? new FounderBrainApi(session.getToken) : null;
  }, [config, session]);
  const friendlyError = (err: unknown) => {
    if (err instanceof ApiError && err.code === "session_expired") setSessionExpired(true);
    return err instanceof ApiError
      ? err.message
      : "Something went wrong. Your draft has not been discarded.";
  };
  const jobStorage = PENDING_JOB_STORAGE_KEY;
  const currentGhlEpochs = (): GhlAsyncEpochs => ({
    session: sessionEpoch.current,
    workspace: workspaceEpoch.current,
    connection: connectionGeneration.current,
  });
  const captureGhlGuard = () => captureGhlAsyncGuard(currentGhlEpochs());
  const ghlGuardCurrent = (
    guard: GhlAsyncEpochs,
    scope: "workspace" | "connection" = "connection",
  ) => isGhlAsyncGuardCurrent(guard, currentGhlEpochs(), scope);
  const resetGhlLinks = () => {
    setGhlBookingLinks(null);
    setGhlBookingLoading(false);
    setGhlBookingError("");
    setGhlLinkSavingKey(null);
  };
  const bumpConnectionGeneration = () => {
    connectionGeneration.current += 1;
    setGhlConnectionGeneration(connectionGeneration.current);
    resetGhlLinks();
  };
  const connectionIdentity = (status: GhlConnectionStatus | null) =>
    status?.connected ? `${status.connectionId ?? ""}:${status.locationId ?? ""}` : "disconnected";
  const applyGhlConnection = (status: GhlConnectionStatus, guard: GhlAsyncEpochs): boolean => {
    if (!ghlGuardCurrent(guard)) return false;
    if (connectionIdentity(ghlConnectionRef.current) !== connectionIdentity(status)) {
      bumpConnectionGeneration();
      pushOperation.current = null;
      bookingLoadOperation.current = null;
      bookingWriteOperation.current = null;
    }
    ghlConnectionRef.current = status;
    ghlStatusVerifiedRef.current = true;
    setGhlConnection(status);
    setGhlStatusVerified(true);
    setGhlStatusError("");
    return true;
  };
  const invalidateGhlIdentity = () => {
    bumpConnectionGeneration();
    pushOperation.current = null;
    bookingLoadOperation.current = null;
    bookingWriteOperation.current = null;
    ghlStatusVerifiedRef.current = false;
    setGhlStatusVerified(false);
    setGhlStatusError(
      "The GoHighLevel connection changed during that request. Refresh status before writing again.",
    );
  };
  const clearPrivate = () => {
    sessionEpoch.current += 1;
    workspaceEpoch.current += 1;
    workspaceIdentity.current = null;
    connectionGeneration.current += 1;
    setGhlConnectionGeneration(connectionGeneration.current);
    ghlConnectionRef.current = null;
    ghlStatusVerifiedRef.current = false;
    statusOperation.current = null;
    connectOperation.current = null;
    disconnectOperation.current = null;
    pushOperation.current = null;
    bookingLoadOperation.current = null;
    bookingWriteOperation.current = null;
    saveOperation.current = null;
    jobOperation.current = null;
    acceptOperation.current = null;
    window.sessionStorage.removeItem(jobStorage);
    setState(null);
    setOrientation(null);
    setOrientationSaving(false);
    setConnecting(false);
    setDisconnecting(false);
    setGhlConnection(null);
    setGhlStatusVerified(false);
    setGhlStatusLoading(false);
    setGhlStatusError("");
    resetGhlLinks();
    latestDraft.current = emptyBrain();
    setDraft(latestDraft.current);
    setChanged(false);
    setHistory([]);
    setComparison(null);
    setConflict(null);
    setArtifact(null);
    setArtifactText("");
    setArtifactStale(false);
    setGenerating(false);
    setGenerationRetry(false);
    setAcceptRetry(false);
    setJobNeedsReconcile(false);
    setDeleteOpen(false);
    setDeleteText("");
    setUploads([]);
    setUploadsAi({ budgetBytes: 0, usedBytes: 0 });
    uploadsLoaded.current = false;
  };

  useEffect(() => {
    void (async () => {
      try {
        setConfig(await new FounderBrainApi().config());
      } catch {
        setError("FounderBrain configuration is unavailable. Try again shortly.");
      }
    })();
  }, []);
  // Ask Hexclave whether this browser is signed in. On the way back from the hosted sign-in
  // page this is also what completes the sign-in. Failure to reach Hexclave is not "signed
  // out": it is shown as an error so nobody is bounced to a sign-in page they cannot use.
  useEffect(() => {
    if (!hexclave) return;
    const epoch = sessionEpoch.current;
    void (async () => {
      try {
        const current = await hexclave.currentSession();
        if (epoch === sessionEpoch.current) setSession(current);
      } catch {
        if (epoch === sessionEpoch.current) {
          setError("Sign-in service is unavailable. Try again shortly.");
        }
      }
    })();
  }, [hexclave]);
  // A Hexclave session is a claim; `/api/me` is the API confirming it verified the token and
  // telling us who it saw. In local demo mode the person has to click through first, so the
  // demo is never mistaken for real sign-in.
  useEffect(() => {
    if (!api || !config) return;
    if (config.authMode === "local-demo" && !demoEntered) return;
    const epoch = sessionEpoch.current;
    void (async () => {
      try {
        const me = await api.me();
        if (epoch !== sessionEpoch.current) return;
        if (workspaceIdentity.current !== me.email) {
          workspaceIdentity.current = me.email;
          workspaceEpoch.current += 1;
          bumpConnectionGeneration();
          ghlConnectionRef.current = null;
          ghlStatusVerifiedRef.current = false;
          setGhlConnection(null);
          setGhlStatusVerified(false);
          setGhlStatusError("");
        }
        setEmail(me.email);
        setSessionExpired(false);
      } catch (err) {
        if (epoch === sessionEpoch.current) setError(friendlyError(err));
      }
    })();
  }, [api, config, demoEntered]);
  useEffect(() => {
    if (api && email) void loadWorkspace();
    if (api && email && config?.routinesEnabled) void loadRoutines();
    if (api && email && config?.uploadsEnabled) void loadUploads();
  }, [api, email]);
  // Tokens used (Danny, 2026-09-21): keep the account chip's spend line fresh
  // wherever AI can run (missions run generation, chapters run site reads).
  useEffect(() => {
    if (api && email) void loadUsage();
  }, [api, email, view]);
  useEffect(() => {
    if (!conflict) return undefined;
    const prior = document.activeElement as HTMLElement | null;
    closeConflict.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") keepMyDraft();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prior?.focus();
    };
  }, [conflict]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!changed || saving) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [changed, saving]);

  async function loadWorkspace() {
    if (!api) return;
    const epoch = sessionEpoch.current;
    const workspace = workspaceEpoch.current;
    const epochOrientation = orientationEpoch.current;
    setError("");
    try {
      const [nextState, output] = await Promise.all([api.brain(), api.artifact()]);
      let nextOrientation;
      try {
        nextOrientation = await api.orientation();
      } catch (err) {
        if (!(err instanceof ApiError && (err.status === 404 || err.status === 503))) throw err;
        nextOrientation = emptyOrientationState();
      }
      if (epoch !== sessionEpoch.current || workspace !== workspaceEpoch.current) return;
      setState(nextState);
      if (orientationEpoch.current === epochOrientation) setOrientation(nextOrientation);
      latestDraft.current = nextState.brain;
      setDraft(nextState.brain);
      setChanged(false);
      setArtifact(output.artifact ?? nextState.artifact ?? null);
      setArtifactText((output.artifact ?? nextState.artifact)?.text ?? "");
      setArtifactStale(output.stale);
      const pendingJob = window.sessionStorage.getItem(jobStorage);
      if (pendingJob) void pollJob(pendingJob, epoch);
      if (nextOrientation.ghlAnswers.connected !== true) void healGhlConnection();
    } catch (err) {
      if (epoch === sessionEpoch.current && workspace === workspaceEpoch.current)
        setError(friendlyError(err));
    }
  }

  async function saveOrientation(patch: OrientationPatch): Promise<OrientationState> {
    if (!api) throw new Error("api_unavailable");
    const epoch = sessionEpoch.current;
    orientationEpoch.current += 1;
    const writeEpoch = orientationEpoch.current;
    setOrientationSaving(true);
    setError("");
    try {
      const saved = await api.saveOrientation(patch);
      // Always apply the server response: it is fresher than any local state,
      // even when the session epoch moved mid-request (token refresh). The old
      // guard dropped this update and left the client stale (#69).
      // A newer orientation write that started after this one still wins.
      if (writeEpoch === orientationEpoch.current) setOrientation(saved);
      return saved;
    } catch (err) {
      if (epoch === sessionEpoch.current) setError(friendlyError(err));
      throw err;
    } finally {
      setOrientationSaving(false);
    }
  }

  async function refreshGhlStatus(options: { announce?: boolean } = {}) {
    if (!api || statusOperation.current) return null;
    const operation = Symbol("ghl-status");
    statusOperation.current = operation;
    const guard = captureGhlGuard();
    ghlStatusVerifiedRef.current = false;
    setGhlStatusVerified(false);
    setGhlStatusLoading(true);
    setGhlStatusError("");
    try {
      const status = await api.oauthStatus();
      if (!applyGhlConnection(status, guard)) return null;
      if (options.announce) {
        setNotice(
          status.connected
            ? "GoHighLevel connection refreshed."
            : "No GoHighLevel subaccount is connected.",
        );
      }
      return status;
    } catch {
      if (ghlGuardCurrent(guard, "workspace")) {
        setGhlStatusError(
          "FounderBrain could not verify the connected GoHighLevel subaccount. Your saved work is still here. Refresh status to enable external writes.",
        );
      }
      return null;
    } finally {
      if (statusOperation.current === operation) {
        statusOperation.current = null;
        if (ghlGuardCurrent(guard, "workspace")) setGhlStatusLoading(false);
      }
    }
  }

  /** Read-only healing: live CRM state can correct the screen, but never writes stale orientation. */
  async function healGhlConnection() {
    const status = await refreshGhlStatus();
    if (status?.connected) setNotice("GoHighLevel is already connected.");
  }

  useEffect(() => {
    if (api && email && view === "ghl") void refreshGhlStatus();
  }, [api, email, view]);

  useEffect(() => {
    if (!api || !email || oauthHandled.current) return;
    if (window.location.pathname !== "/oauth/callback") return;
    oauthHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthState = params.get("state");
    const denied = params.has("error")
      ? (params.get("error") || "access_denied").slice(0, 200)
      : null;
    window.history.replaceState({}, "", "/");
    setView("ghl");
    if (!oauthState || (!denied && !code)) {
      setError("GoHighLevel Connect did not finish. Try Connect again.");
      return;
    }
    if (!denied) {
      bumpConnectionGeneration();
      ghlStatusVerifiedRef.current = false;
      setGhlStatusVerified(false);
      orientationEpoch.current += 1;
    }
    const guard = captureGhlGuard();
    const operation = Symbol("ghl-connect-callback");
    connectOperation.current = operation;
    setConnecting(true);
    setError("");
    void (async () => {
      try {
        if (denied) {
          await api.completeOauth({ error: denied, state: oauthState });
          if (ghlGuardCurrent(guard)) {
            setError("GoHighLevel Connect was cancelled. Start Connect again when you are ready.");
          }
          return;
        }
        const completed = await api.completeOauth({ code: code!, state: oauthState });
        if (!ghlGuardCurrent(guard)) return;
        if (!applyGhlConnection(completed, guard)) return;
        orientationEpoch.current += 1;
        setOrientation(completed.orientation);
        setNotice("GoHighLevel connected.");
      } catch (err) {
        if (ghlGuardCurrent(guard)) setError(friendlyError(err));
      } finally {
        if (connectOperation.current === operation) {
          connectOperation.current = null;
          if (ghlGuardCurrent(guard, "workspace")) setConnecting(false);
        }
      }
    })();
  }, [api, email]);

  async function startConnect() {
    if (!api || connectOperation.current || disconnectOperation.current) return;
    const operation = Symbol("ghl-connect");
    connectOperation.current = operation;
    let guard = captureGhlGuard();
    ghlStatusVerifiedRef.current = false;
    setGhlStatusVerified(false);
    setConnecting(true);
    setError("");
    try {
      const status = await api.oauthStatus();
      if (!applyGhlConnection(status, guard)) return;
      if (status.connected) {
        setNotice("GoHighLevel is already connected.");
        return;
      }
      bumpConnectionGeneration();
      guard = captureGhlGuard();
      const started = await api.startOauth();
      if (!ghlGuardCurrent(guard)) return;
      window.location.assign(started.url);
    } catch (err) {
      if (ghlGuardCurrent(guard, "workspace")) setError(friendlyError(err));
    } finally {
      if (connectOperation.current === operation) {
        connectOperation.current = null;
        if (ghlGuardCurrent(guard, "workspace")) setConnecting(false);
      }
    }
  }

  async function loadRoutines() {
    if (!api || routineLoaded.current) return;
    routineLoaded.current = true;
    try {
      const result = await api.routines();
      setRoutineDrafts(result.drafts);
      setRoutineSettings(result.settings);
      // First visit since routines shipped: register the browser timezone so
      // the sweep can run in the founder's own wall clock.
      if (!result.settings.timezone) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) {
          const saved = await api.saveRoutineSettings({ timezone: tz });
          setRoutineSettings(saved);
        }
      }
    } catch {
      // Routines are an enhancement; never block the workspace on them.
    }
  }

  /** Founder file uploads: list is re-fetched after every upload/delete so the
   *  server-computed AI status (full/partial/excluded/unreadable) and the
   *  usage line stay accurate rather than guessed client-side. */
  async function loadUploads(options: { silent?: boolean } = {}): Promise<void> {
    if (!api) return;
    const epoch = sessionEpoch.current;
    try {
      const result = await api.listUploads();
      if (epoch !== sessionEpoch.current) return;
      setUploads(result.items);
      setUploadsAi(result.ai);
      uploadsLoaded.current = true;
    } catch (err) {
      // The mount-time load stays silent: the paperclip and Files screen
      // degrade to "no files yet" rather than block the workspace. A caller
      // that just uploaded or deleted a file asks for silent: false so it can
      // surface the failure instead of losing it quietly.
      if (options.silent === false) throw err;
    }
  }

  async function uploadFile(file: File, questionKey?: string): Promise<UploadItem> {
    if (!api) throw new Error("api_unavailable");
    const result = await api.uploadFile(file, questionKey);
    const item = result.item;
    // Insert immediately: the upload itself succeeded, so the file must not
    // vanish from the UI just because the follow-up list refresh fails (#lost-uploads).
    setUploads((rows) => [item, ...rows.filter((row) => row.id !== item.id)]);
    // A generated pack read from these files before the upload; the artifact
    // is now stale until the founder regenerates.
    setArtifactStale(true);
    try {
      await loadUploads({ silent: false });
    } catch (err) {
      // The optimistic item above is kept; only the AI usage totals may be
      // stale until the next successful refresh. Surface it, don't swallow it.
      setError(friendlyError(err));
    }
    return item;
  }

  async function deleteUploadItem(id: string): Promise<void> {
    if (!api) throw new Error("api_unavailable");
    await api.deleteUpload(id);
    setUploads((rows) => rows.filter((row) => row.id !== id));
    await loadUploads();
    setArtifactStale(true);
  }

  async function downloadUploadItem(id: string, filename: string): Promise<void> {
    if (!api) throw new Error("api_unavailable");
    await api.downloadUpload(id, filename);
  }

  /** Everything the founder can download, zipped client-side with fflate's
   *  sync API (the CSP has no worker-src, so the async/worker API is out). */
  async function downloadAllFiles(): Promise<void> {
    if (!api) throw new Error("api_unavailable");
    const totalBytes = uploads.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (totalBytes > MAX_DOWNLOAD_ALL_BYTES) {
      setError(
        `Your uploaded files total ${formatBytes(totalBytes)}, over the ` +
          `${formatBytes(MAX_DOWNLOAD_ALL_BYTES)} zip limit. Download large files individually ` +
          "instead, from the list above.",
      );
      return;
    }
    const entries: Record<string, Uint8Array> = {};
    const used = new Set<string>();
    const addEntry = (folder: string, name: string, bytes: Uint8Array) => {
      const path = `${folder}/${name}`;
      const unique = dedupeFilename(used, path);
      used.add(unique);
      entries[unique] = bytes;
    };
    // One microtask between fetches so a long file list never blocks the UI thread solid.
    const yieldToBrowser = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    for (const item of uploads) {
      try {
        const blob = await api.downloadUploadBlob(item.id);
        addEntry("Uploaded by you", item.name, new Uint8Array(await blob.arrayBuffer()));
      } catch {
        // Skip a file that fails to fetch rather than failing the whole zip.
      }
      await yieldToBrowser();
    }
    try {
      const md = await api.exportBlob("markdown");
      addEntry("Created by FounderBrain", "brain.md", new Uint8Array(await md.arrayBuffer()));
    } catch {
      /* omit on failure */
    }
    try {
      const json = await api.exportBlob("json");
      addEntry("Created by FounderBrain", "brain.json", new Uint8Array(await json.arrayBuffer()));
    } catch {
      /* omit on failure */
    }
    if (artifactText && isPack(artifactText)) {
      const sections = splitPack(artifactText);
      const named: Array<[string, string]> = [
        ["content.md", sections.content],
        ["outreach.md", sections.outreach],
        ["90-day-plan.md", sections.plan],
      ];
      for (const [name, text] of named) {
        if (text.trim()) addEntry("Created by FounderBrain", name, strToU8(text));
      }
    } else if (artifactText.trim()) {
      addEntry("Created by FounderBrain", "output.md", strToU8(artifactText));
    }
    const zipped = zipSync(entries, { level: 6 });
    const blob = new Blob([zipped], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "founder-brain-files.zip";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function setDraftStatus(id: string, status: "read" | "dismissed") {
    if (!api) return;
    if (status === "dismissed") setRoutineDrafts((rows) => rows.filter((r) => r.id !== id));
    else setRoutineDrafts((rows) => rows.map((r) => (r.id === id ? { ...r, status } : r)));
    await api.setRoutineDraftStatus(id, status);
  }

  async function importSite(url: string) {
    if (!api) throw new Error("api_unavailable");
    return api.importSite(url);
  }

  async function voiceSamples() {
    if (!api) throw new Error("api_unavailable");
    return api.voiceSamples();
  }
  async function addVoiceSample(name: string, text: string) {
    if (!api) throw new Error("api_unavailable");
    return api.addVoiceSample({ name, text });
  }
  async function deleteVoiceSample(id: string) {
    if (!api) throw new Error("api_unavailable");
    return api.deleteVoiceSample(id);
  }
  async function regeneratePieces(pieces: Array<{ n: number; text: string; feedback: string }>) {
    if (!api) throw new Error("api_unavailable");
    const result = await api.regeneratePieces(pieces);
    const fresh = await api.artifact();
    if (fresh.artifact) {
      setArtifact(fresh.artifact);
      setArtifactText(fresh.artifact.text);
    }
    return result.pieces;
  }
  function requireVerifiedGhlConnection(): GhlConnectionStatus {
    const connection = ghlConnectionRef.current;
    if (
      !connection?.connected ||
      !connection.connectionId ||
      !connection.locationId ||
      !ghlStatusVerifiedRef.current ||
      disconnectOperation.current
    ) {
      throw new ApiError(
        409,
        "ghl_connection_unverified",
        "Refresh GoHighLevel status before writing anything externally.",
      );
    }
    return connection;
  }

  async function disconnectGhl() {
    if (!api || disconnectOperation.current || connectOperation.current) return null;
    const connection = requireVerifiedGhlConnection();
    const operation = Symbol("ghl-disconnect");
    disconnectOperation.current = operation;
    bumpConnectionGeneration();
    const guard = captureGhlGuard();
    ghlStatusVerifiedRef.current = false;
    setGhlStatusVerified(false);
    setDisconnecting(true);
    setGhlStatusError("");
    try {
      const result = await api.disconnectOauth(connection.connectionId!);
      if (!ghlGuardCurrent(guard)) return null;
      if (!applyGhlConnection(result, guard)) return null;
      orientationEpoch.current += 1;
      setOrientation(result.orientation);
      resetGhlLinks();
      setNotice(
        "FounderBrain disconnected from GoHighLevel. Existing GoHighLevel content and workflows were not deleted.",
      );
      return result;
    } catch (err) {
      if (ghlGuardCurrent(guard)) setGhlStatusError(friendlyError(err));
      throw err;
    } finally {
      if (disconnectOperation.current === operation) {
        disconnectOperation.current = null;
        if (ghlGuardCurrent(guard, "workspace")) setDisconnecting(false);
      }
    }
  }

  async function loadGhlBookingLinks() {
    if (!api || bookingLoadOperation.current) return null;
    const connection = requireVerifiedGhlConnection();
    const operation = Symbol("ghl-booking-read");
    bookingLoadOperation.current = operation;
    const guard = captureGhlGuard();
    setGhlBookingLoading(true);
    setGhlBookingError("");
    try {
      const result = await api.ghlBookingLinks(connection.connectionId!);
      if (!ghlGuardCurrent(guard)) return null;
      if (result.connection.connectionId !== connection.connectionId) {
        invalidateGhlIdentity();
        return null;
      }
      setGhlBookingLinks(result);
      return result;
    } catch (err) {
      if (ghlGuardCurrent(guard)) setGhlBookingError(friendlyError(err));
      return null;
    } finally {
      if (bookingLoadOperation.current === operation) {
        bookingLoadOperation.current = null;
        if (ghlGuardCurrent(guard, "workspace")) setGhlBookingLoading(false);
      }
    }
  }

  async function saveGhlBookingLink(
    input: Omit<GhlBookingLinkInput, "connectionId">,
  ): Promise<GhlBookingLinkResult | null> {
    if (!api || bookingWriteOperation.current) return null;
    const connection = requireVerifiedGhlConnection();
    const operation = Symbol("ghl-booking-write");
    bookingWriteOperation.current = operation;
    const guard = captureGhlGuard();
    setGhlLinkSavingKey(input.key);
    setGhlBookingError("");
    try {
      const result = await api.saveGhlBookingLink({
        ...input,
        connectionId: connection.connectionId!,
      });
      if (!ghlGuardCurrent(guard)) return null;
      if (result.connection.connectionId !== connection.connectionId) {
        invalidateGhlIdentity();
        return null;
      }
      setGhlBookingLinks((current) => {
        if (!current || current.connection.connectionId !== connection.connectionId) return current;
        return {
          connection: result.connection,
          links: current.links.map((link) => (link.key === result.link.key ? result.link : link)),
        };
      });
      return result;
    } catch (err) {
      if (ghlGuardCurrent(guard)) setGhlBookingError(friendlyError(err));
      throw err;
    } finally {
      if (bookingWriteOperation.current === operation) {
        bookingWriteOperation.current = null;
        if (ghlGuardCurrent(guard, "workspace")) setGhlLinkSavingKey(null);
      }
    }
  }

  async function ghlPush(pack?: string): Promise<GhlPushResult | null> {
    if (!api || pushOperation.current) return null;
    const connection = requireVerifiedGhlConnection();
    const operation = Symbol("ghl-push");
    pushOperation.current = operation;
    const guard = captureGhlGuard();
    try {
      const result = await api.ghlPush(connection.connectionId!, pack);
      if (!ghlGuardCurrent(guard)) return null;
      if (result.connection.connectionId !== connection.connectionId) {
        invalidateGhlIdentity();
        return null;
      }
      return result;
    } finally {
      if (pushOperation.current === operation) pushOperation.current = null;
    }
  }
  async function transcribeVoice(blob: Blob, seconds: number) {
    if (!api) throw new Error("api_unavailable");
    const audioBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("read_failed"));
      reader.readAsDataURL(blob);
    });
    return api.transcribeVoice({ audioBase64, mime: blob.type || "audio/webm", seconds });
  }

  /** Founder-facing usage totals for the account chip (tokens, reads, price so far). */
  async function loadUsage() {
    if (!api) return;
    const epoch = sessionEpoch.current;
    try {
      const result = await api.usage();
      if (epoch !== sessionEpoch.current) return;
      setUsage(result);
    } catch {
      // The chip simply omits the spend line when usage is unavailable.
    }
  }

  async function getUsage() {
    if (!api) throw new Error("api_unavailable");
    return api.usage();
  }

  async function completeFirstLogin() {
    await saveOrientation({
      firstLoginScreen: 4,
      firstLoginComplete: true,
    });
    setMission("identity");
    setView("atlanta");
  }

  async function commitField(
    section: Exclude<Mission, "output">,
    field: string,
    value: string | boolean,
  ) {
    const next = patchBrain(latestDraft.current, section, field, value);
    latestDraft.current = next;
    setDraft(next);
    setChanged(true);
    const saved = await save(next);
    if (!saved) throw new Error("The answer has not been saved yet. Please retry.");
    return saved.brain;
  }

  async function applyIntake(proposal: {
    identity?: Record<string, string>;
    customer?: Record<string, string>;
    offer?: Record<string, string>;
    voice?: Record<string, string>;
  }) {
    let next = latestDraft.current;
    for (const section of ["identity", "customer", "offer", "voice"] as const) {
      const fields = proposal[section];
      if (!fields) continue;
      for (const [field, value] of Object.entries(fields)) {
        if (typeof value === "string" && value.trim()) {
          next = patchBrain(next, section, field, value);
        }
      }
    }
    latestDraft.current = next;
    setDraft(next);
    setChanged(true);
    const saved = await save(next);
    if (!saved) throw new Error("The imported answers have not been saved yet. Please retry.");
  }

  function patch(
    section: Exclude<Mission, "output">,
    field: string,
    value: string | boolean | number,
  ) {
    if (saving) return;
    // Background synchronization and repeated choices are not edits.
    const prior = (latestDraft.current[section] as unknown as Record<string, unknown>)[field];
    if (Object.is(prior, value)) return;
    setDraft((current) => {
      const next = patchBrain(current, section, field, value);
      latestDraft.current = next;
      return next;
    });
    setChanged(true);
    setError("");
    setNotice("");
    // The chapters fork on the track: keep the orientation record in step
    // with the Brain so Content/Outreach ask the right variant.
    if (section === "identity" && field === "track" && (value === "b2b" || value === "b2c")) {
      void saveOrientation({ track: value }).catch(() => undefined);
    }
  }

  function settleSave(
    saved: BrainState,
    operation: { brain: Brain; expectedVersion: number; key: string },
    epoch: number,
    pendingVerification = false,
  ) {
    if (epoch !== sessionEpoch.current) return;
    const decision = settleSaveDecision(latestDraft.current, saved, operation, pendingVerification);
    setState(saved);
    if (decision.draftMatchesSaved) {
      latestDraft.current = decision.nextDraft;
      setDraft(decision.nextDraft);
    }
    setChanged(decision.changed);
    setNotice(decision.notice);
    saveOperation.current = null;
  }

  async function save(next = draft) {
    if (!api || !state || saving) return;
    const epoch = sessionEpoch.current;
    const operation = nextSaveOperation(saveOperation.current, next, state.version, () =>
      crypto.randomUUID(),
    );
    saveOperation.current = operation;
    setSaving(true);
    setError("");
    try {
      const saved = await api.save(operation.brain, operation.expectedVersion, operation.key);
      settleSave(saved, operation, epoch);
      if (epoch === sessionEpoch.current) return saved;
    } catch (err) {
      if (epoch !== sessionEpoch.current) return;
      if (err instanceof ApiError && err.status === 409) {
        saveOperation.current = null;
        try {
          const remote = await api.brain();
          if (epoch !== sessionEpoch.current) return;
          setConflict(remote);
          setError("A newer version exists. Compare it with your draft before saving again.");
        } catch {
          if (epoch === sessionEpoch.current) {
            setError("A newer version exists, but it could not be loaded. Your draft is intact.");
          }
        }
      } else if (
        err instanceof ApiError &&
        err.status === 503 &&
        err.code === "verification_pending" &&
        typeof err.details.committedVersion === "number"
      ) {
        try {
          const receipt = await api.brain(err.details.committedVersion);
          settleSave(receipt, operation, epoch, true);
          if (epoch === sessionEpoch.current) return receipt;
        } catch {
          if (epoch === sessionEpoch.current) {
            setError(
              "The saved receipt is still unavailable. Retry the exact saved request; your draft is intact.",
            );
          }
        }
      } else {
        setError(friendlyError(err));
        setNotice(
          "Save outcome is unresolved. Retry the exact saved request or continue editing after it resolves.",
        );
      }
    } finally {
      if (epoch === sessionEpoch.current) setSaving(false);
    }
    return undefined;
  }

  async function retrySave() {
    if (saveOperation.current) await save(saveOperation.current.brain);
  }

  async function approve(section: MissionSection) {
    if (!sectionWouldApprove(draft, section) && !draft[section].approved) {
      setError(
        `Finish the required ${section} fields before approving. ` +
          `Empty values and placeholders like “tbd” do not count. You can still save a draft.`,
      );
      return;
    }
    const next = structuredClone(latestDraft.current);
    next[section].approved = !next[section].approved;
    latestDraft.current = next;
    setDraft(next);
    setChanged(true);
    await save(next);
  }

  function keepMyDraft() {
    if (!conflict) return;
    setState(conflict);
    setConflict(null);
    setChanged(true);
    setNotice(
      "Your draft is retained. Saving now creates a new request against the current version.",
    );
  }

  function loadServerConflict() {
    if (!conflict) return;
    setState(conflict);
    latestDraft.current = conflict.brain;
    setDraft(conflict.brain);
    setChanged(false);
    setConflict(null);
  }

  /** Fetch saved versions without moving the view; the Atlanta hub lists them. */
  async function refreshHistory() {
    if (!api) return;
    const epoch = sessionEpoch.current;
    try {
      const result = await api.history();
      if (epoch !== sessionEpoch.current) return;
      setHistory(result.versions);
    } catch {
      // The hub degrades to "Loading saved versions…"; no toast over the dashboard.
    }
  }

  async function openHistory() {
    if (!api) return;
    await refreshHistory();
    setView("brain");
  }

  async function compare(version: number) {
    if (!api) return;
    const epoch = sessionEpoch.current;
    try {
      const selected = await api.brain(version);
      if (epoch === sessionEpoch.current) setComparison(selected);
    } catch (err) {
      if (epoch === sessionEpoch.current) setError(friendlyError(err));
    }
  }

  async function restore(version: number) {
    if (!api || !state) return;
    const epoch = sessionEpoch.current;
    try {
      const restored = await api.restore(version, state.version);
      if (epoch !== sessionEpoch.current) return;
      setState(restored);
      latestDraft.current = restored.brain;
      setDraft(restored.brain);
      setChanged(false);
      setComparison(null);
      setNotice(`Restored version ${version} as new version ${restored.version}.`);
      const refreshed = await api.history();
      if (epoch === sessionEpoch.current) setHistory(refreshed.versions);
    } catch (err) {
      if (epoch === sessionEpoch.current) setError(friendlyError(err));
    }
  }

  // The Atlanta hub lists all saved versions; fetch them whenever the hub opens
  // (re-run when api appears, since the memo materializes after sign-in).
  useEffect(() => {
    if (view === "atlanta") void refreshHistory();
  }, [view, api]);

  async function pollJob(id: string, epoch = sessionEpoch.current) {
    if (!api || epoch !== sessionEpoch.current) return;
    setGenerating(true);
    const deadline = Date.now() + JOB_POLL_DEADLINE_MS;
    let waitMs = JOB_POLL_INITIAL_WAIT_MS;
    let lastStatus: Job["status"] | null = null;
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, waitMs));
        if (epoch !== sessionEpoch.current) return;
        const job = await api.job(id);
        if (epoch !== sessionEpoch.current) return;
        lastStatus = job.status;
        const outcome = interpretJobStatus(job.status);
        if (outcome.kind === "completed" && job.artifact) {
          window.sessionStorage.removeItem(jobStorage);
          const fresh = await api.brain();
          if (epoch !== sessionEpoch.current) return;
          setState(fresh);
          setArtifact(job.artifact);
          setArtifactText(job.artifact.text);
          const moved = job.artifact.sourceVersion !== fresh.version;
          setArtifactStale(moved);
          setJobNeedsReconcile(false);
          setNotice(
            moved
              ? "Your Brain has updated to a new version. Rebuild before accepting."
              : "A draft output is ready for review.",
          );
          return;
        }
        if (outcome.kind === "failed") {
          window.sessionStorage.removeItem(jobStorage);
          jobOperation.current = null;
          const message = job.error ?? "Generation did not complete.";
          if (/brain changed|updated to a new version/i.test(message)) {
            setArtifactStale(true);
            setGenerationRetry(true);
            setError("Your Brain has updated to a new version. Rebuild before accepting.");
            return;
          }
          // Uploaded files changing mid-job is the same kind of staleness as the
          // Brain changing: mark stale and offer a rebuild.
          if (/files changed/i.test(message)) {
            setArtifactStale(true);
            setGenerationRetry(true);
            setError("Your files changed since this draft was started. Rebuild before accepting.");
            return;
          }
          // Any other failure: job.error is a plain string, not an ApiError, so
          // it must be shown directly. friendlyError() below only passes through
          // ApiError messages and would otherwise flatten it to a generic line
          // (#lost-job-error-text).
          setJobNeedsReconcile(true);
          setError(job.error || "Generation did not complete.");
          return;
        }
        if (outcome.kind === "uncertain") {
          window.sessionStorage.removeItem(jobStorage);
          setJobNeedsReconcile(true);
          setNotice(
            "Generation outcome is uncertain. Reconcile by refreshing the output before starting another job.",
          );
          return;
        }
        waitMs = nextPollWaitMs(waitMs);
      }
      const timeout = interpretPollTimeout(lastStatus);
      if (timeout.kind === "still_running") setNotice(stillRunningNotice());
      else {
        setJobNeedsReconcile(true);
        setNotice(unresolvedJobNotice());
      }
    } catch (err) {
      if (epoch === sessionEpoch.current) {
        setJobNeedsReconcile(true);
        setError(friendlyError(err));
      }
    } finally {
      if (epoch === sessionEpoch.current) setGenerating(false);
    }
  }

  async function generate() {
    if (!api || !state || !config?.aiEnabled || generating) return;
    const epoch = sessionEpoch.current;
    // `generatingRef` is a plain ref cell mutated synchronously by
    // runExclusive, so a second click fired before React re-renders with
    // `generating: true` still sees the lock and is dropped, instead of
    // racing in and starting a second save or a second job.
    const outcome = await runExclusive(generatingRef, async () => {
      setGenerating(true);
      setGenerationRetry(false);
      setError("");
      try {
        // Channels the picker writes only land in the local draft until Save
        // runs, and `state` is the last-saved snapshot -- so the plan is built
        // from the live draft and saves it first, awaiting the result, before
        // any job version is chosen. See lib/generate-job.ts for the ordering
        // this guarantees (no job on missing channels, no job on a save that
        // failed/conflicted, no job silently built on a selection that was
        // superseded by further edits made while the save was in flight).
        const plan = await prepareGenerateJob({
          getDraft: () => latestDraft.current,
          state,
          save,
        });
        if (epoch !== sessionEpoch.current) return;
        if (plan.kind === "no_channels") {
          setError(
            "Select the channels this pack is for before generating. Choose at least one of Instagram, Facebook, LinkedIn, Reddit, TikTok, YouTube, or Threads.",
          );
          setGenerationRetry(false);
          return;
        }
        if (plan.kind === "save_failed") {
          // save() already surfaced a conflict/error banner and left the draft
          // untouched; do not start a job against a stale/unsaved version.
          return;
        }
        if (plan.kind === "superseded") {
          setError(
            "Your channel selection changed while saving. Click Generate again to build with the latest selection.",
          );
          setGenerationRetry(true);
          return;
        }
        const current = plan.state;
        const operation =
          jobOperation.current && jobOperation.current.expectedVersion === current.version
            ? jobOperation.current
            : { expectedVersion: current.version, key: crypto.randomUUID() };
        jobOperation.current = operation;
        try {
          const start = await api.startJob(operation.expectedVersion, operation.key);
          if (epoch !== sessionEpoch.current) return;
          jobOperation.current = null;
          window.sessionStorage.setItem(jobStorage, start.id);
          await pollJob(start.id, epoch);
        } catch (err) {
          if (epoch !== sessionEpoch.current) return;
          // The API sends { error, message, details: { jobId, status } }; ApiError keeps
          // the whole body in `details`, so the job id sits one level down.
          const activeJob =
            err instanceof ApiError
              ? ((err.details as { details?: { jobId?: unknown; status?: unknown } }).details ?? {})
              : {};
          if (
            err instanceof ApiError &&
            err.code === "job_active" &&
            typeof activeJob.jobId === "string"
          ) {
            if (activeJob.status === "uncertain") {
              jobOperation.current = {
                expectedVersion: current.version,
                key: crypto.randomUUID(),
              };
              try {
                const again = await api.startJob(current.version, jobOperation.current.key, true);
                jobOperation.current = null;
                window.sessionStorage.setItem(jobStorage, again.id);
                await pollJob(again.id, epoch);
                return;
              } catch (retryErr) {
                setError(friendlyError(retryErr));
                setGenerationRetry(true);
                return;
              }
            }
            window.sessionStorage.setItem(jobStorage, activeJob.jobId);
            setNotice("A build is already running. Staying with it.");
            await pollJob(activeJob.jobId, epoch);
            return;
          }
          if (
            err instanceof ApiError &&
            (err.code === "version_conflict" || err.code === "idempotency_conflict")
          ) {
            try {
              const fresh = await api.brain();
              if (epoch !== sessionEpoch.current) return;
              setState(fresh);
              jobOperation.current = { expectedVersion: fresh.version, key: crypto.randomUUID() };
              const start = await api.startJob(fresh.version, jobOperation.current.key);
              jobOperation.current = null;
              window.sessionStorage.setItem(jobStorage, start.id);
              await pollJob(start.id, epoch);
              return;
            } catch (retryErr) {
              jobOperation.current = null;
              setArtifactStale(true);
              setError(
                retryErr instanceof ApiError &&
                  (retryErr.code === "version_conflict" || retryErr.code === "idempotency_conflict")
                  ? "Your Brain has updated to a new version. Rebuild before accepting."
                  : friendlyError(retryErr),
              );
              setGenerationRetry(true);
              return;
            }
          }
          setError(friendlyError(err));
          setGenerationRetry(true);
          setNotice("Generation start is unresolved. Retry uses the same request key.");
        }
      } finally {
        // Runs on every exit path, including the early no_channels/save_failed/
        // superseded returns above, so the lock and the spinner never get stuck
        // on together after a failure.
        if (epoch === sessionEpoch.current) setGenerating(false);
      }
    });
    if (outcome.kind === "already_running") return;
  }

  async function reconcileOutput() {
    if (!api) return;
    const epoch = sessionEpoch.current;
    try {
      const output = await api.artifact();
      if (epoch !== sessionEpoch.current) return;
      setArtifact(output.artifact);
      setArtifactText(output.artifact?.text ?? "");
      setArtifactStale(output.stale);
      setJobNeedsReconcile(false);
      setNotice(
        output.artifact
          ? "Output refreshed from the server."
          : "No completed output is available yet.",
      );
    } catch (err) {
      if (epoch === sessionEpoch.current) setError(friendlyError(err));
    }
  }

  async function acceptOutput(textOverride?: string) {
    if (!api || !state || !artifact || artifactStale || artifact.acceptedAt || accepting) return;
    const epoch = sessionEpoch.current;
    const text = textOverride ?? artifactText;
    if (textOverride) setArtifactText(textOverride);
    const operation = acceptOperation.current ?? {
      id: artifact.id,
      text,
      expectedVersion: state.version,
      key: crypto.randomUUID(),
    };
    if (textOverride) operation.text = textOverride;
    acceptOperation.current = operation;
    setAccepting(true);
    setAcceptRetry(false);
    try {
      const accepted = await api.acceptArtifact(
        operation.id,
        operation.text,
        operation.expectedVersion,
        operation.key,
      );
      if (epoch !== sessionEpoch.current) return;
      const fresh = await api.brain();
      if (epoch !== sessionEpoch.current) return;
      acceptOperation.current = null;
      setArtifact(accepted.artifact);
      setArtifactText(accepted.artifact.text);
      setState(fresh);
      latestDraft.current = fresh.brain;
      setDraft(fresh.brain);
      setArtifactStale(false);
      setNotice(
        accepted.verified
          ? "Output accepted and verified by the server."
          : "Output accepted; server verification is pending.",
      );
    } catch (err) {
      if (epoch === sessionEpoch.current) {
        if (
          err instanceof ApiError &&
          (err.code === "stale_proposal" || err.code === "version_conflict")
        ) {
          acceptOperation.current = null;
          setAcceptRetry(false);
          setArtifactStale(true);
          setGenerationRetry(true);
          setError("Your Brain has updated to a new version. Rebuild before accepting.");
          setNotice("");
        } else {
          setError(friendlyError(err));
          setAcceptRetry(true);
          setNotice("Acceptance outcome is unresolved. Retry uses the same request key.");
        }
      }
    } finally {
      if (epoch === sessionEpoch.current) setAccepting(false);
    }
  }

  // Signing out asks the Hexclave SDK to end the session, which clears its cookie and
  // navigates to `/`. Private state is cleared first so nothing lingers if that is slow, and
  // the session is dropped locally even if Hexclave cannot be reached. In local demo there is
  // no session; we just leave the demo.
  async function leaveSession(message: string) {
    const current = session;
    setEmail(null);
    setSession(null);
    setDemoEntered(false);
    clearPrivate();
    if (current) {
      try {
        await current.signOut();
      } catch {
        setError(
          "Signed out of this page, but Hexclave could not be reached to end the session. " +
            "Close the browser to be sure.",
        );
      }
      return;
    }
    setNotice(message);
  }

  async function deleteWorkspace() {
    if (!api || deleteText !== "DELETE") return;
    const epoch = sessionEpoch.current;
    try {
      await api.deleteWorkspace();
      if (epoch !== sessionEpoch.current) return;
      await leaveSession("Workspace deleted and session cleared.");
    } catch (err) {
      if (epoch === sessionEpoch.current) setError(friendlyError(err));
    }
  }

  /** Delete from the account-chip modal; the typed-phrase gate lives in the modal. */
  async function deleteAccountNow() {
    if (!api) return;
    const epoch = sessionEpoch.current;
    try {
      await api.deleteWorkspace();
      if (epoch !== sessionEpoch.current) return;
      await leaveSession("Account deleted and session cleared.");
    } catch (err) {
      if (epoch === sessionEpoch.current) setError(friendlyError(err));
    }
  }

  function signOut() {
    void leaveSession("Signed out of the local demo.");
  }

  function download(format: "json" | "markdown") {
    void api?.download(format).catch((err) => setError(friendlyError(err)));
  }

  function onSignInError() {
    setError("Sign-in service is unavailable. Try again shortly.");
  }

  return {
    api,
    config,
    session,
    email,
    sessionExpired,
    demoEntered,
    setDemoEntered,
    state,
    draft,
    orientation: orientation ?? emptyOrientationState(),
    orientationLoaded: orientation !== null,
    orientationSaving,
    firstLoginComplete: orientation ? isFirstLoginComplete(orientation) : false,
    view,
    setView,
    mission,
    setMission,
    changed,
    saving,
    accepting,
    notice,
    error,
    history,
    comparison,
    conflict,
    artifact,
    artifactText,
    setArtifactText,
    artifactStale,
    generating,
    generationRetry,
    acceptRetry,
    jobNeedsReconcile,
    deleteOpen,
    setDeleteOpen,
    deleteText,
    setDeleteText,
    saveOperation,
    closeConflict,
    hexclave,
    patch,
    commitField,
    applyIntake,
    save,
    retrySave,
    approve,
    keepMyDraft,
    loadServerConflict,
    openHistory,
    refreshHistory,
    usage,
    loadUsage,
    compare,
    restore,
    generate,
    reconcileOutput,
    acceptOutput,
    signOut,
    deleteWorkspace,
    deleteAccountNow,
    download,
    onSignInError,
    saveOrientation,
    completeFirstLogin,
    importSite,
    getUsage,
    transcribeVoice,
    voiceSamples,
    addVoiceSample,
    deleteVoiceSample,
    routineDrafts,
    setDraftStatus,
    uploads,
    uploadsAi,
    loadUploads,
    uploadFile,
    deleteUploadItem,
    downloadUploadItem,
    downloadAllFiles,
    ghlPush,
    regeneratePieces,
    connecting,
    disconnecting,
    startConnect,
    refreshGhlStatus,
    disconnectGhl,
    ghlConnection,
    ghlStatusVerified,
    ghlStatusLoading,
    ghlStatusError,
    ghlConnectionGeneration,
    ghlBookingLinks,
    ghlBookingLoading,
    ghlBookingError,
    ghlLinkSavingKey,
    loadGhlBookingLinks,
    saveGhlBookingLink,
  };
}
