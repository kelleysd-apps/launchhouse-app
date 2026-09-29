import { test } from "node:test";
import assert from "node:assert/strict";
import { routeUploadFile } from "./media-upload";

test("routeUploadFile sends document extensions through the document pipeline", () => {
  assert.equal(routeUploadFile({ name: "notes.txt", type: "text/plain" }, true), "document");
  assert.equal(routeUploadFile({ name: "plan.PDF", type: "application/pdf" }, false), "document");
  assert.equal(routeUploadFile({ name: "budget.xlsx", type: "" }, true), "document");
});

test("routeUploadFile sends Danny's allow-listed photo/video types through the media pipeline when media is enabled", () => {
  assert.equal(routeUploadFile({ name: "photo.jpg", type: "image/jpeg" }, true), "media");
  assert.equal(routeUploadFile({ name: "clip.mov", type: "video/quicktime" }, true), "media");
  assert.equal(routeUploadFile({ name: "clip.webm", type: "video/webm" }, true), "media");
});

test("routeUploadFile rejects media types when media is disabled for the workspace", () => {
  assert.equal(routeUploadFile({ name: "photo.jpg", type: "image/jpeg" }, false), "rejected");
});

test("routeUploadFile rejects a type that is not a document extension and not on Danny's media allow-list", () => {
  assert.equal(routeUploadFile({ name: "script.exe", type: "application/octet-stream" }, true), "rejected");
  assert.equal(routeUploadFile({ name: "audio.mp3", type: "audio/mpeg" }, true), "rejected");
});

test("routeUploadFile prefers the document pipeline even when media is enabled", () => {
  assert.equal(routeUploadFile({ name: "report.csv", type: "text/csv" }, true), "document");
});
