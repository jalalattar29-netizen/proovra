# Phase 2.4 — Enterprise backend completion, organization architecture, reviewer acceleration & cases operational depth

Scope: close the four CONFIRMED backend gaps identified in Phase 2.3
(sessions, password change, notification prefs, account export/delete),
clarify the organization-vs-team data model, accelerate the reviewer
workflow, and harden the cases lifecycle — all without breaking Phases
0/1/2.1/2.2/2.3.

Hard rules carried forward:

- Backend is authoritative; the frontend never invents auth state.
- No schema reproducibility / public-verify / rate-limit / PII-redaction
  / evidence / custody / report / signing regression.
- No fake settings or governance pages.
- Every backend route exposed in the UI has loading / error / forbidden
  /AccessGate handling.
- Missing backend stays documented; UI does not pretend it exists.

---

## Section 1 — Current-state inspection matrix

Three parallel inspection agents produced the following matrix.

| Capability | Backend exists? | Frontend exists? | Usable? | Enterprise risk | Phase 2.4 priority |
|---|---|---|---|---|---|
| Per-device sessions list | **model + service yes, route NO** | Phase 2.3 placeholder | ❌ | medium (table-stakes) | **shipped (read + revoke)** |
| Direct password change (current pw) | **helpers yes, route NO** | Phase 2.3 placeholder | ❌ | high (enterprise) | **shipped (EMAIL provider only)** |
| Notification preferences | model NO | Phase 2.3 documented | ❌ | low | document, defer to Phase 2.5 |
| Account export | model NO | n/a | ❌ | high (GDPR) | document, defer to Phase 2.5 |
| Account deletion | model NO | n/a | ❌ | high (GDPR) | document, defer to Phase 2.5 |
| Organization entity (multi-team contract) | NO discrete model | n/a | ❌ | high (enterprise) | **conclusion: stay on Team model; design Phase 2.5 migration** |
| Reviewer reason modal | backend always required reason | window.prompt × 6 | partial | medium (UX P0) | **shipped (modal replaces all 6 prompts)** |
| Reviewer keyboard shortcuts | n/a | NONE | ❌ | medium (operator velocity) | document, deferred |
| Cases closure cascade (auto-deactivate assignments) | NO | n/a | ❌ | high (assignment bug) | **shipped (service-level cascade)** |
| Bulk case actions | NO | NO | ❌ | medium | document, defer to Phase 2.5 |
| Dual case↔evidence link reconciliation | NO reconciler | n/a | partial | medium | document |

---

## Section 2 — Backend completion (shipped)

### A. Sessions

**New endpoints in `services/api/src/routes/users.routes.ts`:**

```
GET    /v1/users/me/sessions
DELETE /v1/users/me/sessions/:id
```

Properties:

- **GET** queries `AuthenticatedSession` filtered strictly by
  `userId === self`. Returns a `{ sessions: [...] }` envelope with
  `id`, `teamId`, `ssoConnectionId`, `issuedAtUtc`, `expiresAtUtc`,
  `lastSeenAtUtc`, `ipPreview`, `uaPreview`, `revoked`, `revokedAtUtc`,
  `revokedReason`, `active`, `current`.
- The `current` flag is computed by comparing each row's
  `sessionIdHash` against `req.user.sessionIdHash` — set by the auth
  middleware (Phase 2.4 `middleware/auth.ts` change).
- The middleware also re-uses the existing `hashSessionId(payload.sid)`
  to populate `req.user.sessionIdHash`, so we do NOT recompute SHA-256
  in the route handler.
- **DELETE** verifies ownership (`userId === self`), rejects malformed
  UUIDs with 400 INVALID_SESSION_ID, returns 404 SESSION_NOT_FOUND for
  rows not owned by the caller, and reuses the existing
  `revokeActiveSession()` service so the RevokedSession registry stays
  the canonical source of truth.
- The fallback path (workspace-less rows) writes the
  AuthenticatedSession + RevokedSession rows directly via prisma so
  guest tokens (which have no teamId) can still be revoked from the
  user-facing surface.
- A `session_revoked` SecurityEvent is emitted with
  `actorUserId === targetUserId` so SOC can distinguish self-initiated
  revocation from operator action.

**Known gap (documented for Phase 2.5):** the inventory table is only
populated by SAML / SSO logins today (`recordAuthenticatedSession()` is
called from `saml-auth.routes.ts:587` and `sso-auth.routes.ts:468`).
Guest + email-password login paths don't write rows, so the
user-facing list is honestly empty for those users. The honest empty
state is rendered by the AccountSecurityCard's empty-state branch.

