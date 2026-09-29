/**
 * src/founderbrain-web/api.ts
 *
 * WHAT THIS IS. Browser client for the FounderBrain API. Each request pulls a
 * fresh Hexclave access token (or the local-demo header) and never relies on
 * cookies (`credentials: 'omit'`).
 */
import type {
  Artifact,
  Brain,
  BrainState,
  Config,
  HiggsfieldStatus,
  HistoryItem,
  Job,
  Me,
  MediaItem,
  UploadItem,
  UploadsAi,
  UsageResponse,
} from "./types";

import type { GmailStatus, GmailDraft, SentMail } from "./components/GmailStudio";

export type RoutineDraftRow = {
  id: string;
  kind: "monday_plan" | "content_top_up" | "readiness";
  periodKey: string;
  title: string;
  body: string;
  status: "pending" | "read" | "dismissed";
  createdAt: string;
};
import type { OrientationPatch, OrientationState } from "../founderbrain-shared/orientation";
import type {
  GhlBookingLinkInput,
  GhlBookingLinkResult,
  GhlBookingLinks,
  GhlConnectionStatus,
  GhlPushResult,
} from "../founderbrain-shared/ghl";

export type GhlConnectionMutationResult = GhlConnectionStatus & {
  orientation: OrientationState;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: { committedVersion?: number; [key: string]: unknown } = {},
  ) {
    super(message);
  }
}

const makeKey = (): string => crypto.randomUUID();
const SESSION_EXPIRED = new ApiError(
  401,
  "session_expired",
  "Your sign-in has expired. Your draft is still on this page. " +
    "Sign in again in a new tab, then retry.",
);
/** The header the API and the Worker read the Hexclave access token from. */
export const ACCESS_TOKEN_HEADER = "x-stack-access-token";

/** Returns the current Hexclave access token, or null when there is no session. */
export type TokenSource = () => Promise<string | null>;

/**
 * The browser's view of the API. Identity is a Hexclave access token, fetched from the SDK
 * right before each request so the SDK's own refresh logic is what keeps it current. No
 * cookies are relied on by the API and none are sent: `credentials: "omit"` makes that
 * explicit. A 401 from the API means the token was missing, expired or refused; it becomes
 * one clear error that keeps the draft on screen.
 */
export class FounderBrainApi {
  /**
   * @param token   where to get the access token; `null` for `/api/config`, which is fetched before sign-in.
   * @param demo    local demo mode: send the loopback-only dev header instead of a token.
   */
  constructor(
    private readonly token: TokenSource | null = null,
    private readonly demo = false,
  ) {}

