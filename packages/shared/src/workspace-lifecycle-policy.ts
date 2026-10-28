/**
 * WORKSPACE LIFECYCLE POLICY — how each kind of Workspace is allowed to end.
 *
 * The ONE authority for this question. The API refuses and projects from it;
 * web and mobile render the server's projection of it and never decide it.
 *
 * There is no self-service hard delete for ANY Workspace kind:
 *
 *   PERSONAL      ends only through account closure (Settings → Privacy →
 *                 Close account). It is never closed, transferred or deleted
 *                 on its own, because it is the account's home and every
 *                 commercial mode (Free, Pay-per-evidence, Pro, Team) lives on
 *                 this same Workspace.
 *   ORGANIZATION  ends only through Organization offboarding / contract
 *                 termination, governed at the organization level.
 *   OWNED         (legacy self-service Workspace) ends through the canonical
 *                 Workspace closure: a cooling-off request that archives
 *                 access. Evidence is never deleted by closure.
 *
 * Any future physical purge is an operator tool that runs only after closure,
 * under retention and legal hold — never a customer action.
 */

export type WorkspaceLifecycleKind =
  | "PERSONAL"
  | "OWNED"
  | "ORGANIZATION"
  | "UNKNOWN";

/** How a Workspace of this kind ends. */
export type WorkspaceEndPath =
  | "ACCOUNT_CLOSURE"
  | "ORGANIZATION_OFFBOARDING"
  | "WORKSPACE_CLOSURE"
  | "NONE";

/** The next action a person is pointed at instead of a refused one. */
export type WorkspaceLifecycleNextAction =
  | "CLOSE_ACCOUNT"
  | "ORGANIZATION_OFFBOARDING"
  | "REQUEST_WORKSPACE_CLOSURE"
  | "CONTACT_SUPPORT";

export type WorkspaceLifecyclePolicy = {
  kind: WorkspaceLifecycleKind;
  endPath: WorkspaceEndPath;
  /** Always false: no Workspace kind has a self-service hard delete. */
  deletable: false;
  /** May the owner request the canonical Workspace closure? */
  closable: boolean;
  /** May ownership move to another member? */
  transferable: boolean;
  nextAction: WorkspaceLifecycleNextAction;
};

export const WORKSPACE_LIFECYCLE_ERROR_CODES = {
  /** DELETE on a Personal or Organization Workspace. */
  KIND_NOT_DELETABLE: "WORKSPACE_KIND_NOT_DELETABLE",
  /** DELETE on a closable Workspace: closure is the only way it ends. */
  CLOSURE_REQUIRED: "WORKSPACE_CLOSURE_REQUIRED",
  /** A closure request against a kind that does not close on its own. */
  KIND_NOT_CLOSABLE: "WORKSPACE_KIND_NOT_CLOSABLE",
  /** The caller is not the Workspace owner. */
  OWNER_REQUIRED: "WORKSPACE_OWNER_REQUIRED",
} as const;

export function resolveWorkspaceLifecyclePolicy(
  kind: string | null | undefined,
): WorkspaceLifecyclePolicy {
  switch (kind) {
    case "PERSONAL":
      return {
        kind: "PERSONAL",
        endPath: "ACCOUNT_CLOSURE",
        deletable: false,
        closable: false,
        transferable: false,
        nextAction: "CLOSE_ACCOUNT",
      };
    case "ORGANIZATION":
      return {
        kind: "ORGANIZATION",
        endPath: "ORGANIZATION_OFFBOARDING",
        deletable: false,
        closable: false,
        transferable: false,
        nextAction: "ORGANIZATION_OFFBOARDING",
      };
    case "OWNED":
      return {
        kind: "OWNED",
        endPath: "WORKSPACE_CLOSURE",
        deletable: false,
        closable: true,
        transferable: true,
        nextAction: "REQUEST_WORKSPACE_CLOSURE",
      };
    default:
      // Unclassifiable rows fail closed: nothing ends them from the product.
      return {
        kind: "UNKNOWN",
        endPath: "NONE",
        deletable: false,
        closable: false,
        transferable: false,
        nextAction: "CONTACT_SUPPORT",
      };
  }
}

/**
 * Customer copy for each kind's lifecycle. The words "team" and "delete" do
 * not appear: the object is a Workspace and nothing deletes it.
 */
export function describeWorkspaceLifecycle(
  policy: WorkspaceLifecyclePolicy,
  /**
   * Whose eyes. A Personal Workspace's copy speaks to its OWNER ("your
   * account"); anyone else who can read the policy — a collaborator in a PRO
   * or TEAM owner's Workspace — is told whose account it ends with, and is
   * never pointed at closing their own.
   */
  viewer: { isOwner: boolean } = { isOwner: true },
): {
  title: string;
  explanation: string;
} {
  switch (policy.kind) {
    case "PERSONAL":
      if (!viewer.isOwner) {
        return {
          title: "Personal Workspace",
          explanation:
            "This Personal Workspace belongs to its owner's account and closes only when the owner closes that account. Evidence stays governed by retention and legal-hold rules.",
        };
      }
      return {
        title: "Your Personal Workspace",
        explanation:
          "Your Personal Workspace belongs to your account. It closes only when you close your account, and your plan changes always keep this same workspace.",
      };
    case "ORGANIZATION":
      return {
        title: "Organization Workspace",
        explanation:
          "This workspace is governed by your organization. It ends only through your organization's offboarding, under its retention and legal-hold rules.",
      };
    case "OWNED":
      return {
        title: "Workspace closure",
        explanation:
          "Closing archives everyone's access after a cancellation window. Evidence is never deleted by closure — it stays governed by retention and legal-hold rules.",
      };
    default:
      return {
        title: "Workspace lifecycle",
        explanation:
          "This workspace's lifecycle can't be changed here. Contact support if you need help.",
      };
  }
}
