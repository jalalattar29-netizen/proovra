/**
 * Phase A5 — Prohibited-claims engine (layered, categorized).
 *
 * Replaces reliance on a fragile literal phrase blocklist with a categorized,
 * variant-normalized deterministic validator. Text is NFKC-normalized, lower-
 * cased, and whitespace/punctuation-collapsed BEFORE matching so homoglyph /
 * spacing / punctuation variants ("100% authentic", "a u t h e n t i c",
 * "authored by John") cannot slip past. Any match produces a category list, a
 * safe rewrite, and a blocked verdict.
 *
 * This is one layer; it composes with (1) the system-prompt policy, (2) the
 * response schema which contains no verdict fields, and (3) the route-level
 * blocked-claim audit event.
 */

export type ProhibitedClaimCategory =
  | "FACTUAL_TRUTH"
  | "AUTHENTICITY"
  | "AUTHORSHIP"
  | "IDENTITY"
  | "INTENT"
  | "LIABILITY"
  | "FRAUD"
  | "LEGAL_ADMISSIBILITY"
  | "COURT_ACCEPTANCE"
  | "LEGAL_VALIDITY"
  | "FORENSIC_CONCLUSION"
  | "EVENT_ATTESTATION"
  | "RELIABILITY_VERDICT"
  | "CREDIBILITY_VERDICT";

/*
 * A COPULA CAN BE SEPARATED FROM ITS CLAIM, AND WAS.
 *
 * The rules below were written as `(is|are)\s+(authentic|admissible|…)` —
 * the copula immediately followed by the forbidden word. That matched
 * "this is authentic" and missed every one of these:
 *
 *     "this evidence is legally admissible"     ← the exact policy wording
 *     "this evidence is clearly admissible"
 *     "this would be fully admissible in a hearing"
 *     "the recording is clearly authentic"
 *     "this will be readily accepted by the court"
 *
 * One adverb defeated the whole layer, and an adverb is the MORE likely
 * phrasing: a model asked for a judgement hedges it. "Clearly authentic" is
 * the sentence this engine exists to stop, and it was the sentence it let by.
 *
 * The normalizer already removes the evasions someone has to try on purpose —
 * homoglyphs, letter-spacing, punctuation. This closes the one that happens by
 * accident, in ordinary English, every time.
 *
 * `GAP` allows up to three intervening words. Bounded on purpose: `.*` would
 * reach across clauses and start matching "this is a copy of a document the
 * court found admissible", which asserts nothing.
 */
const GAP = String.raw`(?:\w+\s+){0,3}`;

/** `is/are/was/were/will be/would be` + up to three words + the claim. */
function copula(claim: string): RegExp {
  return new RegExp(String.raw`\b(?:is|are|was|were|will be|would be)\s+${GAP}(?:${claim})\b`);
}

