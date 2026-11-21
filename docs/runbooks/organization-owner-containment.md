# Runbook — Organization owner account under suspected misuse

**Incident slug**: `organization-owner-containment` · **Category**: `IDENTITY_SECURITY` · **Default severity**: `HIGH`

How an authorized operator contains an organization owner's account that is suspected of being used by someone other than its owner, without taking anything from unrelated self-serve accounts. Not incident-fired: read it before you need it.

## When to use it
- The organization reports that an ORG_OWNER account is acting in ways its owner did not do (unexpected role changes, invitations, exports or sign-ins).
- Identity signals for that account are rising (`suspicious_login_detected`, `impossible_travel_signal`, `step_up_denied`); see `suspicious-login-burst`.
- The organization's directory (SCIM) answered `409 last_active_organization_owner` to a deactivation of that person.

## The rules this runbook works within
- **Owner continuity (closure 2, "sem" item 1).** An organization always keeps one live owner. The last ACTIVE ORG_OWNER cannot be demoted, removed or suspended by another member (`LAST_OWNER_PROTECTED`), and the directory cannot suspend or deprovision them either. A SCIM deactivation of the last live owner is refused with `409 last_active_organization_owner` and writes nothing: no membership change, no mapping unlink, no session revocation. The refusal is recorded as tenant audit `scim.user.deactivate` with outcome `denied` and denial reason `LAST_ACTIVE_ORGANIZATION_OWNER`.
- **When another live owner exists**, the directory may suspend an owner's governance membership, and so may another live owner through the members page. Both decide under the organization's owner lock, so two suspensions at once can never leave zero owners.
- **Workspace owners (PROV-011).** Neither the members page nor the directory suspends a person who owns a live workspace of the organization: both answer `OWNERSHIP_TRANSFER_REQUIRED` (SCIM: `409` with that detail) and write nothing. Move that workspace's ownership first.
- **DEC-08.** A workspace never controls a self-serve account's global sessions just because the account joined it. Workspace session doors end only the sessions of identities the organization originated (`workspaceGovernsAccountSessions`). Nothing here touches anyone's Personal Space or personal data.
- **Payer.** Containing or suspending an owner does not move payment liability (decision E). The payer stays the payer until an explicit handover.

## Safe commands / routes

### 1. End the account's sessions
1. Organization-originated owner identity (the organization's directory or IdP created it): another owner or an identity administrator of the workspace calls `POST /v1/identity-security/sessions/revoke-all` with `{ teamId, userId }`. This needs `identity.access_review.action`, Enterprise session governance and a step-up (`CONTRIBUTOR_SESSION_REVOKE`).
2. Self-serve owner account: the workspace cannot end that account's global sessions (DEC-08; the door answers 404). The organization asks the owner to sign out everywhere from their own account (`POST /v1/identity-security/my-sessions/revoke-others`, with account step-up) and to change their password. Sessions the organization's SSO issued end when the organization's membership is suspended (step 2).
3. Remove trust from the account's trusted devices in each workspace: `POST /v1/identity-security/devices/:id/revoke`. For another person's device this needs `identity.access_review.action`, the members rank rule and a step-up bound to that device (`MFA_TRUSTED_DEVICE_RESET`). An ADMIN cannot remove trust from the OWNER's device; the OWNER or an operator with higher rank must. To clear all of one person's devices in a workspace: `POST /v1/identity/mfa-admin/trusted-devices/:teamId/:userId/reset` (rank rule plus step-up).

### 2. Suspend the owner while another owner exists
1. Confirm a second live owner: `GET /v1/orgs/:id/members` lists at least two `ORG_OWNER` rows with status `ACTIVE`. If there is only one, go to section 3. Do not promote an unvetted member just to get past the rule.
2. Another live owner suspends the membership: `POST /v1/orgs/:id/members/:memberId/suspend`. The route refuses with `OWNERSHIP_TRANSFER_REQUIRED` while the suspected owner still owns a live workspace of the organization, because a workspace must keep a live owner (PROV-011).
3. Or the organization's directory deactivates the person (`DELETE /v2/scim/Users/:id`, or a PATCH with `active:false`). It is refused the same way while they own a live workspace. With another live owner present and no workspace owned, this suspends the governance membership and the person's non-owner workspace memberships, unlinks the directory mapping, and ends sessions within the authority-loss scope (all sessions for an organization-originated identity; only SSO-issued sessions for a self-serve account).
4. Restore later with `POST /v1/orgs/:id/members/:memberId/restore` by a live owner, or a directory reactivation. Restore brings back exactly the workspace memberships the suspension paused.

### 3. The platform-operator path (single remaining owner, or a workspace owner who cannot be suspended)
1. A platform administrator, on a second-factor-verified session with a fresh step-up, suspends the whole organization: `POST /v1/admin/orgs/:id/suspend` with `{ teamId, reason }`. This halts the organization's SSO, SCIM and API credentials, suspends every governance membership, expires open invitations and clears switcher pointers into the organization's workspaces. It affects only that organization: members keep their Personal Spaces, and other organizations are untouched.
2. Once the rightful owner is confirmed out of band, re-provision ownership through `POST /v1/admin/orgs/:id/owner-invite/reissue` (the operator's platform authority is checked again when the invitation is accepted), then resume with `POST /v1/admin/orgs/:id/resume`. Resume restores exactly the memberships the suspension paused.
3. If the organization's directory token itself is suspect, revoke or rotate it: `POST /v1/admin/identity/scim/tokens/:id/revoke` or `/rotate`.

## What NOT to do
- **Do not** edit `organization_memberships` rows by hand to get past `LAST_OWNER_PROTECTED`. That leaves the organization with no one who can administer it.
- **Do not** delete the `User` row. Suspend memberships instead; deletion drops the audit trail.
- **Do not** revoke a self-serve member's account-wide sessions through a workspace door, a script or the database. That signs the person out of their Personal Space and breaks DEC-08.
- **Do not** move the billing owner or contract owner as part of containment. Payment liability changes only through an explicit handover.
- **Do not** switch on `IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT` as a containment step. It is a fleet-wide decision with its own activation evidence (`docs/operations/identity-operations-runbook.md` §4b).

## Escalation
- Single remaining owner, or the suspected owner owns workspaces: platform operations (section 3).
- Payment or contract questions: billing operations. Containment does not change the payer.
- Signal investigation: `suspicious-login-burst`.
