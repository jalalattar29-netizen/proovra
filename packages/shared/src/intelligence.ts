/**
 * Phase 15 — Enterprise intelligence canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Holds:
 *   - Job kind + status catalogs
 *   - Extracted text kind + status catalogs
 *   - Entity kind + source catalogs
 *   - Similarity kind catalog
 *   - Mandatory AI disclaimer + advisory wording constants
 *   - Pure helpers: entity normalisation, filename Jaccard, advisory
 *     summary builders
 *
 * Wording rule (per Phase 15 brief): never claim "authentic / fake /
 * manipulated / legally admissible / proven / verified truth /
 * deepfake detected". Intelligence outputs are ALWAYS advisory.
 */

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

export const INTELLIGENCE_JOB_KINDS = [
  "OCR",
  "TRANSCRIPT",
  "ENTITY_EXTRACTION",
  "EMBEDDING",
  "SIMILARITY",
] as const;
export type IntelligenceJobKind = (typeof INTELLIGENCE_JOB_KINDS)[number];

export const INTELLIGENCE_JOB_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
] as const;
export type IntelligenceJobStatus = (typeof INTELLIGENCE_JOB_STATUSES)[number];

export const EXTRACTED_TEXT_KINDS = [
  "OCR_PDF",
  "OCR_IMAGE",
  "PDF_TEXT",
  "TRANSCRIPT_AUDIO",
  "TRANSCRIPT_VIDEO",
] as const;
export type ExtractedTextKind = (typeof EXTRACTED_TEXT_KINDS)[number];

export const EXTRACTED_TEXT_STATUSES = [
  "PENDING",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
] as const;
export type ExtractedTextStatus = (typeof EXTRACTED_TEXT_STATUSES)[number];

export const EVIDENCE_ENTITY_KINDS = [
  "PERSON",
  "EMAIL",
  "PHONE",
  "ORG",
  "LOCATION",
  "DATE",
  "REFERENCE_ID",
  "URL",
] as const;
export type EvidenceEntityKind = (typeof EVIDENCE_ENTITY_KINDS)[number];

export const EVIDENCE_ENTITY_SOURCES = [
  "OCR",
  "TRANSCRIPT",
  "METADATA",
  "AI",
  "MANUAL",
] as const;
export type EvidenceEntitySource = (typeof EVIDENCE_ENTITY_SOURCES)[number];

export const EVIDENCE_SIMILARITY_KINDS = [
  "HASH_DUPLICATE",
  "FILENAME_SIMILAR",
  "OCR_SIMILAR",
  "TRANSCRIPT_SIMILAR",
  "METADATA_SIMILAR",
  "EMBEDDING_SIMILAR",
] as const;
export type EvidenceSimilarityKind =
  (typeof EVIDENCE_SIMILARITY_KINDS)[number];

// -----------------------------------------------------------------------------
// MANDATORY AI / intelligence disclaimer
//
// Every AI-assisted response surface (API + UI) MUST include this
// string verbatim. The test suite asserts the constant exists in
// every projection that exposes AI output to operators.
// -----------------------------------------------------------------------------

export const AI_ADVISORY_DISCLAIMER =
  "AI assistance is advisory and does not determine factual truth, authenticity, or legal admissibility.";

export const INTELLIGENCE_ADVISORY_DISCLAIMER =
  "Intelligence signals are advisory only. They do not assert authenticity, manipulation, fakery, or legal admissibility.";

// -----------------------------------------------------------------------------
// Forbidden wording — checked at AI-assistance render time.
//
// Any AI response containing any of these phrases is rejected and the
// caller falls back to a safe operator message. Adding to this list
// does NOT silently remove the phrase from operator copy paste — the
// guard exists to keep the AI surface honest.
// -----------------------------------------------------------------------------