const RULES: Array<{ category: ProhibitedClaimCategory; re: RegExp }> = [
  { category: "FACTUAL_TRUTH", re: copula("true|factual|a fact") },
  { category: "FACTUAL_TRUTH", re: /\b(this|it|the (evidence|event|incident))\s+(proves|confirms|shows)\s+(that\s+)?(the\s+)?(event|incident)?\s*(happened|occurred|is true)\b/ },
  { category: "FACTUAL_TRUTH", re: /\bdefinitely\s+(happened|occurred|took place)\b/ },
  { category: "AUTHENTICITY", re: copula("genuine|authentic|unaltered|unmanipulated") },
  { category: "AUTHENTICITY", re: /\b(looks|look|appears|appear)\s+(?:\w+\s+){0,3}(genuine|authentic|unaltered|unmanipulated)\b/ },
  { category: "AUTHENTICITY", re: /\b(not|isn.?t|aren.?t)\s+(fake|forged|manipulated|altered|doctored)\b/ },
  { category: "AUTHENTICITY", re: /\b\d{1,3}\s*%\s*(authentic|genuine|real)\b/ },
  { category: "AUTHORSHIP", re: /\bthe\s+author\s+(is|was|of this)\b/ },
  { category: "AUTHORSHIP", re: /\b(authored|written|created|taken|captured|produced)\s+by\s+[a-z]/ },
  { category: "IDENTITY", re: /\bthe\s+person\s+(in|shown|depicted|pictured)[^.]{0,30}\b(is|are)\b/ },
  { category: "IDENTITY", re: /\bthis\s+(person\s+)?is\s+[a-z]+\s+[a-z]+\b/ },
  { category: "INTENT", re: /\b(intentional|intentionally|deliberate|deliberately|on purpose|willful|willfully)\b/ },
  { category: "INTENT", re: /\b(meant|intended)\s+to\b/ },
  { category: "LIABILITY", re: copula("liable|at fault|responsible for the") },
  { category: "LIABILITY", re: /\bliabilit(y|ies)\b/ },
  { category: "FRAUD", re: /\b(is|are|this is|committed|constitutes)\s+(fraud|fraudulent|a scam|falsified|forgery)\b/ },
  { category: "FRAUD", re: /\bfraudulent\b/ },
  { category: "LEGAL_ADMISSIBILITY", re: copula("admissible") },
  { category: "LEGAL_ADMISSIBILITY", re: /\badmissible\s+in\s+court\b/ },
  { category: "COURT_ACCEPTANCE", re: /\b(will be|is|are|was|were|would be)\s+(?:\w+\s+){0,3}accepted\s+by\s+(a|the)\s+court\b/ },
  { category: "COURT_ACCEPTANCE", re: /\bcourt[-\s]?ready\b/ },
  { category: "LEGAL_VALIDITY", re: copula("legally\\s+(?:valid|binding|enforceable)") },
  { category: "LEGAL_VALIDITY", re: /\blegally\s+valid\b/ },
  { category: "FORENSIC_CONCLUSION", re: /\bforensic(ally)?\s+(proof|proven|conclusion|certain|certainty)\b/ },
  { category: "EVENT_ATTESTATION", re: /\b(attest|certif(y|ies|ied)|guarantee)[a-z]*\b[^.]{0,40}\b(happened|occurred|is true|took place)\b/ },
  { category: "RELIABILITY_VERDICT", re: /\b(100\s*%|fully|completely|totally|entirely|highly)\s+reliable\b/ },
  { category: "RELIABILITY_VERDICT", re: /\breliability\s+(score|verdict|rating)\b/ },
  { category: "CREDIBILITY_VERDICT", re: copula("credible|not credible|trustworthy|untrustworthy") },
  { category: "CREDIBILITY_VERDICT", re: /\bcredibility\s+(verdict|assessment|score)\b/ },
];

/** NFKC + lowercase + collapse spacing/punctuation so variants cannot evade. */
export function normalizeForClaimScan(text: string): string {
  let s = text;
  try {
    s = s.normalize("NFKC");
  } catch {
    /* ignore */
  }
  s = s.toLowerCase();
  // collapse letter-spacing evasion ("a u t h e n t i c") — join single-char runs
  s = s.replace(/\b(?:[a-z]\s){2,}[a-z]\b/g, (m) => m.replace(/\s+/g, ""));
  // normalize punctuation to spaces, collapse whitespace
  s = s.replace(/[^a-z0-9%]+/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/** Classify prohibited claims present in a single text. */
export function classifyProhibitedClaims(text: string): ProhibitedClaimCategory[] {
  const norm = normalizeForClaimScan(text);
  const found = new Set<ProhibitedClaimCategory>();
  for (const { category, re } of RULES) {
    if (re.test(norm)) found.add(category);
  }
  return [...found];
}

/** The canonical safe rewrite when a prohibited claim is detected. */
export function buildProhibitedClaimSafeSummary(): string {
  return (
    "PROOVRA AI cannot determine truth, authenticity, authorship, identity, intent, " +
    "liability, fraud, or legal admissibility. It can only summarize the operational " +
    "metadata and integrity signals PROOVRA has recorded. Please review the underlying " +
    "records and consult a qualified human reviewer for any determination."
  );
}

/** Scan an assembled set of output strings; returns all categories found. */
export function scanTextsForProhibitedClaims(
  texts: Array<string | null | undefined>,
): ProhibitedClaimCategory[] {
  const found = new Set<ProhibitedClaimCategory>();
  for (const t of texts) {
    if (!t) continue;
    for (const c of classifyProhibitedClaims(t)) found.add(c);
  }
  return [...found];
}
