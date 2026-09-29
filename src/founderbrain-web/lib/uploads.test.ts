import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeFilename,
  extensionOf,
  formatBytes,
  humanizeQuestionKey,
  isAllowedUploadExtension,
  toQuestionKey,
} from "./uploads";

test("extensionOf lowercases and ignores dotfiles / trailing dots", () => {
  assert.equal(extensionOf("Notes.PDF"), "pdf");
  assert.equal(extensionOf("archive.tar.gz"), "gz");
  assert.equal(extensionOf(".gitignore"), "");
  assert.equal(extensionOf("no-extension"), "");
  assert.equal(extensionOf("trailing."), "");
});

test("isAllowedUploadExtension matches the paperclip's accept list", () => {
  assert.equal(isAllowedUploadExtension("plan.docx"), true);
  assert.equal(isAllowedUploadExtension("notes.MD"), true);
  assert.equal(isAllowedUploadExtension("photo.png"), false);
  assert.equal(isAllowedUploadExtension("script.exe"), false);
});

test("formatBytes picks B/KB/MB and rounds sensibly", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(20 * 1024), "20 KB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
  assert.equal(formatBytes(20 * 1024 * 1024), "20 MB");
});

test("toQuestionKey encodes section+field into the API's allowed charset", () => {
  assert.equal(toQuestionKey("identity", "venture"), "identity-venture");
  assert.equal(toQuestionKey("identity", "modelNote"), "identity-modelnote");
  assert.equal(toQuestionKey("Track", "Track"), "track-track");
});

test("toQuestionKey stays within 64 characters", () => {
  const key = toQuestionKey("a".repeat(40), "b".repeat(40));
  assert.ok(key.length <= 64);
});

test("humanizeQuestionKey turns a dashed key into a readable fallback label", () => {
  assert.equal(humanizeQuestionKey("identity-venture"), "Identity venture");
  assert.equal(humanizeQuestionKey("track-track"), "Track track");
  assert.equal(humanizeQuestionKey(""), "");
});

test("dedupeFilename returns the name unchanged when it is not taken", () => {
  assert.equal(dedupeFilename(new Set(), "brief.pdf"), "brief.pdf");
});

test("dedupeFilename numbers collisions before the extension", () => {
  const used = new Set(["brief.pdf"]);
  assert.equal(dedupeFilename(used, "brief.pdf"), "brief (1).pdf");
});

test("dedupeFilename finds the next free number and handles extension-less names", () => {
  const used = new Set(["brief.pdf", "brief (1).pdf"]);
  assert.equal(dedupeFilename(used, "brief.pdf"), "brief (2).pdf");
  const usedNoExt = new Set(["README"]);
  assert.equal(dedupeFilename(usedNoExt, "README"), "README (1)");
});
