/**
 * WHAT SETTINGS SAYS ABOUT AI, AND WHO DECIDED IT.
 *
 * The backend resolves the effective status — `assistance` on the AI-policy
 * envelope, produced by the same evaluator that gates every provider call. This
 * file only turns that bounded status into a sentence, and works out which
 * authority a reader should be pointed at.
 *
 * It deliberately contains no policy reasoning. If this file ever starts
 * deciding whether AI is available, the page will be able to disagree with the
 * gate that enforces it — which is precisely the failure this whole surface was
 * fixed for.
 */

/** Mirrors the backend's bounded, user-safe status. */
export type AiAssistanceStatus =
  | "AVAILABLE"
  | "DISABLED_FOR_WORKSPACE"
  | "NOT_INCLUDED_IN_PLAN"
  | "NOT_PERMITTED_FOR_ROLE"
  | "TEMPORARILY_UNAVAILABLE";

/** The authority a reader should take the answer up with. */
export type AiManagedBy = "YOU" | "WORKSPACE_ADMINS" | "ORGANIZATION" | "PLATFORM" | "PLAN";

export type AiStatusCopy = {
  /** The status word beside the label. Short enough for one line. */
  label: string;
  /** One sentence of context. Never a diagnostic. */
  detail: string;
  /**
   * Canonical `AppTone`, named directly rather than through a private
   * three-value vocabulary that would need translating at every call site.
   *
   * `green` available, `slate` for a deliberate configuration, `amber` only
   * where something is genuinely not working. A workspace that switched AI off
   * is not a warning — painting it amber tells an administrator their own
   * decision is a fault.
   */
  tone: "green" | "slate" | "amber";
};

export function aiStatusCopy(status: AiAssistanceStatus): AiStatusCopy {
  switch (status) {
    case "AVAILABLE":
      return {
        label: "Available",
        detail: "AI assistance is available in this workspace.",
        tone: "green",
      };
    case "DISABLED_FOR_WORKSPACE":
      return {
        label: "Disabled",
        detail:
          "AI assistance is turned off for this workspace. Capture, custody, verification and reporting are unaffected.",
        tone: "slate",
      };
    case "NOT_INCLUDED_IN_PLAN":
      return {
        label: "Not included",
        detail:
          "AI assistance is not available on your current plan. Core evidence capture, custody, verification and reporting remain fully available without AI.",
        tone: "slate",
      };
    case "NOT_PERMITTED_FOR_ROLE":
      return {
        label: "Not available",
        detail:
          "This workspace limits AI assistance to certain roles. Your role does not currently include it.",
        tone: "slate",
      };
    case "TEMPORARILY_UNAVAILABLE":
    default:
      /*
       * The one status that is a real problem — and the one that must say the
       * least. It covers both operator configuration gaps, and which of the two
       * it is discloses the deployment's state to anyone with an account.
       */
      return {
        label: "Unavailable",
        detail:
          "AI assistance is currently unavailable. Capture, custody, verification and reporting are unaffected.",
        tone: "amber",
      };
  }
}

/**
 * Who governs this workspace's AI setting.
 *
 * Derived from two facts the SERVER already projects — the workspace kind and
 * whether this user holds `SETTINGS_MANAGE` — never from a role string or a
 * plan name read on the client.
 *
 * Note that PROOVRA has no organization-level policy that locks a workspace:
 * the policy row is keyed by workspace, and an ORGANIZATION workspace's row IS
 * the organization's policy. So "your organization" here means "this
 * organization workspace's administrators", which is what a member of one
 * should be told. No org-level lock is claimed, because none exists.
 */
export function resolveManagedBy(input: {
  status: AiAssistanceStatus;
  workspaceKind: "PERSONAL" | "ORGANIZATION" | null;
  canManage: boolean | null;
}): AiManagedBy {
  if (input.status === "TEMPORARILY_UNAVAILABLE") return "PLATFORM";
  if (input.status === "NOT_INCLUDED_IN_PLAN") return "PLAN";
  if (input.workspaceKind === "ORGANIZATION") {
    return input.canManage === true ? "WORKSPACE_ADMINS" : "ORGANIZATION";
  }
  return input.canManage === true ? "YOU" : "WORKSPACE_ADMINS";
}

export function managedByCopy(managedBy: AiManagedBy): string {
  switch (managedBy) {
    case "YOU":
      return "Managed by you";
    case "WORKSPACE_ADMINS":
      return "Managed by workspace administrators";
    case "ORGANIZATION":
      return "Managed by your organization";
    case "PLAN":
      return "Determined by your plan";
    case "PLATFORM":
    default:
      return "PROOVRA platform availability";
  }
}
