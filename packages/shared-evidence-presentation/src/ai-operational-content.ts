/**
 * Phase E9 — Canonical AI operational intelligence content
 * (single source of truth).
 *
 * Codifies what AI may and may not do in PROOVRA. The platform already
 * has the AI infrastructure (provider abstraction, policy filter, cost
 * guard, structured-output validation, noop fallback). Phase E9 does
 * NOT build new AI features — it canonicalizes the contract so future
 * AI-backed surfaces can opt in from one source of truth.
 *
 * Hard rules pinned by `phase-e9-ai-operational-intelligence.test.ts`:
 *
 *   1. Allowed categories enumerate the only operational AI use cases
 *      that may exist on the platform. Anything else requires a new
 *      phase + entry gate + dedicated test suite.
 *   2. Forbidden categories block AI from becoming an authority,
 *      judge, forensic engine, or autonomous operator.
 *   3. Every AI surface MUST surface the canonical advisory
 *      disclaimer (mirrors `ai-policy.ts`).
 *   4. Every AI surface MUST run output through the policy filter
 *      before reaching a user — the structured-output schema is the
 *      enforceable shape and the discriminated `status` is the
 *      failure-tolerance contract.
 *   5. AI features stay OPTIONAL. The platform fully operates when AI
 *      is disabled. Noop provider preserves workflows.
 *   6. AI never mutates evidence / custody / governance / automation /
 *      external grants. Source-grep tests assert no `evidence.update`
 *      / `custody.append` / `automation.create` calls live in the AI
 *      service tree.
 *   7. AI never bypasses permissions. The capability registry has zero
 *      AI input — verified by source-grep (mirrors persona invariant).
 *   8. Forbidden output phrases (codified in `ai-policy.ts` as 37
 *      regex patterns) are mirrored at a higher level here as 12
 *      category-level forbidden patterns so future content surfaces
 *      can grep at the shared layer.
 *
 * This module is pure data — no fs, fetch, Prisma. Shared across web
 * + api test surfaces.
 */

// NOTE: Intentionally not importing PROOVRA_REQUIRED_BOUNDARY_PHRASES
// here — those phrases ("recorded integrity state",
// "does not independently prove factual truth") belong to the
// evidence-integrity boundary used by the Verify page / report-v2 /
// verification-package surfaces. AI disclaimers have their own
// narrower required-phrase list below, since AI surfaces describe the
// platform's posture, not the per-record integrity claim.

// ---------------------------------------------------------------------------
// Canonical advisory disclaimer (mirrors the string in ai-policy.ts)
// ---------------------------------------------------------------------------

export const AI_CANONICAL_ADVISORY_DISCLAIMER =
  "AI assistance is advisory and does not determine factual truth, authorship, or legal admissibility.";

// ---------------------------------------------------------------------------
// Allowed operational AI use-case categories
// ---------------------------------------------------------------------------

export const AI_ALLOWED_USE_CASES = [
  "OPERATIONAL_SUMMARIZATION",
  "WORKFLOW_GUIDANCE",
  "INTAKE_COMPLETENESS_GUIDANCE",
  "REVIEWER_ASSISTANCE",
  "OPERATIONAL_PRIORITIZATION",
  "GOVERNANCE_REMINDERS",
  "SEARCH_NAVIGATION_ASSISTANCE",
  "OPERATIONAL_ANOMALY_SUGGESTIONS",
  "DOCUMENTATION_HELP",
] as const;

export type AiAllowedUseCase = (typeof AI_ALLOWED_USE_CASES)[number];

// Description of each allowed category so future surfaces have one
// authoritative reference for what the category may and may not do.
export const AI_ALLOWED_USE_CASE_CONTENT: Record<
  AiAllowedUseCase,
  {
    label: string;
    purpose: string;
    allowedInputs: string;
    forbiddenInputs: string;
    outputBoundary: string;
  }
