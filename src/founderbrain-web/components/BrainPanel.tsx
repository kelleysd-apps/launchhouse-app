/**
 * Files and downloads (Danny, 2026-09-21; uploads added 2026-09-26; media
 * management added 2026-09-27): the same cinematic glass stage as the hub.
 * Two sections -- what the founder uploaded, and what FounderBrain produced --
 * a "Download all" zip, then the unchanged version history with field-by-field
 * compare and restore.
 *
 * Photos, videos and Instagram media are a second place to manage the same
 * content-library media: Open and Delete both call the existing media API
 * (mediaApi, the same FounderBrainApi instance Danny's Media.tsx uses), and
 * "Upload files" routes each file to whichever existing pipeline fits it
 * (document vs. photo/video). None of Danny's engine, components, or API
 * surface changes -- this only reuses what's already there.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import "../uploads.css";
import type { BrainState, HistoryItem, MediaItem, UploadItem, UploadsAi } from "../types";
import type { FounderBrainApi } from "../api";
import { sectionFounderNames, stamp } from "../mission-copy";
import { questionKeyTitles } from "../guide-intake";
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  formatBytes,
  humanizeQuestionKey,
} from "../lib/uploads";
import { splitMediaForFiles } from "../lib/media-files";
import { mediaLengthError, routeUploadFile, uploadMediaFile, MEDIA_CONTENT_TYPES } from "../lib/media-upload";
import { isPack, splitPack } from "../pack";
import { BrainDiff } from "./BrainDiff";
import { BrandMark } from "./BrandMark";

const DOCUMENT_ACCEPT = ALLOWED_UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(",");
const MEDIA_ACCEPT = Array.from(MEDIA_CONTENT_TYPES).join(",");

const AI_BADGE_LABEL: Record<UploadItem["ai"], string> = {
  full: "Read by AI",
  partial: "Partly read by AI",
  excluded: "Not read — over the AI limit",
  unreadable: "No readable text (scanned PDF)",
};

function questionLabel(questionKey: string | null): string | null {
  if (!questionKey) return null;
  return questionKeyTitles[questionKey] ?? humanizeQuestionKey(questionKey);
}

function mediaFileName(item: MediaItem): string {
  if (item.name) return item.name;
  if (item.source === "higgsfield") return `Higgsfield ${item.kind}`;
  if (item.source === "instagram") return `Instagram ${item.kind}`;
  return `Uploaded ${item.kind}`;
}

/** Not-ready label to match how the content library describes the same item
 *  (Media.tsx's statusOf), so this list reads the same as the library's. */
function mediaStatusLabel(item: MediaItem): string | null {
  if (item.status === "ready") return null;
  if (item.status === "failed") return "Didn't finish";
  if (item.source === "higgsfield") return "Making…";
  const ageMs = Date.now() - new Date(item.createdAt).getTime();
  return ageMs > 2 * 60 * 1000 ? "Not confirmed" : "Still uploading";
}

/** Text for the confirm step before DELETE /api/media/:id. Deleting removes
 *  the file from R2 and its fb_media row outright (src/founderbrain/media.ts
 *  deleteMedia); a piece's media is just `items.filter(i => i.pieceN === n)`
 *  at render time (Media.tsx), so once the row is gone the piece shows no
 *  media for it too -- this describes that plainly instead of implying a
 *  separate detach step happens. */
function mediaDeleteConfirmText(item: MediaItem): string {
  const name = mediaFileName(item);
  if (item.pieceN) {
    return `Delete "${name}"? It's attached to post ${item.pieceN} and will be removed from that post too. This can't be undone.`;
  }
  return `Delete "${name}"? This can't be undone.`;
}

/** A row for a piece of Danny's media on the Files screen -- the same media
 *  the content library manages, shown here as a second place to do it. The
 *  url is a short-lived presigned link from the private bucket, so it can't
 *  be an <a download> across origins -- it opens in a new tab instead. */
