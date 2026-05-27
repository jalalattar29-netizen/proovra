# Phase 2.3 — Enterprise governance, organization control center, and account security surfaces

Scope: turn PROOVRA from a team-centric evidence app into an enterprise-
governed operational platform by **exposing** the security and
governance capabilities the backend already supports but that were
hidden from the UI, while documenting the real gaps.

Hard rules carried forward (Phase 0/1/2.1/2.2):

- Backend remains authoritative.
- No schema reproducibility / public-verify / rate-limit / PII-redaction
  / evidence integrity / custody / report / signing / upload regression.
- No fake settings pages.
- No security control without backend enforcement.
- No hidden backend capability that is safe + relevant left undocumented.

The single biggest finding of Section 1 inspection: **PROOVRA already
ships an enterprise-grade governance suite** (see matrix). The
operator-UX gap was almost entirely **discoverability** and
**user-facing account security**.

---

## Section 1 — Current-state inspection matrix

For each governance capability: does the backend exist, does the
frontend exist, can the user actually use it, what is the gate, what
states are missing, what is the risk if hidden, and the Phase 2.3
priority.

### Account / Profile / Identity

| Capability | Backend | Frontend | Usable | Gate | Missing states | Risk if hidden | P2.3 priority |
|---|---|---|---|---|---|---|---|
| Read profile (`GET /v1/users/me`) | ✅ | ✅ `/settings` | ✅ | auth | — | low | shipped pre-2.3 |
| Update profile (PATCH) | ✅ | ✅ `/settings` | ✅ | auth | avatar UPLOAD endpoint absent (URL field only) | medium | doc the upload gap |
| Legal acceptance history | ✅ | ✅ `/settings` | ✅ | auth | — | low | shipped pre-2.3 |
| Cookie consent | ✅ | ✅ `/settings` | ✅ | auth | — | low | shipped pre-2.3 |
| **Change password (direct)** | ❌ — only reset-by-email exists | ❌ | ❌ | n/a | **no direct change endpoint** | medium | **NEW UI exposes reset-link button + documents the gap** |
| Account deletion | ❌ confirmed missing | ❌ | ❌ | n/a | full GDPR delete flow | high | next phase |
| Data export | ❌ confirmed missing | ❌ | ❌ | n/a | full export | high | next phase |

### MFA

| Capability | Backend | Frontend (pre-2.3) | Frontend (post-2.3) | Gate | P2.3 |
|---|---|---|---|---|---|
| Read factors (`GET /v1/identity/mfa/factors`) | ✅ | ❌ | ✅ AccountSecurityCard | auth | **SHIPPED** |
| Enroll TOTP (start/verify) | ✅ | ❌ | ✅ AccountSecurityCard | auth + 429 rate-limit on verify | **SHIPPED** |
| Disable factor | ✅ `DELETE /v1/identity/mfa/factors/:id` | ❌ | ✅ AccountSecurityCard (with confirm) | auth | **SHIPPED** |
| Regenerate recovery codes | ✅ | ❌ | ✅ AccountSecurityCard (one-time display) | auth | **SHIPPED** |
| Workspace MFA policy (read/write) | ✅ `/v1/identity-security/mfa-policy` | ✅ `/security-center` | ✅ | step-up + `identity.org_policy.manage` | shipped pre-2.3 |

### Sessions

| Capability | Backend | Frontend | Gate | Risk | P2.3 |
|---|---|---|---|---|---|
| **List my own sessions** | ❌ confirmed missing | ❌ | n/a | medium | **document the gap; next phase** |
| Revoke single session (admin) | ✅ `POST /v1/identity-security/sessions/revoke` | ✅ `/admin/identity/sessions` | `identity.access_review.action` | low | nav promoted (Phase 2.3) |
| Revoke all sessions (admin/self) | ✅ `POST /v1/identity-security/sessions/revoke-all` | ✅ AccountSecurityCard (self) + `/admin/identity/sessions` (admin) | auth + role | medium | **SHIPPED** (user-facing) |
| List recent revocations | ✅ `GET /v1/identity-security/sessions` | ✅ `/admin/identity/sessions` | `identity.member.read` | low | shipped pre-2.3 |
| Trusted devices list / revoke | ✅ | ✅ `/security-center` | `identity.member.read` / `identity.access_review.action` | medium | shipped pre-2.3 |