> = {
  OPERATIONAL_SUMMARIZATION: {
    label: "Operational summarization",
    purpose:
      "Summarize bounded operational counters and queue states for an operator. The AI describes; the operator decides.",
    allowedInputs:
      "Real counts from Phase E4 analytics envelopes (operations / reviewer / governance / automation / artifacts) — same source-traced shape rendered on /ops/analytics.",
    forbiddenInputs:
      "Raw evidence content, raw file bytes, signed storage URLs, custody event payloads, secret material, credentials.",
    outputBoundary:
      "Prose summary + bounded list of operational signals. Never a 'risk score', 'authenticity score', 'admissibility score', or 'confidence-in-truth' rating.",
  },
  WORKFLOW_GUIDANCE: {
    label: "Workflow guidance",
    purpose:
      "Explain what the current workflow state is and what bounded next-step options exist. Operator chooses.",
    allowedInputs:
      "Workflow state from the canonical Evidence / Case / Review lifecycle. Persona profile from the canonical PlatformContextEnvelope.",
    forbiddenInputs:
      "Cross-team workflow data. Other teams' permission state. Other teams' evidence.",
    outputBoundary:
      "Step-by-step operator guidance with explicit references to the canonical workflow states. Never invents states; never claims to have completed steps.",
  },
  INTAKE_COMPLETENESS_GUIDANCE: {
    label: "Intake completeness guidance",
    purpose:
      "Identify operationally missing or inconsistent intake items (e.g. a claim intake without a date-of-loss field).",
    allowedInputs:
      "Sanitised intake-session metadata (already filename-redacted by ai-capture.service.ts). Capture template definitions.",
    forbiddenInputs:
      "Raw uploaded file content; the actual evidence bytes. Anything outside the bounded intake session.",
    outputBoundary:
      "Operational flags (deterministic when possible; advisory when AI-only). Never determines authenticity or completeness as a legal conclusion.",
  },
  REVIEWER_ASSISTANCE: {
    label: "Reviewer assistance",
    purpose:
      "Help a reviewer triage their queue and surface stale / overdue / unresolved items.",
    allowedInputs:
      "EvidenceReviewWorkflow counts (already exposed via Phase E4 reviewer analytics). Per-reviewer assignment metadata from the canonical reviewer-ops service.",
    forbiddenInputs:
      "Other reviewers' notes. Reviewer comments on evidence the active reviewer does not have permission to read.",
    outputBoundary:
      "Advisory recommendations only. The reviewer remains the authoritative human actor. AI never approves / rejects / re-assigns reviews on its own.",
  },
  OPERATIONAL_PRIORITIZATION: {
    label: "Operational prioritization",
    purpose:
      "Suggest which queue / case / workflow to look at next based on real operational signals.",
    allowedInputs:
      "Operational pressure signals (queue depths, SLA dueAt timestamps, escalation counts) from the canonical analytics service.",
    forbiddenInputs:
      "Customer-PII-bearing fields. Anything that infers identity from the operational signal.",
    outputBoundary:
      "Ordered suggestion list. Never a 'priority score' that pretends to be precise. Never claims a particular case is 'most important' as a truth claim.",
  },
  GOVERNANCE_REMINDERS: {
    label: "Governance reminders",
    purpose:
      "Surface overdue lifecycle actions, retention-policy gaps, expiring legal holds.",
    allowedInputs:
      "Governance analytics envelope (Phase E4 governance metrics). EvidenceLegalHold + CaseLegalHold counts. RetentionPolicy state.",
    forbiddenInputs:
      "AI may not execute a governance action. May not release a legal hold. May not delete evidence. May not alter retention. May not bypass governance gates.",
    outputBoundary:
      "Read-only reminder list. The operator action is always operator-driven.",
  },
  SEARCH_NAVIGATION_ASSISTANCE: {
    label: "Search & navigation assistance",
    purpose:
      "Translate a natural-language operator question into a bounded search query against permission-aware existing surfaces.",
    allowedInputs:
      "Operator-typed query text. The canonical capability map for the viewer.",
    forbiddenInputs:
      "Free-text retrieval over the entire org. Cross-team semantic embeddings. Direct DB access. Any retrieval that bypasses the capability registry.",
    outputBoundary:
      "A bounded search query or navigation link to an existing surface. AI never invents URLs; never returns links the viewer lacks capability for.",
  },
  OPERATIONAL_ANOMALY_SUGGESTIONS: {
    label: "Operational anomaly suggestions",
    purpose:
      "Notice when an operational counter has spiked, when a webhook destination has auto-disabled, when a queue is degraded.",
    allowedInputs:
      "Phase E4 analytics counters + their degradedSources arrays.",
    forbiddenInputs:
      "Claims about WHY the anomaly occurred unless the underlying degraded-source data supports it. AI never invents causes.",
    outputBoundary:
      "Advisory observation. Never a 'incident severity' score. Never an autoremediation suggestion that mutates state.",
  },
  DOCUMENTATION_HELP: {
    label: "Documentation help",
    purpose:
      "Answer operator questions about how PROOVRA works using the canonical product documentation and Trust Center content.",
    allowedInputs:
      "Operator question text. Canonical product documentation (Trust Center sections, /legal docs, /about pages).",
    forbiddenInputs:
      "Inventing platform capabilities. Promising features that do not exist. Quoting legal-style guarantees.",
    outputBoundary:
      "Plain answer with reference to the canonical doc URL. Stays inside the E5 trust-language boundary.",
  },
};

