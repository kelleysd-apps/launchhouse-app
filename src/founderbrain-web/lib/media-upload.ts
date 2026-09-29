/**
 * Routes a file dropped on the Files screen's "Upload files" button to the
 * right existing pipeline, and drives Danny's existing media upload flow for
 * the photo/video branch -- the exact sequence Media.tsx already uses
 * (POST /api/media/upload with pieceN null, PUT to the presigned URL, then
 * POST /api/media/:id/complete), reusing the same FounderBrainApi methods.
 * Nothing here talks to the server directly and nothing here is new surface
 * on the server or api.ts -- it only calls methods that already exist.
 */
import type { FounderBrainApi } from "../api";
import type { MediaItem } from "../types";
import { isAllowedUploadExtension } from "./uploads";
import { videoLengthError } from "./video-length";

/**
 * Kept in sync with `UPLOAD_TYPES` in src/founderbrain/media.ts (~line 25) and
 * the `ACCEPT` constant in components/Media.tsx -- Danny's allow-list for the
 * photos and clips a founder attaches to a piece. This is a read-only mirror
 * so the Files screen can classify a file the same way; it is never imported
 * from server code (which would drag node/postgres deps into the browser
 * bundle) or from Media.tsx's unexported constant.
 */
export const MEDIA_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export type UploadRoute = "document" | "media" | "rejected";

/**
 * Which existing pipeline a file goes through. Document extensions always win
 * (so a founder's "notes.csv" never gets misrouted); otherwise it's media only
 * when media is enabled for this workspace and the browser's reported type is
 * on Danny's allow-list. Anything else is rejected client-side, same as today.
 */
export function routeUploadFile(file: { name: string; type: string }, mediaEnabled: boolean): UploadRoute {
  if (isAllowedUploadExtension(file.name)) return "document";
  if (mediaEnabled && MEDIA_CONTENT_TYPES.has(file.type)) return "media";
  return "rejected";
}

function readVideoDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const finish = (result: number | Error) => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => finish(video.duration);
    video.onerror = () => finish(new Error("unreadable"));
    video.src = url;
  });
}

/**
 * Same 6-second clip gate Media.tsx applies before every upload (video-length.ts),
 * duplicated here (Media.tsx doesn't export its version) so a clip uploaded
 * from the Files screen still meets the limit every piece-attach flow assumes.
 * Returns an error string, or null when the file is fine to upload.
 */
export async function mediaLengthError(file: File): Promise<string | null> {
  if (!file.type.startsWith("video/")) return null;
  try {
    return videoLengthError(file.name, await readVideoDuration(file));
  } catch {
    return `${file.name}: Could not read the length of this video. Trim it to 6 seconds or less and try again.`;
  }
}

function putMediaFile(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("upload_failed"));
    };
    xhr.onerror = () => reject(new Error("upload_failed"));
    xhr.send(file);
  });
}

/**
 * Uploads one photo or clip through Danny's existing media flow, unattached
 * to any piece (pieceN: null -- the content library already supports these as
 * "saved files" that can be attached to a post later). Same three calls, same
 * order, as MediaProvider's `upload` in Media.tsx.
 */
export async function uploadMediaFile(
  api: Pick<FounderBrainApi, "createUpload" | "completeUpload">,
  file: File,
  onProgress: (pct: number) => void = () => {},
): Promise<MediaItem> {
  const started = await api.createUpload({
    pieceN: null,
    filename: file.name,
    contentType: file.type,
    size: file.size,
  });
  await putMediaFile(started.uploadUrl, file, onProgress);
  const done = await api.completeUpload(started.item.id);
  return done.item;
}
