# Review step-up action matrix and session compatibility

Status: authoritative for the Team remediation (stage B, 2026-11-24). The data
lives in `packages/shared/src/review-step-up-policy.ts`; the API gate
(`services/api/src/services/reviewer-ops/review-action-gate.ts`) and the Review
settings page both read it, so this table, the code and the page cannot drift.
`packages/shared/tests/review-step-up-policy.test.mjs` checks this document
against the data.

## 1. Layers, in the order they run

1. **Session trust** (always): a revoked or ended session is refused; a
   quarantined session cannot perform privileged actions; CRITICAL risk blocks.
2. **Session age window** (always, per action): approve, reject, single archive
   and escalation resolve need a sign-in from the last **8 hours**; bulk actions
   and escalation suppression need one from the last **4 hours**. Otherwise the
   answer is `401 reauth_required` with `details.reason = session_age_window`
   and `details.windowHours`. The person stays signed in for everything else.
3. **Session risk** (always): MEDIUM asks for a second factor
   (`details.reason = elevated_session_risk`); HIGH asks for a fresh sign-in
   (`high_session_risk`). Concurrent sessions count towards risk only when they
   come from a different network, device or country (T-025).
4. **Workspace checkbox** (optional, Review settings): asks for a second factor
   (`details.reason = policy_flag:<flag>`).

A second factor is a passkey or security key, an authenticator app, the
organization's sign-in, or (where allowed) a verified phone. A password is
never accepted in its place, and a trusted device does not satisfy a review
step-up.

## 2. Governed actions

| Action | Checkbox | Step-up purpose | Session window |
|---|---|---|---|
| Approve a review | Approve | `REVIEW_APPROVAL_HIGH_RISK` | 8 h |
| Uphold a decision when adjudicating a disagreement | Approve | `REVIEW_APPROVAL_HIGH_RISK` | 8 h |
| Reject a review | Reject | `REVIEWER_OPS_REJECT` | 8 h |
| Close a review from the Evidence page | Reject | `REVIEWER_OPS_REJECT` | 8 h |
| Reopen a review from the Evidence page | Reject | `REVIEWER_OPS_REJECT` | 8 h |
| Archive one review (close it without a decision) | Reject | `REVIEWER_OPS_ARCHIVE` | 8 h |
| Resolve an escalation | Escalation | `REVIEWER_OPS_ESCALATION_RESOLVE` | 8 h |
| Suppress an escalation | Escalation | `REVIEWER_OPS_ESCALATION_RESOLVE` | 4 h |
| Bulk decisions and bulk close | Bulk | `REVIEWER_OPS_BULK_ACTION` | 4 h |
| Bulk priority, pause, request information and escalate | Bulk | `REVIEWER_OPS_BULK_ACTION` | 4 h |
| Bulk coding | Bulk | `REVIEWER_OPS_BULK_ACTION` | 4 h |
| Save Review settings | always (cannot be switched off) | `GOVERNANCE_POLICY_UPDATE` | — |

A single Archive is sent to the bulk door as `scope: "single"` with exactly one
review; the server classifies it as its own action (T-030). A close of several
reviews is a bulk close.

## 3. Actions that never ask for a second factor

| Action | Rule |
|---|---|
| Assign or reassign reviews, one or many | no step-up (P8). Authorization (`review.assign`), the eligible-reviewer check and the audit row apply. Bulk doors still refuse a quarantined or CRITICAL-risk session. No Enterprise contract flag requiring step-up for assignment exists; one would be added to the shared table, never per door. |
| Start, pause or resume a review | no step-up |
| Request information on one review | no step-up |
| Raise or acknowledge an escalation | no step-up |
| Add notes | no step-up |
| Revoke an external reviewer or a share link | **no step-up (protective)**: revocation reduces exposure (P9). Issuing and renewing keep their step-up. Pinned by `services/api/test/revocation-frictionless-pin.integration.test.ts`. |

## 4. Refusal reasons a client renders

| `error.code` | `error.details.reason` | Meaning | Client presentation |
|---|---|---|---|
| `STEP_UP_REQUIRED` (401) | `policy_flag:<flag>` | the workspace checkbox | second-factor dialog with the workspace sentence |
| `STEP_UP_REQUIRED` (401) | `elevated_session_risk` | MEDIUM session risk | second-factor dialog with the "unusual sign-in activity" sentence |
| `STEP_UP_REQUIRED` (401) | `save_policy_requires_mfa` | Save Review settings | second-factor dialog |
| `STEP_UP_ENROLLMENT_REQUIRED` (403) | — | no factor usable here | enrolment state with "Set up two-factor" (returns to the task) and "Not now" |
| `reauth_required` (401) | `session_age_window` | sign-in older than the window | "Sign in again" in a separate window; the page and typed text stay; Continue re-runs only when the person asks |
| `reauth_required` (401) | `high_session_risk` / `legacy_session` | HIGH risk / pre-inventory session | as above |
| `session_quarantined` / `session_blocked` (403) | — | session trust | refusal sentence; sign out and in again |

`reauth_required` is never treated as "session expired": the web client does
not sign the person out and does not show the expired-session copy.

## 5. Session inventory compatibility (T-038, T-039)

Before 2026-11-22 an interactive sign-in wrote its `AuthenticatedSession` row
best-effort; a failed insert left a valid token without a row. Such a token
skipped risk, age windows and quarantine, was not listed under "My sessions"
and survived "Sign out other sessions".

- **Adoption.** On such a token's next authenticated request, `requireAuth`
  writes its row (`authMethod = ADOPTED_LEGACY`, `issuedAtUtc = iat`) and emits
  the `legacy_session_adopted` security event. Nobody is signed out. Because the
  row carries the real issue time, every genuine legacy token (older than every
  privileged window) must sign in again before approve, reject, archive, bulk,
  resolve or suppress. If the row cannot be written, the request is refused with
  `401 reauthentication_required`.
- **Gate.** A sid that reaches the adaptive gate without a row is refused with
  `reauth_required` / `legacy_session`.
- **Sign out other sessions / change password + sign out others.** Besides
  revoking every other inventory row by its own hash, the action writes an
  ALL_FOR_USER cut-off at the acting token's own `iat`: every token issued
  before it ends, with or without a row. The acting token (same second,
  inventoried) and sessions signed in later stay valid.

## 6. Score recalibration (T-026)

Sessions scored before T-025 may carry 35 (MEDIUM) only because of the old
concurrency rule. The scheduled identity-runtime sweep runs
`recalibrateConcurrencyOnlySessionScores` on every pass: it re-derives each
live MEDIUM/HIGH session's signals and lowers the stored score only by the
concurrency weight the new rule no longer applies (other causes are kept). Each
lowered score is recorded as `runtime_risk_cooled_down` with reason
`concurrency_recalibrated`. It is idempotent (sessions evaluated since
2026-11-24 are not selected again).