// ---------------------------------------------------------------------------
// Forbidden AI categories
// ---------------------------------------------------------------------------

export const AI_FORBIDDEN_CATEGORIES = [
  "TRUTH_DETERMINATION",
  "AUTHENTICITY_DETERMINATION",
  "ADMISSIBILITY_DETERMINATION",
  "LEGAL_CONCLUSIONS",
  "FORENSIC_CERTIFICATION",
  "AUTHORSHIP_CERTAINTY",
  "FAKE_EVIDENCE_CERTAINTY",
  "REAL_EVIDENCE_CERTAINTY",
  "AUTONOMOUS_DESTRUCTIVE_ACTIONS",
  "AUTONOMOUS_GOVERNANCE_DECISIONS",
  "AUTONOMOUS_REVIEW_DECISIONS",
  "AUTONOMOUS_MUTATIONS",
] as const;

export type AiForbiddenCategory = (typeof AI_FORBIDDEN_CATEGORIES)[number];

export const AI_FORBIDDEN_CATEGORY_DESCRIPTION: Record<
  AiForbiddenCategory,
  string
> = {
  TRUTH_DETERMINATION:
    "AI must never claim that a specific piece of evidence is true or false. Truth is external to the platform.",
  AUTHENTICITY_DETERMINATION:
    "AI must never claim authenticity. Authenticity requires external evaluation (reviewer judgment, expert opinion, device-attested capture).",
  ADMISSIBILITY_DETERMINATION:
    "AI must never claim that any evidence, report, or package is or is not admissible. Admissibility is jurisdiction- and process-dependent.",
  LEGAL_CONCLUSIONS:
    "AI must never offer legal advice, draft legal opinions, or suggest legal strategy.",
  FORENSIC_CERTIFICATION:
    "AI must never claim forensic-grade certification, validation, or authority. PROOVRA is not a forensic acquisition tool.",
  AUTHORSHIP_CERTAINTY:
    "AI must never claim that a particular person authored or did not author a particular piece of evidence.",
  FAKE_EVIDENCE_CERTAINTY:
    "AI must never label any evidence 'fake'. Doing so would imply a truth determination it is not permitted to make.",
  REAL_EVIDENCE_CERTAINTY:
    "AI must never label any evidence 'real'. Doing so would imply an authenticity determination it is not permitted to make.",
  AUTONOMOUS_DESTRUCTIVE_ACTIONS:
    "AI must never delete evidence, custody events, security events, or any record. Only operators may.",
  AUTONOMOUS_GOVERNANCE_DECISIONS:
    "AI must never release a legal hold, modify retention policy, or perform any governance mutation.",
  AUTONOMOUS_REVIEW_DECISIONS:
    "AI must never approve, reject, re-assign, or close a review workflow.",
  AUTONOMOUS_MUTATIONS:
    "AI must never mutate any DB row in capture / custody / reports / packages / automation rules / webhook destinations. Read-only by contract.",
};

