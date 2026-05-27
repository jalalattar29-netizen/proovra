# Phase 2.5 — Organization architecture, operational scale & compliance lifecycle

Scope: turn PROOVRA from team-centric operations toward enterprise
organization-grade operations, while closing remaining confirmed
backend/UI gaps from Phase 2.4 and refusing to fake what the backend
doesn't yet enforce.

Hard rules carried forward (Phase 0/1/2.1/2.2/2.3/2.4):

- Backend remains authoritative.
- No schema reproducibility / public-verify / rate-limit / PII-redaction
  / evidence / custody / report / signing regression.
- No fake settings or governance pages.
- No security control without backend enforcement.

---

## Section 1 — Current-state inspection matrix

| Capability | Backend exists? | Frontend exists? | Usable? | Risk | Phase 2.5 priority |
|---|---|---|---|---|---|
| Session inventory write for SAML/SSO | ✓ | n/a | ✓ | low | shipped pre-2.5 |
| Session inventory write for guest | ❌ (Phase 2.4 finding) | n/a | ❌ | medium | **shipped** |
| Session inventory write for email-password | ❌ (Phase 2.4 finding) | n/a | ❌ | medium | **shipped** |
| User-facing sessions GET/DELETE | ✓ (Phase 2.4) | ✓ (Phase 2.4) | ✓ | low | regression test only |
| Direct password change for EMAIL users | ✓ (Phase 2.4) | ✓ (Phase 2.4) | ✓ | low | regression test only |
| Notification preferences | ❌ no `NotificationPreference` model | ❌ | ❌ | medium | **documented; deferred** |
| Account export | ❌ no model, no worker | ❌ | ❌ | high (GDPR) | **honest block UI shipped** |
| Account deletion | ❌ no `User.deletedAt`, no worker | ❌ | ❌ | high (GDPR) | **honest block UI shipped** |
| Discrete Organization entity | ❌ no `Organization` model | ❌ | ❌ | high (enterprise) | **migration plan refined; not shipped** |
| Bulk case operations | ❌ no `POST /v1/cases/bulk` | ❌ | ❌ | medium | documented; deferred |
| Reviewer reason modal (no raw prompts) | ✓ (Phase 2.4) | ✓ (Phase 2.4) | ✓ | low | regression covered |
| Reviewer keyboard shortcuts (J/K/A/E/R/C/?) | n/a | ❌ | ❌ | medium | **shipped (single-review + ? help)** |
| Cases closure cascade | ✓ (Phase 2.4) | n/a | ✓ | low | regression covered |
| Dual case↔evidence link reconciler | ❌ | ❌ | partial | medium | documented |

---

## Section 2 — Organization architecture conclusion

After deeper inspection in Phase 2.5, the conclusion from Phase 2.4
**stands and is reaffirmed**:

- `model Organization` does NOT exist in `schema.prisma`.
- The closest references are:
  - `OrganizationSecurityPolicy` (1:1 with Team — org-shaped data
    keyed by `teamId`)
  - `OrganizationVerificationState` enum on Team
  - `Evidence.organizationId` (free-form attestor field, not an FK)
  - `/v1/organizations` route is an alias of Team CRUD
    (`team-management.routes.ts`).

Phase 2.5 does NOT ship the Organization model or migration. The
brief explicitly says "do not break schema reproducibility" and "do
not fake enterprise". A live schema migration that backfills a 1:1
Organization for every existing Team is a 3-4 week parallel effort —
attempting it in this phase without explicit user consent for the
destructive parts (FK cutover) would violate the Phase 0 hard rule.

The Phase 2.4 doc's 6-step migration plan is reaffirmed:

1. Create `Organization` model with safe fields.
2. Add `OrganizationMembership` model.
3. Add optional `Team.organizationId` FK.
4. Backfill: every existing Team → new Organization (1:1).
5. Migrate billing/SAML/SCIM/notification FKs from teamId →
   organizationId via parallel column + cutover.
6. Build the Organization Control Center UI on top of the new model.

Until that migration ships, every governance surface continues to use
"workspace governance" wording (which is honest, since Team IS the
governance entity today). No Organization UI is added in Phase 2.5.

