import test from "node:test";
import assert from "node:assert/strict";

// Phase 24 — Enterprise Evidence Discovery shared-types contract tests.
//
// Coverage:
//   - SEARCH_DOCUMENT_TYPES catalog is exhaustive + sorted intent
//   - SearchFilterSchema strictness (rejects unknown filters)
//   - SearchSortMode enum membership
//   - SavedViewVisibility membership
//   - encode/decode cursor round-trip + malformed input handling
//   - allowed badge catalog membership + isAllowedSearchBadge
//   - forbidden overclaim regex matches the brief's hard-list

import {
  SAVED_VIEW_VISIBILITIES,
  SEARCH_DOCUMENT_TYPES,
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  SEARCH_RESULT_ALLOWED_BADGES,
  SEARCH_SORT_MODES,
  SearchDocumentTypeSchema,
  SearchFilterSchema,
  SearchSortModeSchema,
  SavedViewVisibilitySchema,
  decodeSearchCursor,
  encodeSearchCursor,
  isAllowedSearchBadge,
  stringContainsForbiddenOverclaim,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Document-type catalog
// -----------------------------------------------------------------------------

test("SEARCH_DOCUMENT_TYPES covers all Phase 24 surfaces", () => {
  const expected = [
    "EVIDENCE",
    "WORKFLOW",
    "WORKFLOW_STEP",
    "REVIEW_EVENT",
    "AUDIT_EVENT",
    "COMMUNICATION",
    "CASE_TIMELINE",
    "INCIDENT",
  ];
  assert.deepEqual([...SEARCH_DOCUMENT_TYPES].sort(), [...expected].sort());
});

test("SearchDocumentTypeSchema rejects unknown values", () => {
  assert.equal(SearchDocumentTypeSchema.safeParse("EVIDENCE").success, true);
  assert.equal(SearchDocumentTypeSchema.safeParse("UNKNOWN").success, false);
  assert.equal(SearchDocumentTypeSchema.safeParse("").success, false);
});

// -----------------------------------------------------------------------------
// Sort mode catalog
// -----------------------------------------------------------------------------

test("SEARCH_SORT_MODES contains exactly the five bounded modes", () => {
  assert.deepEqual([...SEARCH_SORT_MODES].sort(), [
    "CREATED_ASC",
    "CREATED_DESC",
    "RELEVANCE_DESC",
    "UPDATED_ASC",
    "UPDATED_DESC",
  ]);
  assert.equal(SearchSortModeSchema.safeParse("RANDOM").success, false);
});

// -----------------------------------------------------------------------------
// Saved-view visibility
// -----------------------------------------------------------------------------

test("SavedViewVisibility is PRIVATE or TEAM only", () => {
  assert.deepEqual([...SAVED_VIEW_VISIBILITIES].sort(), ["PRIVATE", "TEAM"]);
  assert.equal(SavedViewVisibilitySchema.safeParse("PUBLIC").success, false);
});

// -----------------------------------------------------------------------------
// Filter schema — strict mode rejects unknown keys.
// -----------------------------------------------------------------------------

// Use the explicitly-allowed nil UUID — Zod v4 enforces version/variant
// bits in its uuid() validator, so `11111111-1111-1111-1111-111111111111`
// is NOT accepted.
const fixtureTeamId = "00000000-0000-0000-0000-000000000000";

test("SearchFilterSchema accepts a minimal valid filter", () => {
  const r = SearchFilterSchema.safeParse({ teamId: fixtureTeamId });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.teamId, fixtureTeamId);
});

test("SearchFilterSchema accepts a fully-populated valid filter", () => {
  const r = SearchFilterSchema.safeParse({
    teamId: fixtureTeamId,
    q: "ferry incident 2026",
    documentTypes: ["EVIDENCE", "WORKFLOW"],
    evidenceTypes: ["PHOTO", "VIDEO"],
    workflowStatuses: ["SUBMITTED", "NEEDS_REVIEW"],
    reviewStatuses: ["AWAITING_REVIEWER"],
    onLegalHold: false,
    exportRestricted: true,
    incidentLinked: true,
    workflowLinked: true,
    contributorScoped: false,
    updatedSinceUtc: "2026-01-01T00:00:00.000Z",
    updatedUntilUtc: "2026-12-31T23:59:59.000Z",
    sort: "UPDATED_DESC",
    cursor: "abcdefgh",
    limit: 25,
  });
  assert.equal(r.success, true);
});

test("SearchFilterSchema rejects unknown filters (.strict)", () => {
  const r = SearchFilterSchema.safeParse({
    teamId: fixtureTeamId,
    somethingNew: true,
  });
  assert.equal(r.success, false);
});