// ---------------------------------------------------------------------------
// Surface-grep forbidden output phrases — mirrors the existing
// ai-policy.ts pattern shapes at a higher category level so other
// content surfaces can grep without importing the backend file.
// ---------------------------------------------------------------------------

export const AI_OPERATIONAL_FORBIDDEN_OUTPUT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bthis\s+evidence\s+is\s+(?:authentic|real|fake)\b/i,
  /\bproves?\s+(?:authorship|truth|authenticity|admissibility)\b/i,
  /\blegally\s+admissible\b/i,
  /\badmissible\s+in\s+court\b/i,
  /\bAI[- ]?(?:verified|certified|determined|confirmed)\s+(?:the\s+)?evidence\b/i,
  /\bforensic(?:ally)?\s+(?:certified|grade|validated|authority)\b/i,
  /\bdefinitively\s+shows\b/i,
  /\bproovra\s+guarantees\b/i,
  /\b(?:authenticity|admissibility|truth)\s+score\b/i,
  /\bconfidence\s+in\s+truth\b/i,
  /\bauto[- ]?(?:approve|reject|finalize|release\s+hold|delete\s+evidence)\b/i,
  /\bautonomous\s+(?:governance|review|mutation)\b/i,
];

// ---------------------------------------------------------------------------
// Required boundary phrases on every AI-facing surface
// ---------------------------------------------------------------------------

export const AI_OPERATIONAL_REQUIRED_PHRASES = [
  // AI surfaces MUST clearly surface their advisory-only posture.
  "advisory",
  "does not determine",
] as const;

// ---------------------------------------------------------------------------
// Failure-tolerance contract — the bounded shape every AI surface must
// honour so the platform stays functional when AI is unavailable.
// ---------------------------------------------------------------------------

export const AI_FAILURE_TOLERANCE_CONTRACT = {
  /** Default state of the AI feature flag. */
  defaultEnabled: false,
  /**
   * Discriminated-union statuses the surface MUST surface (mirrors the
   * existing Zod schema in `ai-types.ts`).
   */
  resultStatuses: ["ok", "blocked", "disabled", "error"] as const,
  /** Whether the noop provider preserves all workflows when AI is disabled. */
  noopPreservesWorkflows: true,
  /** Whether a deterministic fallback layer runs before the AI call. */
  deterministicFallbackLayer: true,
  /** Whether structured-output validation runs on every provider response. */
  structuredOutputValidationEnforced: true,
  /** Whether the policy filter runs on every provider response. */
  policyFilterAlwaysRuns: true,
  /** Whether the cost guard short-circuits BEFORE calling the provider. */
  costGuardShortCircuitsBeforeProvider: true,
} as const;

// ---------------------------------------------------------------------------
// Prompt-injection / data-safety principles
// ---------------------------------------------------------------------------

export const AI_PROMPT_INJECTION_PRINCIPLES: ReadonlyArray<string> = [
  "Never trust user-provided text or evidence text as instructions to the AI provider.",
  "System instructions and user content live in different message roles; system content is operator-controlled only.",
  "Retrieval context is sanitised before being sent to the provider (filenames redacted; UUIDs and tokens replaced with placeholders).",
  "Tool / function calls are not enabled on any provider call — outputs are JSON-schema-constrained data only.",
  "Chain-of-thought, hidden instructions, and system-prompt leakage are blocked by the output-side policy filter.",
  "Secrets, tokens, signed storage URLs, and raw file bytes are never passed to the AI provider.",
  "Streaming is disabled — every response is a complete JSON object the schema validator accepts or rejects atomically.",
];
