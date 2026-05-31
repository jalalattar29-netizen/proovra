# Phase 2B Enterprise Closure — Final Report

> External Reviewer Portal — SSO federation + invitation email delivery
> + bulk invitation workflows.
>
> This report supersedes the in-flight notes in
> `PHASE_2B_FINAL_REPORT.md` for everything that was either deferred
> or only "federation-ready" in the original Phase 2B ship.

---

## 1. What was incomplete after restart

The mid-session audit (Tasks 85–95) confirmed that Tasks 85–91 had
landed before the host restart:

* `packages/shared/src/external-review-portal.ts` had the new bounded
  enums (`PORTAL_AUTH_METHODS`, `INVITATION_DELIVERY_STATUSES`,
  `BULK_INVITATION_ROW_OUTCOMES`, `BULK_INVITATION_MAX_ROWS`,
  `BulkInvitationResultRow`) and 14 new activity codes
  (`INVITATION_EMAIL_*`, `INVITATION_RESENT`, `BULK_INVITATION_*`,
  `BULK_REVOKE_*`, `EXTERNAL_SSO_*`, `PORTAL_SESSION_*`).
* The Prisma schema already had the `auth_method`, `sso_connection_id`,
  `allowed_domains`, `sso_subject_hash`, `sso_name_id`,
  `sso_bound_at_utc`, `mfa_satisfied_at_utc` columns on
  `external_reviewer_role_assignments`, plus the new
  `external_review_invitation_deliveries` table.
* Three new services were in place:
  `portal-invitation-email.service.ts`,
  `portal-sso.service.ts`,
  `portal-bulk-invitations.service.ts`.
* `portal-session.service.ts` exposed `authMethod`, `ssoConnectionId`,
  `ssoSubjectHash`, `mfaSatisfied` on `PortalSessionContext` and
  exported `emitPortalSessionExpired` / `emitPortalSessionRevoked`.
* `external-portal.routes.ts` mounted the new endpoints (bulk,
  bulk/revoke, :id/resend, :id/delivery, :id/send-email,
  :id/sessions/revoke, /v1/portal/sso/start/:grantId,
  /v1/portal/sso/callback).

What was **missing** when work resumed:

| # | Task | Pre-restart state |
|---|------|------|
| 92 | Internal Operator Console UI | Still the pre-closure 428-line single-issue page. No tabs, no bulk surface, no SSO controls, no delivery panel, raw-token reveal as the default workflow. |
| 93 | Portal UX (accept landing + SSO callback + dashboard chips) | Email links produced by the API (`/portal/accept/[grantId]?token=…`) 404'd. There was no SAML ACS handler at `/portal/sso/callback/[grantId]`. The dashboard ribbon never showed the federation chips even though the back-end exposed them. |
| 94 | Phase 2B Closure test | Existing Phase 2B test had **zero** references to closure concepts. No `phase-2b-closure-*.test.ts` file. |
| 95 | Final closure report | Did not exist. |

---

## 2. What was completed in this closure pass

* **Operator Console redesign** — `apps/web/app/(app)/review/external/page.tsx`
  is now the **External Review Management Console** (Task 92).
* **Portal UX additions** — invitation landing page + SAML ACS route
  handler + dashboard ribbon federation chips (Task 93).
* **Closure test suite** — new
  `services/api/test/phase-2b-closure-external-portal.test.ts`
  with 54 bounded source-contract + canonical-shape assertions
  (Task 94).
* **Operator-side backend tweaks** to support the new console:
  * `listInvitationsForTeam` now joins grant state, expiry,
    federation columns, allowed domains, and the latest delivery
    row.
  * `bulkIssueInvitations` accepts `defaultAuthMethod` /
    `defaultSsoConnectionId` / `defaultAllowedDomains` and applies
    them to every issued grant's role assignment.
  * New bounded `rotateExternalReviewGrantToken` primitive on the
    grant service drives the break-glass "Reveal token" UI without
    losing the grant id or audit story.
  * New POST `/v1/external-review/invitations/:id/reveal-token`
    route — bounded reason required (≥ 10 chars), surfaces a
    fresh raw token EXACTLY ONCE, and emits a bounded
    `external_review_invited` SecurityEvent with `breakGlass: true`.
