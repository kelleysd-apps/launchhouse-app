/**
 * Saturday content and outreach are saved work, not checkboxes.
 * The same rules gate the chapter screens and the orientation write.
 */
export class OrientationWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrientationWorkError";
  }
}

export const MIN_PROSPECTS = 5;
export const MIN_ACCOUNTS = 25;
export const MIN_COPY = 40;

export function normalizeInstagramHandle(value: string): string {
  return value.trim().replace(/^@+/, "");
}

export function instagramHandleOk(value: string | undefined): boolean {
  return /^[A-Za-z0-9._]{1,30}$/.test(normalizeInstagramHandle(value ?? ""));
}

export function emailDomainOk(value: string | undefined): boolean {
  const domain = (value ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (
    domain.length < 4 ||
    domain.length > 253 ||
    domain.includes(" ") ||
    domain.includes("@") ||
    domain.includes("://")
  ) {
    return false;
  }
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    domain,
  );
}

export function accountLines(value: string | undefined): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of (value ?? "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^@+/, "");
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function prospectLines(value: string | undefined): string[] {
  const lines: string[] = [];
  for (const raw of (value ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(EMAIL);
    if (!match) continue;
    const name = line.replace(match[0], "").replace(/[<>,;|]/g, " ").trim();
    if (name.length < 2) continue;
    lines.push(line);
  }
  return lines;
}

export function copyOk(value: string | undefined): boolean {
  return (value ?? "").trim().length >= MIN_COPY;
}

export type SaturdayAnswers = {
  track: "b2b" | "b2c" | null;
  contentAnswers: { instagramHandle?: string; emailDomain?: string };
  outreachAnswers: { copy?: string; accounts?: string; prospects?: string };
};

/** A blank handle is allowed. Instagram is optional and must not block the workflow pick. */
export function instagramOptionalOk(value: string | undefined): boolean {
  return !value?.trim() || instagramHandleOk(value);
}

export function contentFieldBlock(state: SaturdayAnswers): string | null {
  if (state.track === "b2c") {
    return instagramOptionalOk(state.contentAnswers.instagramHandle)
      ? null
      : "That Instagram handle is not usable. Leave it blank, or use letters, numbers, periods, and underscores.";
  }
  if (state.track === "b2b") {
    return emailDomainOk(state.contentAnswers.emailDomain)
      ? null
      : "Enter your email domain before finishing the content chapter.";
  }
  return "Choose B2B or B2C before finishing the content chapter.";
}

/**
 * Track setup has no additional B2C requirement: Instagram is optional and
 * its handle field may be blank. B2B still requires the same valid email
 * domain as the content chapter. An unknown track is never ready.
 */
export function trackSetupReady(state: SaturdayAnswers): boolean {
  if (state.track === "b2c") {
    return true;
  }
  if (state.track === "b2b") {
    return emailDomainOk(state.contentAnswers.emailDomain);
  }
  return false;
}

export function outreachFieldBlock(state: SaturdayAnswers): string | null {
  if (!copyOk(state.outreachAnswers.copy)) {
    return "Write the outreach copy you will actually send before finishing this chapter.";
  }
  if (state.track === "b2c") {
    const count = accountLines(state.outreachAnswers.accounts).length;
    return count >= MIN_ACCOUNTS
      ? null
      : `Enter ${MIN_ACCOUNTS} target accounts, one per line. ${count} so far.`;
  }
  if (state.track === "b2b") {
    const count = prospectLines(state.outreachAnswers.prospects).length;
    return count >= MIN_PROSPECTS
      ? null
      : `Enter at least ${MIN_PROSPECTS} prospects, one person per line with a name and an email. ${count} so far.`;
  }
  return "Choose B2B or B2C before finishing outreach.";
}

export type ContentPiece = { n: number; text: string };

const HEADER_SPLIT = /\n(?=\d{1,2}\.\s[^\n]*·)/;
const PLAIN_SPLIT = /\n(?=\d+\.\s)/;

/** Piece text from a pack or from the content section alone. Matches the studio splitter. */
export function contentSection(pack: string): string {
  const content = /^##\s+Content\s*$/im.exec(pack);
  if (!content) return pack;
  const rest = pack.slice(content.index + content[0].length);
  const outreach = /^##\s+Outreach\s*$/im.exec(rest);
  return (outreach ? rest.slice(0, outreach.index) : rest).trim();
}

/**
 * Same split as `parseContentPieces`, but also returns whatever came before
 * the first numbered piece (e.g. the 'Pillars: A; B; C; D' line orchestrate.ts
 * writes). A revision that serializes pieces back into the pack must not
 * silently drop that preamble.
 */
export function splitContentSection(pack: string): { preamble: string; pieces: ContentPiece[] } {
  const text = "\n" + contentSection(pack).trim();
  if (text.trim() === "") return { preamble: "", pieces: [] };
  const splitter = HEADER_SPLIT.test(text) ? HEADER_SPLIT : PLAIN_SPLIT;
  const chunks = text.split(splitter);
  const preamble = /^\s*\d+\.\s/.test(chunks[0] ?? "") ? "" : (chunks.shift() ?? "").trim();
  const pieces: ContentPiece[] = [];
  for (const chunk of chunks) {
    const match = chunk.trim().match(/^(\d+)\.\s*([\s\S]*)$/);
    if (match) pieces.push({ n: Number(match[1]), text: (match[2] ?? "").trim() });
  }
  return { preamble, pieces: pieces.sort((a, b) => a.n - b.n) };
}

export function parseContentPieces(content: string): ContentPiece[] {
  return splitContentSection(content).pieces;
}

const NO_MEDIA = new Set(["none", "n/a", "na", "text only", "no media", "not needed"]);

export function pieceAsksForMedia(text: string): boolean {
  const match = text.match(/(?:^|\n)\s*Media:\s*(.+)/i);
  if (!match) return false;
  const value = (match[1] ?? "").trim().toLowerCase();
  return value.length > 0 && !NO_MEDIA.has(value);
}

export function missingPieceNumbers(pieces: ContentPiece[]): number[] {
  const have = new Set(pieces.map((piece) => piece.n));
  const missing: number[] = [];
  for (let n = 1; n <= 30; n += 1) if (!have.has(n)) missing.push(n);
  return missing;
}

export function piecesMissingMedia(
  pieces: ContentPiece[],
  readyPieceNumbers: Iterable<number>,
): number[] {
  const ready = new Set(readyPieceNumbers);
  return pieces
    .filter((piece) => pieceAsksForMedia(piece.text) && !ready.has(piece.n))
    .map((piece) => piece.n);
}

/**
 * A saved file count is not the same thing as piece coverage: two files can
 * land on the same piece (leaving another piece with none), so "49 saved"
 * and "29 pieces covered" are both true and both need to be shown. Never
 * collapse this into a single number.
 */
export type PieceCoverage = {
  /** Saved (ready) files that are attached to any piece. Counts duplicates. */
  attachedCount: number;
  /** Distinct piece numbers with at least one attached file. */
  coveredCount: number;
  /** Attached rows beyond the first one landing on the same piece. */
  duplicateCount: number;
  /** The piece numbers that have more than one file attached. */
  duplicatePieces: number[];
};

export function pieceCoverage(pieceNumbers: Iterable<number | null | undefined>): PieceCoverage {
  let attachedCount = 0;
  const counts = new Map<number, number>();
  for (const n of pieceNumbers) {
    if (typeof n !== "number") continue;
    attachedCount += 1;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const duplicatePieces = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([n]) => n)
    .sort((a, b) => a - b);
  const coveredCount = counts.size;
  return {
    attachedCount,
    coveredCount,
    duplicateCount: attachedCount - coveredCount,
    duplicatePieces,
  };
}

/**
 * Piece numbers that show up more than once in a parsed piece list. A pack
 * with any duplicate is not safe to patch by number: which occurrence is
 * "piece 3" is ambiguous, and a blind replace would silently keep one copy
 * and throw the other away.
 */
export function duplicatePieceNumbers(pieces: ContentPiece[]): number[] {
  const counts = new Map<number, number>();
  for (const piece of pieces) counts.set(piece.n, (counts.get(piece.n) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([n]) => n)
    .sort((a, b) => a - b);
}

/**
 * New packs mark every piece with a header line 'N. Pillar · Format ·
 * Platform'. `splitContentSection`/`parseContentPieces` use the '·' on that
 * first line to find piece boundaries. A rewritten piece that drops it is
 * invisible as a boundary, so the piece before it silently swallows it.
 */
export function hasStructuredHeading(text: string): boolean {
  return /·/.test((text.split("\n")[0] ?? ""));
}

/**
 * Force the original piece's own heading (pillar · format · platform) onto
 * a revised body, discarding whatever heading-like first line the model
 * produced. This is unconditional, not a fallback for a missing heading:
 * the model is asked to keep the header unchanged, but a malformed or
 * drifted reply (wrong platform, reworded pillar, or no heading at all)
 * must never be allowed to move a piece's channel or break the pack's own
 * piece-boundary splitter. If the original never had a heading, the
 * revision is returned as-is -- there is nothing canonical to enforce.
 */
export function enforceCanonicalHeading(revisedText: string, originalText: string): string {
  const originalHeading = (originalText.split("\n")[0] ?? "").trim();
  if (!hasStructuredHeading(originalHeading)) return revisedText;
  const lines = revisedText.split("\n");
  // The model may have written its own (possibly wrong) heading-like first
  // line; drop it so the canonical heading is not stacked on top of it.
  const body = hasStructuredHeading(lines[0] ?? "") ? lines.slice(1).join("\n") : revisedText;
  return `${originalHeading}\n${body.trimStart()}`;
}

/** Serialize pieces back into the '## Content' section's own numbered-list shape. */
export function piecesToContentText(pieces: ContentPiece[]): string {
  return pieces.map((piece) => `${piece.n}. ${piece.text}`).join("\n\n");
}

/**
 * Serialize a content section including whatever preamble (e.g. the
 * 'Pillars: A; B; C; D' line) preceded the numbered pieces, so a revision
 * that only touches a piece or two does not silently erase it.
 */
export function serializeContentSection(preamble: string, pieces: ContentPiece[]): string {
  const body = piecesToContentText(pieces);
  return preamble.trim() ? `${preamble.trim()}\n\n${body}` : body;
}

/**
 * Splice fresh content-section text into a full pack without touching
 * anything before '## Content' or at/after '## Outreach' -- outreach's own
 * numbered touches and lists must never be reached by a content-piece edit.
 * Returns the pack unchanged if it has no '## Content' heading to bound the
 * edit to.
 */
export function replaceContentSection(pack: string, newContentText: string): string {
  const content = /^##\s+Content\s*$/im.exec(pack);
  if (!content) return pack;
  const afterHeading = content.index + content[0].length;
  const rest = pack.slice(afterHeading);
  const outreach = /^##\s+Outreach\s*$/im.exec(rest);
  const sectionEnd = outreach ? afterHeading + outreach.index : pack.length;
  const before = pack.slice(0, afterHeading).trimEnd();
  const after = pack.slice(sectionEnd);
  const body = newContentText.trim();
  return after ? `${before}\n\n${body}\n\n${after.trimStart()}` : `${before}\n\n${body}`;
}

function listTail(values: number[]): string {
  const shown = values.slice(0, 8).join(", ");
  return values.length > 8 ? `${shown}, and ${values.length - 8} more` : shown;
}

export function contentPackBlock(
  content: string,
  readyPieceNumbers: Iterable<number>,
): string | null {
  const pieces = parseContentPieces(content);
  const missing = missingPieceNumbers(pieces);
  if (missing.length) {
    return `The content chapter needs all 30 pieces. Still missing ${listTail(missing)}.`;
  }
  const media = piecesMissingMedia(pieces, readyPieceNumbers);
  if (media.length) {
    return `Attach a saved file to every piece that asks for one. Still missing a file on ${listTail(media)}.`;
  }
  return null;
}