  private async headers(init: RequestInit): Promise<Headers> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    // A caller that already set Content-Type (raw-body upload: application/octet-stream)
    // knows better than this default; never clobber it.
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (this.demo) headers.set("X-Dev-User", "demo");
    else if (this.token) {
      const value = await this.token();
      if (!value) throw SESSION_EXPIRED;
      headers.set(ACCESS_TOKEN_HEADER, value);
    }
    return headers;
  }

  private async fetchApi(path: string, init: RequestInit, timeout: number): Promise<Response> {
    const headers = await this.headers(init);
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(`/api${path}`, {
        ...init,
        headers,
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError")
        throw new ApiError(
          0,
          "timeout",
          "The request timed out. Your draft is still here. Check the saved version before retrying.",
        );
      throw new ApiError(0, "network", "Network unavailable. Your draft is still here.");
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  private async parseBody<T>(response: Response): Promise<T> {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      committedVersion?: number;
    } & T;
    if (response.status === 401 && this.token) throw SESSION_EXPIRED;
    if (!response.ok) {
      const code = body.error ?? "request_failed";
      const message =
        body.message ??
        (code !== "request_failed"
          ? `FounderBrain could not complete that request (${response.status} ${code}).`
          : `FounderBrain could not complete that request (${response.status}).`);
      throw new ApiError(response.status, code, message, body);
    }
    return body as T;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeout = 12_000): Promise<T> {
    const response = await this.fetchApi(path, init, timeout);
    return this.parseBody<T>(response);
  }

  gmailStatus() {
    return this.request<GmailStatus>("/gmail/status");
  }
  gmailStart() {
    return this.request<{ url: string }>("/gmail/oauth/start", { method: "POST" });
  }
  gmailComplete(input: { code: string; state: string }) {
    return this.request<GmailStatus>(
      "/gmail/oauth/complete",
      { method: "POST", body: JSON.stringify(input) },
      45_000,
    );
  }
  gmailDisconnect() {
    return this.request<{ disconnected: boolean; revoked: boolean }>(
      "/gmail",
      { method: "DELETE" },
      30_000,
    );
  }
  gmailSent(pageToken?: string) {
    return this.request<{ messages: SentMail[]; nextPageToken?: string }>(
      "/gmail/sent" + (pageToken ? "?pageToken=" + encodeURIComponent(pageToken) : ""),
      {},
      60_000,
    );
  }
  gmailAnalyze(input: { messageIds: string[]; consent: true }) {
    return this.request<GmailStatus>(
      "/gmail/voice",
      { method: "POST", body: JSON.stringify(input) },
      90_000,
    );
  }
  gmailDrafts() {
    return this.request<{ drafts: GmailDraft[] }>("/gmail/drafts");
  }
  gmailCreateDraft(input: {
    requestId: string;
    recipient: string;
    brief: string;
    subject?: string;
    autoSend?: boolean;
  }) {
    return this.request<GmailDraft>(
      "/gmail/drafts",
      { method: "POST", body: JSON.stringify(input) },
      90_000,
    );
  }
  gmailUpdateDraft(input: { id: string; subject: string; body: string }) {
    const { id, ...body } = input;
    return this.request<GmailDraft>("/gmail/drafts/" + encodeURIComponent(id), {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  gmailSaveDraft(input: { id: string }) {
    return this.request<GmailDraft>(
      "/gmail/drafts/" + encodeURIComponent(input.id) + "/save",
      { method: "POST" },
      45_000,
    );
  }
  gmailSendDraft(input: { id: string }) {
    return this.request<GmailDraft>(
      "/gmail/drafts/" + encodeURIComponent(input.id) + "/send",
      { method: "POST", body: JSON.stringify({ confirmed: true }) },
      45_000,
    );
  }
  gmailSettings(input: {
    autoSend: boolean;
    allowedRecipients: string[];
    dailyLimit: number;
    confirmed: boolean;
  }) {
    return this.request<GmailStatus>("/gmail/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  config() {
    return this.request<Config>("/config", {}, 8_000);
  }
  me() {
    return this.request<Me>("/me", {}, 8_000);
  }
  orientation() {
    return this.request<OrientationState>("/orientation");
  }
  saveOrientation(patch: OrientationPatch) {
    return this.request<OrientationState>("/orientation", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }
  oauthStatus() {
    return this.request<GhlConnectionStatus>("/oauth/status");
  }
  usage() {
    return this.request<UsageResponse>("/usage");
  }
  startOauth() {
    return this.request<{ url: string }>("/oauth/start");
  }
  routines() {
    return this.request<{
      settings: {
        timezone: string;
        mondayPlan: boolean;
        contentTopUp: boolean;
        readinessDigest: boolean;
      };
      drafts: RoutineDraftRow[];
    }>("/routines");
  }
  saveRoutineSettings(patch: {
    timezone?: string;
    mondayPlan?: boolean;
    contentTopUp?: boolean;
    readinessDigest?: boolean;
  }) {
    return this.request<{
      timezone: string;
      mondayPlan: boolean;
      contentTopUp: boolean;
      readinessDigest: boolean;
    }>("/routines/settings", { method: "POST", body: JSON.stringify(patch) });
  }
  setRoutineDraftStatus(id: string, status: "read" | "dismissed") {
    return this.request<{ ok: boolean }>("/routines/drafts/status", {
      method: "POST",
      body: JSON.stringify({ id, status }),
    });
  }
  importSite(url: string) {
    return this.request<{
      proposal: Record<string, unknown>;
      source: "ai" | "title";
      logoUrl?: string;
    }>("/site-import", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }
  voiceSamples() {
    return this.request<{
      samples: Array<{ id: string; name: string; chars: number; createdAt: string }>;
      min: number;
    }>("/voice-samples", {}, 15_000);
  }
  addVoiceSample(input: { name: string; text: string }) {
    return this.request<{ count: number }>(
      "/voice-samples",
      { method: "POST", body: JSON.stringify(input) },
      20_000,
    );
  }
  deleteVoiceSample(id: string) {
    return this.request<{ count: number }>(`/voice-samples/${id}`, { method: "DELETE" }, 15_000);
  }
  ghlBookingLinks(connectionId: string) {
    return this.request<GhlBookingLinks>(
      `/ghl/booking-links?connectionId=${encodeURIComponent(connectionId)}`,
    );
  }
  saveGhlBookingLink(input: GhlBookingLinkInput) {
    return this.request<GhlBookingLinkResult>("/ghl/booking-links", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  ghlPush(connectionId: string, pack?: string) {
    return this.request<GhlPushResult>(
      "/ghl/push",
      {
        method: "POST",
        body: JSON.stringify(pack ? { connectionId, pack } : { connectionId }),
      },
      60_000,
    );
  }
  transcribeVoice(audio: { audioBase64: string; mime: string; seconds: number }) {
    return this.request<{ text: string }>(
      "/voice",
      { method: "POST", body: JSON.stringify(audio) },
      45_000,
    );
  }
  completeOauth(
    body:
      | { code: string; state: string; error?: never }
      | { error: string; state: string; code?: never },
  ) {
    return this.request<GhlConnectionMutationResult>(
      "/oauth/complete",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      30_000,
    );
  }
  disconnectOauth(connectionId: string) {
    return this.request<GhlConnectionMutationResult>(
      "/oauth/connection",
      {
        method: "DELETE",
        body: JSON.stringify({ connectionId, confirmed: true }),
      },
      30_000,
    );
  }
  brain(version?: number) {
    return this.request<BrainState>(
      `/brain${version === undefined ? "" : `?version=${encodeURIComponent(version)}`}`,
    );
  }
  history() {
    return this.request<{ versions: HistoryItem[] }>("/history");
  }
  artifact() {
    return this.request<{ artifact: Artifact | null; stale: boolean }>("/artifact");
  }
  save(brain: Brain, expectedVersion: number, idempotencyKey = makeKey()) {
    return this.request<BrainState>("/brain", {
      method: "PUT",
      body: JSON.stringify({ brain, expectedVersion, idempotencyKey }),
    });
  }
  restore(version: number, expectedVersion: number, idempotencyKey = makeKey()) {
    return this.request<BrainState>("/restore", {
      method: "POST",
      body: JSON.stringify({ version, expectedVersion, idempotencyKey }),
    });
  }
  media() {
    return this.request<{ items: MediaItem[]; higgsfield: HiggsfieldStatus }>("/media");
  }
  createUpload(input: {
    pieceN: number | null;
    filename: string;
    contentType: string;
    size: number;
  }) {
    return this.request<{ item: MediaItem; uploadUrl: string }>("/media/upload", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  completeUpload(id: string) {
    return this.request<{ item: MediaItem }>(`/media/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body: "{}",
    });
  }
  assignMedia(id: string, pieceN: number | null) {
    return this.request<{ item: MediaItem }>(`/media/${encodeURIComponent(id)}/assign`, {
      method: "POST",
      body: JSON.stringify({ pieceN }),
    });
  }
  refreshMedia(id: string) {
    return this.request<{ item: MediaItem }>(
      `/media/${encodeURIComponent(id)}/refresh`,
      { method: "POST", body: "{}" },
      55_000,
    );
  }
  deleteMedia(id: string) {
    return this.request<{ ok: true }>(`/media/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  higgsfieldConnect(apiKey: string) {
    return this.request<HiggsfieldStatus>(
      "/higgsfield/connect",
      {
        method: "POST",
        body: JSON.stringify({ apiKey }),
      },
      55_000,
    );
  }
  higgsfieldDisconnect() {
    return this.request<HiggsfieldStatus>("/higgsfield", { method: "DELETE" });
  }
  higgsfieldEstimate(kind: "image" | "video", prompt: string, pieceN: number | null) {
    return this.request<{ usd: number; model: string; remainingUsd: number }>(
      "/higgsfield/estimate",
      {
        method: "POST",
        body: JSON.stringify({ kind, prompt, pieceN }),
      },
      55_000,
    );
  }
  higgsfieldGenerate(kind: "image" | "video", prompt: string, pieceN: number | null) {
    return this.request<{ item: MediaItem }>(
      "/higgsfield/generate",
      {
        method: "POST",
        body: JSON.stringify({ kind, prompt, pieceN }),
      },
      55_000,
    );
  }
  regeneratePieces(pieces: Array<{ n: number; text: string; feedback: string }>) {
    return this.request<{ pieces: Array<{ n: number; text: string }> }>("/content/regenerate", {
      method: "POST",
      body: JSON.stringify({ pieces }),
    });
  }
  startJob(expectedVersion: number, idempotencyKey = makeKey(), replaceStuck = false) {
    return this.request<Pick<Job, "id" | "status">>("/jobs", {
      method: "POST",
      body: JSON.stringify({
        expectedVersion,
        idempotencyKey,
        ...(replaceStuck ? { replaceStuck: true } : {}),
      }),
    });
  }
  job(id: string) {
    return this.request<Job>(`/jobs/${encodeURIComponent(id)}`);
  }
  acceptArtifact(id: string, text: string, expectedVersion: number, idempotencyKey = makeKey()) {
    return this.request<{ artifact: Artifact; verified: boolean }>(
      `/artifact/${encodeURIComponent(id)}/accept`,
      { method: "POST", body: JSON.stringify({ text, expectedVersion, idempotencyKey }) },
    );
  }
  deleteWorkspace() {
    return this.request<{ deleted: true }>("/workspace", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
  }
  async exportBlob(format: "json" | "markdown"): Promise<Blob> {
    const response = await this.fetchApi(`/export?format=${format}`, {}, 20_000);
    if (response.status === 401) throw SESSION_EXPIRED;
    if (!response.ok)
      throw new ApiError(response.status, "export_failed", "Export could not be prepared.");
    return response.blob();
  }
  async download(format: "json" | "markdown"): Promise<void> {
    const blob = await this.exportBlob(format);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `founder-brain.${format === "markdown" ? "md" : "json"}`;
    link.click();
    URL.revokeObjectURL(url);
  }
  /** Raw-body upload. filename and questionKey travel as query params; the body is the file itself. */
  async uploadFile(file: File, questionKey?: string): Promise<{ item: UploadItem }> {
    const params = new URLSearchParams({ filename: file.name });
    if (questionKey) params.set("questionKey", questionKey);
    const response = await this.fetchApi(
      `/uploads?${params.toString()}`,
      { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } },
      60_000,
    );
    return this.parseBody<{ item: UploadItem }>(response);
  }
  listUploads() {
    return this.request<{ items: UploadItem[]; ai: UploadsAi }>("/uploads");
  }
  deleteUpload(id: string) {
    return this.request<{ ok: true }>(`/uploads/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async downloadUploadBlob(id: string): Promise<Blob> {
    const response = await this.fetchApi(`/uploads/${encodeURIComponent(id)}/download`, {}, 30_000);
    if (response.status === 401) throw SESSION_EXPIRED;
    if (!response.ok)
      throw new ApiError(response.status, "download_failed", "Download could not be prepared.");
    return response.blob();
  }
  async downloadUpload(id: string, filename: string): Promise<void> {
    const blob = await this.downloadUploadBlob(id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }
}