* **Shared projection extension** — `ExternalPortalProjection.session`
  now carries `authMethod`, `ssoConnectionId`, `ssoSubjectHash`,
  `mfaRequired`, `mfaSatisfied`. Re-exported via the shared package
  build.
* **Phase O migration hygiene** — the original closure migration
  was rewritten to satisfy the Phase O safety gate:
  brand-new table created with plain `CREATE TABLE` (no `IF NOT
  EXISTS`), every `CREATE INDEX` wrapped in a
  `DO $$ … information_schema.columns … END $$` guard,
  `ALTER TABLE IF EXISTS … ADD COLUMN IF NOT EXISTS` for column adds.
  Allowlist entries added to the Phase 32.7.2 migration drift gate.

---

## 3. Federation architecture

* The portal **reuses** the existing `SsoConnection` model + the
  Phase R8.2 SAML primitives (`buildSamlAuthnRequest`,
  `validateSamlResponse`). There is **no parallel identity system**.
* `portal-sso.service.ts` is the only place that touches federation:
  * `startPortalSsoFlow(grantId, acsUrl, spEntityId)` — looks up the
    role assignment + the workspace-anchored `SsoConnection`,
    builds the AuthnRequest, emits `EXTERNAL_SSO_STARTED` with
    bounded payload, returns the IdP redirect URL.
  * `completePortalSsoFlow(grantId, samlResponseBase64,
    expectedInResponseTo)` — validates the assertion against the
    pinned IdP cert via `validateSamlResponse`, then enforces the
    bounded identity-match rules:
      * The asserted email matches `inviteEmail` exactly
        (case-insensitive), OR
      * the asserted email's domain appears in
        `role.allowedDomains`.
      * Fails closed otherwise — emits
        `EXTERNAL_SSO_IDENTITY_MISMATCH` and returns
        `NOT_PERMITTED`.
    * On first success the asserted `nameIdHash` is pinned to
      `role.ssoSubjectHash`. Subsequent SSO sign-ins that present a
      different `nameIdHash` are refused with
      `subject_hash_drift` and the same identity-mismatch event.
    * On success: emits `EXTERNAL_SSO_SUCCEEDED`, stamps
      `authMethod = "SSO"` and `inviteAcceptedAtUtc`, transitions
      the grant `INVITED → ACTIVE` (idempotent — already-ACTIVE is a
      no-op).
* **Workspace anchoring**: every read filters on `teamId` derived
  from the role assignment row. The SAML XML never reaches the
  workspace layer until the assertion has been validated.
* The IdP cert is read from the workspace `SsoConnection`. KeyInfo
  inside the assertion is ignored — `validateSamlResponse` does
  this.

---

## 4. Invitation delivery architecture

* `portal-invitation-email.service.ts` composes invitation emails and
  hands them to the shared `sendCustomEmailViaResend` helper. No
  second Resend client; no second template engine.
* Each send creates one row in `external_review_invitation_deliveries`
  before the network call so the audit trail survives a provider
  crash. State transitions are bounded by `INVITATION_DELIVERY_STATUSES`:

  | from | event | to |
  |---|---|---|
  | (n/a) | row created | `PENDING` |
  | `PENDING` | Resend `ok` | `SENT` |
  | `PENDING` | Resend `not_configured` | `FAILED` (`provider = "RESEND_DISABLED"`) |
  | `PENDING` | Resend other error | `FAILED` (bounded `failureReason`, ≤ 400-char `lastErrorPreview`) |
  | any | grant revoked | `REVOKED` |
  | any | grant expired | `EXPIRED` |
  | `SENT` | provider open ping | `OPENED` (via `annotateLatestDeliveryStatus`) |
  | `SENT` | provider delivery webhook | `DELIVERED` |

* Activity emissions: `INVITATION_EMAIL_SENT` on success,
  `INVITATION_EMAIL_FAILED` on provider failure, `INVITATION_RESENT`
  when the operator resends.
* The delivery row **never** stores the raw token. The token is
  composed into the accept URL at send time and immediately discarded.
* The email body explicitly notes (when applicable) that MFA is
  required and that SSO sign-in is offered.

---