### Notification preferences

| Capability | Backend | Frontend | P2.3 |
|---|---|---|---|
| Per-event delivery preferences (channels, opt-in/out) | ❌ confirmed missing — only delivery LOG exists | ❌ | **document; next phase** |
| Delivery log + manual resend | ✅ `/v1/notifications/deliveries` | partial — admin only | next phase |

### Workspace / Team governance

| Capability | Backend | Frontend | Gate | P2.3 |
|---|---|---|---|---|
| Member list + role change | ✅ | ✅ `/teams/[id]` | ADMIN+ | shipped pre-2.3 |
| Member removal with transfer | ✅ (Phase 2.1) | ✅ MemberRemovalDialog (Phase 2.2) | ADMIN+ | shipped Phase 2.2 |
| Invite lifecycle (create/cancel) | ✅ | ✅ `/teams/[id]` | ADMIN+ | shipped pre-2.3 |
| Activity / audit feed | ✅ `/v1/teams/:id/activity` | ✅ `/teams/[id]` | member | shipped pre-2.3 |
| Access reviews | ✅ `/v1/identity/access-reviews` | ✅ `/admin/identity/access-reviews` | `identity.access_review.read` | nav promoted Phase 2.3 |
| Permission matrix | ✅ `/v1/admin/identity/permission-matrix` | ✅ `/admin/identity/permission-matrix` | admin | nav promoted Phase 2.3 |
| Capability grants / delegated admin | ✅ `/v1/identity/members/:id/capabilities` etc. | ✅ `/admin/identity/permission-matrix` (read-only display) | admin | shipped pre-2.3; manage UI is partial |
| Service accounts / API keys | ✅ `/v1/identity/service-accounts` | ✅ `/admin/identity/scim` (SCIM) + `/integrations` (API keys/webhooks) | admin / `identity.service_account.manage` | shipped pre-2.3 |
| Org security policy (MFA-required, IP allowlist, domain allowlist, SSO/SCIM flags) | ✅ `/v1/identity/policy` | ✅ `/security-center` (MFA) + `/admin/identity/providers` (SSO/SCIM flags) | `identity.org_policy.manage` | shipped pre-2.3 |
| Identity timeline (SSO/SCIM/sessions/etc.) | ✅ `/v1/admin/identity/timeline` | ✅ `/admin/identity/timeline` | admin | nav promoted Phase 2.3 |
| SOC runtime monitor (quarantine / emergency revoke) | ✅ `/v1/admin/identity/runtime` etc. | ✅ `/admin/identity/runtime` | admin | nav promoted Phase 2.3 |

### SAML / SSO

| Capability | Backend | Frontend | P2.3 |
|---|---|---|---|
| SP metadata (public) | ✅ `/v1/auth/saml/metadata/:connectionId` | n/a (server response) | n/a |
| IdP metadata ingest | ✅ | ✅ `/security-center/sso` | shipped pre-2.3 |
| Test connection | ✅ | ✅ `/security-center/sso` | shipped pre-2.3 |
| Certificate rotation (next-cert) | ✅ | ✅ `/security-center/sso` | shipped pre-2.3 |
| AccessGate for workspace-required | n/a | **SHIPPED Phase 2.3** | new |

### SCIM

| Capability | Backend | Frontend | P2.3 |
|---|---|---|---|
| Token create/list/revoke | ✅ `/v1/admin/identity/scim/tokens` | ✅ `/admin/identity/scim` | shipped pre-2.3 |
| SCIM endpoints (Users + Groups CRUD, RFC 7644) | ✅ `/v2/scim/Users` etc. | n/a (consumed by IdP) | n/a |
| Provisioning status / sync log | ✅ surfaces in `/admin/identity/timeline` | ✅ | nav promoted Phase 2.3 |