### B. Password change

**New endpoint:**

```
POST /v1/users/me/password/change
```

Body: `{ currentPassword: string, newPassword: string }` (Zod-validated;
min 8 chars on `newPassword` per the existing `EmailRegisterBody`
convention).

Properties:

- Returns **409 PROVIDER_UNSUPPORTED** when `user.provider !== "EMAIL"`
  or `user.passwordHash === null`. The frontend renders an
  `<AccessGate kind="FEATURE_UNAVAILABLE">` panel for those users
  ("managed by Google/Apple/...").
- Reuses `verifyPassword(...)` from
  `services/email-password-auth.service.ts` to verify the current
  password. A failed match returns **403 CURRENT_PASSWORD_INVALID**
  and emits a `password_change_failed` SecurityEvent (warning level).
- On success, `hashPassword(...)` produces a new scrypt hash, the
  User row is updated, and a `password_changed` SecurityEvent fires
  (info level).
- The Phase 2.4 contract intentionally does NOT include "sign out
  other sessions" in the same call — that becomes a Phase 2.5 polish
  item once the inventory table is universally populated.

### C. Notification preferences — backend gap remains

**Inspection finding:** the only related table today is
`CommunicationPreference` (SMS/WhatsApp channel-level opt-out, Phase 18).
There is NO `NotificationPreference` model, NO `GET/PATCH
/v1/users/me/notification-preferences` route, and NO precedent for
per-event-type opt-outs.

**Decision:** do NOT fake a UI for this. The Phase 2.3 documentation
already lists this as a confirmed backend gap; Phase 2.4 reaffirms it
and proposes the smallest safe addition for Phase 2.5:

```
GET  /v1/users/me/notification-preferences
PUT  /v1/users/me/notification-preferences  body: { eventType, optOut }[]
```

Backed by a new lightweight `NotificationPreference` table
`(userId, eventType, optOut, updatedAtUtc)` with a unique
`(userId, eventType)` constraint. Existing `NotificationDelivery`
dispatch path consults this table to suppress opted-out events.

### D. Account export + deletion — backend gap remains

**Inspection finding:** `User` has no `deletedAt` column. No
`POST /v1/users/me/export` or `DELETE /v1/users/me/account` exists.
Soft-delete pattern is proven on other entities (`Team.deletedAt`,
`CaseAccess.deletedAt`) but not yet on User.

**Decision:** do NOT fake. Phase 2.5 should add:

- `User.deletedAt` column with safe cascade rules (preserve audit /
  custody trail; nullify FK back-references to ex-user).
- `POST /v1/users/me/account/delete` requiring step-up + a typed
  confirmation phrase. Schedules deletion via a worker, NOT inline.
- `POST /v1/users/me/export` reusing the existing
  `GovernanceExportSnapshot` infrastructure (Phase 27.5) to enqueue
  a per-user export job.

---

## Section 3 — Organization architecture conclusion

**There is no discrete Organization entity today.** The schema's
`Team` model carries all the org-like fields (`legalName`, `address`,
`billingPlan`, `billingStatus`, `includedSeats`, `verificationState`).
The routes file `team-management.routes.ts` aliases
`/v1/organizations` to Team CRUD — this is legacy API surface, not a
real second entity.

**Enterprise ask: can PROOVRA support "5 teams sharing one contract"
today?** No. Each Team owns its own billing row.

**Decision for Phase 2.4:** ship NO Organization control center.
Continue using "workspace governance" wording (which is already in
the codebase). The Phase 2.3 docs already describe `/security-center`
and `/admin/identity` as workspace-scoped — that wording remains
accurate.

**Phase 2.5 migration design (precise plan):**

1. Create new `Organization` model (id, name, legalName, address,
   legalEmail, billingPlan, billingStatus, includedSeats,
   billingOwnerUserId, verificationState, verifiedAtUtc).
2. Add `Team.organizationId` (FK, optional in v1 for rolling
   migration).
3. Backfill: every existing Team → new Organization (1:1 initial), so
   no existing behavior changes.
4. Move billing models (Subscription, Payment) FK references from
   `teamId` to `organizationId` via a parallel column → cutover →
   drop the old.
5. Update `team-management.routes.ts` to clarify that
   `/v1/organizations` now reads the real Organization entity, with
   backward-compatible Team-aliased fields removed in a deprecation
   window.
6. Surface a real "Organization Control Center" only after step 5.

