/**
 * Phase F1 — Enterprise Natural-Language Search parser (DETERMINISTIC).
 *
 * Translates a natural-language Evidence-Operations query (EN/DE/AR) into a
 * VALIDATED filter: either a mapping onto the existing authorized
 * SearchFilterInput (executeSearch) or a bounded operational state-query enum
 * served by tenant-scoped queries. No LLM is involved in parsing: the model
 * never searches, never generates SQL, never invents filters. Unsupported
 * asks return UNSUPPORTED_FILTER honestly (never a fake result).
 */

export type NlStateQuery =
  | "TSA_PENDING"
  | "TSA_FAILED"
  | "OTS_PENDING"
  | "FAILED_VERIFICATION"
  | "WAITING_REPORT"
  | "UNSIGNED_PACKAGE"
  | "REVIEW_BACKLOG"
  | "REPORTS_RECENT";

export type NlParseResult =
  | { kind: "STATE_QUERY"; query: NlStateQuery; language: "en" | "de" | "ar" }
  | {
      kind: "TEXT_SEARCH";
      q: string | null;
      evidenceTypes?: Array<"PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT">;
      documentTypes?: string[];
      updatedSinceUtc?: string;
      language: "en" | "de" | "ar";
    }
  | { kind: "UNSUPPORTED_FILTER"; reason: string; language: "en" | "de" | "ar" };

const AR = /[؀-ۿ]/;
function lang(text: string): "en" | "de" | "ar" {
  if (AR.test(text)) return "ar";
  if (/\b(zeige|finde|beweis|bericht|prüf|ausstehend|fehlgeschlagen|ohne|gestern)\b/i.test(text)) return "de";
  return "en";
}

function normalize(text: string): string {
  let s = text;
  try { s = s.normalize("NFKC"); } catch { /* ignore */ }
  return s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
}

const STATE_PATTERNS: Array<{ query: NlStateQuery; re: RegExp; ar: string[] }> = [
  { query: "TSA_PENDING", re: /\btsa\b.*\b(pending|ausstehend|offen)\b|\b(pending|ausstehend)\b.*\btsa\b/, ar: ["tsa معلق", "ختم زمني معلق"] },
  { query: "TSA_FAILED", re: /\btsa\b.*\b(failed|fehlgeschlagen)\b|\b(failed|fehlgeschlagen)\b.*\btsa\b/, ar: ["tsa فشل", "فشل الختم الزمني"] },
  { query: "OTS_PENDING", re: /\bots\b.*\b(pending|ausstehend|offen)\b|\b(pending|ausstehend)\b.*\bots\b|opentimestamps.*pending/, ar: ["ots معلق"] },
  { query: "FAILED_VERIFICATION", re: /\b(failed|fehlgeschlagen(e)?)\b.*\b(verification|verifizierung)\b|\b(verification|verifizierung)\b.*\b(failed|failures|fehlgeschlagen)\b/, ar: ["فشل التحقق", "تحقق فاشل"] },
  { query: "WAITING_REPORT", re: /\b(waiting|without|missing|ohne|wartet)\b.*\b(report|bericht)\b|\b(report|bericht)\b.*\b(pending|missing|fehlt|ausstehend)\b|evidence waiting for report/, ar: ["بانتظار التقرير", "بدون تقرير"] },
  { query: "UNSIGNED_PACKAGE", re: /\b(unsigned|missing|without|ohne|failed)\b.*\b(package(s)?|paket(e)?)\b|\bpackage generation (failure|failures|failed)\b/, ar: ["حزمة غير موقعة", "بدون حزمة", "فشل توليد الحزمة"] },
  { query: "REVIEW_BACKLOG", re: /\b(pending|open|offene|backlog)\b.*\b(review(s)?|prüfung(en)?)\b|\breview backlog\b|\bshow pending reviews\b/, ar: ["مراجعات معلقة", "تراكم المراجعات"] },
  { query: "REPORTS_RECENT", re: /\breport(s|e)?\b.*\b(yesterday|today|gestern|heute|recent|last (24|48) hours)\b/, ar: ["تقارير الأمس", "تقارير اليوم"] },
];

const TYPE_MAP: Array<{ type: "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT"; re: RegExp }> = [
  { type: "PHOTO", re: /\b(photo(s)?|image(s)?|foto(s)?|bild(er)?|صور|صورة)\b/u },
  { type: "VIDEO", re: /\b(video(s)?|فيديو)\b/u },
  { type: "AUDIO", re: /\b(audio|recording(s)?|صوت|تسجيل)\b/u },
  { type: "DOCUMENT", re: /\b(document(s)?|pdf|dokument(e)?|مستند|وثيقة)\b/u },
];

const UNSUPPORTED_HINTS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bgps\b|location missing|missing gps|ohne gps/, reason: "GPS-presence filtering" },
  { re: /\bexif\b/, reason: "EXIF-presence filtering" },
  { re: /\bandroid\b|\biphone\b|\bios\b/, reason: "capture-device filtering" },
  { re: /\bcontributor\b|\bby contributor\b/, reason: "contributor filtering" },
];

const SEARCH_VERBS = /\b(find|show|list|search|zeige|finde|suche|ابحث|أظهر|اعرض)\b/u;

export function parseNlSearch(input: string): NlParseResult {
  const language = lang(input);
  const norm = normalize(input);

  // Bounded operational state queries first (highest specificity).
  for (const { query, re, ar } of STATE_PATTERNS) {
    if (re.test(norm) || ar.some((t) => norm.includes(t))) {
      return { kind: "STATE_QUERY", query, language };
    }
  }

  // Honestly-unsupported filters — say so, never fake.
  for (const { re, reason } of UNSUPPORTED_HINTS) {
    if (re.test(norm)) {
      return { kind: "UNSUPPORTED_FILTER", reason, language };
    }
  }

  // Generic evidence/report/package/case text search mapping.
  if (SEARCH_VERBS.test(norm) || norm.length > 0) {
    const evidenceTypes = TYPE_MAP.filter(({ re }) => re.test(norm)).map(({ type }) => type);
    // Strip verbs + entity words to get the free-text remainder.
    const q = norm
      .replace(SEARCH_VERBS, " ")
      .replace(/\b(evidence|record(s)?|report(s|e)?|package(s)?|case(s)?|beweis(mittel|e)?|bericht(e)?|paket(e)?|fall|fälle|دليل|أدلة|تقرير|حزمة|قضية|me|all|the)\b/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      kind: "TEXT_SEARCH",
      q: q.length >= 2 ? q.slice(0, 200) : null,
      ...(evidenceTypes.length > 0 ? { evidenceTypes } : {}),
      language,
    };
  }
  return { kind: "UNSUPPORTED_FILTER", reason: "empty query", language };
}