function MediaRow({
  item,
  busy,
  confirming,
  onDelete,
  onConfirm,
  onCancel,
}: {
  item: MediaItem;
  busy: boolean;
  confirming: boolean;
  onDelete: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const status = mediaStatusLabel(item);
  return (
    <li className="upload-row media-row" key={item.id}>
      {item.kind === "image" && item.url ? (
        <img className="media-row-thumb" src={item.url} alt="" loading="lazy" />
      ) : null}
      <div className="upload-row-meta">
        <span className="upload-row-name">{mediaFileName(item)}</span>
        <span className="upload-row-detail">
          {formatBytes(item.sizeBytes ?? 0)} · {stamp(item.createdAt)}
          {item.source === "instagram" ? " · From Instagram" : ""}
        </span>
        <span className={`upload-badge media-kind-${item.kind}`}>
          {item.kind === "image" ? "Photo" : "Video"}
        </span>
        {status ? <span className={`upload-badge media-status`}>{status}</span> : null}
      </div>
      <div className="upload-row-actions">
        {item.status === "ready" && item.url ? (
          <a
            className="atlanta-version-btn"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open
          </a>
        ) : null}
        {confirming ? (
          <>
            <span className="media-delete-confirm">{mediaDeleteConfirmText(item)}</span>
            <button
              type="button"
              className="atlanta-version-btn primary"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? "Deleting…" : "Confirm delete"}
            </button>
            <button type="button" className="atlanta-version-btn" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="atlanta-version-btn" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function BrainPanel({
  state,
  history,
  comparison,
  onCompare,
  onRestore,
  onDownload,
  onHome,
  onPrivacy,
  artifactText,
  uploadsEnabled,
  uploads,
  uploadsAi,
  onUpload,
  onUploadDelete,
  onUploadDownload,
  onDownloadAll,
  mediaEnabled,
  mediaApi,
  onOpenLibrary,
}: {
  state: BrainState;
  history: HistoryItem[];
  comparison: BrainState | null;
  onCompare: (v: number) => void;
  onRestore: (v: number) => void;
  onDownload: (format: "json" | "markdown") => void;
  onHome: () => void;
  onPrivacy: () => void;
  artifactText: string;
  uploadsEnabled: boolean;
  uploads: UploadItem[];
  uploadsAi: UploadsAi;
  onUpload: (files: FileList | null) => Promise<void>;
  onUploadDelete: (id: string) => Promise<void>;
  onUploadDownload: (id: string, filename: string) => Promise<void>;
  onDownloadAll: () => Promise<void>;
  /** Founder photos/videos, Instagram media, and Higgsfield output live in
   *  Danny's media bucket (R2). This is a second place to manage the same
   *  media the content library manages -- Open and Delete both go through
   *  mediaApi, the same FounderBrainApi instance Media.tsx uses. */
  mediaEnabled: boolean;
  mediaApi: FounderBrainApi | null;
  onOpenLibrary: () => void;
}) {
  const versions = [...history].sort((a, b) => b.version - a.version);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaError, setMediaError] = useState("");
  const [mediaBusyId, setMediaBusyId] = useState<string | null>(null);
  const [mediaConfirmId, setMediaConfirmId] = useState<string | null>(null);
  const [mediaJobs, setMediaJobs] = useState<
    Array<{ key: string; name: string; pct: number; phase: "uploading" | "failed"; error?: string }>
  >([]);

  const refreshMedia = useCallback(() => {
    if (!mediaApi) return Promise.resolve();
    return mediaApi
      .media()
      .then((res) => setMediaItems(res.items))
      .catch(() => undefined);
  }, [mediaApi]);

  useEffect(() => {
    if (!mediaApi) {
      setMediaItems([]);
      return;
    }
    let cancelled = false;
    void mediaApi
      .media()
      .then((res) => {
        if (!cancelled) setMediaItems(res.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mediaApi]);

  const { uploaded: uploadedMedia, created: createdMedia } = mediaEnabled
    ? splitMediaForFiles(mediaItems)
    : { uploaded: [], created: [] };

  async function handleDocumentFiles(files: File[]) {
    if (!files.length) return;
    setUploadBusy(true);
    try {
      const dt = new DataTransfer();
      files.forEach((file) => dt.items.add(file));
      await onUpload(dt.files);
    } catch (err) {
      setUploadError(err instanceof Error && err.message ? err.message : "Upload failed.");
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleMediaFiles(files: File[]) {
    if (!files.length || !mediaApi) return;
    for (const file of files) {
      const key = crypto.randomUUID();
      const lengthError = await mediaLengthError(file);
      if (lengthError) {
        setMediaJobs((current) => [{ key, name: file.name, pct: 0, phase: "failed", error: lengthError }, ...current]);
        continue;
      }
      setMediaJobs((current) => [{ key, name: file.name, pct: 0, phase: "uploading" }, ...current]);
      try {
        await uploadMediaFile(mediaApi, file, (pct) =>
          setMediaJobs((current) => current.map((job) => (job.key === key ? { ...job, pct } : job))),
        );
        setMediaJobs((current) => current.filter((job) => job.key !== key));
        await refreshMedia();
      } catch (err) {
        const message = err instanceof Error && err.message ? err.message : `${file.name} did not upload. Try again.`;
        setMediaJobs((current) =>
          current.map((job) => (job.key === key ? { ...job, phase: "failed", error: message } : job)),
        );
      }
    }
  }

  /** Routes each file to the document pipeline (api.uploadFile) or Danny's
   *  existing media pipeline (create/PUT/complete), by extension and type --
   *  see lib/media-upload.ts. Neither pipeline changes; this only picks. */
  async function handleFiles(fileList: FileList | null) {
    if (!fileList || !fileList.length) return;
    setUploadError("");
    setMediaError("");
    const docs: File[] = [];
    const media: File[] = [];
    for (const file of Array.from(fileList)) {
      const route = routeUploadFile(file, mediaEnabled && Boolean(mediaApi));
      if (route === "document") {
        if (file.size > MAX_UPLOAD_BYTES) {
          setUploadError(`${file.name}: files over ${formatBytes(MAX_UPLOAD_BYTES)} are too large.`);
          continue;
        }
        docs.push(file);
      } else if (route === "media") {
        media.push(file);
      } else {
        setUploadError(`${file.name}: that file type is not supported here.`);
      }
    }
    await Promise.all([handleDocumentFiles(docs), handleMediaFiles(media)]);
  }

  async function handleMediaDelete(id: string) {
    if (!mediaApi) return;
    setMediaBusyId(id);
    try {
      await mediaApi.deleteMedia(id);
      setMediaItems((current) => current.filter((item) => item.id !== id));
    } catch (err) {
      setMediaError(err instanceof Error && err.message ? err.message : "That file could not be removed. Try again.");
    } finally {
      setMediaBusyId(null);
      setMediaConfirmId(null);
    }
  }

  const pack = isPack(artifactText) ? splitPack(artifactText) : null;
  const packSections: Array<{ key: string; title: string; text: string; filename: string }> = pack
    ? [
        { key: "content", title: "Content", text: pack.content, filename: "content.md" },
        { key: "outreach", title: "Outreach", text: pack.outreach, filename: "outreach.md" },
        { key: "plan", title: "90 day plan", text: pack.plan, filename: "90-day-plan.md" },
      ].filter((section) => section.text.trim())
    : [];

  return (
    <main className="entry-stage typeform-stage atlanta-stage brain-stage">
      <div className="entry-media" aria-hidden="true">
        <img
          className="entry-photo"
          src="/atlanta-skyline.jpg"
          alt=""
          width={1920}
          height={1282}
          decoding="async"
          fetchPriority="high"
        />
      </div>
      <div className="entry-veil" aria-hidden="true" />
      <section className="entry-panel typeform-panel atlanta-panel" aria-labelledby="brain-title">
        <header className="entry-brand-block">
          <BrandMark size={56} className="entry-mark" />
          <p className="entry-product">
            <span>Founder</span>Brain
          </p>
        </header>
        <p className="entry-kicker">YOUR BRAIN</p>
        <h1 id="brain-title" className="entry-title">
          Your files and downloads.
        </h1>
        <div className="typeform-body in atlanta-body">
          <p className="atlanta-lede">
            Everything you uploaded and everything FounderBrain created lives here, plus every saved
            version of your Brain. Nothing was ever published or sent to customers.
          </p>

          <div className="atlanta-actions">
            <button className="entry-cta" type="button" onClick={onHome}>
              Back to Atlanta
            </button>
            <button className="atlanta-secondary" type="button" onClick={onPrivacy}>
              Privacy and data use
            </button>
            {uploadsEnabled ? (
              <button
                className="atlanta-secondary"
                type="button"
                disabled={zipping}
                onClick={() => {
                  setZipping(true);
                  void onDownloadAll().finally(() => setZipping(false));
                }}
              >
                {zipping ? "Zipping…" : "Download all"}
              </button>
            ) : null}
          </div>
          {uploadsEnabled && mediaEnabled ? (
            <p className="atlanta-muted media-zip-note">
              Photos and videos download individually below -- they aren't part of the zip.
            </p>
          ) : null}

          {uploadsEnabled || mediaEnabled ? (
            <section className="atlanta-day">
              <h2>Uploaded by you</h2>
              <p>
                Files you attached to a question, or added here. The AI can read text from these
                when you generate.
              </p>
              {uploadsEnabled || mediaEnabled ? (
                <>
                  <input
                    ref={inputRef}
                    type="file"
                    className="visually-hidden"
                    accept={mediaEnabled && mediaApi ? `${DOCUMENT_ACCEPT},${MEDIA_ACCEPT}` : DOCUMENT_ACCEPT}
                    multiple
                    onChange={(event) => {
                      void handleFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <div className="atlanta-actions">
                    <button
                      className="atlanta-secondary"
                      type="button"
                      disabled={uploadBusy}
                      onClick={() => inputRef.current?.click()}
                    >
                      {uploadBusy ? "Uploading…" : "Upload files"}
                    </button>
                  </div>
                </>
              ) : null}
              {uploadError ? (
                <p className="entry-error" role="alert">
                  {uploadError}
                </p>
              ) : null}
              {mediaEnabled && mediaJobs.length ? (
                <ul className="upload-list media-job-list">
                  {mediaJobs.map((job) => (
                    <li className="upload-row media-row" key={job.key}>
                      <div className="upload-row-meta">
                        <span className="upload-row-name">{job.name}</span>
                        {job.phase === "uploading" ? (
                          <div className="media-progress" aria-hidden="true">
                            <span style={{ width: `${job.pct}%` }} />
                          </div>
                        ) : null}
                        <span className={`upload-badge ${job.phase === "failed" ? "unreadable" : ""}`}>
                          {job.phase === "failed" ? "Didn't finish" : `Uploading ${job.pct}%`}
                        </span>
                        {job.error ? (
                          <p className="entry-error" role="alert">
                            {job.error}
                          </p>
                        ) : null}
                      </div>
                      {job.phase === "failed" ? (
                        <div className="upload-row-actions">
                          <button
                            type="button"
                            className="atlanta-version-btn"
                            onClick={() => setMediaJobs((current) => current.filter((x) => x.key !== job.key))}
                          >
                            Dismiss
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {mediaEnabled && mediaError ? (
                <p className="entry-error" role="alert">
                  {mediaError}
                </p>
              ) : null}
              {uploadsEnabled ? (
                <p className="upload-usage-line">
                  The AI reads up to {formatBytes(uploadsAi.budgetBytes)} of your files per
                  generation; {formatBytes(uploadsAi.usedBytes)} in use.
                </p>
              ) : null}
              {uploadsEnabled && uploads.length === 0 ? (
                <p className="atlanta-muted">No files uploaded yet.</p>
              ) : uploadsEnabled ? (
                <ul className="upload-list">
                  {uploads.map((item) => {
                    const label = questionLabel(item.questionKey);
                    return (
                      <li className="upload-row" key={item.id}>
                        <div className="upload-row-meta">
                          <span className="upload-row-name">{item.name}</span>
                          <span className="upload-row-detail">
                            {item.ext.toUpperCase()} · {formatBytes(item.sizeBytes)} ·{" "}
                            {stamp(item.createdAt)}
                            {label ? ` · Attached to "${label}"` : ""}
                          </span>
                          <span className={`upload-badge ${item.ai}`}>
                            {AI_BADGE_LABEL[item.ai]}
                          </span>
                        </div>
                        <div className="upload-row-actions">
                          <button
                            type="button"
                            className="atlanta-version-btn"
                            disabled={busyId === item.id}
                            onClick={() => {
                              setBusyId(item.id);
                              void onUploadDownload(item.id, item.name).finally(() =>
                                setBusyId(null),
                              );
                            }}
                          >
                            Download
                          </button>
                          {confirmId === item.id ? (
                            <>
                              <button
                                type="button"
                                className="atlanta-version-btn primary"
                                disabled={busyId === item.id}
                                onClick={() => {
                                  setBusyId(item.id);
                                  void onUploadDelete(item.id).finally(() => {
                                    setBusyId(null);
                                    setConfirmId(null);
                                  });
                                }}
                              >
                                Confirm delete
                              </button>
                              <button
                                type="button"
                                className="atlanta-version-btn"
                                onClick={() => setConfirmId(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="atlanta-version-btn"
                              onClick={() => setConfirmId(item.id)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {mediaEnabled ? (
                uploadedMedia.length ? (
                  <ul className="upload-list media-list">
                    {uploadedMedia.map((item) => (
                      <MediaRow
                        key={item.id}
                        item={item}
                        busy={mediaBusyId === item.id}
                        confirming={mediaConfirmId === item.id}
                        onDelete={() => setMediaConfirmId(item.id)}
                        onConfirm={() => void handleMediaDelete(item.id)}
                        onCancel={() => setMediaConfirmId(null)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="atlanta-muted">No content photos or videos yet.</p>
                )
              ) : null}
              {mediaEnabled ? (
                <p className="atlanta-muted media-library-note">
                  You can also manage these in{" "}
                  <button type="button" className="atlanta-link" onClick={onOpenLibrary}>
                    your content library
                  </button>
                  .
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="atlanta-day">
            <h2>Created by FounderBrain</h2>
            <p>Your Brain and the generated pack, each downloadable on its own.</p>
            {mediaEnabled ? (
              createdMedia.length ? (
                <>
                  <ul className="upload-list media-list">
                    {createdMedia.map((item) => (
                      <MediaRow
                        key={item.id}
                        item={item}
                        busy={mediaBusyId === item.id}
                        confirming={mediaConfirmId === item.id}
                        onDelete={() => setMediaConfirmId(item.id)}
                        onConfirm={() => void handleMediaDelete(item.id)}
                        onCancel={() => setMediaConfirmId(null)}
                      />
                    ))}
                  </ul>
                  <p className="atlanta-muted media-library-note">
                    You can also manage these in{" "}
                    <button type="button" className="atlanta-link" onClick={onOpenLibrary}>
                      your content library
                    </button>
                    .
                  </p>
                </>
              ) : null
            ) : null}
            <ul className="upload-created-list">
              <li>
                <span>Brain as markdown</span>
                <button
                  className="atlanta-version-btn"
                  type="button"
                  onClick={() => onDownload("markdown")}
                >
                  Download
                </button>
              </li>
              <li>
                <span>Brain as JSON</span>
                <button
                  className="atlanta-version-btn"
                  type="button"
                  onClick={() => onDownload("json")}
                >
                  Download
                </button>
              </li>
              {packSections.length ? (
                packSections.map((section) => (
                  <li key={section.key}>
                    <span>{section.title}</span>
                    <button
                      className="atlanta-version-btn"
                      type="button"
                      onClick={() => downloadText(section.filename, section.text)}
                    >
                      Download
                    </button>
                  </li>
                ))
              ) : (
                <li>
                  <span className="atlanta-muted">
                    No generated pack yet. Generate one from a mission's output screen.
                  </span>
                </li>
              )}
            </ul>
          </section>

          <section className="atlanta-day">
            <h2>Saved versions</h2>
            <p>
              Pick any version to compare it field by field with the one in use, then restore it if
              it is the one you want.
            </p>
            {versions.length === 0 ? (
              <p className="atlanta-muted">Loading your saves…</p>
            ) : (
              <ol className="atlanta-versions brain-versions">
                {versions.map((item) => {
                  const current = item.version === state.version;
                  return (
                    <li key={item.version} className={current ? "current" : ""}>
                      <div className="atlanta-version-meta">
                        <b>
                          Version {item.version}
                          {item.track ? (
                            <span className="atlanta-track-chip">
                              {item.hybrid
                                ? "Sells to businesses and people (Hybrid)"
                                : item.track === "b2c"
                                  ? "Sells to people (B2C)"
                                  : "Sells to businesses (B2B)"}
                            </span>
                          ) : null}
                        </b>
                        <small>
                          {stamp(item.at)}
                          {item.venture ? ` · ${item.venture}` : ""}
                        </small>
                        <small className="atlanta-version-changed">
                          {item.changed === undefined
                            ? null
                            : item.changed.length === 5
                              ? "First version"
                              : item.changed.length === 0
                                ? "Same content as the version before it"
                                : `Changed: ${item.changed
                                    .map(
                                      (key) =>
                                        sectionFounderNames[
                                          key as keyof typeof sectionFounderNames
                                        ],
                                    )
                                    .join(", ")}`}
                        </small>
                      </div>
                      {current ? (
                        <span className="atlanta-current-tag">In use</span>
                      ) : (
                        <button
                          type="button"
                          className="atlanta-version-btn"
                          onClick={() => onCompare(item.version)}
                        >
                          Compare
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section className="atlanta-day">
            <h2>
              {comparison
                ? `Version ${state.version} (in use) next to version ${comparison.version}`
                : `Version ${state.version} (in use)`}
            </h2>
            {comparison ? (
              <>
                <BrainDiff
                  left={state.brain}
                  right={comparison.brain}
                  leftLabel="In use"
                  rightLabel={`Selected v${comparison.version}`}
                />
                {comparison.version !== state.version ? (
                  <button
                    type="button"
                    className="atlanta-version-btn primary"
                    onClick={() => onRestore(comparison.version)}
                  >
                    Make version {comparison.version} current
                  </button>
                ) : null}
              </>
            ) : (
              <p className="atlanta-muted">
                Select a version above to compare it field by field before restoring.
              </p>
            )}
          </section>

          <small>
            Deleting your account lives in the menu at the top right, and always asks twice.
          </small>
        </div>
      </section>
    </main>
  );
}