export const FORBIDDEN_AI_PHRASES = [
  "is authentic",
  "is verified",
  "is admissible",
  "legally admissible",
  "court admissible",
  "court-admissible",
  "is genuine",
  "deepfake detected",
  "deep fake detected",
  "manipulation detected",
  "manipulated",
  "tampered",
  "proven authentic",
  "proven fake",
  "is a fake",
  "is fake",
  "we confirm",
  "this is the same evidence",
] as const;

export function aiResponseContainsForbiddenPhrase(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const p of FORBIDDEN_AI_PHRASES) {
    if (lower.includes(p)) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Advisory summary builders for similarity hints
// -----------------------------------------------------------------------------

const SIMILARITY_SUMMARY: Readonly<Record<EvidenceSimilarityKind, string>> = {
  HASH_DUPLICATE: "Possible duplicate — same file SHA-256.",
  FILENAME_SIMILAR: "Similar filename detected.",
  OCR_SIMILAR: "Possibly related — OCR text overlap.",
  TRANSCRIPT_SIMILAR: "Possibly related — transcript text overlap.",
  METADATA_SIMILAR: "Similar metadata detected.",
  EMBEDDING_SIMILAR: "Possibly related — semantic similarity.",
};

export function similaritySummaryFor(kind: EvidenceSimilarityKind): string {
  return SIMILARITY_SUMMARY[kind];
}

// -----------------------------------------------------------------------------
// Entity normalisation
// -----------------------------------------------------------------------------

export function normaliseEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

export function normalisePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D+/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

export function normaliseUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const u = new URL(input.trim());
    return u.toString();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Filename similarity (Jaccard on lowercased letter-token sets)
//
// Token rules:
//   - split on non-letter / non-digit
//   - drop tokens < 2 chars
//   - lowercase
//   - dedupe
//
// Returns a 0..1 score. Used by similarity-detection.service.ts for
// the FILENAME_SIMILAR signal; never claims truth.
// -----------------------------------------------------------------------------

export function filenameTokens(name: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!name) return out;
  const lower = name.toLowerCase();
  for (const t of lower.split(/[^a-z0-9]+/)) {
    if (t.length >= 2) out.add(t);
  }
  return out;
}

export function jaccardSimilarity(
  a: Set<string>,
  b: Set<string>,
): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const v of a) {
    if (b.has(v)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// -----------------------------------------------------------------------------
// Entity-extraction regex helpers (deterministic; no AI needed)
//
// Operates on caller-provided text (OCR / transcript / metadata) and
// returns a typed list. The service-side wrapper adds normalisation +
// dedupe; this module exposes the raw matchers for tests.
// -----------------------------------------------------------------------------

export type RegexEntityMatch = {
  kind: EvidenceEntityKind;
  value: string;
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE =
  /\+?\d[\d\s\-().]{6,}\d/g;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const DATE_RE =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{2,4})\b/g;
const REFERENCE_ID_RE = /\b(?:ref|case|claim|matter|invoice|po|inv)[#:\-\s]*([A-Za-z0-9_-]{4,})\b/gi;

export function extractRegexEntities(text: string): RegexEntityMatch[] {
  const out: RegexEntityMatch[] = [];
  for (const m of text.matchAll(EMAIL_RE)) out.push({ kind: "EMAIL", value: m[0] });
  for (const m of text.matchAll(PHONE_RE)) out.push({ kind: "PHONE", value: m[0] });
  for (const m of text.matchAll(URL_RE)) out.push({ kind: "URL", value: m[0] });
  for (const m of text.matchAll(DATE_RE)) out.push({ kind: "DATE", value: m[0] });
  for (const m of text.matchAll(REFERENCE_ID_RE)) {
    out.push({ kind: "REFERENCE_ID", value: m[1] });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Word-set Jaccard for OCR / transcript similarity
//
// Cheap, deterministic, no embeddings required. Returns 0..1.
// -----------------------------------------------------------------------------

export function textTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const lower = text.toLowerCase();
  for (const t of lower.split(/[^a-z0-9']+/)) {
    if (t.length >= 3) out.add(t);
  }
  return out;
}

export function textSimilarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return jaccardSimilarity(textTokens(a), textTokens(b));
}
