/**
 * What an organization invitation grants, before it is accepted (PRO-072).
 *
 * The org-invite acceptance page told the recipient "This does NOT grant you
 * access to workspace evidence, cases, or reviewer queues" while the same
 * invitation could carry workspace assignments that acceptance writes, up to
 * workspace ADMIN. The page had no way to know: the organization invitation
 * domain was mutation-only. This is its READ, built on the same disclosure
 * rules as the workspace invitation lookup (`WorkspaceInvitationLookup`):
 *
 *   - an unknown token gets one opaque answer (the route's 404);
 *   - `context` is present ONLY for `PENDING`;
 *   - the invited address is masked;
 *   - no organization, workspace, invite or user id leaves the server.
 *
 * `workspaces` lists the assignments acceptance would attempt, by display
 * name and role, after the same filter the accept transaction applies (the
 * workspace still belongs to the organization and is not personal). An
 * assignment can still be refused at acceptance for a full or restricted
 * workspace; the accept response says so, and the page reports it.
 */
import type { WorkspaceInvitationLookupState } from "./workspace-invitation-contract.js";

export type OrganizationInvitationWorkspaceGrant = {
  /** The workspace's display name. Never an id. */
  workspaceName: string;
  /** The workspace role acceptance grants: VIEWER, MEMBER or ADMIN. */
  role: string;
};

export type OrganizationInvitationContext = {
  organizationName: string;
  /** The organization role, as the enum the API already publishes. */
  role: string;
  invitedEmailMasked: string;
  /** ISO-8601 UTC. */
  expiresAtUtc: string;
  /** Empty for a governance-only invitation. */
  workspaces: OrganizationInvitationWorkspaceGrant[];
};

export type OrganizationInvitationLookup = {
  state: WorkspaceInvitationLookupState;
  context: OrganizationInvitationContext | null;
};