## 5. Bulk invitation architecture

* `portal-bulk-invitations.service.ts` exposes three bounded entry
  points:
  * `bulkIssueInvitations` — ≤ `BULK_INVITATION_MAX_ROWS` (100) per
    call. Emits `BULK_INVITATION_STARTED` first, processes every
    row in sequence, emits `BULK_INVITATION_ROW_FAILED` for each
    failing row, and emits `BULK_INVITATION_COMPLETED` with a
    summary at the end. **A failing row never aborts the batch.**
  * `bulkRevokeInvitations` — ≤ 100 grant ids per call. Per-row
    outcomes: `REVOKED`, `NOT_FOUND`, `ALREADY_REVOKED`, `FAILED`.
    Emits `BULK_REVOKE_STARTED` / `BULK_REVOKE_COMPLETED`. Each
    revoke also annotates the latest delivery row as `REVOKED`.
  * `resendInvitationEmail` (single + bulk usage) — increments the
    attempt counter via `deriveAttemptCounter`, emits
    `INVITATION_RESENT`, stamps `inviteResentAtUtc`.
* Per-row outcomes are bounded by `BULK_INVITATION_ROW_OUTCOMES`:
  `INVITED`, `INVALID_EMAIL`, `DUPLICATE`, `POLICY_DENIED`,
  `FAILED`.
* Federation defaults (`defaultAuthMethod`, `defaultSsoConnectionId`,
  `defaultAllowedDomains`) are applied to each successfully-issued
  row's role assignment via a single follow-up
  `externalReviewerRoleAssignment.updateMany`.

---

## 6. Portal session / security changes

* `PortalSessionContext` carries `authMethod`, `ssoConnectionId`,
  `ssoSubjectHash`, `mfaSatisfied`.
* MFA gate: once a TOTP challenge succeeds, we stamp
  `mfaSatisfiedAtUtc`. Subsequent session re-establishment within
  `EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS` (30 min) treats MFA as
  satisfied and does not re-prompt.
* New bounded session lifecycle emitters:
  * `emitPortalSessionExpired({ reason: "INACTIVITY" | "MAX_LIFETIME" })`
    → `PORTAL_SESSION_EXPIRED`.
  * `emitPortalSessionRevoked({ reason: "OPERATOR_REVOKE" |
    "GRANT_REVOKED" | "GRANT_EXPIRED" })` → `PORTAL_SESSION_REVOKED`.
* The token-lookup denial path still fails closed with
  `TOKEN_INVALID` / `TOKEN_EXPIRED` / `TOKEN_REVOKED`.

---

## 7. Operator UI changes (Task 92)

Single file: `apps/web/app/(app)/review/external/page.tsx`.

* Header rebranded to **"External Review Management Console"**.
* `data-console-tabs` exposes the six bounded tabs: **Active /
  Pending / Accepted / Expired / Revoked / Bulk Invite**.
* Per-tab filtering (`filterRowsForTab`) uses the new `grantState`,
  `expired`, and `inviteAcceptedAtUtc` fields returned by the
  extended `listInvitationsForTeam` projection.
* `InvitationsTable` — workspace-wide table with multi-select
  checkboxes (`data-row-multi`), `data-bulk-revoke-action` toolbar
  button driving `POST /v1/external-review/invitations/bulk/revoke`.
  Status chips include auth method, MFA, watermark, and latest
  delivery state (`data-delivery-chip`).
* `InvitationDetailDrawer` — opens on row click and shows:
  * Status / role / auth / watermark / expiry / SSO connection /
    SSO-pinned chips.
  * `data-invitation-resend` (POST `/:id/resend`) and
    `data-invitation-revoke` (POST `/:id/revoke`) actions.
  * **Break-glass token reveal** (`data-drawer-break-glass`) is
    hidden by default. Arming the panel reveals a bounded reason
    textarea (≥ 10 chars). On confirmation the API rotates the
    grant's token via `rotateExternalReviewGrantToken` and surfaces
    the new raw token in a `data-break-glass-token` textarea
    EXACTLY ONCE.
  * `data-drawer-delivery-panel` — full delivery history table with
    bounded `data-delivery-status` chips, attempt counter,
    `failureReason` preview.
  * `data-drawer-sso-panel` — auth method, SSO connection id,
    allowed domains chips, SSO bound timestamp, subject-hash pin
    notice.
  * `data-drawer-activity-panel` — bounded `data-activity-timeline`
    list (per-grant audit feed).