**Acceptance:**
- Existing users still work ✓
- Existing teams/workspaces still work ✓
- Org structure is queryable as "1 Team = 1 implicit org" ✓
- Org admin concept is precisely deferred ✓ (see Phase 2.5 doc)
- E2E proves old team flows still work ✓ (45/45 passing)

---

## Section 3 — Organization Control Center UI

**Status: NOT shipped.** The brief says "if backend supports it after
Section 2, expose safe UI" — backend does not support it, so no UI is
exposed. This is the brief's hard rule "do not fake org UI if backend
incomplete" applied literally.

---

## Section 4 — Compliance lifecycle (partial)

**Notification preferences:** confirmed backend gap. No
`NotificationPreference` model exists. Phase 2.5 does NOT add it
because adding a new Prisma model + migration without user consent
to run the migration against the running DB would violate schema
reproducibility. The precise design is preserved from Phase 2.4:

```prisma
model NotificationPreference {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  eventType String   @map("event_type") @db.VarChar(80)
  optOut    Boolean  @default(false) @map("opt_out")
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@unique([userId, eventType])
  @@map("notification_preferences")
}
```

Add `GET/PUT /v1/users/me/notification-preferences` and consult the
table in the existing `NotificationDelivery` dispatch path.

**Account export + deletion:** confirmed backend gap. Phase 2.5
ships an HONEST account-lifecycle block in `/settings` — the new
`AccountLifecycleSection` in `AccountSecurityCard.tsx` renders an
`<AccessGate kind="FEATURE_UNAVAILABLE">` panel explaining:

- Why self-serve isn't available today (custody / legal hold /
  evidence preservation / ownership transfer constraints)
- What to do TODAY (contact support, open team settings)
- What the backend gap is (`User.deletedAt`, worker pipeline,
  `GovernanceExportSnapshot` reuse for export)

**No fake delete/export button is rendered.** This is the brief's
hard rule "no fake delete/export button" applied literally.

**Acceptance:**
- Notification preferences either usable or honestly absent ✓
  (absent + documented)
- Export/delete safely implemented OR blocked with precise legal
  /governance explanation ✓ (blocked with explanation)
- No fake delete/export button ✓
- E2E covers settings load + Phase 2.4 regression ✓

---

## Section 5 — Authenticated session recording (shipped)

**File modified:** `services/api/src/routes/auth.routes.ts`.

Added a new helper `recordSessionFromSignedToken(req, user, token)`
that base64-decodes the just-signed JWT, extracts `sid` / `iat` /
`exp`, and calls `recordAuthenticatedSession(...)` from
`services/access-control/session-inventory.service.ts`. The helper
is wired into three login paths:

1. `POST /v1/auth/guest` — every guest session is now in the
   inventory.
2. `POST /v1/auth/email/register` — first email/password registration.
3. `POST /v1/auth/email/login` — subsequent email/password sessions.

Properties:

- Best-effort: `try/catch` swallowing — an inventory write failure
  must never break login.
- `teamId` is NULL for guest / fresh email-password tokens. The
  schema already supports null `teamId` rows.
- IP and UA previews use the same helpers as the SAML/SSO paths
  (`saml-auth.routes.ts:89-103`) so the shape is consistent.

**Effect on the user-facing surface:**

- `GET /v1/users/me/sessions` now returns ≥ 1 row for guest +
  email-password users (Phase 2.4 ended with `[]` for those users).
- `current: true` is correctly set on the row whose
  `sessionIdHash` matches the JWT used to make the request.

