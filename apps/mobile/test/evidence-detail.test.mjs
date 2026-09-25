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

const ENVELOPE_URL =
  "data:text/javascript," + encodeURIComponent(compile("../src/product/envelope.ts"));

const src = readFileSync(resolve(HERE, "../src/product/evidence-detail.ts"), "utf8")
  .replace('from "./envelope"', `from "${ENVELOPE_URL}"`)
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

test("the match summary says WHY in the web's words, with the part-level count", () => {
  // evidence.routes.ts:8091 — matchReasons are lowercase (`exact_hash`, `part_hash`, …);
  // DuplicateDetectionPanel.tsx:16/:106 — the web labels and `× n` on part_hash.
  const [m] = mod.parseDuplicateReport({
    groupedMatches: [{ evidenceId: "e1", matchReasons: ["exact_hash", "part_hash"], matchedPartsCount: 3 }],
  }).matches;
  assert.equal(mod.duplicateMatchSummary(m), "Exact file hash · Part-level hash × 3");
  const [meta] = mod.parseDuplicateReport({ groupedMatches: [{ evidenceId: "e2", matchReasons: ["metadata", "fingerprint"] }] }).matches;
  assert.equal(mod.duplicateMatchSummary(meta), "Filename + size · Fingerprint");
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

test("a legal note is read out of the envelope the route actually sends", () => {
  // Verbatim shape of GET /v1/evidence/:id/legal-notes
  // (evidence.routes.ts:7515), author per mapCollaborativeAuthor (:3213).
  const list = mod.parseLegalNotes({
    items: [
      {
        id: "3f1c2a6e-1111-4a2b-8c3d-000000000001",
        evidenceId: "9a0b1c2d-2222-4e5f-9a0b-000000000002",
        noteType: "PRIVILEGED",
        body: "Counsel reviewed the chain.",
        createdAt: "2026-09-20T10:15:00.000Z",
        updatedAt: "2026-09-20T10:15:00.000Z",
        edited: false,
        author: { id: "u-1", displayName: "Ada Lovelace", email: "ada@example.com" },
      },
    ],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].noteType, "PRIVILEGED");
  assert.equal(list[0].body, "Counsel reviewed the chain.");
  assert.equal(list[0].authorLabel, "Ada Lovelace");
  assert.equal(list[0].createdAtIso, "2026-09-20T10:15:00.000Z");
});

test("a raw user id is never shown where an author belongs", () => {
  // The server sends author: { id, displayName, email } with nulls preserved,
  // so an account that has set neither has no label - not its user id.
  const [n] = mod.parseLegalNotes({
    items: [{ id: "n1", body: "x", author: { id: "u-9", displayName: null, email: null } }],
  });
  assert.equal(n.authorLabel, null);
  const [byEmail] = mod.parseLegalNotes({
    items: [{ id: "n2", body: "x", author: { id: "u-9", displayName: null, email: "a@b.c" } }],
  });
  assert.equal(byEmail.authorLabel, "a@b.c");
});

test("an envelope we do not recognise is not an empty list", () => {
  // THE F-09 REGRESSION. Both parsers read notes/annotations and fell through
  // to the bare payload, so the items envelope the route has always sent was
  // refused by rows() and the tab rendered empty on every populated record.
  const note = {
    id: "n1",
    body: "x",
    author: { id: "u-1", displayName: "Ada", email: null },
  };
  assert.equal(mod.parseLegalNotes({ items: [note] }).length, 1);
  assert.equal(mod.parseAnnotations({ items: [{ id: "a1", annotationType: "TEXT" }] }).length, 1);

  // A legitimately empty list stays empty ...
  assert.deepEqual(mod.parseLegalNotes({ items: [] }), []);
  assert.deepEqual(mod.parseAnnotations({ items: [] }), []);

  // ... but a shape we cannot read REFUSES. Returning [] here is exactly how
  // this pair shipped unable to show a row while every test passed: the screen
  // said "no legal notes on this record" about a record that had them. The
  // throw reaches the caller's catch and renders the failed state instead.
  for (const bad of [null, undefined, 42, "items", { data: [note] }, { items: { note } }]) {
    assert.throws(() => mod.parseLegalNotes(bad), /Unreadable list response/);
    assert.throws(() => mod.parseAnnotations(bad), /Unreadable list response/);
  }
  // The keys this parser used to read are refused like any other envelope
  // the route does not send. They were invented here, not deprecated there.
  assert.throws(() => mod.parseLegalNotes({ notes: [note] }), /Unreadable list response/);
  assert.throws(() => mod.parseLegalNotes({ annotations: [note] }), /Unreadable list response/);
  // A bare array is still accepted: some list routes answer that way.
  assert.equal(mod.parseLegalNotes([note]).length, 1);
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
  // Verbatim shape of GET /v1/evidence/:id/annotations (evidence.routes.ts:7662).
  const author = { id: "u-1", displayName: "Ada Lovelace", email: "ada@example.com" };
  const list = mod.parseAnnotations({
    items: [
      {
        id: "a1",
        evidenceId: "ev-1",
        evidencePartId: null,
        annotationType: "TEXT",
        body: "note",
        pageNumber: null,
        mediaTimestampMs: null,
        x: null,
        y: null,
        width: null,
        height: null,
        coordinateSpace: "TIME_ONLY",
        createdAt: "2026-09-20T10:15:00.000Z",
        updatedAt: "2026-09-20T10:15:00.000Z",
        edited: false,
        author,
      },
      { id: "a2", annotationType: "TIMESTAMP", mediaTimestampMs: 125000, author },
      { id: "a3", annotationType: "BOX", x: 0.1, y: 0.2, coordinateSpace: "NORMALIZED", author },
      { id: "a4", annotationType: "TEXT", pageNumber: 4, author },
      { annotationType: "TEXT", author },
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

/* ------------------------------------------------- the lifecycle projection */

test("an absent lifecycle projection withholds rather than permits", () => {
  // A client that defaulted to yes would put a destructive control in front of
  // someone the server will refuse.
  assert.equal(mod.parseEvidenceLifecycle({}), null);
  assert.equal(mod.parseEvidenceLifecycle(null), null);
});

test("every verdict is READ, never re-derived", () => {
  const l = mod.parseEvidenceLifecycle({
    lifecycle: {
      productState: "ARCHIVED",
      canArchive: false,
      canUnarchive: true,
      canTrash: false,
      canRestoreFromTrash: false,
      archiveBlockReason: "ALREADY_IN_STATE",
      trashBlockReason: "LEGAL_HOLD_ACTIVE",
      legalHold: true,
    },
  });
  assert.equal(l.productState, "ARCHIVED");
  assert.equal(l.canUnarchive, true);
  // Not inferred from productState — the server said so.
  assert.equal(l.canArchive, false);
  assert.equal(l.legalHold, true);
});

test("a missing capability flag is false, not absent", () => {
  const l = mod.parseEvidenceLifecycle({ lifecycle: { productState: "ACTIVE" } });
  assert.equal(l.canArchive, false);
  assert.equal(l.canTrash, false);
});

test("a locked record is recognised from the server's own block reason", () => {
  // The code names the remedy: EVIDENCE_LOCKED on a trash or archive attempt
  // means unlock first.
  assert.equal(
    mod.evidenceIsLocked(
      mod.parseEvidenceLifecycle({
        lifecycle: { productState: "ACTIVE", trashBlockReason: "EVIDENCE_LOCKED" },
      }),
    ),
    true,
  );
  assert.equal(
    mod.evidenceIsLocked(
      mod.parseEvidenceLifecycle({
        lifecycle: { productState: "ACTIVE", trashBlockReason: "LEGAL_HOLD_ACTIVE" },
      }),
    ),
    false,
  );
  assert.equal(mod.evidenceIsLocked(null), false);
});

test("every block reason reads as a sentence, and an unknown one still refuses", () => {
  assert.match(mod.lifecycleBlockReasonLabel("EVIDENCE_LOCKED"), /Unlock it first/);
  assert.match(mod.lifecycleBlockReasonLabel("LEGAL_HOLD_ACTIVE"), /legal hold/i);
  assert.match(mod.lifecycleBlockReasonLabel("OBJECT_LOCK_RETENTION_ACTIVE"), /retention/i);
  // An unknown code is still a refusal. Saying "not available" with no reason
  // is honest; treating it as permitted would not be.
  assert.match(mod.lifecycleBlockReasonLabel("SOMETHING_NEW"), /not available/i);
  assert.equal(mod.lifecycleBlockReasonLabel(null), null);
});

test("the lifecycle paths are the canonical ones", () => {
  assert.equal(mod.buildEvidencePath("e1"), "/v1/evidence/e1");
  assert.equal(mod.buildEvidenceLockPath("e1"), "/v1/evidence/e1/lock");
  assert.equal(mod.buildEvidenceUnlockPath("e1"), "/v1/evidence/e1/unlock");
  assert.equal(mod.buildEvidenceArchivePath("e1"), "/v1/evidence/e1/archive");
  assert.equal(mod.buildEvidenceUnarchivePath("e1"), "/v1/evidence/e1/unarchive");
});

/* ----------------------------------------- F-04 renaming the record ------ */

test("the label route and its bound are the server's own", () => {
  // PATCH /v1/evidence/:id/label, UpdateEvidenceLabelBody 1..160
  // (evidence.routes.ts:388, :5813). Nothing native called it: a record
  // arrived as IMG_0042.jpg and stayed that way on a phone.
  assert.equal(mod.buildEvidenceLabelPath("ev 1"), "/v1/evidence/ev%201/label");
  assert.equal(mod.EVIDENCE_LABEL_MAX, 160);
  assert.match(mod.validateEvidenceLabel("   "), /Name the record/);
  assert.match(mod.validateEvidenceLabel("x".repeat(161)), /160/);
  assert.equal(mod.validateEvidenceLabel("Front door, 14:02"), null);
  assert.deepEqual(mod.buildEvidenceLabelBody("  Front door "), { label: "Front door" });
});

test("a record the route would refuse says so before the tap", () => {
  const lifecycle = (over) => ({
    productState: "ACTIVE",
    canArchive: true,
    canUnarchive: false,
    canTrash: true,
    canRestoreFromTrash: false,
    trashBlockReason: null,
    archiveBlockReason: null,
    legalHold: false,
    effectiveRetentionUntilIso: null,
    ...over,
  });

  assert.equal(mod.evidenceLabelRefusal(lifecycle({})), null);
  // The route answers 409 "permanently locked and cannot be renamed"; the
  // wording here is its own, so the two cannot drift.
  assert.match(
    mod.evidenceLabelRefusal(lifecycle({ trashBlockReason: "EVIDENCE_LOCKED" })),
    /permanently locked/,
  );
  assert.match(mod.evidenceLabelRefusal(lifecycle({ productState: "TRASHED" })), /trash/);
  assert.match(mod.evidenceLabelRefusal(lifecycle({ productState: "DESTROYED" })), /destroyed/);
  // An absent projection withholds: this screen never assumes permission it
  // has not read.
  assert.match(mod.evidenceLabelRefusal(null), /until the record's state is known/);
});

/* ------------------------------------- F-05 opening the ORIGINAL file ---- */

test("the consequence of opening the original is stated, not implied", () => {
  // GET /v1/evidence/:id/original appends EVIDENCE_VIEWED to the custody
  // chain and writes an evidence.downloaded audit row AS IT ANSWERS
  // (evidence.routes.ts:11591). By the time a toast could explain that, the
  // entry exists — so the sentence has to precede the request.
  assert.match(mod.ORIGINAL_ACCESS_CONSEQUENCE, /custody chain/);
  assert.match(mod.ORIGINAL_ACCESS_CONSEQUENCE, /your name and the time/);
  assert.match(mod.ORIGINAL_ACCESS_CONSEQUENCE, /10 minutes/);
});

test("the presigned link is read from the response the route sends", () => {
  assert.equal(mod.buildEvidenceOriginalPath("ev-1"), "/v1/evidence/ev-1/original");
  assert.equal(mod.parseOriginalLink({ url: "https://s3/x" }), "https://s3/x");
  assert.equal(mod.parseOriginalLink({ publicUrl: "https://cdn/x" }), "https://cdn/x");
  assert.equal(mod.parseOriginalLink({ url: "https://s3/x", publicUrl: "https://cdn/x" }), "https://s3/x");
  // "not available" and "available at nowhere" are different answers, and
  // only one of them should reach a button.
  for (const bad of [null, undefined, {}, { url: "" }, { url: 42 }]) {
    assert.equal(mod.parseOriginalLink(bad), null);
  }
});

test("a destroyed record is not offered an original it no longer has", () => {
  const base = {
    productState: "ACTIVE",
    canArchive: true,
    canUnarchive: false,
    canTrash: true,
    canRestoreFromTrash: false,
    trashBlockReason: null,
    archiveBlockReason: null,
    legalHold: false,
    effectiveRetentionUntilIso: null,
  };
  assert.equal(mod.originalAccessRefusal(base), null);
  assert.equal(mod.originalAccessRefusal(null), null);
  assert.match(
    mod.originalAccessRefusal({ ...base, productState: "DESTROYED" }),
    /no longer exists/,
  );
});

/* ---------------------------------- F-04 relationships were read-only ---- */

test("the relationship routes are the canonical ones", () => {
  // Read has worked from the start; the three write routes
  // (evidence.routes.ts:8389 / :8428 / :8475) were never called.
  assert.equal(
    mod.buildEvidenceRelationshipsPath("ev-1"),
    "/v1/evidence/ev-1/relationships",
  );
  assert.equal(
    mod.buildEvidenceRelationshipPath("ev-1", "rel 2"),
    "/v1/evidence/ev-1/relationships/rel%202",
  );
});

test("every relationship type the schema defines is offered", () => {
  // Generated from EvidenceRelationshipType rather than typed out, so a type
  // added to the schema cannot quietly become one this surface refuses.
  assert.deepEqual(
    [...mod.EVIDENCE_RELATIONSHIP_TYPES],
    ["RELATED", "SUPPORTS", "DUPLICATE_OF", "DERIVED_FROM", "SAME_INCIDENT", "CONTRADICTS", "REPLACES", "REFERENCES"],
  );
  assert.equal(mod.relationshipTypeLabel("SAME_INCIDENT"), "Same Incident");
});

test("an empty note is omitted, never sent as an empty string", () => {
  // The field is .optional().nullable(); sending "" would store a note that
  // says nothing where "no note" is the truthful state.
  assert.deepEqual(
    mod.buildRelationshipBody({ targetEvidenceId: "t1", relationshipType: "RELATED", note: "   " }),
    { targetEvidenceId: "t1", relationshipType: "RELATED" },
  );
  assert.deepEqual(
    mod.buildRelationshipBody({ targetEvidenceId: "t1", relationshipType: "REPLACES", note: " supersedes " }),
    { targetEvidenceId: "t1", relationshipType: "REPLACES", note: "supersedes" },
  );
  assert.equal(mod.RELATIONSHIP_NOTE_MAX, 1000);
  assert.match(mod.validateRelationshipNote("x".repeat(1001)), /1000/);
  assert.equal(mod.validateRelationshipNote(""), null);
});

test("linking needs the same write a rename does, and refuses in the same states", () => {
  // Both routes ask for evidence.update_metadata on THIS record (the routes'
  // own D21 note), so the refusals cannot be allowed to drift apart.
  const lifecycle = (over) => ({
    productState: "ACTIVE",
    canArchive: true,
    canUnarchive: false,
    canTrash: true,
    canRestoreFromTrash: false,
    trashBlockReason: null,
    archiveBlockReason: null,
    legalHold: false,
    effectiveRetentionUntilIso: null,
    ...over,
  });
  assert.equal(mod.relationshipEditRefusal(lifecycle({})), null);
  for (const state of [{ productState: "TRASHED" }, { productState: "DESTROYED" }, { trashBlockReason: "EVIDENCE_LOCKED" }]) {
    assert.notEqual(mod.relationshipEditRefusal(lifecycle(state)), null);
    assert.notEqual(mod.evidenceLabelRefusal(lifecycle(state)), null);
  }
  assert.match(mod.relationshipEditRefusal(null), /until the record's state is known/);
});

test("materials are read where the review workspace puts them: evidence.contentItems", () => {
  // evidence.routes.ts review-workspace reply nests the files under `evidence`.
  // Reading only the top level found nothing, so the Materials list was empty.
  const items = mod.projectMaterials({
    evidence: { id: "ev-1", contentItems: [{ id: "p1", index: 0, label: "roof.jpg", kind: "image", isPrimary: true, downloadable: false, previewable: true }] },
    relationships: { items: [] },
  });
  assert.equal(items.length, 1, "the nested files were not read");
  assert.equal(items[0].label, "roof.jpg");
});
