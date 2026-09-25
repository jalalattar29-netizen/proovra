/**
 * AI POLICY EDITING + USAGE (T-15) — the native port of the web's
 * Settings → AI editable modes (apps/web/app/(app)/settings/_sections/AiSection.tsx).
 *
 * GET  /v1/workspaces/ai-policy?teamId   → { policy, version, hasExplicitPolicy, … }
 * PUT  /v1/workspaces/ai-policy           { teamId, expectedVersion, reason, ...policy }
 * GET  /v1/workspaces/ai-usage?teamId     → { monthUtc, allowance, … }
 *
 * Native was read-only ("transparency is not authority"). The web lets the
 * people the SERVER allows edit it — a 403 on the policy read means "read the
 * status only", and the PUT is refused server-side for anyone who is not a
 * workspace owner/admin. So this port shows switches only where the server
 * returned the editable envelope, and names the refusal when a save is denied.
 * Optimistic concurrency: a stale `expectedVersion` is a 409 → reload, never a
 * silent overwrite.
 */

import { formatTimestampParts } from "@proovra/shared";

export type AiSettingsMode = "personal-assistance" | "personal-not-included" | "org-governance" | "org-readonly";

/** aiAssistanceView.ts deriveAiSettingsMode, verbatim. */
export function deriveAiSettingsMode(input: {
  workspaceKind: "ORGANIZATION" | "PERSONAL";
  monthlyAllowance: number | null | undefined;
  canManageWorkspaceAiPolicy: boolean | null;
}): AiSettingsMode {
  if (input.workspaceKind === "ORGANIZATION") {
    return input.canManageWorkspaceAiPolicy === true ? "org-governance" : "org-readonly";
  }
  if (input.monthlyAllowance === 0) return "personal-not-included";
  return "personal-assistance";
}

export const AI_POLICY_KEYS = [
  "aiEnabled",
  "supportChatEnabled",
  "captureAssistanceEnabled",
  "evidenceCategorizationEnabled",
  "semanticSearchEnabled",
  "contentIntelligenceEnabled",
  "reviewerCopilotEnabled",
  "caseCopilotEnabled",
  "rawContentProcessingAllowed",
  "ocrAllowed",
  "transcriptionAllowed",
  "embeddingsAllowed",
] as const;
export type AiPolicyKey = (typeof AI_POLICY_KEYS)[number];
export type AiPolicy = Record<AiPolicyKey, boolean>;

