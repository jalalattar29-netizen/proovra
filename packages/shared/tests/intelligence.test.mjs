import test from "node:test";
import assert from "node:assert/strict";

// Phase 15 — Intelligence shared-type tests.
//
// Coverage:
//   - catalogs (job kinds/statuses, text kinds, entity kinds/sources,
//     similarity kinds)
//   - mandatory AI disclaimer + intelligence advisory disclaimer
//   - forbidden-phrase guard
//   - similarity summary wording is advisory
//   - entity regex extraction
//   - normalisation helpers
//   - filename + text Jaccard

import {
  AI_ADVISORY_DISCLAIMER,
  EVIDENCE_ENTITY_KINDS,
  EVIDENCE_ENTITY_SOURCES,
  EVIDENCE_SIMILARITY_KINDS,
  EXTRACTED_TEXT_KINDS,
  EXTRACTED_TEXT_STATUSES,
  FORBIDDEN_AI_PHRASES,
  INTELLIGENCE_ADVISORY_DISCLAIMER,
  INTELLIGENCE_JOB_KINDS,
  INTELLIGENCE_JOB_STATUSES,
  aiResponseContainsForbiddenPhrase,
  extractRegexEntities,
  filenameTokens,
  jaccardSimilarity,
  normaliseEmail,
  normalisePhone,
  normaliseUrl,
  similaritySummaryFor,
  textSimilarity,
  textTokens,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

test("INTELLIGENCE_JOB_KINDS contains the five canonical kinds", () => {
  assert.deepEqual([...INTELLIGENCE_JOB_KINDS].sort(), [
    "EMBEDDING",
    "ENTITY_EXTRACTION",
    "OCR",
    "SIMILARITY",
    "TRANSCRIPT",
  ]);
});

test("INTELLIGENCE_JOB_STATUSES has PENDING/PROCESSING/COMPLETED/FAILED/SKIPPED", () => {
  assert.deepEqual([...INTELLIGENCE_JOB_STATUSES].sort(), [
    "COMPLETED",
    "FAILED",
    "PENDING",
    "PROCESSING",
    "SKIPPED",
  ]);
});

test("EXTRACTED_TEXT_KINDS covers OCR / PDF / transcript variants", () => {
  for (const k of [
    "OCR_PDF",
    "OCR_IMAGE",
    "PDF_TEXT",
    "TRANSCRIPT_AUDIO",
    "TRANSCRIPT_VIDEO",
  ]) {
    assert.ok(EXTRACTED_TEXT_KINDS.includes(k), `expected ${k}`);
  }
});

test("EXTRACTED_TEXT_STATUSES is PENDING/COMPLETED/FAILED/SKIPPED", () => {
  assert.deepEqual([...EXTRACTED_TEXT_STATUSES].sort(), [
    "COMPLETED",
    "FAILED",
    "PENDING",
    "SKIPPED",
  ]);
});

test("EVIDENCE_ENTITY_KINDS covers people/contact/temporal/reference", () => {
  for (const k of [
    "PERSON",
    "EMAIL",
    "PHONE",
    "ORG",
    "LOCATION",
    "DATE",
    "REFERENCE_ID",
    "URL",
  ]) {
    assert.ok(EVIDENCE_ENTITY_KINDS.includes(k), `expected ${k}`);
  }
});

test("EVIDENCE_ENTITY_SOURCES catalogs every audit-relevant origin", () => {
  for (const s of ["OCR", "TRANSCRIPT", "METADATA", "AI", "MANUAL"]) {
    assert.ok(EVIDENCE_ENTITY_SOURCES.includes(s), `expected ${s}`);
  }
});

test("EVIDENCE_SIMILARITY_KINDS covers the six advisory signals", () => {
  for (const k of [
    "HASH_DUPLICATE",
    "FILENAME_SIMILAR",
    "OCR_SIMILAR",
    "TRANSCRIPT_SIMILAR",
    "METADATA_SIMILAR",
    "EMBEDDING_SIMILAR",
  ]) {
    assert.ok(EVIDENCE_SIMILARITY_KINDS.includes(k), `expected ${k}`);
  }
});

// -----------------------------------------------------------------------------
// Disclaimers + forbidden wording
// -----------------------------------------------------------------------------

test("AI_ADVISORY_DISCLAIMER mentions advisory + factual-truth boundary", () => {
  assert.ok(/advisory/i.test(AI_ADVISORY_DISCLAIMER));
  assert.ok(/factual truth/i.test(AI_ADVISORY_DISCLAIMER));
  assert.ok(/authenticity/i.test(AI_ADVISORY_DISCLAIMER));
  assert.ok(/legal admissibility/i.test(AI_ADVISORY_DISCLAIMER));
});

test("INTELLIGENCE_ADVISORY_DISCLAIMER mentions advisory + no manipulation claim", () => {
  assert.ok(/advisory/i.test(INTELLIGENCE_ADVISORY_DISCLAIMER));
  assert.ok(/manipulation|fakery/i.test(INTELLIGENCE_ADVISORY_DISCLAIMER));
});

test("forbidden phrase guard catches authenticity / admissibility claims", () => {
  for (const phrase of FORBIDDEN_AI_PHRASES) {
    assert.equal(
      aiResponseContainsForbiddenPhrase(`This response: ${phrase}.`),
      true,
      `expected guard to catch "${phrase}"`,
    );
  }
});

test("forbidden phrase guard passes safe operational wording", () => {
  assert.equal(
    aiResponseContainsForbiddenPhrase("Possible related evidence detected."),
    false,
  );
  assert.equal(
    aiResponseContainsForbiddenPhrase(
      "Similar filename detected. Review attention suggested.",
    ),
    false,
  );
});

// -----------------------------------------------------------------------------
// Similarity wording is ADVISORY
// -----------------------------------------------------------------------------

test("similarity summaries use advisory wording (no 'same evidence confirmed')", () => {
  for (const k of EVIDENCE_SIMILARITY_KINDS) {
    const s = similaritySummaryFor(k);
    assert.ok(s.length > 0);
    assert.ok(
      /possib|similar/i.test(s),
      `summary for ${k} must read as advisory: "${s}"`,
    );
    assert.ok(
      !/same evidence confirmed/i.test(s),
      `summary for ${k} must NOT confirm identity`,
    );
    assert.ok(
      !/authentic|admissible|verified/i.test(s),
      `summary for ${k} must NOT claim authenticity / admissibility`,
    );
  }
});

// -----------------------------------------------------------------------------
// Entity extraction (deterministic regex)
// -----------------------------------------------------------------------------

test("extractRegexEntities picks up email + phone + URL + date + ref-id", () => {
  const text = `
    Witness email: alice@example.com
    Reach the office at +1 (555) 867-5309 or visit https://example.com/case
    Date of incident: 2026-05-21
    Case ref: REF-12345 logged Monday.
  `;
  const out = extractRegexEntities(text);
  const kinds = new Set(out.map((m) => m.kind));
  assert.ok(kinds.has("EMAIL"));
  assert.ok(kinds.has("PHONE"));
  assert.ok(kinds.has("URL"));
  assert.ok(kinds.has("DATE"));
  assert.ok(kinds.has("REFERENCE_ID"));
});

test("extractRegexEntities returns empty array on empty text", () => {
  assert.deepEqual(extractRegexEntities(""), []);
});

// -----------------------------------------------------------------------------
// Normalisation
// -----------------------------------------------------------------------------

test("normaliseEmail lowercases + validates", () => {
  assert.equal(normaliseEmail("Alice@Example.COM"), "alice@example.com");
  assert.equal(normaliseEmail("not-an-email"), null);
  assert.equal(normaliseEmail(null), null);
});

test("normalisePhone keeps digits only and rejects too-short / too-long", () => {
  assert.equal(normalisePhone("+1 (555) 867-5309"), "15558675309");
  assert.equal(normalisePhone("12"), null);
  assert.equal(normalisePhone("1234567890123456789"), null);
});

test("normaliseUrl returns canonical form or null", () => {
  assert.equal(
    normaliseUrl("https://example.com/path"),
    "https://example.com/path",
  );
  assert.equal(normaliseUrl("not-a-url"), null);
});

// -----------------------------------------------------------------------------
// Similarity helpers
// -----------------------------------------------------------------------------

test("filenameTokens tokenises on non-alphanumeric and drops < 2 chars", () => {
  const t = filenameTokens("Case-2026-WitnessStatement.v2.pdf");
  assert.ok(t.has("case"));
  assert.ok(t.has("2026"));
  assert.ok(t.has("witnessstatement"));
  assert.ok(t.has("v2"));
  assert.ok(t.has("pdf"));
});

test("jaccardSimilarity returns 1 for identical sets, 0 for disjoint", () => {
  const a = new Set(["alpha", "beta"]);
  const b = new Set(["alpha", "beta"]);
  const c = new Set(["gamma"]);
  assert.equal(jaccardSimilarity(a, b), 1);
  assert.equal(jaccardSimilarity(a, c), 0);
});

test("textTokens drops short fillers and lowercases", () => {
  const t = textTokens("The quick brown fox jumps");
  // "the" (3 chars) is included; "a" (1 char) would be filtered.
  assert.ok(t.has("quick"));
  assert.ok(t.has("brown"));
  assert.ok(t.has("fox"));
  assert.ok(t.has("jumps"));
});

test("textSimilarity > 0 for overlapping text", () => {
  const score = textSimilarity(
    "the witness arrived at the courthouse",
    "a witness arrived at the address",
  );
  assert.ok(score > 0);
  assert.ok(score < 1);
});