test("SearchFilterSchema enforces q length bound (200)", () => {
  const r = SearchFilterSchema.safeParse({
    teamId: fixtureTeamId,
    q: "x".repeat(201),
  });
  assert.equal(r.success, false);
});

test("SearchFilterSchema rejects bad teamId", () => {
  assert.equal(
    SearchFilterSchema.safeParse({ teamId: "not-a-uuid" }).success,
    false
  );
});

test("SearchFilterSchema enforces documentTypes max=8", () => {
  const all = [...SEARCH_DOCUMENT_TYPES];
  const r = SearchFilterSchema.safeParse({
    teamId: fixtureTeamId,
    documentTypes: [...all, "EVIDENCE"], // 9 items
  });
  assert.equal(r.success, false);
});

test("SearchFilterSchema enforces limit bounds (1..100)", () => {
  assert.equal(
    SearchFilterSchema.safeParse({ teamId: fixtureTeamId, limit: 0 }).success,
    false
  );
  assert.equal(
    SearchFilterSchema.safeParse({ teamId: fixtureTeamId, limit: 101 }).success,
    false
  );
  assert.equal(
    SearchFilterSchema.safeParse({ teamId: fixtureTeamId, limit: 50 }).success,
    true
  );
});

// -----------------------------------------------------------------------------
// Cursor encode/decode
// -----------------------------------------------------------------------------

test("encode + decode cursor round-trips", () => {
  const c = {
    updatedAtUtc: "2026-04-01T12:00:00.000Z",
    id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
  };
  const encoded = encodeSearchCursor(c);
  assert.equal(typeof encoded, "string");
  assert.notEqual(encoded.length, 0);
  const decoded = decodeSearchCursor(encoded);
  assert.deepEqual(decoded, c);
});

test("decodeSearchCursor returns null for non-base64 input", () => {
  assert.equal(decodeSearchCursor("not base64!@#"), null);
});

test("decodeSearchCursor returns null for malformed JSON payload", () => {
  // valid base64url, but the decoded bytes are not JSON
  const bogus = Buffer.from("not json at all", "utf8").toString("base64url");
  assert.equal(decodeSearchCursor(bogus), null);
});

test("decodeSearchCursor returns null when fields are missing", () => {
  const partial = Buffer.from(JSON.stringify({ id: "x" }), "utf8").toString(
    "base64url"
  );
  assert.equal(decodeSearchCursor(partial), null);
});

// -----------------------------------------------------------------------------
// Badge catalog
// -----------------------------------------------------------------------------

test("SEARCH_RESULT_ALLOWED_BADGES carries the operator-safe wording", () => {
  for (const b of [
    "matched metadata",
    "related evidence",
    "workflow-linked",
    "review-linked",
    "governance-restricted",
    "visibility-restricted",
    "legal-hold",
    "export-restricted",
    "integrity record",
    "incident-linked",
    "communication-linked",
    "contributor-scoped",
  ]) {
    assert.equal(
      SEARCH_RESULT_ALLOWED_BADGES.includes(b),
      true,
      `expected badge "${b}" to be allowed`
    );
    assert.equal(isAllowedSearchBadge(b), true);
  }
});

test("isAllowedSearchBadge rejects free-form labels", () => {
  assert.equal(isAllowedSearchBadge("court-approved"), false);
  assert.equal(isAllowedSearchBadge("forensic proof"), false);
  assert.equal(isAllowedSearchBadge(""), false);
});

// -----------------------------------------------------------------------------
// Forbidden overclaim wording
// -----------------------------------------------------------------------------

test("SEARCH_FORBIDDEN_OVERCLAIM_PHRASES catches the brief's banned phrases", () => {
  const banned = [
    "this image is tamper-proof",
    "court-approved chain of custody",
    "guaranteed authentic record",
    "impossible to alter",
    "detects fake photos",
    "forensic proof of integrity",
    "legally admissible evidence",
  ];
  for (const phrase of banned) {
    assert.equal(
      stringContainsForbiddenOverclaim(phrase),
      true,
      `expected "${phrase}" to be flagged`
    );
  }
});

test("stringContainsForbiddenOverclaim leaves operator-safe wording alone", () => {
  assert.equal(stringContainsForbiddenOverclaim("matched metadata"), false);
  assert.equal(stringContainsForbiddenOverclaim("related evidence"), false);
  assert.equal(stringContainsForbiddenOverclaim("integrity record"), false);
  assert.equal(stringContainsForbiddenOverclaim(""), false);
});

test("forbidden regex list is non-empty and case-insensitive", () => {
  assert.ok(SEARCH_FORBIDDEN_OVERCLAIM_PHRASES.length >= 7);
  assert.equal(stringContainsForbiddenOverclaim("TAMPER-PROOF"), true);
  assert.equal(stringContainsForbiddenOverclaim("Court Approved"), true);
});
