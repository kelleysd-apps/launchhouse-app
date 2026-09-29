import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMediaForFiles } from "./media-files";
import type { MediaItem } from "../types";

function item(overrides: Partial<MediaItem>): MediaItem {
  return {
    id: "id",
    pieceN: null,
    kind: "image",
    source: "upload",
    status: "ready",
    contentType: "image/png",
    sizeBytes: 100,
    url: "https://example.com/file.png",
    prompt: null,
    costUsd: 0,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("splitMediaForFiles buckets uploads and Higgsfield output separately", () => {
  const uploadPhoto = item({ id: "a", source: "upload" });
  const higgsfieldVideo = item({ id: "b", source: "higgsfield", kind: "video" });
  const result = splitMediaForFiles([uploadPhoto, higgsfieldVideo]);
  assert.deepEqual(result.uploaded, [uploadPhoto]);
  assert.deepEqual(result.created, [higgsfieldVideo]);
});

test("splitMediaForFiles keeps pending and failed items so the screen matches the library", () => {
  const pending = item({ id: "a", source: "upload", status: "pending" });
  const failed = item({ id: "b", source: "higgsfield", status: "failed" });
  const result = splitMediaForFiles([pending, failed]);
  assert.deepEqual(result.uploaded, [pending]);
  assert.deepEqual(result.created, [failed]);
});

test("splitMediaForFiles lists Instagram media under uploaded, next to founder uploads", () => {
  const instagram = item({ id: "a", source: "instagram" });
  const upload = item({ id: "b", source: "upload" });
  const result = splitMediaForFiles([instagram, upload]);
  assert.deepEqual(
    result.uploaded.map((x) => x.id),
    ["a", "b"],
  );
  assert.deepEqual(result.created, []);
});

test("splitMediaForFiles keeps input order within each bucket", () => {
  const first = item({ id: "a", source: "upload", createdAt: "2026-01-02T00:00:00.000Z" });
  const second = item({ id: "b", source: "upload", createdAt: "2026-01-01T00:00:00.000Z" });
  const result = splitMediaForFiles([first, second]);
  assert.deepEqual(
    result.uploaded.map((x) => x.id),
    ["a", "b"],
  );
});