### Audit / observability

| Capability | Backend | Frontend | P2.3 |
|---|---|---|---|
| Platform audit log + chain-of-custody verify | ✅ `/v1/admin/audit-log` + `/verify` | ✅ `/admin/audit` | nav promotion candidate (currently not in main nav) |
| Audit log CSV export | ✅ `/v1/admin/audit-log/export` | partial — referenced from `/admin/audit` | shipped pre-2.3 |
| Security events / scans | ✅ `/v1/security/{summary,events,scans}` | partial — referenced from security center | shipped pre-2.3 |
| Demo requests (sales pipeline) | ✅ `/v1/admin/demo-requests` | ✅ `/admin/demo-requests` | shipped pre-2.3 |

---

## Section 2 — Settings security surfaces (shipped)

**File:** `apps/web/app/(app)/settings/components/AccountSecurityCard.tsx` (550 lines, new).

Mounted into `/settings/page.tsx` between the Subscription card and
the Legal card.

Three subsections — all backed by real endpoints:

### MFA section
- Reads `/v1/identity/mfa/factors` and renders status (Enabled /
  Not enabled) + active factor list.
- "Set up authenticator app" launches enrollment:
  `POST /v1/identity/mfa/enroll/start` → renders the
  `provisioning_uri` and `secret` for the operator to add to their
  authenticator app → enters the 6-digit code →
  `POST /v1/identity/mfa/enroll/verify` returns the recovery codes
  ONCE. Codes are shown immediately with a "Copy all" + "I've saved
  them" affordance, and the panel is dismissable.
- "Remove" on each factor requires a second explicit click before
  calling `DELETE /v1/identity/mfa/factors/:id`.
- "Regenerate recovery codes" calls
  `POST /v1/identity/mfa/recovery-codes/regenerate`. New codes are
  displayed in the same one-time panel.
- If `GET /v1/identity/mfa/factors` returns 402/403, the section
  renders `<AccessGate kind="REQUEST_ACCESS">` linking to
  `/security-center`.