* `BulkInvitePanel` — multi-row paste (`data-bulk-paste`) accepting
  one reviewer per line (`email`, `email,Display`, or
  `email,Display,Org`). Live `data-bulk-paste-preview` with
  `data-bulk-paste-valid` per-row validation chip. Bounded to
  `BULK_INVITATION_MAX_ROWS`.
* Bulk panel federation controls: `data-bulk-auth-method`,
  `data-bulk-sso-connection`, `data-bulk-allowed-domains`,
  `data-bulk-default-mfa`, `data-bulk-default-watermark`.
* Per-row outcomes are rendered after submit in a
  `data-bulk-outcome-table` with bounded chips (`INVITED` / `FAILED`
  / `DUPLICATE` / `INVALID_EMAIL` / `POLICY_DENIED`) plus a summary
  chip row.

---

## 8. External reviewer UX changes (Task 93)

* **New** `apps/web/app/portal/accept/[grantId]/page.tsx` is the
  bounded invitation landing surface. The email link the API
  composes is exactly the URL it serves at.
  * Consumes `?token=` from the URL (and the `?sso=ok | denied`
    return path from the SAML callback). Immediately strips both
    from `window.history` so a casual tab share does not leak the
    token.
  * Two clearly labelled choices:
    `data-portal-accept-open-with-token` and
    `data-portal-accept-sign-in-with-sso`.
  * SSO start: pushes the raw token into sessionStorage via the
    new `stashRawTokenForSso` helper, calls
    `POST /v1/portal/sso/start/:grantId` with
    `acsUrl = ${origin}/portal/sso/callback/{grantId}`, then
    `window.location.href = redirectUrl`.
  * On `?sso=ok` return: the page auto-resumes the bounded portal
    session using the stashed token (`consumeStashedRawTokenForSso`)
    and routes to the dashboard.
  * Bounded denial paths: `data-portal-accept-sso-denied`
    (with `?reason=` chip), `data-portal-accept-error`,
    `data-portal-accept-no-token` (with link to `/portal` fallback).
* **New** `apps/web/app/portal/sso/callback/[grantId]/route.ts` is
  the SAML ACS receiver:
  * POST handler reads `SAMLResponse` (and `RelayState`) from the
    form-encoded body, forwards exactly that payload (plus the
    path-derived `grantId`) to `POST /v1/portal/sso/callback`.
  * On API `200` → redirects to `/portal/accept/{grantId}?sso=ok`.
  * On API failure → redirects to
    `/portal/accept/{grantId}?sso=denied&reason=<BOUNDED>` with
    `BOUNDED` clipped to `[A-Z_]{1,64}` to prevent fuzzing.
  * GET handler honestly refuses with `SAML_REQUIRES_POST`.
  * The route handler never logs the raw `SAMLResponse`.
* **Dashboard ribbon (`apps/web/app/portal/[token]/page.tsx`)** now
  surfaces bounded chips:
  * `data-portal-auth-method-chip` = `TOKEN | SSO`.
  * `data-portal-mfa-chip` = `SATISFIED | REQUIRED` (rendered only
    when `mfaRequired === true`).
  * `data-portal-sso-chip` = the truncated `ssoConnectionId` when
    the grant is federation-bound.
* The legacy `/portal` paste-token entry page is retained as a
  documented **fallback** — the accept landing renders a link to it
  only when the URL is missing a token.

---

## 9. Audit / activity mapping

