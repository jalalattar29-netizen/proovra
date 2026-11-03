/**
 * An invitation reaches a person who may have no account. Signed out, these two
 * pages show alone: the shell's sidebar and workspace chip describe an app they
 * cannot use yet. Signed in, they keep the shell.
 */
export function isInvitationAcceptPath(pathname: string | null): boolean {
  return /^\/(org-invites|collaboration-teams\/invites)\/[^/]+\/accept\/?$/.test(pathname ?? "");
}
