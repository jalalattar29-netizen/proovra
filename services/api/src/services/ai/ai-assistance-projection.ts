import {
  type AiPolicyDecision,
  type ResolvedWorkspaceAiPolicy,
} from "./workspace-ai-policy.service.js";

/**
 * THE EFFECTIVE AI STATUS, IN WORDS A CUSTOMER MAY SEE.
 *
 * =============================================================================
 * WHY SETTINGS NEEDED THIS
 * =============================================================================
 * Settings → AI rendered the workspace POLICY ROW: a set of switches an
 * administrator had set. It never asked whether the platform could actually
 * serve AI. On a deployment with no provider configured — which is every
 * environment in this repository — the page showed "AI assistance" enabled,
 * with green toggles, while every request the product made returned
 * unavailable.
 *
 * That is the same defect this codebase has now met twice, in both directions:
 * the assistant reported a policy decision as an outage, and Settings reported
 * an outage as a working configuration. Both came from a surface reading one
 * layer of a multi-layer decision and presenting it as the whole answer.
 *
 * The answer is the evaluator's, not a re-derivation: `evaluateWorkspaceAiPolicy`
 * already runs every gate in order. This maps its bounded decision to the
 * bounded status a customer may be shown.
 *
 * =============================================================================
 * WHAT IT DELIBERATELY DOES NOT DISTINGUISH
 * =============================================================================
 * `GLOBAL_DISABLED` and `PROVIDER_NOT_CONFIGURED` collapse into one status.
 *
 * That is not laziness. They are the two ways an OPERATOR has not finished
 * configuring the platform, and the difference between them — whether a flag
 * is off or a key is absent — is infrastructure detail. A customer cannot act
 * on it, and telling them which one it is discloses the deployment's state to
 * anyone with an account. The operator keeps the distinction: it is in the
 * decision code, in the logs, and in the capability disclosure table.
 *
 * Nothing here ever carries a decision code, an environment variable name, a
 * provider name or a policy key outward. Callers receive a bounded status and
 * two booleans.
 */

/** Bounded, user-safe. Every value is something a customer may be told. */
export type AiAssistanceStatus =
  /** Policy and platform both allow it right now. */
  | "AVAILABLE"
  /** The workspace's own policy switched it off. */
  | "DISABLED_FOR_WORKSPACE"
  /** The plan does not include it. */
  | "NOT_INCLUDED_IN_PLAN"
  /** This workspace limits AI to certain roles, and the viewer is not one. */
  | "NOT_PERMITTED_FOR_ROLE"
  /** The platform cannot serve AI at the moment. Operator-side, not customer-side. */
  | "TEMPORARILY_UNAVAILABLE";

export type AiAssistanceProjection = {
  status: AiAssistanceStatus;
  /**
   * Whether an AI request would succeed right now — policy AND platform.
   * This is the honest headline; `enabled` alone is not.
   */
  available: boolean;
  /**
   * The workspace's own switch, independent of platform state. Kept separate so
   * the UI can say "enabled for this workspace, unavailable right now" rather
   * than having to choose one of two true things.
   */
  enabled: boolean;
};

/**
 * Map an evaluator decision to what a customer may be shown.
 *
 * `policy` supplies `enabled` because a workspace's own switch is a fact about
 * the workspace even when a platform gate denies before it is ever consulted.
 */
export function projectAiAssistance(
  decision: AiPolicyDecision,
  policy: ResolvedWorkspaceAiPolicy,
): AiAssistanceProjection {
  const enabled = policy.aiEnabled;

  if (decision.allowed) {
    return { status: "AVAILABLE", available: true, enabled };
  }

  switch (decision.decision) {
    case "PLAN_NOT_ENTITLED":
      return { status: "NOT_INCLUDED_IN_PLAN", available: false, enabled };
    case "ROLE_NOT_PERMITTED":
      return { status: "NOT_PERMITTED_FOR_ROLE", available: false, enabled };
    case "GLOBAL_DISABLED":
    case "PROVIDER_NOT_CONFIGURED":
      return { status: "TEMPORARILY_UNAVAILABLE", available: false, enabled };
    case "WORKSPACE_DISABLED":
    case "FEATURE_DISABLED":
    case "DATA_CLASS_NOT_ALLOWED":
      return { status: "DISABLED_FOR_WORKSPACE", available: false, enabled };
    default:
      /*
       * An unrecognised denial is reported as unavailable, never as available.
       * A new decision code added without updating this map must fail toward
       * "we cannot serve this", not toward a promise.
       */
      return { status: "TEMPORARILY_UNAVAILABLE", available: false, enabled };
  }
}
