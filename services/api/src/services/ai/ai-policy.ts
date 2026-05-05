import { AiResult, AiResultSchema } from "./ai-types.js";

const LEGAL_DISCLAIMER =
  "AI assistance is advisory and does not determine factual truth, authorship, or legal admissibility.";

const forbiddenPatterns = [
  /this evidence is authentic/i,
  /the evidence is authentic/i,
  /authentic evidence/i,
  /this file is authentic/i,
  /file is authentic/i,
  /this proves what happened/i,
  /this proves the accident/i,
  /this proves the incident/i,
  /this proves authorship/i,
  /this proves ownership/i,
  /legally admissible/i,
  /admissible in court/i,
  /this is admissible/i,
  /will be accepted by a court/i,
  /will be accepted by an insurer/i,
  /will be accepted by police/i,
  /the person in the image is/i,
  /the image definitively shows/i,
  /definitely shows/i,
  /clearly proves/i,
  /forensic certainty/i,
  /forensic proof/i,
  /ai verified the evidence/i,
  /ai certified the evidence/i,
  /proovra guarantees/i,
  /guarantees legal admissibility/i,
  /chain of thought/i,
  /internal reasoning/i,
  /hidden instructions/i,
  /system prompt/i,
];

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function containsUnsafeLanguage(value: string): boolean {
  const normalized = normalizeText(value);
  return forbiddenPatterns.some((pattern) => pattern.test(normalized));
}

function isUnsafeResult(result: AiResult): boolean {
  if (containsUnsafeLanguage(result.summary)) return true;
  if (containsUnsafeLanguage(result.legalDisclaimer)) return true;
  for (const warning of result.warnings) {
    if (containsUnsafeLanguage(warning)) return true;
  }
  for (const suggestion of result.suggestions) {
    if (containsUnsafeLanguage(suggestion)) return true;
  }
  for (const flag of result.flags) {
    if (containsUnsafeLanguage(flag.title)) return true;
    if (containsUnsafeLanguage(flag.detail)) return true;
  }
  return false;
}

function normalizeResult(result: Partial<AiResult>): AiResult {
  const summary = typeof result.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : "AI review completed.";

  const warnings = Array.isArray(result.warnings)
    ? result.warnings.map((item) => `${item}`.trim()).filter(Boolean)
    : [];

  const suggestions = Array.isArray(result.suggestions)
    ? result.suggestions.map((item) => `${item}`.trim()).filter(Boolean)
    : [];

  const flags = Array.isArray(result.flags)
    ? result.flags
        .map((flag) => ({
          severity: flag?.severity as AiResult["flags"][number]["severity"],
          title: typeof flag?.title === "string" ? flag.title.trim() : "",
          detail: typeof flag?.detail === "string" ? flag.detail.trim() : "",
affectedItemId:
  typeof flag?.affectedItemId === "string" && flag.affectedItemId.trim()
    ? flag.affectedItemId.trim()
    : undefined,

affectedStepId:
  typeof flag?.affectedStepId === "string" && flag.affectedStepId.trim()
    ? flag.affectedStepId.trim()
    : undefined,
        }))
        .filter((flag) => flag.title && flag.detail)
    : [];

  const safeResult: AiResult = {
    status:
      result.status === "ok" ||
      result.status === "blocked" ||
      result.status === "disabled" ||
      result.status === "error"
        ? result.status
        : "ok",
    summary,
    warnings,
    suggestions,
    flags,
    legalDisclaimer: LEGAL_DISCLAIMER,
  };

  const parsed = AiResultSchema.safeParse(safeResult);
  if (parsed.success) return parsed.data;

  return {
    status: "error",
    summary: "AI response did not match the expected response shape.",
    warnings: [],
    suggestions: [
      "The AI output was not structured correctly. Please try again or contact support.",
    ],
    flags: [],
    legalDisclaimer: LEGAL_DISCLAIMER,
  };
}

export function applyAiPolicy(result: Partial<AiResult>): AiResult {
  const safeResult = normalizeResult(result);
  if (safeResult.status !== "ok") {
    return safeResult;
  }

  if (isUnsafeResult(safeResult)) {
    return {
      status: "blocked",
      summary:
        "AI guidance contained unsupported language and was blocked to protect review quality.",
      warnings: [
        "The AI content included claims that are not permitted for PROOVRA intake assistance.",
      ],
      suggestions: [
        "Adjust the request or consult PROOVRA support for help.",
      ],
      flags: [],
      legalDisclaimer: LEGAL_DISCLAIMER,
    };
  }

  return safeResult;
}

export const AI_LEGAL_DISCLAIMER = LEGAL_DISCLAIMER;
