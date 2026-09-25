/**
 * EXTERNAL COLLABORATORS (T-14 TeamAccessReviewCard) — who outside the
 * workspace holds case access, and the one place it can be withdrawn.
 *
 *   GET    /v1/teams/:id/access-review             (ADMIN+; 403 otherwise)
 *   DELETE /v1/teams/:id/external-grants/:grantId  (ADMIN+, audited)
 *
 * Read from the route's own reply (`externalCollaborators[]`, each with
 * `grants[] { grantId, caseId, caseName, grantedAt }`). Success of a revoke is
 * decided by a REREAD, never by the DELETE's 200 alone — the web rule.
 *
 * Pure: no React, no fetch.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface ExternalGrant {
  grantId: string;
  caseId: string | null;
  caseName: string | null;
  grantedAtIso: string | null;
}

export interface ExternalCollaborator {
  userId: string;
  email: string | null;
  displayName: string | null;
  firstGrantedAtIso: string | null;
  grants: ExternalGrant[];
}

export function buildAccessReviewPath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/access-review`;
}
export function buildExternalGrantPath(teamId: string, grantId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/external-grants/${encodeURIComponent(grantId)}`;
}

export function parseExternalCollaborators(raw: unknown): ExternalCollaborator[] {
  const list = obj(raw).externalCollaborators;
  return (Array.isArray(list) ? list : [])
    .map(obj)
    .filter((c) => str(c.userId))
    .map((c) => ({
      userId: c.userId as string,
      email: str(c.email),
      displayName: str(c.displayName),
      firstGrantedAtIso: str(c.firstGrantedAt),
      grants: (Array.isArray(c.grants) ? c.grants : [])
        .map(obj)
        .filter((g) => str(g.grantId))
        .map((g) => ({
          grantId: g.grantId as string,
          caseId: str(g.caseId),
          caseName: str(g.caseName),
          grantedAtIso: str(g.grantedAt),
        })),
    }));
}

export function collaboratorLabel(c: Pick<ExternalCollaborator, "displayName" | "email">): string {
  return c.displayName?.trim() || c.email || "External collaborator";
}

/** The server substitutes "(unknown case)" when the name cannot be resolved. */
export function grantCaseLabel(g: Pick<ExternalGrant, "caseName">): string {
  return g.caseName && g.caseName !== "(unknown case)" ? g.caseName : "an unnamed case";
}

export function grantStillListed(list: ExternalCollaborator[], grantId: string): boolean {
  return list.some((c) => c.grants.some((g) => g.grantId === grantId));
}

export function revokeConfirmCopy(who: string, where: string) {
  return {
    title: `Remove ${who}'s access to ${where}?`,
    body: `${who} will immediately lose access to ${where}. They are not a member of this workspace, so this removes their standing access to that case. The removal is recorded in the workspace audit trail; to give access back, the case owner must share the case again.`,
    confirm: "Revoke access",
  };
}

export type RevokeOutcome = { tone: "ok" | "danger"; message: string };

/** After a 200: the reread decides. `reread` null = the reread failed. */
export function revokeAcceptedOutcome(reread: ExternalCollaborator[] | null, grantId: string, who: string, where: string): RevokeOutcome {
  if (reread && !grantStillListed(reread, grantId)) return { tone: "ok", message: `${who} no longer has access to ${where}.` };
  return {
    tone: "danger",
    message: reread
      ? "The removal was accepted, but the reloaded access review still lists this grant. Reload before trying again."
      : "The removal was accepted, but the access review could not be reloaded to confirm it. Reload to check.",
  };
}

/** A refused DELETE, by the server's status + code. null = use the safe generic. */
export function revokeRefusedMessage(status: number | null, code: string | null, who: string, where: string): string | null {
  if (status === 404 && code === "GRANT_NOT_FOUND") {
    return `This workspace cannot remove ${who}'s access to ${where}: the grant is gone, or the case is not owned by this workspace. The list has been reloaded; if the grant is still shown, the case owner must remove it from the case.`;
  }
  if (status === 422 && code === "INTERNAL_MEMBER") {
    return `${who} is now a member of this workspace, so their access is managed from Members, not here. Nothing was changed.`;
  }
  return null;
}

export const ACCESS_REVIEW_FORBIDDEN = {
  headline: "External access can only be reviewed by admins",
  reason: "Only an Owner or Admin can see who holds case-scoped access to this workspace. Ask a workspace admin if you need that information.",
};
export const ACCESS_REVIEW_EMPTY = "No external collaborators. Everyone with access to this workspace is a member of it.";
export const ACCESS_REVIEW_FOOTNOTE =
  "People who are not workspace members but hold access to individual cases in this workspace. Revoking removes their access to that case only; workspace members are managed from Members.";