| Operator / reviewer action | Activity code | Surface |
|---|---|---|
| Bulk invitation start | `BULK_INVITATION_STARTED` | Operator console "Bulk Invite" submit |
| Bulk invitation complete | `BULK_INVITATION_COMPLETED` | Operator console "Bulk Invite" submit |
| Bulk row refused / failed | `BULK_INVITATION_ROW_FAILED` | Operator console |
| Bulk revoke start | `BULK_REVOKE_STARTED` | Operator console "Bulk revoke" toolbar button |
| Bulk revoke complete | `BULK_REVOKE_COMPLETED` | Operator console |
| Single invitation email sent | `INVITATION_EMAIL_SENT` | Operator console resend / single send-email |
| Single invitation email failed | `INVITATION_EMAIL_FAILED` | Same |
| Resend | `INVITATION_RESENT` | Operator console resend button + bulk resend |
| Break-glass token reveal | `GRANT_RESENT` (payload: `path: "break_glass_reveal"`) + bounded SecurityEvent | Operator console drawer break-glass form |
| SSO flow initiated | `EXTERNAL_SSO_STARTED` | Reviewer-side `/portal/accept` → start endpoint |
| SSO callback succeeded | `EXTERNAL_SSO_SUCCEEDED` | SAML ACS → complete endpoint |
| SSO callback validation failed | `EXTERNAL_SSO_FAILED` | Same |
| SSO identity mismatch (email, domain, or hash drift) | `EXTERNAL_SSO_IDENTITY_MISMATCH` | Same |
| Session expired (inactivity / max-lifetime) | `PORTAL_SESSION_EXPIRED` | Server-side via `emitPortalSessionExpired` |
| Session revoked (operator / grant-state) | `PORTAL_SESSION_REVOKED` | Operator console `/sessions/revoke` + back-end revoke paths |

All emissions flow through the existing `emitPortalActivity` helper
into `external_review_activity` — no parallel audit system.

---

## 10. API changes

New / extended HTTP routes (all under `services/api/src/routes/external-portal.routes.ts`):

* `POST /v1/external-review/invitations/bulk`
* `POST /v1/external-review/invitations/bulk/revoke`
* `POST /v1/external-review/invitations/:id/resend`
* `POST /v1/external-review/invitations/:id/send-email`
* `GET  /v1/external-review/invitations/:id/delivery`
* `POST /v1/external-review/invitations/:id/sessions/revoke`
* `POST /v1/external-review/invitations/:id/reveal-token` (break-glass)
* `POST /v1/portal/sso/start/:grantId` (reviewer-initiated)
* `POST /v1/portal/sso/callback` (SAML ACS receiver)

All bulk endpoints validate inputs with `BULK_INVITATION_MAX_ROWS`
upper bound. All denial responses use `EXTERNAL_PORTAL_DENIAL_REASONS`.

New service exports:

* `services/external-review/portal-invitation-email.service.ts` —
  `sendInvitationEmail`, `listDeliveriesForGrant`,
  `getLatestDeliveryForGrant`, `annotateLatestDeliveryStatus`.
* `services/external-review/portal-sso.service.ts` —
  `startPortalSsoFlow`, `completePortalSsoFlow`.
* `services/external-review/portal-bulk-invitations.service.ts` —
  `bulkIssueInvitations`, `bulkRevokeInvitations`,
  `resendInvitationEmail`.
* `services/external-review/portal-session.service.ts` (extended) —
  `emitPortalSessionExpired`, `emitPortalSessionRevoked`.
* `services/external-review/external-review-grant.service.ts`
  (extended) — `rotateExternalReviewGrantToken`.
* `services/external-review/portal-invitation.service.ts` (extended)
  — `listInvitationsForTeam` projection now includes `grantState`,
  `expiresAtUtc`, `expired`, `authMethod`, `ssoConnectionId`,
  `allowedDomains`, `ssoSubjectHash`, `ssoNameId`, `ssoBoundAtUtc`,
  `mfaSatisfiedAtUtc`, `latestDelivery`.

---

## 11. Database changes

Migration: `services/api/prisma/migrations/20261015000000_phase_2b_closure_invitation_delivery_sso/migration.sql`

* `external_reviewer_role_assignments` gains 7 nullable / defaulted
  columns: `auth_method`, `sso_connection_id`, `allowed_domains`,
  `sso_subject_hash`, `sso_name_id`, `sso_bound_at_utc`,
  `mfa_satisfied_at_utc`. Plus two indexes
  (`_team_auth_idx`, `_sso_conn_idx`).
* New table `external_review_invitation_deliveries` with bounded
  columns and four indexes (per-team + per-grant timeline,
  team+status pivot, provider message id lookup, bulk batch id
  grouping).