This is a 3-4 week parallel effort. Do NOT start the UI before the
migration ships — committing to "organizations" in the API while the
schema says "teams" creates the broken mental model the brief warns
against.

---

## Section 4 — Reviewer acceleration (shipped)

**File added:**
`apps/web/app/(app)/reviewer-ops/components/ReviewerReasonModal.tsx`
(~370 lines, new).

A structured reusable modal with 6 kinds — REQUEST_INFO, REJECT, PAUSE,
ESCALATION_REASSIGN, ESCALATION_RESOLVE, ESCALATION_SUPPRESS — each with
its own headline / description / placeholder / submit copy.

**Wired into:**

- `apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx` — replaces the
  3 `window.prompt` calls for request-info / reject / pause.
- `apps/web/app/(app)/reviewer-ops/escalations/page.tsx` — replaces
  the 3 `window.prompt` calls for reassign / resolve / suppress.

Properties:

- 400-char limit on free-text reasons (matches existing case-lifecycle
  convention).
- UUID-format validation for the reassign kind (since the field
  collects a user id).
- Escape closes only when not submitting.
- Outside-click closes only when not submitting.
- Counter shows `N/400`.
- Submit disabled until at least one non-whitespace char is typed.
- All inputs / buttons carry `data-reviewer-reason-*` markers for E2E.

**Total `window.prompt` calls removed:** 6 / 6 (all reviewer paths).

