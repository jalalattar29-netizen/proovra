/**
 * PRO-T2-05 — what an organization's policies mean for the person accepting
 * its invitation, stated BEFORE acceptance (both acceptance surfaces render
 * this one component).
 *
 * The facts come from POST /v1/org-invites/lookup (`context.policy`). An API
 * that predates the field sends none, and this renders nothing — never a
 * guess. Accepting with an existing account never converts it and never takes
 * its Personal Space or personal billing away (DEC-07): the restrictions an
 * organization sets apply to accounts it created itself.
 */
import type { OrganizationInvitationPolicyFacts } from "@proovra/shared";

export function OrgInvitationPolicyNotice({
  policy,
}: {
  policy: OrganizationInvitationPolicyFacts | undefined | null;
}) {
  if (!policy) return null;
  const text = { fontSize: 13, opacity: 0.85, margin: 0 } as const;
  return (
    <div data-invite-policy style={{ display: "grid", gap: 4 }}>
      <p style={text} data-invite-policy-account>
        Your own account stays yours: accepting does not convert it, and your Personal Space, personal
        billing and personal data export are not affected.
      </p>
      {policy.ssoRequired ? (
        <p style={text} data-invite-policy-sso>
          This organization requires signing in through its identity provider to open its workspaces.
        </p>
      ) : null}
      {policy.noPersonalSpace || policy.managedIdentityRequired ? (
        <p style={text} data-invite-policy-managed>
          This organization manages the accounts it creates itself
          {policy.noPersonalSpace ? " and does not give those accounts a Personal Space" : ""}. That does not
          apply to an account you opened yourself.
        </p>
      ) : null}
      <p style={text} data-invite-policy-admin>
        Organization administrators can suspend or end your access to the organization and its workspaces.
      </p>
    </div>
  );
}