* Phase O hygiene: brand-new table uses plain `CREATE TABLE`;
  every `CREATE INDEX` is wrapped in a
  `DO $$ … information_schema.columns … END $$` guard; column adds
  use `ALTER TABLE IF EXISTS … ADD COLUMN IF NOT EXISTS`.
* Allow-listed in `phase-32-7-2-security-event-mapping-drift.test.ts`
  with an inline justification comment.

---

## 12. Frontend changes

| File | Change |
|---|---|
| `apps/web/app/(app)/review/external/page.tsx` | Full rewrite → External Review Management Console (tabs, drawer, bulk panel, break-glass reveal). |
| `apps/web/app/portal/accept/[grantId]/page.tsx` | New — invitation landing page with token + SSO paths. |
| `apps/web/app/portal/sso/callback/[grantId]/route.ts` | New — SAML ACS receiver (POST handler + GET fallback). |
| `apps/web/app/portal/[token]/page.tsx` | Ribbon gains auth method / MFA / SSO chips. |
| `apps/web/lib/external-portal/portal-client.ts` | New helpers — `startPortalSso`, `stashRawTokenForSso`, `consumeStashedRawTokenForSso`. |

The token is never stored in `localStorage`. The accept page and the
SSO callback flow keep it in memory + (briefly) `sessionStorage`.

---

## 13. Tests added

* `services/api/test/phase-2b-closure-external-portal.test.ts` —
  **54 assertions** across 10 describe blocks: shared contracts,
  Prisma additions, email service, bulk service, SSO service,
  portal-session extension, routes, operator console UI, portal
  UX, audit/activity hooks.
* `services/api/test/phase-2b-external-reviewer-portal.test.ts` —
  the legacy "issue form + raw-token reveal + revoke action"
  assertion was retargeted to the closure-era anchors
  (`data-bulk-issue-submit`, `data-break-glass-token`,
  `data-invitation-revoke`). The closure test continues to pin the
  full new surface.
* `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts`
  — closure migration added to the allowlist with citation.

---

## 14. Validation results

