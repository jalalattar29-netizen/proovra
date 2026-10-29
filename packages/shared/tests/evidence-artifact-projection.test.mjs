/**
 * WIRE CONTRACT D (2026-10-29) — a continuous screen recording is ONE user
 * item; its segments and manifest are technical; a CAPTURE_MANIFEST part is
 * never user evidence; every other record keeps one item per ORIGINAL part.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_RECORD_SYSTEM_LABEL,
  COMBINED_RECORDING_ASSET_KIND,
  SCREEN_RECORDING_ITEM_LABEL,
  classifyEvidencePartPresentation,
  continuousRecordingFactsFromCustody,
  countEvidenceUserItems,
  downloadOriginalFilesLabel,
  isContinuousScreenRecordingMode,
  projectEvidenceArtifacts,
  safeAttachmentContentDisposition,
} from "../dist/index.js";

const seg = (i) => ({ partIndex: i, mimeType: "video/mp4", sha256: String(i).repeat(64).slice(0, 64), artifactClass: "ORIGINAL" });
const manifest = (i) => ({ partIndex: i, mimeType: "application/json", sha256: "f".repeat(64), artifactClass: "CAPTURE_MANIFEST" });

test("a SEGMENTED iOS recording (6 segments + manifest) is ONE user item", () => {
  const parts = [manifest(6), ...[5, 4, 3, 2, 1, 0].map(seg)];
  const p = projectEvidenceArtifacts({ acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS", parts });
  assert.equal(p.counts.userItems, 1);
  assert.equal(p.userItems.length, 1);
  const [item] = p.userItems;
  assert.equal(item.kind, "recording");
  assert.equal(item.label, SCREEN_RECORDING_ITEM_LABEL);
  assert.deepEqual(item.partIndexes, [0, 1, 2, 3, 4, 5]);
  assert.equal(item.primaryPartIndex, 0);
  assert.equal(item.layout, "SEGMENTED");
  assert.equal(item.combined, null);
  assert.deepEqual(p.technical, {
    originalPartCount: 6,
    captureRecordCount: 1,
    derivedCount: 0,
    storedPartCount: 7,
    captureRecordPartIndexes: [6],
  });
});

test("a SINGLE_FILE Android recording (recording + manifest) is ONE user item, part 0", () => {
  const p = projectEvidenceArtifacts({
    acquisitionMode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
    parts: [seg(0), manifest(1)],
  });
  assert.equal(p.counts.userItems, 1);
  assert.equal(p.userItems[0].layout, "SINGLE_FILE");
  assert.equal(p.userItems[0].primaryPartIndex, 0);
  assert.deepEqual(p.userItems[0].partIndexes, [0]);
  assert.equal(p.technical.captureRecordCount, 1);
});

test("the manifest-stated layout wins over the inferred one", () => {
  const p = projectEvidenceArtifacts({
    acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS",
    parts: [seg(0), manifest(1)],
    recordingLayout: "SEGMENTED",
  });
  assert.equal(p.userItems[0].layout, "SEGMENTED");
});

test("a completed combined derivative is attached to a SEGMENTED recording only", () => {
  const derived = [
    { assetKind: COMBINED_RECORDING_ASSET_KIND, status: "SUPERSEDED", id: "old" },
    { assetKind: COMBINED_RECORDING_ASSET_KIND, status: "COMPLETED", id: "new" },
    { assetKind: "video_keyframe", status: "COMPLETED" },
  ];
  const seg3 = projectEvidenceArtifacts({
    acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS",
    parts: [seg(0), seg(1), manifest(2)],
    derived,
  });
  assert.equal(seg3.userItems[0].combined.available, true);
  assert.equal(seg3.userItems[0].combined.asset.id, "new");
  assert.equal(seg3.userItems[0].combined.label, "Combined recording (derived from 2 original segments)");
  // A derived copy is never an original: it never adds a user item or an original part.
  assert.equal(seg3.counts.userItems, 1);
  assert.equal(seg3.technical.originalPartCount, 2);
  assert.equal(seg3.technical.derivedCount, 3);
  const single = projectEvidenceArtifacts({
    acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS",
    parts: [seg(0), manifest(1)],
    derived,
  });
  assert.equal(single.userItems[0].combined, null);
});

test("an ordinary multipart upload keeps one user item per ORIGINAL part", () => {
  const p = projectEvidenceArtifacts({
    acquisitionMode: "PROOVRA_WEB_UPLOAD",
    parts: [
      { partIndex: 1, mimeType: "image/png", artifactClass: "ORIGINAL", originalFileName: "b.png" },
      { partIndex: 0, mimeType: "image/png", artifactClass: "ORIGINAL", originalFileName: "a.png" },
    ],
  });
  assert.equal(p.counts.userItems, 2);
  assert.deepEqual(p.userItems.map((i) => [i.kind, i.label, i.primaryPartIndex]), [
    ["file", "a.png", 0],
    ["file", "b.png", 1],
  ]);
});

test("a web/frame capture's CAPTURE_MANIFEST is never a user item", () => {
  const p = projectEvidenceArtifacts({
    acquisitionMode: "DIRECT_WEB_CAPTURE_EXTENSION",
    parts: [seg(0), seg(1), manifest(2)],
  });
  assert.equal(p.counts.userItems, 2);
  assert.ok(p.userItems.every((i) => !i.partIndexes.includes(2)));
  assert.equal(
    classifyEvidencePartPresentation({ acquisitionMode: "DIRECT_WEB_CAPTURE_EXTENSION", artifactClass: "CAPTURE_MANIFEST" }),
    "capture_record",
  );
  assert.equal(CAPTURE_RECORD_SYSTEM_LABEL, "Capture record (system-generated)");
});

test("part presentation and the count-only helper follow the same rule", () => {
  assert.equal(isContinuousScreenRecordingMode("DIRECT_SCREEN_CAPTURE_ANDROID"), false);
  assert.equal(isContinuousScreenRecordingMode("DIRECT_SCREEN_CAPTURE_IOS"), true);
  assert.equal(
    classifyEvidencePartPresentation({ acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS", artifactClass: "ORIGINAL" }),
    "recording_part",
  );
  assert.equal(
    classifyEvidencePartPresentation({ acquisitionMode: "PROOVRA_WEB_UPLOAD", artifactClass: null }),
    "user_item",
  );
  assert.equal(countEvidenceUserItems({ acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS", originalPartCount: 6 }), 1);
  assert.equal(countEvidenceUserItems({ acquisitionMode: "PROOVRA_WEB_UPLOAD", originalPartCount: 3 }), 3);
  // A legacy record with no part rows is one item.
  assert.equal(countEvidenceUserItems({ acquisitionMode: null, originalPartCount: 0 }), 1);
  assert.equal(downloadOriginalFilesLabel(7), "Download original files (7 technical parts)");
});

test("an empty part list projects no items (callers apply the legacy single-file rule)", () => {
  const p = projectEvidenceArtifacts({ acquisitionMode: "DIRECT_SCREEN_CAPTURE_IOS", parts: [] });
  assert.equal(p.counts.userItems, 0);
});

test("Content-Disposition is RFC 6266 safe", () => {
  assert.equal(
    safeAttachmentContentDisposition("screen-recording-2026.mp4"),
    `attachment; filename="screen-recording-2026.mp4"; filename*=UTF-8''screen-recording-2026.mp4`,
  );
  const evil = safeAttachmentContentDisposition('../a"b\r\nX-Injected: 1;é.mp4');
  assert.ok(!/[\r\n]/.test(evil));
  assert.ok(!evil.includes("/"));
  assert.match(evil, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  assert.ok(evil.includes("%C3%A9"));
  assert.equal(safeAttachmentContentDisposition("", "fallback.bin"), `attachment; filename="fallback.bin"; filename*=UTF-8''fallback.bin`);
});

test("continuous recording facts are read from the custody manifest-facts event only", () => {
  assert.equal(continuousRecordingFactsFromCustody([]), null);
  assert.equal(continuousRecordingFactsFromCustody([{ eventType: "EVIDENCE_CREATED", payload: { kind: "SCREEN_CONTINUOUS" } }]), null);
  const legacy = continuousRecordingFactsFromCustody([
    { eventType: "CAPTURE_ARTIFACT_RECEIVED", payload: { stage: "manifest_facts", facts: { schema: "PROOVRA_CAPTURE_MANIFEST_FACTS_V1", kind: "SCREEN_CONTINUOUS" } } },
  ]);
  assert.equal(legacy?.layout, "SEGMENTED");
});
