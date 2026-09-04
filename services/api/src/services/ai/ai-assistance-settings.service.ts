import {
  evaluateWorkspaceAiPolicy,
  resolveWorkspaceAiPolicy,
} from "./workspace-ai-policy.service.js";
import {
  projectAiAssistance,
  type AiAssistanceProjection,
} from "./ai-assistance-projection.js";

/**
 * WHAT A WORKSPACE MEMBER MAY KNOW ABOUT AI, WHATEVER THEIR ROLE.
 *
 * =============================================================================
 * WHY A SECOND, NARROWER READ
 * =============================================================================
 * Settings → AI reads `GET /v1/workspaces/ai-policy`, which requires
 * `intelligence.read`. VIEWER does not hold that permission, so a VIEWER opened
 * the page and got an error — they could not learn whether AI was on in a
 * workspace they are a member of.
 *
 * The obvious fix — grant VIEWER `intelligence.read` — is the wrong one.
 * That permission gates twenty-six endpoints, including
 * `/v1/executive/metrics`, `/v1/intelligence/budgets/spend`,
 * `/v1/intelligence/providers/health` and `/v1/intelligence/quality/reviewers`.
 * Making AI status visible must not hand a read-only member executive
 * analytics, provider budgets and reviewer quality scores.
 *
 * The other obvious fix — lower the existing endpoint's permission — is also
 * wrong. That envelope returns the whole policy row, the capability disclosure
 * with its internal statuses (`DISABLED_BY_PLATFORM_CONFIGURATION`,
 * `NOT_CONFIGURED`), and who last modified the policy. All of that is
 * legitimate for an administrator and none of it is a member's business.
 *
 * So: a separate read that returns the ANSWER without the machinery, gated on
 * `governance.policy.read` — a permission every membership role already holds,
 * which is exactly what it means. The workspace AI policy is a governance
 * policy; being able to read which ones govern you is what that permission is
 * for. No role gains anything it did not already have.
 *
 * =============================================================================
 * WHAT IT NEVER RETURNS
 * =============================================================================
 * No decision code, no capability status enum, no environment variable name, no
 * provider name, no model, no budget or cost figure, no policy version, no
 * `lastModifiedByUserId`, and no policy switch a member cannot act on. The
 * shape below is the whole contract.
 */

/** A capability row, in product language rather than policy keys. */
export type AiAssistanceFeature = {
  /** Stable id for the UI to key on. Not a policy key or an operation label. */
  id: "evidence_assistance" | "reviewer_preparation" | "ai_review";
  label: string;
  description: string;
  /** Effective state — the workspace switch AND platform availability. */
  state: "ENABLED" | "DISABLED" | "UNAVAILABLE" | "NOT_INCLUDED";
};

export type AiAssistanceSettings = AiAssistanceProjection & {
  features: AiAssistanceFeature[];
  /** The fixed data-handling summary the AI Use Policy commits to. */
  processing: {
    mode: "METADATA_FIRST";
    rawEvidenceSentByDefault: false;
    decisions: "ADVISORY_ONLY";
  };
};

/*
 * The three capabilities the product actually advertises, each mapped to the
 * policy switch that governs it.
 *
 * `reviewer_preparation` and `ai_review` are both governed by
 * `evidenceCategorizationEnabled`, because both are delivered by the evidence
 * copilot — it emits `reviewerPreparation` and `missingContext` in the same
 * response. The dedicated reviewer and case copilots are a separate, deeper
 * surface and are not what these marketing capabilities describe.
 */
const FEATURES: ReadonlyArray<{
  id: AiAssistanceFeature["id"];
  label: string;
  description: string;
  switch: "captureAssistanceEnabled" | "evidenceCategorizationEnabled";
}> = [
  {
    id: "evidence_assistance",
    label: "Evidence assistance",
    description: "Guide evidence collection and surface missing context, where enabled.",
    switch: "captureAssistanceEnabled",
  },
  {
    id: "reviewer_preparation",
    label: "Reviewer preparation",
    description:
      "Prepare structured reviewer assistance and surface missing context, where enabled.",
    switch: "evidenceCategorizationEnabled",
  },
  {
    id: "ai_review",
    label: "AI review",
    description: "Spot missing context before submission, where enabled.",
    switch: "evidenceCategorizationEnabled",
  },
];

/**
 * Resolve the member-safe AI settings view for one workspace.
 *
 * DELIBERATELY SAYS NOTHING ABOUT EDITABILITY.
 *
 * A first version resolved `editable` here by reading the caller's
 * `teamMember` row. The authorization-closure gate flagged it, correctly: a
 * raw membership read inside a service is indistinguishable from an
 * authorization decision taken outside the canonical primitive, and a codebase
 * cannot tell the difference by looking.
 *
 * It was also redundant. Whether this user may change the policy is already a
 * SERVER-PROJECTED fact — `SETTINGS_MANAGE` on the platform-context envelope,
 * granted to exactly the membership that `PUT /v1/workspaces/ai-policy`
 * enforces. The page reads it there. Answering the same question a second way,
 * from a second source, is how two answers start to disagree.
 *
 * So this returns STATE, and authority is resolved where it already was.
 */
export async function buildAiAssistanceSettings(input: {
  teamId: string;
}): Promise<AiAssistanceSettings> {
  const policy = await resolveWorkspaceAiPolicy(input.teamId);
  const decision = await evaluateWorkspaceAiPolicy({
    teamId: input.teamId,
    feature: "SUPPORT_CHAT",
    dataClass: "METADATA",
  });
  const base = projectAiAssistance(decision, policy);

  const features: AiAssistanceFeature[] = FEATURES.map((f) => {
    // Platform unavailability outranks a workspace switch: a feature that is
    // switched on but cannot run is not "enabled" to the person reading it.
    if (base.status === "NOT_INCLUDED_IN_PLAN") {
      return { id: f.id, label: f.label, description: f.description, state: "NOT_INCLUDED" };
    }
    if (base.status === "TEMPORARILY_UNAVAILABLE") {
      return { id: f.id, label: f.label, description: f.description, state: "UNAVAILABLE" };
    }
    const on = policy.aiEnabled && policy[f.switch] === true;
    return {
      id: f.id,
      label: f.label,
      description: f.description,
      state: on ? "ENABLED" : "DISABLED",
    };
  });

  return {
    ...base,
    features,
    processing: {
      mode: "METADATA_FIRST",
      rawEvidenceSentByDefault: false,
      decisions: "ADVISORY_ONLY",
    },
  };
}
