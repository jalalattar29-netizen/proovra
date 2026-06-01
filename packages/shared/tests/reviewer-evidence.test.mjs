import test from "node:test";
import assert from "node:assert/strict";
import {
  getReviewerEvidenceCategories,
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

test("single audio uploads render as audio evidence", () => {
  assert.equal(
    getReviewerEvidenceTypeLabel({
      itemCount: 1,
      structure: "single",
      evidenceType: "AUDIO",
      mimeType: "audio/webm",
    }),
    "Audio Evidence"
  );
});

test("single video uploads render as video evidence", () => {
  assert.equal(
    getReviewerEvidenceTypeLabel({
      itemCount: 1,
      structure: "single",
      evidenceType: "VIDEO",
      mimeType: "video/mp4",
    }),
    "Video Evidence"
  );
});

test("single pdf uploads render as document evidence", () => {
  assert.equal(
    getReviewerEvidenceTypeLabel({
      itemCount: 1,
      structure: "single",
      evidenceType: "DOCUMENT",
      mimeType: "application/pdf",
    }),
    "Document Evidence"
  );
});

test("single unknown uploads fall back to digital evidence record", () => {
  assert.equal(
    getReviewerEvidenceTypeLabel({
      itemCount: 1,
      structure: "single",
      evidenceType: null,
      mimeType: "application/zip",
    }),
    "Digital Evidence Record"
  );
});

test("multipart audio-only records render as audio evidence packages", () => {
  assert.equal(
    getReviewerEvidenceTypeLabel({
      itemCount: 3,
      structure: "multipart",
      audioCount: 3,
    }),
    "Audio Evidence Package"
  );
});

test("multipart mixed records expose reviewer evidence categories", () => {
  assert.deepEqual(
    getReviewerEvidenceCategories({
      itemCount: 4,
      structure: "multipart",
      imageCount: 1,
      videoCount: 1,
      audioCount: 1,
      pdfCount: 1,
    }),
    ["Image", "Video", "Audio", "Document"]
  );
});

test("multipart mixed-media classification is upload-order independent", () => {
  const permutations = [
    { imageCount: 1, audioCount: 1, pdfCount: 1 },
    { audioCount: 1, pdfCount: 1, imageCount: 1 },
    { pdfCount: 1, imageCount: 1, audioCount: 1 },
  ];

  for (const input of permutations) {
    assert.equal(
      getReviewerEvidenceTypeLabel({
        itemCount: 3,
        structure: "multipart",
        ...input,
      }),
      "Mixed Media Evidence Package"
    );
  }
});

test("multipart upload-started summaries override stale single mode", () => {
  // The label canonicalised in `getReviewerUploadModeLabel` is the
  // operator-readable phrase, not the short `multipart` token. Any
  // multipart structure short-circuits to the authorisation phrase.
  assert.equal(
    getReviewerUploadModeLabel({
      itemCount: 14,
      structure: "multipart",
      rawMode: "single",
    }),
    "initial intake authorization for multipart evidence"
  );
});

test("single upload-started summaries preserve single mode", () => {
  // Single uploads map the bare `single` token to the operator-
  // readable label `single evidence item` (UI surface phrase).
  assert.equal(
    getReviewerUploadModeLabel({
      itemCount: 1,
      structure: "single",
      rawMode: "single",
    }),
    "single evidence item"
  );
});
