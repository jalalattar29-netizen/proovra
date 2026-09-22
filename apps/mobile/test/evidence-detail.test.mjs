/**
 * GUARD — native evidence-detail projection (Master Program §5/B, M2). Binds the
 * REAL review-workspace shape (custody events, TSA/OTS, signature, relationships,
 * provenance) + technical-metadata + certifications — NOT the non-existent fields
 * the screen used to read (rw.parts / rw.integrity). Pure; nothing fabricated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));

const compile = (file) =>
  ts.transpileModule(readFileSync(resolve(HERE, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/**
 * The two real modules evidence-detail imports, inlined as data URLs.
 *
 * A data-URL module cannot resolve a relative specifier. The GENERATED enum
 * module in particular is substituted for real rather than stubbed, because
 * the whole point of generating it is that the values under test are the
 * canonical ones.
 */
const ENUMS_URL = "data:text/javascript," + encodeURIComponent(compile("../src/product/domain-enums.generated.ts"));
const DISPLAY_URL =
  "data:text/javascript," +
  encodeURIComponent(
    compile("../src/product/domain-display.ts")
      .replace(/from ["']\.\/domain-enums\.generated["']/g, `from "${ENUMS_URL}"`),
  );

const src = readFileSync(resolve(HERE, "../src/product/evidence-detail.ts"), "utf8")
  .replace(/from ["']\.\/domain-display["']/g, `from "${DISPLAY_URL}"`)
  .replace(/from ["']\.\/domain-enums\.generated["']/g, `from "${ENUMS_URL}"`);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

// Mirrors apps/web/.../review-workspace-types.ts (the authoritative shape).
const rw = {
  custodyLifecycle: {
    forensicEvents: [
      { sequence: 1, atUtc: "2026-09-19T10:00:00Z", eventType: "EVIDENCE_SEALED", payloadSummary: "Sealed", category: "forensic" },
      { eventType: "" }, // dropped
    ],
    accessEvents: [{ sequence: 5, atUtc: "2026-09-19T11:00:00Z", eventType: "REPORT_DOWNLOADED", payloadSummary: "Downloaded", category: "access" }],
  },
  preservationMatrix: {
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
    verificationStatusLabel: "Integrity verified",
    signature: { recorded: true, valid: true, keyId: "k1" },
    tsa: { status: "GRANTED", provider: "FreeTSA", genTimeUtc: "2026-09-19T10:01:00Z", failureReason: null },
    ots: { status: "PENDING", effectiveStatus: "ANCHORED", proofPresent: true, hashMatches: true, anchoredAtUtc: "2026-09-19T10:05:00Z", bitcoinTxid: "abc123", failureReason: null },
    custodyChain: { valid: true, mode: "HASH_CHAIN", reason: null },
  },
  relationships: {
    items: [
      { id: "r1", relationshipType: "DERIVED_FROM", direction: "outbound", createdAt: "x", updatedAt: "x", linkedEvidence: { id: "ev2", title: "Original", status: "SIGNED" } },
      { id: "r2", relationshipType: "X", linkedEvidence: {} }, // no linked id → dropped
    ],
  },
  sourceContext: { acquisition: { mode: "PROOVRA_MOBILE_APP", category: "MOBILE_APP", label: "Captured with the PROOVRA app", statement: "This record was captured…" } },
  publicVerificationSummary: { state: "PUBLISHED", published: true, disabledReason: null },
};

test("custody events bind from custodyLifecycle (forensic + access), drop malformed", () => {
  const { forensic, access } = mod.projectCustodyEvents(rw);
  assert.equal(forensic.length, 1);
  assert.equal(forensic[0].eventType, "EVIDENCE_SEALED");
  assert.equal(access.length, 1);
  assert.equal(access[0].category, "access");
});

test("preservation binds TSA/OTS/signature/custody-chain from preservationMatrix", () => {
  const p = mod.projectPreservation(rw);
  assert.equal(p.tsa.status, "GRANTED");
  assert.equal(p.tsa.provider, "FreeTSA");
  assert.equal(p.ots.effectiveStatus, "ANCHORED");
  assert.equal(p.ots.bitcoinTxid, "abc123");
  assert.equal(p.signature.recorded, true);
  assert.equal(p.custodyChain.valid, true);
});

test("relationships bind read-only, dropping rows without a linked id", () => {
  const rels = mod.projectRelationships(rw);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].linkedId, "ev2");
  assert.equal(rels[0].linkedTitle, "Original");
});

test("provenance binds from sourceContext.acquisition", () => {
  const prov = mod.projectProvenance(rw);
  assert.equal(prov.label, "Captured with the PROOVRA app");
  assert.equal(prov.mode, "PROOVRA_MOBILE_APP");
});

test("technical + EXIF project from /technical-metadata; certifications from /certifications", () => {
  const tech = mod.projectTechnical({
    technicalMetadata: {
      media: { primaryMediaType: "IMAGE", resolutionSummary: "4032×3024", filesAnalyzed: 1, filesTotal: 1, metadataStatus: "COMPLETE" },
      exif: { exifPresent: true, camera: "Pixel 8", iso: 100, aperture: "f/1.8", gpsPresent: true },
      captureEnvironment: { captureMethod: "SECURE_CAPTURE", deviceClass: "MOBILE", osName: "Android 14", timezone: "Europe/Berlin" },
    },
  });
  assert.equal(tech.primaryMediaType, "IMAGE");
  assert.equal(tech.exif.camera, "Pixel 8");
  assert.equal(tech.exif.gpsPresent, true);
  assert.equal(tech.capture.timezone, "Europe/Berlin");
  assert.equal(mod.projectTechnical({}), null);

  const certs = mod.projectCertifications({ certifications: [{ id: "c1", declarationType: "AUTHENTICITY", status: "ATTESTED", attestorName: "Jane", attestedAtUtc: "x", revokedAtUtc: null }] });
  assert.equal(certs.length, 1);
  assert.equal(certs[0].revoked, false);
});

test("garbage review-workspace fails safe to empty projections", () => {
  assert.deepEqual(mod.projectCustodyEvents(null), { forensic: [], access: [] });
  assert.deepEqual(mod.projectRelationships(null), []);
  assert.equal(mod.projectProvenance(null), null);
});

/* ----------------------------------------------------- materials + comments */

/**
 * The record's files and the conversation about them. The detail screen had
 * custody, integrity and technical metadata but never listed the files, so on
 * a multi-part record — what every mixed-media capture produces — there was no
 * way to see what was actually in it. And a reviewer on a phone could read
 * every hash and not a word anyone had said.
 */
test("materials are ordered by part index and drop rows with no id", () => {
  const list = mod.projectMaterials({
    contentItems: [
      { id: "p2", index: 1, label: "second.jpg", downloadable: true, viewUrl: "https://x/2" },
      { index: 0, label: "orphan" },
      { id: "p1", index: 0, label: "first.jpg", downloadable: true, viewUrl: "https://x/1" },
    ],
  });
  assert.deepEqual(list.map((m) => m.id), ["p1", "p2"]);
});

test("downloadability is the SERVER's answer, never widened here", () => {
  const [locked] = mod.projectMaterials({
    contentItems: [{ id: "p1", label: "x", downloadable: false, viewUrl: "https://x/1" }],
  });
  // A url without permission is still not a download.
  assert.equal(locked.downloadable, false);
  assert.match(mod.materialBlockedReason(locked), /not available for download/i);

  const [noUrl] = mod.projectMaterials({
    contentItems: [{ id: "p1", label: "x", downloadable: true, viewUrl: null }],
  });
  assert.match(mod.materialBlockedReason(noUrl), /could not be issued/i);

  const [ok] = mod.projectMaterials({
    contentItems: [{ id: "p1", label: "x", downloadable: true, viewUrl: "https://x/1" }],
  });
  assert.equal(mod.materialBlockedReason(ok), null);
});

test("a file with no label still has a name", () => {
  const [a] = mod.projectMaterials({
    contentItems: [{ id: "p1", originalFileName: "IMG_1.jpg" }],
  });
  assert.equal(a.label, "IMG_1.jpg");
  const [b] = mod.projectMaterials({ contentItems: [{ id: "p1" }] });
  assert.equal(b.label, "Untitled file");
});

test("an unrecognised comment visibility reads as the NARROWER one", () => {
  // Guessing wide on a comment nobody can un-share is the wrong direction to
  // be wrong.
  const [c] = mod.projectComments({
    items: [{ id: "c1", body: "x", visibility: "EVERYONE" }],
  });
  assert.equal(c.visibility, "INTERNAL");

  const [t] = mod.projectComments({ items: [{ id: "c1", body: "x", visibility: "TEAM" }] });
  assert.equal(t.visibility, "TEAM");
});

test("comments read forwards and name their author", () => {
  const list = mod.projectComments({
    items: [
      { id: "c2", body: "later", createdAt: "2026-09-02T00:00:00.000Z", author: {} },
      { id: "c1", body: "earlier", createdAt: "2026-09-01T00:00:00.000Z", author: { displayName: "Sam" } },
      { body: "orphan" },
    ],
  });
  assert.deepEqual(list.map((c) => c.id), ["c1", "c2"]);
  assert.equal(list[0].authorName, "Sam");
  assert.equal(list[1].authorName, "Someone");
});

test("a comment body is bounded by the route's own limits", () => {
  assert.equal(mod.isSendableComment(""), false);
  assert.equal(mod.isSendableComment("   "), false);
  assert.equal(mod.isSendableComment("ok"), true);
  assert.equal(mod.isSendableComment("x".repeat(4000)), true);
  assert.equal(mod.isSendableComment("x".repeat(4001)), false);
});

test("the default visibility is the narrow one", () => {
  assert.deepEqual(mod.buildCommentBody("  hi  "), { body: "hi", visibility: "INTERNAL" });
  assert.deepEqual(mod.buildCommentBody("hi", "TEAM"), { body: "hi", visibility: "TEAM" });
});

test("the comment paths are the canonical ones", () => {
  assert.equal(mod.buildCommentsPath("ev-1"), "/v1/evidence/ev-1/comments");
  assert.equal(mod.buildCommentPath("ev-1", "c1"), "/v1/evidence/ev-1/comments/c1");
});

/* ------------------------------------------------------ duplicate detection */

test("the grouped view is read, not the four legacy arrays", () => {
  // The per-category arrays repeated a record across categories and once per
  // matching part: one duplicate with 8 matching parts produced 8 rows.
  const r = mod.parseDuplicateReport({
    groupedMatches: [
      {
        evidenceId: "e1",
        rawTitle: "Kitchen leak",
        type: "PHOTO",
        itemCount: 3,
        createdAt: "2026-09-01T00:00:00.000Z",
        matchReasons: ["EXACT_HASH", "PART_HASH"],
        matchedPartsCount: 8,
      },
      { rawTitle: "no id" },
    ],
    exactHashMatches: [{ id: "e1" }, { id: "e1" }],
    totalRecords: 1,
  });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].title, "Kitchen leak");
  assert.equal(r.totalRecords, 1);
});

test("the title cascade runs, because rawTitle is null when the column is empty", () => {
  // The backend used to pre-substitute "Digital Evidence Record" for every
  // empty title, so every row showed the same words and told the reader
  // nothing about which record is which.
  const byFile = mod.parseDuplicateReport({
    groupedMatches: [{ evidenceId: "e1", rawTitle: null, displayFileName: "IMG_0042.HEIC" }],
  });
  assert.equal(byFile.matches[0].title, "IMG_0042.HEIC");

  const byOriginal = mod.parseDuplicateReport({
    groupedMatches: [{ evidenceId: "e1", rawTitle: null, originalFileName: "scan.pdf" }],
  });
  assert.equal(byOriginal.matches[0].title, "scan.pdf");

  const byType = mod.parseDuplicateReport({
    groupedMatches: [{ evidenceId: "e1", rawTitle: null, type: "PHOTO" }],
  });
  assert.equal(byType.matches[0].title, "Photo");

  const byId = mod.parseDuplicateReport({
    groupedMatches: [{ evidenceId: "abcdef1234567890", rawTitle: null }],
  });
  assert.match(byId.matches[0].title, /abcdef12/);
});

test("the match summary says WHY, including the part count", () => {
  const [m] = mod.parseDuplicateReport({
    groupedMatches: [{ evidenceId: "e1", matchReasons: ["EXACT_HASH"], matchedPartsCount: 3 }],
  }).matches;
  assert.match(mod.duplicateMatchSummary(m), /Identical file hash/);
  assert.match(mod.duplicateMatchSummary(m), /3 matching parts/);
});

test("the limitation is stated whether or not anything matched", () => {
  // "No duplicates found" alone reads as "there are none", which is a stronger
  // claim than the check can support.
  assert.match(mod.DUPLICATE_LIMITATION, /accessible records/);
  assert.match(mod.DUPLICATE_LIMITATION, /hashes or metadata/);
});

/* -------------------------------------------------------------- generation */

test("the outcome is read, not the boolean", () => {
  // enqueued:false covered six answers on the web, and two of them described
  // work that was never going to happen.
  const blocked = mod.readGenerationOutcome({ outcome: "RECOVERABLE_BLOCKED" });
  assert.equal(blocked.acceptedWork, false);
  assert.match(blocked.message, /blocked/i);
  assert.equal(blocked.tone, "info");

  const queue = mod.readGenerationOutcome({ outcome: "QUEUE_UNAVAILABLE" });
  assert.equal(queue.acceptedWork, false);
  assert.match(queue.message, /picked up automatically/i);
});

test("only ENQUEUED and SUPERSEDED mean work was accepted", () => {
  assert.equal(mod.generationAcceptedWork("ENQUEUED"), true);
  assert.equal(mod.generationAcceptedWork("SUPERSEDED"), true);
  for (const o of ["ALREADY_ACTIVE", "QUEUE_UNAVAILABLE", "TERMINAL", "NOT_INCLUDED"]) {
    assert.equal(mod.generationAcceptedWork(o), false, o);
  }
});

test("the server's own sentence wins over the fallback", () => {
  const r = mod.readGenerationOutcome({ outcome: "ENQUEUED", message: "  Queued for you.  " });
  assert.equal(r.message, "Queued for you.");
});

test("the legacy boolean still reads correctly when no outcome arrived", () => {
  assert.equal(mod.readGenerationOutcome({ enqueued: true }).outcome, "ENQUEUED");
  // false is ALREADY_ACTIVE, not a failure — the same reading the web uses.
  assert.equal(mod.readGenerationOutcome({ enqueued: false }).outcome, "ALREADY_ACTIVE");
  assert.equal(mod.readGenerationOutcome({}).outcome, "ALREADY_ACTIVE");
});

test("an outcome the client does not know is not invented", () => {
  // It falls to the legacy reading rather than being echoed as if understood.
  const r = mod.readGenerationOutcome({ outcome: "SOMETHING_NEW", enqueued: true });
  assert.equal(r.outcome, "ENQUEUED");
});

test("only a regeneration asks first, and says what it costs", () => {
  assert.equal(mod.generationNeedsConfirmation("REGENERATE"), true);
  assert.equal(mod.generationNeedsConfirmation("RETRY"), false);
  assert.equal(mod.generationNeedsConfirmation("GENERATE"), false);
  assert.match(mod.REGENERATE_CONSEQUENCE, /new immutable version/i);
  assert.match(mod.REGENERATE_CONSEQUENCE, /No evidence credit is charged/i);
});

/* --------------------------------------------- legal notes and annotations */

test("the internal-materials boundary names all three exclusions", () => {
  assert.match(mod.INTERNAL_MATERIALS_BOUNDARY, /public verification/i);
  assert.match(mod.INTERNAL_MATERIALS_BOUNDARY, /PDF report/i);
  assert.match(mod.INTERNAL_MATERIALS_BOUNDARY, /verification package/i);
});

test("the legal-note bounds are the route's own", () => {
  assert.equal(mod.LEGAL_NOTE_MAX, 6000);
  assert.match(mod.validateLegalNote("  "), /Write the note/);
  assert.match(mod.validateLegalNote("x".repeat(6001)), /6000/);
  assert.deepEqual(mod.buildLegalNoteBody("  hello ", "PRIVILEGED"), {
    body: "hello",
    noteType: "PRIVILEGED",
  });
});

test("privilege is a claim with consequences, and is recognised", () => {
  assert.equal(mod.legalNoteIsPrivileged("PRIVILEGED"), true);
  assert.equal(mod.legalNoteIsPrivileged("GENERAL"), false);
});

test("a raw user id is never shown where an author belongs", () => {
  const [n] = mod.parseLegalNotes({ notes: [{ id: "n1", body: "x", authorUserId: "u-9" }] });
  assert.equal(n.authorLabel, null);
  const [named] = mod.parseLegalNotes({
    notes: [{ id: "n1", body: "x", author: { displayName: "Ada" } }],
  });
  assert.equal(named.authorLabel, "Ada");
});

test("a phone writes a TEXT annotation with no spatial claim", () => {
  // A coordinate guessed from a thumbnail would assert WHERE in the evidence
  // something is. TIME_ONLY asserts nothing about the frame.
  const body = mod.buildAnnotationBody("  Check the timestamp ");
  assert.equal(body.annotationType, "TEXT");
  assert.equal(body.coordinateSpace, "TIME_ONLY");
  assert.equal(body.body, "Check the timestamp");
  assert.equal("x" in body, false);
  assert.equal("mediaTimestampMs" in body, false);

  const timed = mod.buildAnnotationBody("At the crash", 90000);
  assert.equal(timed.mediaTimestampMs, 90000);
});

test("every annotation type is READ, and its anchor read honestly", () => {
  const list = mod.parseAnnotations({
    annotations: [
      { id: "a1", annotationType: "TEXT", body: "note" },
      { id: "a2", annotationType: "TIMESTAMP", mediaTimestampMs: 125000 },
      { id: "a3", annotationType: "BOX", x: 0.1, y: 0.2 },
      { id: "a4", annotationType: "TEXT", pageNumber: 4 },
      { annotationType: "TEXT" },
    ],
  });
  assert.equal(list.length, 4);
  assert.equal(mod.annotationAnchorLabel(list[0]), null);
  assert.equal(mod.annotationAnchorLabel(list[1]), "At 02:05");
  // A spatial annotation this surface cannot place is named as marked on the
  // media rather than rendered as if it were about the whole record.
  assert.equal(mod.annotationAnchorLabel(list[2]), "Marked on the media");
  assert.equal(mod.annotationAnchorLabel(list[3]), "Page 4");
});

test("the annotation bound is the route's own", () => {
  assert.equal(mod.ANNOTATION_BODY_MAX, 4000);
  assert.match(mod.validateAnnotation("x".repeat(4001)), /4000/);
  assert.equal(mod.validateAnnotation("ok"), null);
});

test("the internal-materials paths are the canonical ones", () => {
  assert.equal(mod.buildAnnotationsPath("e1"), "/v1/evidence/e1/annotations");
  assert.equal(mod.buildAnnotationPath("e1", "a1"), "/v1/evidence/e1/annotations/a1");
  assert.equal(mod.buildLegalNotesPath("e1"), "/v1/evidence/e1/legal-notes");
  assert.equal(mod.buildLegalNotePath("e1", "n1"), "/v1/evidence/e1/legal-notes/n1");
  assert.equal(mod.buildDuplicatesPath("e1"), "/v1/evidence/e1/duplicates");
  assert.equal(mod.buildRegeneratePath("e1"), "/v1/evidence/e1/reports/regenerate");
});