### Password section
- Backend has no "change password with current password" endpoint;
  only `POST /v1/auth/password-reset/request` exists. The card
  exposes that path explicitly with a "Send password reset link"
  button to the user's account email. Wording is
  enumeration-resistant ("If this email is registered, a reset
  link is on the way.") — matching the Phase 1 backend contract.
- 429 surfaces as "Too many reset requests. Wait a few minutes…"

### Sessions section
- Backend has no user-facing "list my sessions" endpoint today.
  The card states that explicitly ("We don't yet show a per-device
  session list to end users — that's a planned addition.") and
  surfaces ONLY the "Sign out of all devices" affordance using
  `POST /v1/identity-security/sessions/revoke-all`.
- The destructive action requires a second explicit click and
  warns that the user will be signed out on every device including
  the current one. MFA-prompt on the next sign-in is called out.

### What the card intentionally does NOT do
- No fake "Change password" form (backend missing).
- No fake per-device session list (backend missing).
- No fake notification preferences (backend missing).
- No fake avatar upload (only URL set is supported; we kept the
  existing display-only avatar in `/settings` instead of adding a
  broken upload button).

---

## Section 3 — Workspace governance (already shipped; nav promoted)

Most surfaces existed before Phase 2.3. The change is **discoverability**:

- `/security-center` — MFA policy + trusted devices + risk snapshot
  + sessions overview. Already in PLATFORM_HEALTH nav group.
- `/security-center/sso` — full SAML R8.2 console. Already
  navigable from `/security-center`. **Phase 2.3 added
  `<AccessGate kind="WORKSPACE_REQUIRED">`** when the operator is
  in a non-team scope.
- `/security-center/mfa-recovery` — admin recovery queue.
  Reachable from `/security-center`.
- `/admin/identity` and its 7 sub-consoles (providers, SCIM,
  sessions, access-reviews, permission-matrix, timeline, runtime
  monitor) — existed since Phase 26-26.75 but were **not in nav**.
  Phase 2.3 promoted `/admin/identity` to the PLATFORM_HEALTH nav
  group with capability `SECURITY_CENTER_VIEW`.
- `/governance/*` (hub, lifecycle, policy, retention, destruction,
  notifications, analytics) — already in GOVERNANCE nav group.
- `/teams/[id]` — member/invite/case/activity tabs. Phase 2.2
  shipped MemberRemovalDialog for the offboarding flow.
- `/billing` — already in nav.
- `/integrations` — already in nav (`admin.integrations`).

**No new backend was added in Phase 2.3.** This is intentional — the
brief explicitly says "Backend must enforce all security controls.
UI must not pretend policy exists if backend cannot enforce it."

---

## Section 4 — SAML / SCIM / SSO

All major SSO/SCIM surfaces ALREADY EXIST. Phase 2.3 confirms they
are not hidden — `/security-center/sso` is one click from the nav
entry "Security Center", and `/admin/identity/scim` is one click
from the newly-promoted "Identity Admin" nav entry.

Surfaces already shipped (no fake UI):
- SAML 2.0 IdP metadata ingest (Phase R8.2)
- Test connection (Phase R8.2.1)
- Certificate rotation with primary/next slot (Phase R8.2.1)
- IdP entity ID, NameID format, cert expiry warnings (Phase R8.2.2)
- SCIM token create with ONE-TIME bearer display (Phase 26)
- SCIM token revoke + IP allowlist
- Provisioning status visible via identity timeline

Phase 2.3 change in this section: **AccessGate adoption on the
WORKSPACE_REQUIRED branch** of `/security-center/sso` (previously
rendered as bare grey text "Switch to a workspace to manage SSO
connections" with no next step). Now renders a panel with explicit
"Open team workspaces" / "Review plans" actions.

**Plan-gate status:** the SSO surface itself does not 402 for FREE
users at the frontend; the backend `/v1/admin/identity/sso/providers`
call enforces role gating. If/when a plan gate is added server-side,
the AccessGate adoption Phase 2.3 just shipped will pick it up via
the `classifyAccessError` helper.

---

## Section 5 — Admin / security-center cleanup

Phase 2.3 inspection found **zero placeholder pages** in the
settings/security/admin/governance families:

- Grep across these route families for the strings "coming soon",
  "Not implemented", "Placeholder", "TODO", "WIP" returned ZERO
  matches.
- Every page loads real data or surfaces a real operational state.
- Every destructive action calls a real backend endpoint with
  confirmation.

Therefore, **no placeholder removal was required**. The audit
finding is itself the deliverable: "the admin/security surfaces are
real product, not mockups."

The brief asked specifically about `/operations` dead routes. The
sub-agent confirmed `/operations/reliability` is real (Phase 12
upload pipeline recovery console). No dead routes to remove.

---

## Section 6 — AccessGate adoption (continued from Phase 2.2)

Phase 2.3 adoptions:

1. `apps/web/app/(app)/settings/components/AccountSecurityCard.tsx`
   — MFA section renders `<AccessGate kind="REQUEST_ACCESS">` when
   the backend returns 402/403 on the factors read.
2. `apps/web/app/(app)/security-center/sso/page.tsx` — the
   "no workspace selected" branch renders
   `<AccessGate kind="WORKSPACE_REQUIRED">` with explicit
   next-step actions.

Files audited and intentionally deferred:
- Billing cancel actions — still toast-only (Phase 2.2 noted this;
  deferred to next phase to avoid restructuring the billing page
  state machine).
- Capture session finalize `TEAM_PLAN_REQUIRED` — deferred.
- Evidence detail verification-package 403/409 — already produces
  structured per-statuscode messages via `addToast`; deferred.

---

## Section 7 — Navigation / IA improvements

**One nav entry added:**

```
PLATFORM_HEALTH > Identity Admin → /admin/identity
  requiresCapability: SECURITY_CENTER_VIEW
```

This makes the 7 identity admin sub-consoles (providers, SCIM,
sessions, access-reviews, permission-matrix, timeline, runtime
monitor) discoverable from the sidebar instead of relying on
operators knowing the deep-link URLs.

No nav items removed (no dead routes found in the cleanup audit).

No nav items duplicated (the IA already has account-menu vs.
sidebar separation, and the existing surfaces are correctly placed
across the 5 nav groups).

---

## Section 8 — E2E tests added

`e2e/phase2-3-flows.spec.ts` (7 tests):

1. `/settings` exposes the new AccountSecurityCard (via
   `data-account-security-card` or the `account.settings` route
   gate marker).
2. `/security-center` reachable.
3. `/security-center/sso` reachable.
4. `/admin/identity` reachable (proves the Phase 2.3 nav
   promotion's underlying page works).
5. `GET /v1/identity/mfa/factors` returns 200 for an
   authenticated user with a `factors[]` or `enrollments[]` array
   (locks the contract the AccountSecurityCard depends on).
6. `POST /v1/auth/password-reset/request` accepts the
   AccountSecurityCard body and returns 2xx/429 (locks the
   Phase-1 enumeration-resistance contract).
7. `POST /v1/identity-security/sessions/revoke-all` parses the
   AccountSecurityCard body cleanly (never 5xx).

All 7 pass.

---

## Section 9 — Runtime validation

- `pnpm --filter proovra-web typecheck` — clean.
- `pnpm --filter proovra-api typecheck` — clean.
- `pnpm --filter proovra-web lint` — 0 errors. The pre-existing
  exhaustive-deps warnings are unchanged; ZERO new warnings from
  Phase 2.3 files.
- `pnpm exec playwright test` — **32/32 passing** in ~46s:
  - evidence-flow.spec.ts: 3/3
  - landing-pages.spec.ts: 6/6
  - phase2-1-flows.spec.ts: 5/5
  - phase2-2-flows.spec.ts: 5/5
  - phase2-3-flows.spec.ts: 7/7
  - public-verify-privacy.spec.ts: 6/6

**No Phase 0 / 1 / 2.1 / 2.2 regression.**

---

## Bug fixed in passing (Phase 2.2 follow-up)

Phase 2.2 placed the in-app verify workspace at
`apps/web/app/(app)/verify/page.tsx`. Next.js route groups do not
affect URL, which meant that file collided with the existing public
`apps/web/app/verify/page.tsx` (the public marketing/landing page).
The collision only surfaced under HMR pressure during the full e2e
run (a fresh dev server happened to pick one of them).

Phase 2.3 relocates the in-app surface to
`apps/web/app/(app)/inspect/page.tsx` — a distinct URL `/inspect`
that no longer fights the public verify landing. The Phase 2.2 E2E
test was updated to navigate to `/inspect` accordingly.

The Phase 2.2 doc remains accurate about the design and intent; the
URL line is the only change.

---

## Files added / modified in Phase 2.3

Added:

- `apps/web/app/(app)/settings/components/AccountSecurityCard.tsx`
- `apps/web/app/(app)/inspect/page.tsx` (relocated Phase 2.2 file —
  contents unchanged besides the header note)
- `e2e/phase2-3-flows.spec.ts`
- `docs/product/PHASE_2_3_ENTERPRISE_GOVERNANCE.md` (this file)

Modified:

- `apps/web/app/(app)/settings/page.tsx` — imports + renders
  AccountSecurityCard
- `apps/web/app/(app)/security-center/sso/page.tsx` —
  WORKSPACE_REQUIRED branch upgraded to AccessGate
- `services/api/src/services/platform-context/navigation-registry.ts` —
  added `platform.identity_admin` nav entry
- `e2e/phase2-2-flows.spec.ts` — navigation URL updated for the
  relocated in-app verify route

Deleted:

- `apps/web/app/(app)/verify/page.tsx` — collided with
  `apps/web/app/verify/page.tsx` (public landing). Content
  preserved at `apps/web/app/(app)/inspect/page.tsx`.

---

## Enterprise readiness analysis

### What PROOVRA has (after Phase 2.3)

**Account security (user-facing):**
- MFA enroll/disable/recovery codes (NEW Phase 2.3)
- Password reset via email (NEW Phase 2.3)
- Sign-out-everywhere (NEW Phase 2.3)
- Profile + locale + timezone + display name + bio + country
- Legal acceptance history
- Cookie consent management

**Workspace governance (admin-facing):**
- Member lifecycle with orphan-safe removal (Phase 2.2)
- Invite lifecycle + role change
- Team activity feed
- Access reviews with PENDING / IN_PROGRESS / COMPLETED states
- Permission matrix inspector (what can a member do?)
- Capability grants + delegated admin (read view; write paths
  partial)
- Org security policy: MFA-required, IP allowlist, domain
  allowlist, SSO-ready / SCIM-ready flags
- Identity timeline (SSO, SCIM, sessions, step-up, device events)
- SOC runtime monitor: high-risk sessions, quarantine, emergency
  org-wide revoke

**Enterprise SSO / SCIM:**
- Full SAML 2.0 SP (R8.2 compliance level)
- IdP metadata ingest + test connection
- Certificate rotation with zero-downtime next-cert slot
- Cert expiry warnings (30/60/90 day)
- IdP entity ID, NameID format display
- SCIM v2 Users + Groups (RFC 7644)
- SCIM token mgmt with IP allowlist
- JIT provisioning hooks
- SCIM-managed JIT suppression warning

**Compliance / observability:**
- Platform audit log with chain-of-custody verification
- Audit log CSV export
- Security events + file scans
- Demo request pipeline with routing

### What's still missing

**P0 — must-have for enterprise procurement:**
1. **List-my-sessions endpoint** (`GET /v1/users/me/sessions`).
   Self-revoke individual sessions. Backend gap. Phase 2.3 ships
   the "Sign out everywhere" affordance to compensate, but
   per-device visibility is a known table-stakes ask.
2. **Direct password change** (`POST /v1/users/me/password` with
   current password). Backend gap. Phase 2.3 uses the
   reset-by-email flow to compensate.
3. **Notification preferences** (per-event channel preferences).
   Backend gap — only delivery LOG exists.
4. **Account deletion + data export** for GDPR. Backend gap.

**P1 — visible polish for enterprise:**
5. AccessGate adoption on billing cancel actions, capture
   `TEAM_PLAN_REQUIRED`, evidence detail download statuscodes.
6. Avatar UPLOAD endpoint (currently URL field only).
7. SSO provider creation / config UI extensions for
   role-mapping rules.
8. Capability-grant + delegated-admin WRITE UI (read view exists).

**P2 — operator polish:**
9. Audit log surfaced in workspace-scoped admin (today only
   platform-admin sees it via `/admin/audit`).
10. Service-account / API-key audit drill-down per token.

### Competitive operational comparison

(Comparing capability + workflow, NOT visuals.)

| Capability | Stripe | Linear | Notion Enterprise | Atlassian | PROOVRA |
|---|---|---|---|---|---|
| MFA enroll/disable/recovery codes in account settings | ✓ | ✓ | ✓ | ✓ | **✓ (NEW Phase 2.3)** |
| Per-device session list | ✓ | ✓ | ✓ | ✓ | ✗ (backend gap) |
| Sign-out-everywhere | ✓ | ✓ | ✓ | ✓ | **✓ (NEW Phase 2.3)** |
| Password change (direct, with current pw) | ✓ | ✓ | ✓ | ✓ | ✗ (only reset-by-email) |
| Org MFA policy | ✓ | ✓ | ✓ | ✓ | ✓ (`/security-center`) |
| SAML SSO config UI | ✓ | ✓ | ✓ | ✓ | ✓ (`/security-center/sso`) |
| SCIM token mgmt | ✓ | ✓ | ✓ | ✓ | ✓ (`/admin/identity/scim`) |
| Access reviews | ✓ | partial | ✓ | ✓ | ✓ (`/admin/identity/access-reviews`) |
| Identity event timeline | ✓ | partial | ✓ | ✓ | ✓ (`/admin/identity/timeline`) |
| Audit log CSV export | ✓ | ✓ | ✓ | ✓ | ✓ (`/admin/audit`) |
| API keys + webhook mgmt | ✓ | ✓ | partial | ✓ | ✓ (`/integrations`) |
| Permission matrix inspector | ✗ | partial | partial | ✓ | ✓ (`/admin/identity/permission-matrix`) |
| Notification preferences | ✓ | ✓ | ✓ | ✓ | ✗ (backend gap) |
| Account deletion + data export | ✓ | ✓ | ✓ | ✓ | ✗ (backend gap) |
| Service-account creation | ✓ | ✓ | ✓ | ✓ | ✓ but partial UI |
| Chain-of-custody audit verification | ✗ | ✗ | ✗ | ✗ | ✓ unique to PROOVRA |
| Evidence integrity governance | ✗ | ✗ | ✗ | ✗ | ✓ unique to PROOVRA |

**Score (operational capability, not visuals):**
Before Phase 2.3 = 9.5 / 14 enterprise capabilities surfaced.
After Phase 2.3 = 11.5 / 14 enterprise capabilities surfaced.
The remaining 2.5 are backend gaps that must be added in a future
phase — they are NOT frontend gaps masquerading as backend gaps.

PROOVRA's unique advantages over the comparison set (chain-of-custody
audit verification, evidence integrity governance) are already
exposed and never weakened by Phase 2.3.

---

## Recommended next phase

### Phase 2.4 — Backend completion of user-facing security

The Phase 2.3 audit identifies four CONFIRMED backend gaps that
block full enterprise procurement. Each is a small, well-scoped
backend addition:

1. **`GET /v1/users/me/sessions`** — return the caller's active
   sessions (sessionIdHash, lastSeenAt, ipPrefix, userAgentSummary,
   currentSessionFlag). No PII beyond what the existing identity-
   security routes already expose to operators. Pair with a
   `DELETE /v1/users/me/sessions/:sessionIdHash` for per-device
   revoke.
2. **`POST /v1/users/me/password`** — accept `{ currentPassword,
   newPassword }`; verify current with the existing email-password
   service; reuse the password complexity service from the reset
   path; invalidate other sessions on success.
3. **Notification preferences** — `GET/PUT /v1/users/me/notification-preferences`
   with the per-event channel matrix the delivery log already
   honors.
4. **Account deletion + data export** — `POST /v1/users/me/delete-account`
   (with re-auth + step-up gate) and `POST /v1/users/me/export`
   that enqueues an async export job.

Each backend addition is paired with a frontend section in
AccountSecurityCard that REPLACES the "documented as missing" copy
with a real form. The frontend infrastructure is already in place,
so Phase 2.4 frontend work is purely UI integration.

### Phase 2.5 — Out-of-scope polish

After Phase 2.4, the remaining items are P1 polish:
- AccessGate adoption sweep finishes (billing, capture, evidence
  download)
- Service-account WRITE UI extensions
- Per-token audit drill-down
- Avatar upload endpoint
- Workspace-scoped audit log read for non-platform admins

None of these are enterprise procurement blockers; they are
operator-quality improvements.

---

## Out of scope (re-stated)

- No backend behavior change in Phase 2.3.
- No public-verify shape change.
- No Phase 1 rate-limit / PII-redaction rule weakened.
- No production data touched.
- No live-secrets used.
- No schema reproducibility regression.