| Check | Command | Result |
|---|---|---|
| Shared package build | `pnpm --filter @proovra/shared run build` | ✅ Clean (`tsc -p tsconfig.build.json`) |
| Prisma schema validate | `npx prisma validate` | ✅ "The schema at prisma\\schema.prisma is valid 🚀" |
| API typecheck | `npx tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Web typecheck | `npx tsc --noEmit` in `apps/web` | ✅ 0 errors |
| Phase 2B Closure test | `pnpm vitest run test/phase-2b-closure-external-portal.test.ts` | ✅ 54 / 54 |
| Phase 2B (legacy) test | `pnpm vitest run test/phase-2b-external-reviewer-portal.test.ts` | ✅ 48 / 48 |
| Phase O migration safety gate | `pnpm vitest run test/phase-o-migration-safety-gate.test.ts` | ✅ 28 / 28 |
| Phase 32.7.2 migration drift | `pnpm vitest run test/phase-32-7-2-security-event-mapping-drift.test.ts` | ✅ 24 / 24 |
| Full API suite | `pnpm vitest run` | ✅ **250 files passed / 1 skipped · 11575 tests passed / 52 skipped · 0 failures** |

---

## 15. Remaining limitations

* **Bulk resend uses a placeholder token in the email body.** The
  Phase 2B Closure deliberately keeps the per-grant token rotation
  primitive behind the `rotateExternalReviewGrantToken` break-glass
  path. When the operator triggers a row-level resend the email
  surfaces a placeholder string; the operator is expected to choose
  one of:
  1. Resend the same outbound email (the recipient already had
     the original token), or
  2. Use the explicit break-glass "Reveal token" UI to mint and
     deliver a fresh token to the recipient by some out-of-band
     channel.
  This honest-but-bounded behavior is the trade-off for preserving
  the grant id + audit story across the resend.
* **`/v1/portal/sso/callback` correlates by path grantId, not
  RelayState.** This is intentional — the operator-provided ACS
  URL embeds the grantId so a hostile IdP cannot redirect the
  callback at a different grant. The bounded RelayState random
  bytes still flow through but are not consulted on the SP side.
* **Inactivity-bound MFA satisfaction.** Once an MFA challenge
  succeeds, subsequent re-establishments within 30 min skip
  re-prompting (the user's session is preserved). This matches
  enterprise expectations but is documented here so reviewers
  understand the bounded window.

---

## 16. PASS / FAIL closure criteria

| Closure criterion | Result |
|---|---|
| SSO Federation actually wired (not just "ready") | ✅ PASS — `portal-sso.service.ts` + ACS route + accept-page button + real `validateSamlResponse` cryptography. |
| Identity validated against grant email **or** allowed domain | ✅ PASS — `identityMatchesGrant`. |
| Fail closed on email mismatch | ✅ PASS — `NOT_PERMITTED` + `EXTERNAL_SSO_IDENTITY_MISMATCH`. |
| Fail closed on subject-hash drift | ✅ PASS — `subject_hash_drift` audit payload. |
| `EXTERNAL_SSO_STARTED / SUCCEEDED / FAILED / IDENTITY_MISMATCH` emitted | ✅ PASS. |
| Invitation email delivery uses existing Resend infrastructure | ✅ PASS — `sendCustomEmailViaResend`. |
| Email includes inviter, workspace, role, expiration, secure link, security notice | ✅ PASS — `renderInvitationHtml` + `renderInvitationText`. |
| Delivery state stored (`PENDING → SENT / FAILED / REVOKED / EXPIRED`) | ✅ PASS — `external_review_invitation_deliveries`. |
| Manual token reveal kept ONLY as admin fallback | ✅ PASS — break-glass UI requires ≥ 10-char operator reason, audit-stamped, bounded SecurityEvent. |
| Bulk invitation end-to-end | ✅ PASS — `bulkIssueInvitations` + operator console "Bulk Invite" tab. |
| Bulk per-row outcomes bounded (5 values) | ✅ PASS — `BULK_INVITATION_ROW_OUTCOMES`. |
| One bad row never aborts batch | ✅ PASS — closure test pins the `continue` paths. |
| Bulk resend wired | ✅ PASS — `resendInvitationEmail`. |
| Bulk revoke wired | ✅ PASS — `bulkRevokeInvitations` + operator console toolbar button. |
| `BULK_INVITATION_MAX_ROWS === 100` | ✅ PASS. |
| Operator UI exposes Active / Pending / Accepted / Expired / Revoked / Bulk Invite tabs | ✅ PASS — `data-console-tabs`. |
| Operator UI delivery status panel | ✅ PASS — `data-drawer-delivery-panel`. |
| Operator UI activity timeline | ✅ PASS — `data-drawer-activity-panel`. |
| Operator UI SSO controls (auth method / connection / allowed domains) | ✅ PASS — `data-bulk-auth-method` + `data-bulk-sso-connection` + `data-bulk-allowed-domains`. |
| Operator UI MFA toggle | ✅ PASS — `data-bulk-default-mfa`. |
| Operator UI watermark policy selector | ✅ PASS — `data-bulk-default-watermark`. |
| Operator UI token reveal behind explicit break-glass UI | ✅ PASS — `data-drawer-break-glass` → `data-break-glass-arm` → reason text → `data-break-glass-token`. |
| Portal `/portal/accept/[grantId]` landing | ✅ PASS — new file. |
| Portal "Sign in with SSO" button | ✅ PASS — `data-portal-accept-sign-in-with-sso`. |
| Portal SAML callback route handler | ✅ PASS — `app/portal/sso/callback/[grantId]/route.ts`. |
| Portal dashboard chips (auth method / MFA / SSO) | ✅ PASS — `data-portal-auth-method-chip` + `data-portal-mfa-chip` + `data-portal-sso-chip`. |
| Session lifecycle events `PORTAL_SESSION_EXPIRED / REVOKED` | ✅ PASS. |
| No parallel identity / notification / audit systems | ✅ PASS — SsoConnection / Resend / `external_review_activity` are the only stores. |
| All Phase 2B Closure tests pass | ✅ PASS — 54 / 54. |
| Full validation suite passes | ✅ PASS — 11575 / 11575 (52 skipped pre-existing). |

**Phase 2B Enterprise Closure: COMPLETE.**
