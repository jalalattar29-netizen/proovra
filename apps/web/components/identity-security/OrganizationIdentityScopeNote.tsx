/**
 * Members audit DOM-13 — SSO and SCIM belong to the ORGANIZATION.
 *
 * Identity-provider connections, SCIM tokens, directory groups and external
 * identities are the Organization's: every workspace of the Organization
 * addresses the same configuration, and changing it needs an Organization
 * owner, admin or security admin. The consoles that edit it are reached from
 * a workspace, so without this note a reader would reasonably believe a
 * change stays inside the workspace they happen to be standing in.
 */

export const ORGANIZATION_IDENTITY_SCOPE_TITLE = "Managed for the whole organization";

export function OrganizationIdentityScopeNote({
  subject,
}: {
  /** What is organization-scoped, e.g. "Single sign-on connections". */
  subject: string;
}) {
  return (
    <p
      className="adm-help"
      data-testid="organization-identity-scope"
      style={{ margin: "0 0 12px", maxWidth: 720 }}
    >
      <strong>{ORGANIZATION_IDENTITY_SCOPE_TITLE}.</strong> {subject} belong to
      your organization and apply to every one of its workspaces. Changes need
      an organization owner, admin or security admin.
    </p>
  );
}