export interface AiPolicyEnvelope {
  policy: AiPolicy;
  version: number;
  hasExplicitPolicy: boolean;
  lastModifiedAtUtc: string | null;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function buildAiPolicyPath(teamId: string): string {
  return `/v1/workspaces/ai-policy?teamId=${encodeURIComponent(teamId)}`;
}
export const AI_POLICY_PUT_PATH = "/v1/workspaces/ai-policy";
export function buildAiUsagePath(teamId: string): string {
  return `/v1/workspaces/ai-usage?teamId=${encodeURIComponent(teamId)}`;
}

export function parseAiPolicyEnvelope(payload: unknown): AiPolicyEnvelope | null {
  const d = o(payload);
  const p = o(d["policy"]);
  if (Object.keys(p).length === 0) return null;
  const policy = Object.fromEntries(AI_POLICY_KEYS.map((k) => [k, p[k] === true])) as AiPolicy;
  return {
    policy,
    version: typeof d["version"] === "number" ? (d["version"] as number) : 0,
    hasExplicitPolicy: d["hasExplicitPolicy"] === true,
    lastModifiedAtUtc: typeof d["lastModifiedAtUtc"] === "string" ? (d["lastModifiedAtUtc"] as string) : null,
  };
}

export function isAiPolicyDirty(draft: AiPolicy, saved: AiPolicy): boolean {
  return AI_POLICY_KEYS.some((k) => draft[k] !== saved[k]);
}

/** The PUT body the web sends: every column, the expected version, a reason. */
export function buildAiPolicyBody(teamId: string, envelope: AiPolicyEnvelope, draft: AiPolicy) {
  return {
    teamId,
    expectedVersion: envelope.hasExplicitPolicy ? envelope.version : null,
    reason: "Settings → AI update",
    ...draft,
  };
}

export function aiPolicySaveFailure(statusCode: number | undefined): { kind: "conflict" | "denied" | "error"; message: string } {
  if (statusCode === 409) {
    return { kind: "conflict", message: "These settings were changed elsewhere. Reload to see the latest, then re-apply your changes." };
  }
  if (statusCode === 403) return { kind: "denied", message: "Only workspace owners or admins can change AI settings." };
  return { kind: "error", message: "The settings could not be saved. Please try again." };
}

export const LAUNCHED_PERSONAL_AI_FEATURES: ReadonlyArray<{ key: AiPolicyKey; label: string; description: string }> = [
  { key: "supportChatEnabled", label: "Support assistant", description: "Answers product and evidence-operations questions. Uses metadata only." },
  { key: "captureAssistanceEnabled", label: "Capture assistance", description: "Advisory completeness suggestions while you capture evidence." },
  { key: "evidenceCategorizationEnabled", label: "Evidence categorization", description: "Advisory, metadata-based categorization of newly captured evidence." },
];

/** AiSection.tsx GOVERNANCE_TOGGLES, verbatim. */
export const GOVERNANCE_TOGGLES: ReadonlyArray<{ key: AiPolicyKey; label: string; hint: string }> = [
  { key: "supportChatEnabled", label: "Support assistant", hint: "Product + evidence-operations assistant (metadata only)." },
  { key: "captureAssistanceEnabled", label: "Capture assistance", hint: "Advisory completeness review during capture." },
  { key: "evidenceCategorizationEnabled", label: "Evidence categorization", hint: "Metadata-based advisory categorization." },
  { key: "semanticSearchEnabled", label: "Semantic search", hint: "Embeddings-based retrieval (derived text; opt-in)." },
  { key: "contentIntelligenceEnabled", label: "Content intelligence", hint: "Derived-text processing (OCR/transcripts) by AI." },
  { key: "caseCopilotEnabled", label: "Case Copilot", hint: "Case preparation assistance with validated citations." },
  { key: "reviewerCopilotEnabled", label: "Reviewer Copilot", hint: "Review preparation; never makes the decision." },
  { key: "rawContentProcessingAllowed", label: "Raw content processing", hint: "Allow raw bytes to purpose-specific extractors." },
  { key: "ocrAllowed", label: "OCR", hint: "Document text extraction." },
  { key: "transcriptionAllowed", label: "Transcription", hint: "Audio/video transcription." },
  { key: "embeddingsAllowed", label: "Embeddings", hint: "Vector embeddings of derived text." },
];

export interface AiUsageAllowance {
  plan: string;
  monthlyOperations: number | null;
  consumed: number;
  remaining: number | null;
}

export function parseAiUsage(payload: unknown): { monthUtc: string | null; allowance: AiUsageAllowance | null } {
  const d = o(payload);
  const a = o(d["allowance"]);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const allowance =
    typeof a["plan"] === "string"
      ? { plan: a["plan"] as string, monthlyOperations: num(a["monthlyOperations"]), consumed: num(a["consumed"]) ?? 0, remaining: num(a["remaining"]) }
      : null;
  return { monthUtc: typeof d["monthUtc"] === "string" ? (d["monthUtc"] as string) : null, allowance };
}

/**
 * The first day of the next month in UTC, from "2026-07" (AiSection.tsx
 * resetDateLabel, formatted by the same shared formatter) — shown beside the
 * "Resets on" label.
 */
export function aiUsageResetLabel(monthUtc: string | null): string | null {
  const m = monthUtc?.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  return formatTimestampParts(next, "UTC")?.date ?? null;
}

export function aiPlanLabel(plan: string): string {
  return plan === "PAYG" ? "Pay per evidence" : plan.charAt(0) + plan.slice(1).toLowerCase();
}
