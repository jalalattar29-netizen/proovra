import test from "node:test";
import assert from "node:assert/strict";
import {
  getReviewerEvidenceTypeLabel,
  getReviewerUploadModeLabel,
} from "../dist/index.js";

test("multipart mixed-media records render as mixed evidence packages", () => {
  assert.equal(
    getReviewerEvidenceTypeLabel({
      itemCount: 14,
      structure: "multipart",
      imageCount: 5,
      videoCount: 3,
      pdfCount: 2,
    }),
    "Mixed Media Evidence Package"
  );
});

test("multipart single-category records render as category packages", () => {
  assert.equal(
    getReviewerEvidenceTypeLabel({
      itemCount: 4,
      structure: "multipart",
      imageCount: 4,
    }),
    "Image Evidence Package"
  );
});

test("single records keep single-item evidence labels", () => {
  assert.equal(
    getReviewerEvidenceTypeLabel({
      itemCount: 1,
      structure: "single",
      evidenceType: "PHOTO",
      mimeType: "image/png",
    }),
    "Photo Evidence"
  );
});

test("multipart upload-started summaries override stale single mode", () => {
  assert.equal(
    getReviewerUploadModeLabel({
      itemCount: 14,
      structure: "multipart",
      rawMode: "single",
    }),
    "multipart package"
  );
});

test("single upload-started summaries preserve single mode", () => {
  assert.equal(
    getReviewerUploadModeLabel({
      itemCount: 1,
      structure: "single",
      rawMode: "single",
    }),
    "single"
  );
});
