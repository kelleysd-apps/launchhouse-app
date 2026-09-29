/**
 * Pure helpers for founder file uploads: the allow-list and size cap the
 * paperclip enforces client-side (the server is authoritative), a stable
 * questionKey encoding shared between the first-run guide and the mission
 * typeform, human-readable byte counts, and filename de-duplication for the
 * "Download all" zip.
 */

/** Kept in sync with the accept="" list on the paperclip's file input. */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "csv",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
] as const;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Above this total, "Download all" refuses to build a zip and points the
 *  founder at downloading large files individually instead. */
export const MAX_DOWNLOAD_ALL_BYTES = 50 * 1024 * 1024;

/** Lowercase extension without the dot, or "" when the name has none. */
export function extensionOf(filename: string): string {
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return "";
  return trimmed.slice(dot + 1).toLowerCase();
}

export function isAllowedUploadExtension(filename: string): boolean {
  return (ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(extensionOf(filename));
}

/** "512 B", "3.2 KB", "1.4 MB". Binary (1024) units, one decimal above KB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * The API's questionKey is `[a-z0-9_-]{1,64}`. A mission section and field
 * (e.g. "identity" + "venture") and a first-run guide step (same section and
 * field, from guide-intake.ts) collapse onto the same key on purpose: a file
 * attached during the first-run guide is still there when the same question
 * is revisited from the mission typeform.
 */
export function toQuestionKey(section: string, field: string): string {
  return `${section}-${field}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
}

/** Fallback label for a questionKey with no known title: "identity-venture" -> "Identity venture". */
export function humanizeQuestionKey(key: string): string {
  const words = key.split(/[-_]+/).filter(Boolean);
  if (!words.length) return "";
  return words
    .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * Give `name` a filename that has not been used yet, appending " (n)" before
 * the extension on a collision. Pure: does not mutate `used`; the caller adds
 * the returned name before de-duplicating the next one.
 */
export function dedupeFilename(used: ReadonlySet<string>, name: string): string {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(candidate)) return candidate;
  }
}
