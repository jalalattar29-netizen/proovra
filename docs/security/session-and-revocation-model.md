# Session and revocation model (for auditors and support)

Team remediation T-164 (2026-11-24). This page states how PROOVRA treats
sessions, removal and revocation, so that an auditor or a support engineer can
answer "who can still act, and why" without reading code. It complements
[step-up-governance.md](./step-up-governance.md) and
[session-reconstruction.md](./session-reconstruction.md).

> Scope note. Items 1 and 3 describe the contract delivered by the Team
> remediation stage B (T-038, T-039, T-040). Where this page and the running
> code disagree, the code is wrong and the disagreement is a defect.

## 1. Every review-capable token is inventoried

- A signed-in session normally has an `AuthenticatedSession` row (its
  session id is stored hashed). The row carries the risk score, the device and
  the issue time that adaptive security and step-up read.
- A token whose session id has **no** row ("row-less", residue of older
  sign-in paths) is not a normal state.
  - **Adoption rule:** on first use, a row-less session id is adopted into the
    session inventory (a row is written for it), so it can be listed, revoked
    and scored like any other session.
  - **Privileged actions:** until it is adopted, a row-less token is asked to
    re-authenticate before any privileged review action; it is never treated
    as "legacy, allowed".
- "Sign out other sessions" and "change password and sign out others" end
  every other token of the user — inventoried or row-less — by session row and
  by issue time (`iat`), without breaking the current, valid sign-in.

## 2. Removal ends access through membership

- Removing a member (or suspending them) ends their access to the workspace
  through **membership**: every workspace-scoped authorization re-reads the
  ACTIVE membership, so the removed person is refused on their next request.
- Held work is released in the same transaction (reviews, escalations), so no
  review stays assigned to someone who can no longer open it.
- The person's own self-serve session rows are **kept** by design: they still
  own their account and may belong to other workspaces. Removal is not a global
  sign-out; it is the end of this workspace's access.

## 3. Action matrix — step-up on review and sharing actions

| Action | Step-up | Why |
|---|---|---|
| Revoke an External Review grant / reviewer share | revoke: no step-up (protective) | Revoking only reduces access; friction would delay a protective act. |
| Issue or renew an External Review grant | step-up per workspace policy | Issuing extends access to someone outside the workspace. |
| Assign / reassign a review (single or bulk) | no step-up | Assignment is not a decision; authorization, eligibility and audit still apply. |
| Record a verdict (approve / reject) | per policy flag, or genuine HIGH risk | Explicit MFA requirements stay enforced with no password fallback. |
| Resolve / suppress an escalation that forces independent review | per policy flag; only an owner or admin who is neither the assignee nor a decider in the current round | The two-person rule is never lifted by the person it constrains (T-016). |
| Row-less session: adopted or re-auth | re-auth before privileged actions until adopted | See section 1. |

## 4. Where the evidence is

- Tenant audit actions for the review lifecycle are listed in
  `packages/shared/src/review-event-taxonomy.ts` (`REVIEW_LIFECYCLE_AUDIT_ACTIONS`).
- Refused escalation resolves are audited as
  `reviewer.escalation.resolve_refused` / `reviewer.escalation.suppress_refused`.