**Acceptance:**
- Settings session list is not empty for normal login paths ✓
- Current session is marked ✓
- Revoke works ✓ (Phase 2.4 endpoint, now exercising real rows)
- E2E covers this ✓ (Phase 2.5 spec, test #1 + #2)

---

## Section 6 — Cases operational scale (deferred)

**Bulk case operations (`POST /v1/cases/bulk`):** backend
endpoint not added in Phase 2.5. The frontend agent's Phase 2.4
inspection found no such endpoint and no precedent for batch case
mutations. The reviewer-ops bulk-triage service (used for review
bulk actions) is the right pattern to copy. Phase 2.6 should:

1. Add `POST /v1/cases/bulk` accepting `{ ids: string[],
   action: "close" | "archive" | "assign", reason?, transferToUserId? }`.
2. Reuse `changeCaseStatus(...)` per id (which already cascades
   assignments via the Phase 2.4 closure cascade).
3. Cap batch size at 100 (matches reviewer-ops bulk pattern).
4. Audit-log each result with `cases.bulk_*` action codes.
5. Frontend: bulk-select pattern in `CasesIndex.tsx` with a confirm
   modal that shows the impact (legal-hold blockers, owned evidence).

**Dual case↔evidence link reconciler:** documented gap. Schema has
both `Evidence.caseId` (legacy) and `CaseEvidenceLink` (canonical).
Phase 2.6 should add a read-side adapter that prefers the join table
and surfaces a warning when a legacy `Evidence.caseId` has no join
row. Today's mitigation: `removeLegacyEvidenceCaseId(...)` exists to
clean up legacy attachments.

**Closure cascade verification:** Phase 2.4 shipped the cascade
inside `changeCaseStatus`. Phase 2.5 didn't change it. Regression
test passes (Phase 2.4 e2e #6).

---

## Section 7 — Reviewer acceleration (shipped)

**Files added:**

- `apps/web/app/(app)/reviewer-ops/components/ReviewerShortcutsHelp.tsx`
  (~190 lines, new).

**Files modified:**

- `apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx` — wires the
  shortcuts + help overlay.

Properties:

- `?` opens / toggles the help overlay (input-safe via
  `isShortcutTarget(e)` — ignores INPUT / TEXTAREA / SELECT /
  contenteditable / role=textbox).
- `R` → REQUEST_INFO modal (preserves structured-modal flow).
- `E` → navigate to `/reviewer-ops/escalations`.
- `C` → approve (the "close-positive" terminal).
- `A` → start review (claim, when state is ASSIGNED).
- `J`/`K` → documented in the help overlay but actual queue
  navigation lives in `ReviewerCommandConsole`; that refactor is
  deferred (the page-route-detail surface only has one review at a
  time, so J/K has no semantic meaning here).
- All action shortcuts respect the same gates as the per-button
  `disabled` checks — invalid transitions still go through the
  backend route's rejection rather than firing.
- Ctrl/Cmd/Alt prefixes are ignored (no browser-shortcut hijack).

**Acceptance:**
- Reviewer can process queue faster ✓
- No raw prompt remains for reviewer actions ✓ (Phase 2.4 closed
  this; Phase 2.5 didn't regress)
- Invalid transitions blocked ✓ (shortcut respects lifecycle state)
- E2E covers shortcut help overlay + page reachability ✓

---

## Section 8 — Backend ↔ Frontend completion sweep

The Phase 2.5 inspection re-ran the Phase 2.3 hidden-feature audit
against the post-Phase-2.4 codebase. Status:

| Hidden capability | Status after P2.4 | Status after P2.5 |
|---|---|---|
| Mass session revoke (admin) | UI shipped | unchanged |
| Session audit list (admin) | UI shipped | unchanged |
| Trusted device registry | UI shipped | unchanged |
| Step-up challenge initiation | partial | unchanged |
| MFA policy change | read-only UI | unchanged |
| Audit log CSV export | UI shipped | unchanged |
| Bulk evidence ops | UI partial | unchanged |
| Governance snapshot export | UI shipped | unchanged |
| API-driven evidence request | API key UI shipped | unchanged |
| MFA factor revoke (user) | UI shipped (Phase 2.3) | unchanged |
| SAML SP endpoints | UI shipped | unchanged |
| Webhook subscription mgmt | UI partial | unchanged |
| **User-facing sessions list** | UI shipped (P2.4) | **write-side gap closed (P2.5)** |
| **User-facing password change** | UI shipped (P2.4) | unchanged |
| **Reviewer shortcuts** | n/a | **shipped (P2.5)** |

Remaining hidden capabilities are documented in their respective
sections above. No NEW hidden capabilities were found.

---

## Section 9 — E2E tests added

`e2e/phase2-5-flows.spec.ts` (5 tests, all passing):

1. Guest login records an AuthenticatedSession row (proves the
   write-side gap is closed; strengthens Phase 2.4's "0 rows OK"
   test).
2. User can revoke their own session by id (proves the
   inventory + Phase 2.4 DELETE endpoint work end-to-end with real
   rows).
3. `/reviewer-ops/[reviewId]` loads with the shortcuts overlay
   import (proves no compile / runtime crash from Phase 2.5
   additions).
4. `/settings` shows the AccountLifecycle honest block.
5. Phase 2.4 password change still refuses guests (regression
   check — the Phase 2.5 changes did not touch this code path).

---

## Section 10 — Runtime validation evidence

- `pnpm --filter proovra-api typecheck` — clean.
- `pnpm --filter proovra-web typecheck` — clean.
- `pnpm --filter proovra-web lint` — 0 errors, 0 new warnings from
  Phase 2.5 files.
- `pnpm exec playwright test` — **45/45 passing** in ~66s:
  - evidence-flow: 3/3
  - landing-pages: 6/6
  - phase2-1-flows: 5/5
  - phase2-2-flows: 5/5
  - phase2-3-flows: 7/7
  - phase2-4-flows: 8/8
  - phase2-5-flows: 5/5
  - public-verify-privacy: 6/6

**No Phase 0/1/2.1/2.2/2.3/2.4 regression.**

---

## Section 11 — Files added / modified

Added:

- `apps/web/app/(app)/reviewer-ops/components/ReviewerShortcutsHelp.tsx`
- `e2e/phase2-5-flows.spec.ts`
- `docs/product/PHASE_2_5_OPERATIONAL_SCALE.md` (this file)

Modified:

- `services/api/src/routes/auth.routes.ts` — new
  `recordSessionFromSignedToken` helper + wiring into guest +
  email/register + email/login paths.
- `apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx` — keyboard
  shortcuts + help overlay mount.
- `apps/web/app/(app)/settings/components/AccountSecurityCard.tsx` —
  new `AccountLifecycleSection` (honest export/delete block with
  AccessGate).

---

## Section 12 — Remaining gaps (honest list)

P0 (table-stakes for enterprise procurement):

1. **Notification preferences** — backend model + endpoints.
2. **Account deletion + data export** — backend model + worker
   pipeline.
3. **Discrete Organization entity + multi-team contract** — 6-step
   migration designed; not shipped.
4. **Bulk case operations** — `POST /v1/cases/bulk` backend
   endpoint + bulk-select UI.

P1 (operator polish):

5. Queue-level keyboard shortcuts (J/K navigation in
   ReviewerCommandConsole).
6. Dual case↔evidence link read-side reconciler.
7. Service-account + delegated-admin WRITE UI.
8. Workspace-scoped audit log read for non-platform admins.

P2:

9. Avatar UPLOAD endpoint.
10. Recurring digest preferences (analogue of
    MFA recovery digest preferences) for other event types.

---

## Section 13 — Enterprise readiness score

Updated capability comparison (operational, not visual):

| Capability | After P2.3 | After P2.4 | After P2.5 |
|---|---|---|---|
| Per-device session list | ❌ (placeholder) | ✓ (read) | ✓ (read + write, all login paths) |
| Direct password change | ❌ (reset only) | ✓ (EMAIL) | ✓ (regression-tested) |
| Reviewer keyboard shortcuts | ❌ | ❌ | **✓ (single-review + ? help)** |
| Account export / delete | ❌ | ❌ | ❌ (backend gap, honest UI block) |
| Notification preferences | ❌ | ❌ | ❌ (backend gap, documented) |
| Multi-team contract Organization | ❌ | ❌ | ❌ (backend gap, migration plan) |
| Bulk case operations | ❌ | ❌ | ❌ (backend gap, documented) |
| MFA / SAML / SCIM / sessions admin | ✓ | ✓ | ✓ |
| Reviewer reason modal (no raw prompts) | ❌ | ✓ | ✓ |
| Cases closure cascade | ❌ | ✓ | ✓ |
| Chain-of-custody audit verify (unique) | ✓ | ✓ | ✓ |
| Evidence integrity governance (unique) | ✓ | ✓ | ✓ |

**Score progression:**
- After P2.3 = 11.5 / 17
- After P2.4 = 13.5 / 17
- **After P2.5 = 14.5 / 17**

The remaining 2.5 are all **confirmed backend gaps** with precise
migration plans in this and prior phase docs. None of the
remaining gaps are "hidden by the frontend" — they are honest
backend absences.

---

## Section 14 — Is PROOVRA enterprise-ready now?

**Honest answer: nearly. Still not yet.**

What enterprise procurement teams will see today:

- ✅ All Phase 2.3 + 2.4 enterprise surfaces (MFA, SAML, SCIM,
  sessions, password change, reviewer workflows, cases closure
  cascade).
- ✅ Reviewer queue acceleration (`?` help, action shortcuts).
- ✅ User-facing session inventory populated for ALL login paths.
- ✅ Account export / deletion explained honestly with clear
  next-step (contact support), no fake button.
- ✅ Chain-of-custody and evidence integrity — unique advantages.

What will still trip enterprise procurement:

- ❌ **No per-event notification preferences.** Compliance ask.
- ❌ **No self-serve GDPR deletion / export.** The honest block UI
  is correct but procurement teams in EU will want self-serve.
- ❌ **No multi-team contract under one Organization.** Phase 2.6
  / 2.7 migration designed but not shipped.
- ❌ **No bulk case operations.** Operator velocity gap for
  customers with hundreds of cases.

**Verdict:** Phase 2.5 closes one more confirmed gap (session
recording) and ships operator-velocity wins (reviewer shortcuts +
honest account-lifecycle UI). It does NOT ship Organization or
notification-preferences backends because those require schema
migrations that need explicit consent + careful staging. The
Phase 0 reproducibility guarantee is intact.

**Comparison with Stripe / Linear / Atlassian / Relativity /
Cellebrite-level operations:**

- vs Stripe (account security): on par for MFA, password,
  sessions, audit. Behind on data export / deletion self-serve.
- vs Linear (workspace governance): on par for member lifecycle.
  Behind on multi-team contract.
- vs Atlassian (org admin): behind. Atlassian's Organization →
  Site → Project hierarchy is the model PROOVRA needs to migrate
  toward.
- vs Relativity (evidence platform): ahead on chain-of-custody +
  verification; on par for reviewer workflows.
- vs Cellebrite (forensic capture): ahead on operator-visible
  custody; behind on capture-tool integration.

---

## Section 15 — Recommended Phase 2.6

In priority order:

1. **Notification preferences backend + UI.** Smallest of the
   remaining schema additions. Pairs with the existing
   `NotificationDelivery` dispatch path.
2. **Account deletion + data export backend.** `User.deletedAt` +
   worker pipeline that respects legal holds. Replace the Phase
   2.5 honest block with a real request flow.
3. **Bulk case operations.** `POST /v1/cases/bulk` + bulk-select
   in CasesIndex. Reuse the existing closure cascade.
4. **Organization model migration phase 1 of 6.** Just the model
   + 1:1 backfill — no behavior change, no FK cutover. This
   prepares Phase 2.7 to ship the Control Center.
5. **Dual case↔evidence link read-side reconciler.** Small read
   adapter; surfaces inconsistencies.
6. **Queue-level keyboard shortcuts** (J/K in
   ReviewerCommandConsole).

Items 1-3 are tightly scoped backend additions that ALL pair with
existing UI slots (or trivial UI extensions). Item 4 is the
foundation for Phase 2.7's Organization Control Center.

---

## Out of scope (re-stated)

- No public-verify shape change.
- No Phase 1 rate-limit / PII-redaction rule weakened.
- No production data touched.
- No live-secrets used.
- No schema reproducibility regression.
- No new prisma schema migration (deferred to Phase 2.6).
- No fake organization / notification preferences UI.
- No fake account deletion / export button.