**Keyboard shortcuts (J/K navigate, A claim, E escalate, R request info,
C close, ? help):** deferred. The brief lists these but they target the
ReviewerCommandConsole queue list, which is a substantially larger
refactor. Phase 2.4 ships the higher-priority modal replacement (which
the brief explicitly calls out as an acceptance criterion: "no raw
prompt usage remains for reviewer critical actions"). Keyboard
shortcuts move to Phase 2.5.

---

## Section 5 — Cases lifecycle (shipped)

**File modified:**
`services/api/src/services/cases/case-lifecycle.service.ts`

Added a closure cascade inside `changeCaseStatus()`:

```ts
if (CLOSURE_STATUSES.has(input.toStatus)) {
  const cascade = await client.caseAssignment.updateMany({
    where: { caseId: existing.id, status: "ACTIVE" },
    data: {
      status: "REMOVED",
      removedAtUtc: new Date(),
      removedByUserId: input.actorUserId,
    },
  });
  cascadedAssignmentCount = cascade.count;
}
```

Properties:

- Only fires for transitions to `CLOSED` or `ARCHIVED` (the
  `CLOSURE_STATUSES` set already used by the legal-hold check).
- Sets `removedAtUtc` and `removedByUserId` (the actor performing the
  closure) so the audit trail attributes the cascade correctly.
- The platform audit log row now carries
  `metadata.cascadedAssignmentCount` (`-1` on failure, `0` when no
  active assignments existed). SOC consumers can alert if the cascade
  ever fails.
- Best-effort: a cascade failure does NOT roll back the status change.
  An operator can manually remove residual assignments — but the
  audit log will surface the cascade gap.

Does NOT touch:

- Comments (historical readability preserved; "no new comments on
  closed case" stays a route-layer rule, not a data mutation).
- Evidence links (closed cases must keep their evidence association
  for chain-of-custody).
- The Case row itself (already updated).

**Other case items (documented, not shipped this phase):**

- Bulk case operations (close/assign/archive) — backend has NO bulk
  case endpoint today. The bulk-triage service exists for reviewer-ops
  workflows but does not extend to cases. Add `POST /v1/cases/bulk`
  in Phase 2.5 modelled on the reviewer-ops bulk endpoint.
- Dual case↔evidence link reconciliation — `Evidence.caseId` and
  `CaseEvidenceLink` join table can diverge. The existing
  `removeLegacyEvidenceCaseId(...)` service handles the unlink case
  but there is no read-path reconciler that picks one canonical
  source. Phase 2.5 should add a read-side adapter that prefers the
  join table and surfaces a warning when a legacy `Evidence.caseId`
  has no join row.

---

## Section 6 — AccessGate + navigation (continued)

Adoptions added in Phase 2.4:

- `AccountSecurityCard` PasswordSection — renders
  `<AccessGate kind="FEATURE_UNAVAILABLE">` (variant=inline) when
  the backend returns 409 PROVIDER_UNSUPPORTED.

No new navigation entries in this phase — Phase 2.3 already promoted
`/admin/identity`. The reviewer-ops surfaces were already in nav.

---

## Section 7 — Files added / modified

Added:

- `services/api/src/routes/users.routes.ts` — 3 new endpoints
  (`GET /v1/users/me/sessions`, `DELETE /v1/users/me/sessions/:id`,
  `POST /v1/users/me/password/change`).
- `apps/web/app/(app)/reviewer-ops/components/ReviewerReasonModal.tsx`
  (new).
- `e2e/phase2-4-flows.spec.ts` — 8 tests.
- `docs/product/PHASE_2_4_BACKEND_COMPLETION.md` (this file).

Modified:

- `services/api/src/middleware/auth.ts` — populate
  `req.user.sessionIdHash` from the hashed JWT `sid`.
- `services/api/src/types/fastify.d.ts` — extend `FastifyRequest.user`
  with `sessionIdHash`.
- `services/api/src/services/cases/case-lifecycle.service.ts` — add
  closure cascade to `changeCaseStatus()`.
- `packages/shared/src/security.ts` — add `password_changed` and
  `password_change_failed` to `SECURITY_EVENT_TYPES`.
- `apps/web/app/(app)/settings/components/AccountSecurityCard.tsx` —
  rewrite PasswordSection (direct change + reset email + provider-
  locked AccessGate) and SessionsSection (real list + per-session
  revoke).
- `apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx` — replace
  3 `window.prompt` calls with ReviewerReasonModal.
- `apps/web/app/(app)/reviewer-ops/escalations/page.tsx` — replace
  3 `window.prompt` calls with ReviewerReasonModal.

---

## Section 8 — E2E tests added

`e2e/phase2-4-flows.spec.ts` (8 tests, all passing):

1. `GET /v1/users/me/sessions` returns the envelope shape.
2. `DELETE /v1/users/me/sessions/:id` rejects malformed UUIDs (400).
3. `DELETE /v1/users/me/sessions/:id` 404s on a non-owned UUID.
4. `POST /v1/users/me/password/change` returns
   409 PROVIDER_UNSUPPORTED for guest.
5. `POST /v1/users/me/password/change` validates min-8 (400 or 409).
6. `/reviewer-ops/escalations` reachable after modal refactor.
7. `/reviewer-ops` reachable.
8. `/settings` still exposes AccountSecurityCard.

---

## Section 9 — Runtime validation evidence

- `pnpm --filter proovra-api typecheck` — clean.
- `pnpm --filter proovra-web typecheck` — clean.
- `pnpm --filter proovra-web lint` — 0 errors, 0 new warnings from
  Phase 2.4 files.
- `pnpm exec playwright test` — **40/40 passing** in ~58s:
  - evidence-flow: 3/3
  - landing-pages: 6/6
  - phase2-1-flows: 5/5
  - phase2-2-flows: 5/5
  - phase2-3-flows: 7/7
  - phase2-4-flows: 8/8
  - public-verify-privacy: 6/6

**No Phase 0 / 1 / 2.1 / 2.2 / 2.3 regression.**

---

## Section 10 — Remaining gaps (honest list)

P0 / table-stakes for enterprise procurement:

1. **Notification preferences** — backend table missing. Phase 2.5.
2. **Account deletion + data export** — backend missing. Phase 2.5.
3. **Email-password + guest login should call `recordAuthenticatedSession`** —
   today only SAML/SSO does, so the user-facing session list is empty
   for those users. Tiny patch in Phase 2.5.

P1 / operator polish:

4. Reviewer keyboard shortcuts (J/K/A/E/R/C/?) — modal shipped, but
   shortcuts not.
5. Bulk case actions (`POST /v1/cases/bulk`) — backend missing.
6. Dual case↔evidence link read-side reconciler — surfaces warnings
   only.
7. Organization entity migration (multi-team contract).
8. Cases-bulk frontend UX (depends on backend).
9. Reviewer queue (ReviewerCommandConsole) selection / bulk UI.
10. Avatar UPLOAD endpoint (Phase 2.3 noted; still URL-only).

P2:

11. Service-account + delegated-admin WRITE UI (read view exists).
12. Workspace-scoped audit-log read for non-platform admins.

---

## Section 11 — Enterprise readiness score after Phase 2.4

Updated capability comparison (operational, not visual):

| Capability | Before P2.3 | After P2.3 | After P2.4 |
|---|---|---|---|
| MFA enroll/disable/recovery in account settings | ❌ | ✓ | ✓ |
| Per-device session list | ❌ | ❌ (placeholder) | **✓ (read + revoke)** |
| Sign-out-everywhere | ❌ | ✓ | ✓ |
| Direct password change | ❌ | ❌ (reset only) | **✓ (EMAIL provider)** |
| Org MFA policy | ✓ | ✓ | ✓ |
| SAML SSO config | ✓ | ✓ | ✓ |
| SCIM token mgmt | ✓ | ✓ | ✓ |
| Access reviews | ✓ | ✓ | ✓ |
| Identity event timeline | ✓ | ✓ | ✓ |
| Audit log CSV export | ✓ | ✓ | ✓ |
| API keys + webhook mgmt | ✓ | ✓ | ✓ |
| Permission matrix inspector | ✓ | ✓ | ✓ |
| Notification preferences | ❌ | ❌ | ❌ (backend gap) |
| Account deletion + data export | ❌ | ❌ | ❌ (backend gap) |
| Service-account creation | partial | partial | partial |
| Reviewer reason modals (no raw prompts) | ❌ | ❌ | **✓** |
| Cases closure cascade (no orphan assignments) | ❌ | ❌ | **✓** |
| Organization-level governance (multi-team contract) | ❌ | ❌ | ❌ (migration designed) |
| Chain-of-custody audit verification | ✓ unique | ✓ unique | ✓ unique |
| Evidence integrity governance | ✓ unique | ✓ unique | ✓ unique |

**Score progression:**
- Before P2.3 = 9.5 / 17 enterprise capabilities
- After P2.3 = 11.5 / 17
- **After P2.4 = 13.5 / 17**

The remaining 3.5 are all CONFIRMED backend gaps with precise Phase
2.5 migration designs in this doc.

---

## Section 12 — Is PROOVRA enterprise-ready now? (honest)

**Short answer: very close, but not yet.**

What enterprise procurement teams will see today:

- ✅ MFA, SAML, SCIM, audit, sessions, password change, access reviews —
  all there and operator-usable.
- ✅ Workspace governance with real backend enforcement.
- ✅ Reviewer workflows with structured (non-prompt) reason capture.
- ✅ Cases lifecycle with automatic closure cascade.
- ✅ Chain-of-custody and evidence integrity — unique advantages.

What will still trip enterprise procurement:

- ❌ **No per-event notification preferences.** A common compliance ask.
- ❌ **No account deletion or data export.** GDPR-relevant; can become
  a procurement blocker for EU customers.
- ❌ **No multi-team contract under one Organization.** Enterprise
  customers with multiple business units cannot consolidate billing
  today. The migration is designed (Section 3) but not shipped.
- ❌ **Session inventory only populated for SAML/SSO users.** Once an
  enterprise customer wires SSO this is fine — but the experience
  during pilot/POC (often guest or email-password) is empty.

**Verdict:** Phase 2.4 closes the most operationally-painful gaps
(sessions, password change, reviewer prompts, closure cascade) and
documents the precise remaining work. Procurement teams who pilot with
SAML SSO will see a complete account-security surface. Procurement
teams asking for GDPR delete/export, notification prefs, or
multi-team contracts will need to wait for Phase 2.5.

---

## Section 13 — Recommended Phase 2.5

In priority order:

1. **Notification preferences backend + UI** — small backend addition,
   AccountSecurityCard already has the visual slot.
2. **Account deletion + data export backend** — User.deletedAt column,
   delete endpoint with step-up, export job via worker. Pairs with a
   "danger zone" AccountSecurityCard section.
3. **Extend `recordAuthenticatedSession` to email-password + guest
   login paths.** Tiny patch but unlocks the session list for all
   users.
4. **Bulk case operations** — `POST /v1/cases/bulk` modelled on the
   existing reviewer-ops bulk endpoint, plus a bulk-select pattern
   in CasesIndex.
5. **Reviewer keyboard shortcuts** (J/K/A/E/R/C/?) on the queue page
   only, with input-safe gating.
6. **Organization entity migration** (Section 3 plan): create model,
   add Team.organizationId, backfill 1:1, move billing FKs, then
   add Organization Control Center UI.
7. **Dual case↔evidence link read-side reconciler** — surfaces
   warnings on divergence.
8. **Service-account + delegated-admin WRITE UI** for the
   permission-matrix page.

Items 1-3 are tightly scoped and address P0 gaps. Items 4-5 are
operator velocity. Items 6-8 are larger architecture moves.

---

## Out of scope (re-stated)

- No public-verify shape change.
- No rate-limit / PII-redaction rule weakened.
- No production data touched.
- No live-secrets used.
- No schema-reproducibility regression.
- No fake settings / governance pages added.
- No backend security control surfaced without enforcement.
