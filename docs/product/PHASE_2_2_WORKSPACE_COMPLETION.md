# Phase 2.2 — Workspace completion, gates, and hidden-feature inventory

Scope: complete the operator-UX gaps surfaced by the Phase 2.1 read-only
audit and document the backend capabilities that exist but are not yet
surfaced in the UI. No backend behavior changes in this phase — only
frontend additions and audit documentation.

Hard rules carried forward from Phase 0 / 1 / 2.1:

- Backend remains authoritative. The frontend does not invent
  permissions, does not bypass trust checks, and does not weaken any
  public-verify Phase 1 protection.
- No PII surfaced that public verify redacts.
- No destructive action without confirmation.
- No orphaning evidence or cases.
- No fake placeholders or fabricated readiness.

---

## Section 1 — In-app verify workspace

**Status:** shipped.

**File:** `apps/web/app/(app)/verify/page.tsx` (~470 lines, new).

Authenticated operators previously had no way to inspect a record's
verification state from inside the workspace; they had to leave the app
and use the public `/verify/[token]` surface, which is intentionally
PII-redacted (Phase 1). The new in-app verify page closes that gap.

Properties:

- Uses `GET /v1/evidence/:id/review-workspace` (authenticated,
  workspace-scoped) — never the public endpoint.
- Surfaces an explicit "Open public verify ↗" button and "Copy public
  link" — but only when `evidence.publicVerifyState === "PUBLISHED"`.
  When the record is not published, the page states that fact plainly
  ("This record is not currently published to public verify… the
  public verify URL would return 404 — that's by design") instead of
  rendering a broken or misleading button.
- Wrapped in `<PageRouteGate routeId="workspace.evidence">` so route
  discoverability follows the same capability gating as evidence
  detail.
- Distinct error states for 401 / 403 / 404 / 503. The 503 message
  ("Verification is temporarily unavailable. Operations have been
  notified.") reuses Phase 1's operational-alert language.

---

## Section 2 — Team offboarding transfer dialog

**Status:** shipped.

**Files:**

- `apps/web/app/(app)/teams/[id]/components/MemberRemovalDialog.tsx`
  (new).
- `apps/web/app/(app)/teams/[id]/page.tsx` (wiring change).

The Phase 2.1 backend already enforced the orphan-safety rule
(`GET /v1/teams/:id/members/:memberId/removal-impact` + `DELETE …` with
`transferToUserId`). The UI was still using `window.confirm(…)` which
gave operators no idea what they were about to delete. This is the
remaining frontend half of P2.1-S3.

Properties:

- Loads removal impact on open and renders three stat tiles: evidence
  owned, cases owned, open assignments. Tiles tinted when non-zero so
  the operator sees the magnitude before clicking Remove.
- When the backend reports `requiresTransfer: true`:
  - If `eligibleTransferTargets.length > 0`, requires the operator to
    pick a target ADMIN/OWNER from a `<select>` before "Remove member"
    is enabled.
  - If `eligibleTransferTargets.length === 0`, renders an explicit
    block panel: "Removal blocked — no eligible transfer target.
    Promote another member to ADMIN first, then re-open this dialog."
- Submits `DELETE /v1/teams/:id/members/:memberId` with the body
  `{ transferToUserId }` so the re-assignment happens atomically with
  the removal (backend guarantee from Phase 2.1).
- Surfaces backend `code` values verbatim:
  - `TRANSFER_TARGET_REQUIRED` → "This member still owns active
    records. Pick a transfer target above before removing."
  - `INVALID_TRANSFER_TARGET` → "That transfer target isn't eligible
    anymore — refresh and try again."
- Modal blocks `Escape` and outside-click while submitting so an
  accidental dismissal does not leave the parent in an ambiguous
  state.

The two remaining `window.confirm` calls in the same file
(`teams/[id]/page.tsx:728` for invite deletion and `:863` for case
unlink) are intentionally left as `window.confirm` for now — both are
fully reversible and do not orphan data, so the cost-benefit of a full
dialog is lower than offboarding. Documented as future enhancement.

---

## Section 3 — AccessGate adoption sweep

**Status:** baseline adoption shipped.

**Files modified:**

- `apps/web/components/reports-experience/ReportsIndex.tsx` — replaced
  the dead-end text in `ReportsAuthError` (401/403) and
  `ReportsNoWorkspace` with structured `<AccessGate>` panels that give
  the operator actionable next steps ("Sign in", "Switch workspace",
  "Open settings").

**Files audited but not modified (ranked by user-value, deferred):**

1. `apps/web/app/(app)/billing/page.tsx:144-198` — `handleCancelSubscription`
   and `handleCancelStorageAddon` toast a generic message on error.
   402 (plan gate) vs 403 (permission) is not disambiguated. Adopting
   AccessGate here requires non-trivial restructuring of the billing
   page's local state machine and is deferred.
2. `apps/web/app/(app)/evidence/[id]/page.tsx:1090-1140` — verification
   package download already has structured per-statuscode messages
   via `addToast`. Adoption would replace toasts with an inline panel
   in the deliverables tab; deferred.
3. `apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts`
   `~890` — `TEAM_PLAN_REQUIRED` is handled but no upgrade CTA;
   deferred to keep the capture flow stable.

The existing AccessGate consumers (`CasesIndex`, `CreateCaseModal`)
plus the Phase 2.2 additions cover the highest-traffic surfaces. The
deferred items are tracked as adoption tickets; none of them are P0
regressions because the underlying actions still error correctly — the
gap is presentation, not safety.

---

## Section 4 — First-login audit (read-only)

A new authenticated user with zero data lands on `/home` (or
`/dashboard` depending on persona). Observations:

- The workspace-bootstrap codepath (Phase EMERGENCY-RECOVERY) creates a
  personal Team automatically, so an authenticated user always has at
  least one valid workspace. There is no "no workspace" dead end on a
  healthy DB.
- There is no scripted onboarding tour, no sample case, no sample
  evidence record. The dashboard renders empty states from the
  persona-empty-state resolver (see
  `resolvePersonaEmptyState` in
  `apps/web/lib/platform-context`), which gives a persona-specific
  hint but no guided next step.
- Settings (`/settings`) shows profile + legal-acceptance status; it
  does not gate the app, and a non-legal-accepted user can still see
  most read-only surfaces.
- Security center (`/settings/security` / similar) surfaces MFA and
  device-trust state only for users whose role grants it.

**No code change in this section.** The first-login experience is a
known gap; building a real onboarding flow is out of Phase 2.2 scope.
Recommendation: file a dedicated "onboarding" phase with sample-data
seeding, a `?onboarding=1` query-driven tour, and persona-specific
"what to do next" buckets on the dashboard.

---

## Section 5 — Reports reality check

**Finding:** no backend endpoint exists for user-initiated report
regeneration.

- `GET /v1/evidence/:id/report/latest` (evidence routes, ~line 8571)
  is GET-only. It returns the latest version and emits a
  custody-chain "report download" event; it does not enqueue a new
  generation.
- `GET /v1/evidence/:id/artifacts/status` is a status poll only.
- Report regeneration happens via the worker (cron + signal-driven
  enqueue), not via a user-facing route.

**UI implication:** the Reports + evidence-detail pages must NEVER
expose a "Regenerate" button that would 404. Phase 2.1 explicitly
shipped only Download buttons (no Regenerate) for this reason.
This section locks that invariant in writing.

If/when a regenerate endpoint is added, the implementation must:

1. Live at `services/api/src/routes/evidence.routes.ts` next to the
   `report/latest` GET handler.
2. Reuse the existing worker-enqueue path so the cost-guard, custody
   write, and signing trust path stay consistent.
3. Be POST + idempotent against a queued-but-unfinished generation.
4. Return `{ status: "QUEUED" | "REGENERATING" }`, NOT a fake URL.
5. Trigger an AccessGate-shaped 402/403 if the workspace plan does
   not include regeneration (so the existing UI gate component is
   reusable).

Until that endpoint exists, the UI remains download-only.

---

## Section 6 — Hidden backend feature inventory

Ranked by user-value-if-surfaced. None of these are bugs; they are
capabilities the backend supports today that have no UI affordance.

| # | Endpoint | Capability | Why it matters | UI gap |
|---|----------|-----------|---------------|--------|
| 1 | `POST /v1/identity-security/sessions/revoke-all` | Mass session revoke | Required for credential-rotation / break-glass scenarios. | No operator UI; backend-only. |
| 2 | `GET /v1/identity-security/sessions` | Session audit list | Operators need a "where am I signed in" view (table-stakes for security-conscious customers). | No UI. |
| 3 | `GET /v1/identity-security/devices` + `POST .../devices/:id/revoke` | Trusted-device registry + revoke | Step-up bypass relies on device trust; revocation is invisible. | No UI; security center shows policy but not the underlying device list. |
| 4 | `POST /v1/identity-security/step-up/start` | Manual step-up challenge | Lets a user re-prove identity before a sensitive action without waiting for the implicit trigger. | No UI; step-up only fires implicitly. |
| 5 | `PUT /v1/identity-security/mfa-policy` | Workspace MFA policy change | Security center reads the policy but does not let an admin edit it. | Read-only UI. |
| 6 | `GET /v1/admin/audit-log/export` | Audit-log CSV export | Compliance asks. | No UI; route is platform-admin only. |
| 7 | `POST /v1/evidence/bulk` | Bulk evidence ops (tag / archive / restore / soft-delete) | Operators with hundreds of records repeatedly click row actions. | No bulk modal. |
| 8 | `GET /v1/governance/export-snapshots` | Governance snapshot export | Required for periodic compliance attestation. | No UI. |
| 9 | `POST /v1/integrations/api/evidence-requests` + API-key mgmt | External API-driven intake | The integration is implemented; key creation/rotation has no UI. | No UI. |
| 10 | `DELETE /v1/identity/mfa/factors/:id` | Revoke MFA factor | User MFA management is partial. | No "remove TOTP" / "remove recovery codes" UI. |
| 11 | SAML SP endpoints (R8.2 series) | SAML SSO for enterprise | Backend is wired (per R8.2 doc set); customer-facing setup UI is sparse. | No self-serve IdP-config UI; ops-managed. |
| 12 | Webhook subscription + rotation routes | Webhook subscriptions | Used by E3.2 / E3.3 phases; subscription-management UI is partial. | No subscribe/rotate UI for non-admins. |

**Recommended next sprint:** items 1–4 are the smallest, highest-trust
wins (no new product surface needed — they extend the existing security
center). Items 7 and 9 are the largest revenue-relevant ones (bulk ops
and API keys are commonly asked for).

This list is not exhaustive. It is the ranked subset that the Phase
2.2 audit considers worth surfacing in the next product cycle. None of
these gaps are P0 regressions; they are unsold value.

---

## Out of scope (re-stated)

- No backend behavior change.
- No public-verify shape change.
- No new Phase 1 rate-limit / PII-redaction rule.
- No production data touched.
- No live-secrets used.

---

## Files added / modified in Phase 2.2

Added:

- `apps/web/app/(app)/verify/page.tsx`
- `apps/web/app/(app)/teams/[id]/components/MemberRemovalDialog.tsx`
- `e2e/phase2-2-flows.spec.ts` (5 tests covering reachability +
  contract surface of the new dialog)
- `docs/product/PHASE_2_2_WORKSPACE_COMPLETION.md` (this file)

Modified:

- `apps/web/app/(app)/teams/[id]/page.tsx` (offboarding dialog
  wiring, replaces `window.confirm` for member removal; fixes a
  pre-existing bug where the DELETE / removal-impact calls passed
  `userId` to a `:memberId` route that resolves by `TeamMember.id`).
- `apps/web/components/reports-experience/ReportsIndex.tsx`
  (AccessGate adoption for auth / permission / no-workspace states).

## Validation

- `pnpm --filter proovra-web typecheck` — clean.
- `pnpm --filter proovra-web lint` — 0 errors. The 35 pre-existing
  `react-hooks/exhaustive-deps` warnings are unchanged; no new
  warnings originate from the Phase 2.2 files.
- `pnpm exec playwright test` — 25/25 tests passing
  (Phase 1: 11, Phase 2.1: 5, Phase 2.2: 5, evidence-flow: 3,
  landing-pages: 6, public-verify-privacy: 6, with overlap).
- Phase 2.2 spec covers: `/verify` reachable, `/reports` reachable,
  removal-impact authed-non-member 403/404, DELETE body-parse +
  role-gate, malformed-UUID defense in depth.

## Bug fixed in passing

The original `teams/[id]/page.tsx` `handleRemoveMember` and the
Phase 2.1 implicit contract both called:

    DELETE /v1/teams/:teamId/members/:memberId

with `:memberId = member.userId`. The Fastify route resolves the
member by `TeamMember.id`, not `userId`, so the previous flow would
have returned `404 "Member not found"` whenever invoked. The Phase
2.1 e2e test never exercised the success path (it only confirmed
the unauthenticated 401), so the bug was silent. Phase 2.2 fixes
it: `MemberRemovalDialog` accepts `{ memberId, userId, label, role }`
and the wiring passes the `TeamMember.id` row PK to the URL while
keeping `userId` for telemetry and display.
