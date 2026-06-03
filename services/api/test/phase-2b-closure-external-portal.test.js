/**
 * Phase 2B Closure — External Reviewer Portal Enterprise Closure
 * contract + runtime test.
 *
 * Pins the additive closure surface (Tasks 85–93):
 *
 *   * Shared contracts — closure activity codes + auth methods +
 *     invitation delivery statuses + bulk shapes + projection chip
 *     fields.
 *   * Prisma additions — sidecar role-assignment federation columns
 *     and the `external_review_invitation_deliveries` table.
 *   * Email delivery service — sendInvitationEmail / activity / row
 *     transitions / attempt counter / fail-closed path.
 *   * SSO federation service — start + complete + identity matching
 *     + fail-closed paths + subject hash binding.
 *   * Bulk invitation service — per-row outcome enum, bounded ≤100,
 *     never-fail-batch, federation defaults applied, bulk revoke +
 *     resend wired.
 *   * Portal-session extension — authMethod / ssoConnectionId /
 *     ssoSubjectHash / mfaSatisfied propagation + session lifecycle
 *     emitters.
 *   * Routes — bulk, resend, bulk revoke, delivery, send-email,
 *     SSO start + callback, sessions revoke, break-glass reveal.
 *   * Operator UI — tabs, bulk paste preview, delivery panel, SSO
 *     controls, MFA toggle, watermark policy selector, break-glass
 *     token reveal hidden behind explicit confirm.
 *   * Portal UX — /portal/accept/[grantId] landing + SSO callback
 *     route handler + dashboard chips (auth method, MFA satisfied,
 *     SSO bound).
 *
 * Tests are source-contract + bounded-vocabulary assertions over the
 * canonical files. They run without spinning up Prisma so they
 * stay fast and never depend on a populated dev database.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BULK_INVITATION_MAX_ROWS, BULK_INVITATION_ROW_OUTCOMES, EXTERNAL_PORTAL_ACTIVITY_CODES, EXTERNAL_PORTAL_DENIAL_REASONS, INVITATION_DELIVERY_STATUSES, PORTAL_AUTH_METHODS, } from "@proovra/shared";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
const SHARED = readSource("../../../packages/shared/src/external-review-portal.ts");
const SHARED_INDEX = readSource("../../../packages/shared/src/index.ts");
const SCHEMA = readSource("../../../services/api/prisma/schema.prisma");
const MIGRATION = readSource("../../../services/api/prisma/migrations/20261015000000_phase_2b_closure_invitation_delivery_sso/migration.sql");
const SVC_GRANT = readSource("../../../services/api/src/services/external-review/external-review-grant.service.ts");
const SVC_SESSION = readSource("../../../services/api/src/services/external-review/portal-session.service.ts");
const SVC_INVITE = readSource("../../../services/api/src/services/external-review/portal-invitation.service.ts");
const SVC_EMAIL = readSource("../../../services/api/src/services/external-review/portal-invitation-email.service.ts");
const SVC_BULK = readSource("../../../services/api/src/services/external-review/portal-bulk-invitations.service.ts");
const SVC_SSO = readSource("../../../services/api/src/services/external-review/portal-sso.service.ts");
const SVC_PROJ = readSource("../../../services/api/src/services/external-review/portal-projection.service.ts");
const ROUTES = readSource("../../../services/api/src/routes/external-portal.routes.ts");
const UI_OPERATOR = readSource("../../../apps/web/app/(app)/review/external/page.tsx");
const UI_ACCEPT = readSource("../../../apps/web/app/portal/accept/[grantId]/page.tsx");
const UI_SSO_CALLBACK = readSource("../../../apps/web/app/portal/sso/callback/[grantId]/route.ts");
const UI_DASHBOARD = readSource("../../../apps/web/app/portal/[token]/page.tsx");
// =============================================================================
// PART 1 — Shared closure contracts
// =============================================================================
describe("Phase 2B Closure — shared contracts", () => {
    it("PORTAL_AUTH_METHODS pins TOKEN + SSO", () => {
        expect([...PORTAL_AUTH_METHODS]).toEqual(["TOKEN", "SSO"]);
    });
    it("INVITATION_DELIVERY_STATUSES has 7 bounded states", () => {
        expect([...INVITATION_DELIVERY_STATUSES].sort()).toEqual([
            "DELIVERED",
            "EXPIRED",
            "FAILED",
            "OPENED",
            "PENDING",
            "REVOKED",
            "SENT",
        ].sort());
    });
    it("BULK_INVITATION_ROW_OUTCOMES has 5 bounded outcomes", () => {
        expect([...BULK_INVITATION_ROW_OUTCOMES].sort()).toEqual([
            "DUPLICATE",
            "FAILED",
            "INVALID_EMAIL",
            "INVITED",
            "POLICY_DENIED",
        ].sort());
    });
    it("BULK_INVITATION_MAX_ROWS is bounded at 100", () => {
        expect(BULK_INVITATION_MAX_ROWS).toBe(100);
    });
    it("activity catalog adds all closure events", () => {
        const required = [
            "INVITATION_EMAIL_SENT",
            "INVITATION_EMAIL_FAILED",
            "INVITATION_RESENT",
            "BULK_INVITATION_STARTED",
            "BULK_INVITATION_COMPLETED",
            "BULK_INVITATION_ROW_FAILED",
            "BULK_REVOKE_STARTED",
            "BULK_REVOKE_COMPLETED",
            "EXTERNAL_SSO_STARTED",
            "EXTERNAL_SSO_SUCCEEDED",
            "EXTERNAL_SSO_FAILED",
            "EXTERNAL_SSO_IDENTITY_MISMATCH",
            "PORTAL_SESSION_EXPIRED",
            "PORTAL_SESSION_REVOKED",
        ];
        for (const code of required) {
            expect(EXTERNAL_PORTAL_ACTIVITY_CODES.includes(code)).toBe(true);
        }
    });
    it("denial catalog preserves Phase 2B bounded vocabulary", () => {
        for (const d of [
            "TOKEN_INVALID",
            "TOKEN_EXPIRED",
            "TOKEN_REVOKED",
            "POLICY_REJECTED",
            "NOT_PERMITTED",
            "INVITE_NOT_FOUND",
            "INVITE_ALREADY_REVOKED",
        ]) {
            expect(EXTERNAL_PORTAL_DENIAL_REASONS.includes(d)).toBe(true);
        }
    });
    it("shared file declares BulkInvitationResultRow + projection chips", () => {
        expect(SHARED).toMatch(/export type BulkInvitationResultRow\s*=/);
        expect(SHARED).toMatch(/authMethod:\s*PortalAuthMethod/);
        expect(SHARED).toMatch(/ssoConnectionId:\s*string\s*\|\s*null/);
        expect(SHARED).toMatch(/ssoSubjectHash:\s*string\s*\|\s*null/);
        expect(SHARED).toMatch(/mfaRequired:\s*boolean/);
        expect(SHARED).toMatch(/mfaSatisfied:\s*boolean/);
    });
    it("shared/index re-exports closure symbols and types", () => {
        expect(SHARED_INDEX).toMatch(/PORTAL_AUTH_METHODS/);
        expect(SHARED_INDEX).toMatch(/INVITATION_DELIVERY_STATUSES/);
        expect(SHARED_INDEX).toMatch(/BULK_INVITATION_ROW_OUTCOMES/);
        expect(SHARED_INDEX).toMatch(/BULK_INVITATION_MAX_ROWS/);
        expect(SHARED_INDEX).toMatch(/PortalAuthMethod/);
        expect(SHARED_INDEX).toMatch(/InvitationDeliveryStatus/);
        expect(SHARED_INDEX).toMatch(/BulkInvitationRowOutcome/);
        expect(SHARED_INDEX).toMatch(/BulkInvitationResultRow/);
    });
});
// =============================================================================
// PART 2 — Prisma + migration
// =============================================================================
describe("Phase 2B Closure — Prisma additions", () => {
    it("role assignment gains federation + adaptive auth columns", () => {
        expect(SCHEMA).toMatch(/authMethod\s+String\s+@default\("TOKEN"\)\s+@map\("auth_method"\)/);
        expect(SCHEMA).toMatch(/ssoConnectionId\s+String\?\s+@map\("sso_connection_id"\)/);
        expect(SCHEMA).toMatch(/allowedDomains\s+String\[\]\s+@default\(\[\]\)\s+@map\("allowed_domains"\)/);
        expect(SCHEMA).toMatch(/ssoSubjectHash\s+String\?\s+@map\("sso_subject_hash"\)/);
        expect(SCHEMA).toMatch(/ssoNameId\s+String\?\s+@map\("sso_name_id"\)/);
        expect(SCHEMA).toMatch(/ssoBoundAtUtc\s+DateTime\?/);
        expect(SCHEMA).toMatch(/mfaSatisfiedAtUtc\s+DateTime\?/);
    });
    it("external_review_invitation_deliveries model is present + bounded", () => {
        expect(SCHEMA).toMatch(/@@map\("external_review_invitation_deliveries"\)/);
        expect(SCHEMA).toMatch(/status\s+String\s+@default\("PENDING"\)/);
        expect(SCHEMA).toMatch(/provider\s+String\s+@default\("RESEND_API"\)/);
        expect(SCHEMA).toMatch(/attempt\s+Int\s+@default\(1\)/);
        expect(SCHEMA).toMatch(/bulkBatchId\s+String\?/);
    });
    it("Phase O-Final compliant SQL migration creates table + guarded indexes", () => {
        // Brand-new table uses plain CREATE TABLE (no IF NOT EXISTS) so a
        // divergent pre-existing copy fails LOUDLY rather than silently
        // skipping column declarations — the Phase O-Final defense.
        expect(MIGRATION).toMatch(/CREATE TABLE "external_review_invitation_deliveries"/);
        expect(MIGRATION).not.toMatch(/CREATE TABLE IF NOT EXISTS "external_review_invitation_deliveries"/);
        expect(MIGRATION).toMatch(/ALTER TABLE IF EXISTS "external_reviewer_role_assignments"[\s\S]+auth_method/);
        // Every CREATE INDEX is wrapped in a DO/information_schema guard
        // so partial-state replays are safe no-ops.
        for (const indexName of [
            "external_review_invitation_deliveries_team_grant_queued_idx",
            "external_review_invitation_deliveries_team_status_idx",
            "external_review_invitation_deliveries_provider_msg_idx",
            "external_review_invitation_deliveries_bulk_batch_idx",
            "external_reviewer_role_assignments_team_auth_idx",
            "external_reviewer_role_assignments_sso_conn_idx",
        ]) {
            expect(MIGRATION).toMatch(new RegExp(indexName));
        }
        expect(MIGRATION).toMatch(/DO \$\$\s*BEGIN[\s\S]+information_schema\.columns/);
    });
});
// =============================================================================
// PART 3 — Email delivery service
// =============================================================================
describe("Phase 2B Closure — invitation delivery service", () => {
    it("composes through sendCustomEmailViaResend + writes delivery row", () => {
        expect(SVC_EMAIL).toMatch(/sendCustomEmailViaResend\b/);
        expect(SVC_EMAIL).toMatch(/externalReviewInvitationDelivery\.create/);
    });
    it("PENDING → SENT on provider ok + INVITATION_EMAIL_SENT emitted", () => {
        expect(SVC_EMAIL).toMatch(/status:\s*"PENDING"/);
        expect(SVC_EMAIL).toMatch(/status:\s*"SENT"\s*satisfies InvitationDeliveryStatus/);
        expect(SVC_EMAIL).toMatch(/code:\s*input\.isResend === true/);
        expect(SVC_EMAIL).toMatch(/"INVITATION_EMAIL_SENT"/);
        expect(SVC_EMAIL).toMatch(/"INVITATION_RESENT"/);
    });
    it("PENDING → FAILED on provider error + INVITATION_EMAIL_FAILED emitted", () => {
        expect(SVC_EMAIL).toMatch(/status:\s*"FAILED"\s*satisfies InvitationDeliveryStatus/);
        expect(SVC_EMAIL).toMatch(/"INVITATION_EMAIL_FAILED"/);
        expect(SVC_EMAIL).toMatch(/not_configured/);
        expect(SVC_EMAIL).toMatch(/RESEND_DISABLED/);
    });
    it("attempt counter increments on resend", () => {
        expect(SVC_EMAIL).toMatch(/deriveAttemptCounter/);
        expect(SVC_EMAIL).toMatch(/isResend/);
    });
    it("never persists the raw token to the delivery row", () => {
        // The delivery `create` call must not embed the rawToken field.
        expect(SVC_EMAIL).not.toMatch(/rawToken:\s*input\.rawToken/);
    });
});
// =============================================================================
// PART 4 — Bulk invitation service
// =============================================================================
describe("Phase 2B Closure — bulk invitation service", () => {
    it("bounded ≤ BULK_INVITATION_MAX_ROWS at the entry point", () => {
        expect(SVC_BULK).toMatch(/input\.rows\.length > BULK_INVITATION_MAX_ROWS/);
    });
    it("per-row outcomes are bounded by BULK_INVITATION_ROW_OUTCOMES", () => {
        expect(SVC_BULK).toMatch(/"INVITED"/);
        expect(SVC_BULK).toMatch(/"INVALID_EMAIL"/);
        expect(SVC_BULK).toMatch(/"DUPLICATE"/);
        expect(SVC_BULK).toMatch(/"POLICY_DENIED"/);
        expect(SVC_BULK).toMatch(/"FAILED"/);
    });
    it("a failing row continues the loop (never aborts the batch)", () => {
        // Each per-row failure pattern must `continue` rather than throw.
        const failurePathContinues = /outcome: "INVALID_EMAIL"[\s\S]{0,500}continue;/m;
        expect(SVC_BULK).toMatch(failurePathContinues);
    });
    it("emits BULK_INVITATION_STARTED + COMPLETED + ROW_FAILED", () => {
        expect(SVC_BULK).toMatch(/"BULK_INVITATION_STARTED"/);
        expect(SVC_BULK).toMatch(/"BULK_INVITATION_COMPLETED"/);
        expect(SVC_BULK).toMatch(/"BULK_INVITATION_ROW_FAILED"/);
    });
    it("bulk revoke emits BULK_REVOKE_STARTED + COMPLETED", () => {
        expect(SVC_BULK).toMatch(/"BULK_REVOKE_STARTED"/);
        expect(SVC_BULK).toMatch(/"BULK_REVOKE_COMPLETED"/);
        // Per-row outcomes are returned without aborting.
        expect(SVC_BULK).toMatch(/outcome:\s*"REVOKED"/);
        expect(SVC_BULK).toMatch(/outcome:\s*"NOT_FOUND"/);
        expect(SVC_BULK).toMatch(/outcome:\s*"ALREADY_REVOKED"/);
    });
    it("bulk resend wires resendInvitationEmail", () => {
        expect(SVC_BULK).toMatch(/export async function resendInvitationEmail/);
        expect(SVC_BULK).toMatch(/sendInvitationEmail/);
    });
    it("applies operator-chosen federation defaults to issued grants", () => {
        expect(SVC_BULK).toMatch(/defaultAuthMethod/);
        expect(SVC_BULK).toMatch(/defaultSsoConnectionId/);
        expect(SVC_BULK).toMatch(/defaultAllowedDomains/);
        expect(SVC_BULK).toMatch(/externalReviewerRoleAssignment\.updateMany/);
    });
});
// =============================================================================
// PART 5 — SSO federation service
// =============================================================================
describe("Phase 2B Closure — SSO federation service", () => {
    it("startPortalSsoFlow emits EXTERNAL_SSO_STARTED", () => {
        expect(SVC_SSO).toMatch(/buildSamlAuthnRequest\b/);
        expect(SVC_SSO).toMatch(/"EXTERNAL_SSO_STARTED"/);
    });
    it("completePortalSsoFlow validates assertion via shared SAML primitive", () => {
        expect(SVC_SSO).toMatch(/validateSamlResponse/);
    });
    it("emits EXTERNAL_SSO_SUCCEEDED + FAILED + IDENTITY_MISMATCH", () => {
        expect(SVC_SSO).toMatch(/"EXTERNAL_SSO_SUCCEEDED"/);
        expect(SVC_SSO).toMatch(/"EXTERNAL_SSO_FAILED"/);
        expect(SVC_SSO).toMatch(/"EXTERNAL_SSO_IDENTITY_MISMATCH"/);
    });
    it("fails closed on email mismatch + disallowed domain", () => {
        expect(SVC_SSO).toMatch(/identityMatchesGrant/);
        // mismatch path returns NOT_PERMITTED.
        expect(SVC_SSO).toMatch(/denial:\s*"NOT_PERMITTED"/);
    });
    it("pins ssoSubjectHash on first bind + refuses drift on later binds", () => {
        expect(SVC_SSO).toMatch(/ssoSubjectHash:\s*role\.ssoSubjectHash\s*\?\?\s*assertion\.nameIdHash/);
        expect(SVC_SSO).toMatch(/subject_hash_drift/);
    });
    it("never logs the raw nameId — only the hash", () => {
        // Bounded — payload uses nameIdHash, not nameId.
        expect(SVC_SSO).toMatch(/nameIdHash:\s*assertion\.nameIdHash/);
        expect(SVC_SSO).not.toMatch(/nameId:\s*assertion\.nameId,/);
    });
    it("does NOT define a parallel identity store — reuses SsoConnection", () => {
        expect(SVC_SSO).toMatch(/ssoConnection\.findFirst/);
        expect(SVC_SSO).not.toMatch(/portalSsoConnection|portalSsoStore/);
    });
});
// =============================================================================
// PART 6 — Portal session extension
// =============================================================================
describe("Phase 2B Closure — portal session extension", () => {
    it("PortalSessionContext exposes federation + adaptive auth fields", () => {
        expect(SVC_SESSION).toMatch(/authMethod:\s*PortalAuthMethod/);
        expect(SVC_SESSION).toMatch(/ssoConnectionId:\s*string\s*\|\s*null/);
        expect(SVC_SESSION).toMatch(/ssoSubjectHash:\s*string\s*\|\s*null/);
        expect(SVC_SESSION).toMatch(/mfaSatisfied:\s*boolean/);
    });
    it("persists mfaSatisfiedAtUtc after a successful MFA challenge", () => {
        expect(SVC_SESSION).toMatch(/externalReviewerRoleAssignment\.update[\s\S]+mfaSatisfiedAtUtc:\s*new Date\(\)/);
    });
    it("respects the inactivity window without re-prompting MFA", () => {
        expect(SVC_SESSION).toMatch(/mfaSatisfiedRecently/);
        expect(SVC_SESSION).toMatch(/EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS/);
    });
    it("emits PORTAL_SESSION_EXPIRED + PORTAL_SESSION_REVOKED", () => {
        expect(SVC_SESSION).toMatch(/emitPortalSessionExpired/);
        expect(SVC_SESSION).toMatch(/emitPortalSessionRevoked/);
        expect(SVC_SESSION).toMatch(/"PORTAL_SESSION_EXPIRED"/);
        expect(SVC_SESSION).toMatch(/"PORTAL_SESSION_REVOKED"/);
    });
    it("token-lookup failure (expired / revoked) denies access fail-closed", () => {
        expect(SVC_SESSION).toMatch(/TOKEN_EXPIRED/);
        expect(SVC_SESSION).toMatch(/TOKEN_REVOKED/);
        expect(SVC_SESSION).toMatch(/TOKEN_INVALID/);
    });
    it("projection forwards federation chips into the portal response", () => {
        expect(SVC_PROJ).toMatch(/authMethod:\s*s\.authMethod/);
        expect(SVC_PROJ).toMatch(/ssoConnectionId:\s*s\.ssoConnectionId/);
        expect(SVC_PROJ).toMatch(/ssoSubjectHash:\s*s\.ssoSubjectHash/);
        expect(SVC_PROJ).toMatch(/mfaRequired:\s*s\.mfaRequired/);
        expect(SVC_PROJ).toMatch(/mfaSatisfied:\s*s\.mfaSatisfied/);
    });
});
// =============================================================================
// PART 7 — Routes
// =============================================================================
describe("Phase 2B Closure — HTTP routes", () => {
    it("mounts bulk + resend + delivery + send-email + reveal-token endpoints", () => {
        expect(ROUTES).toMatch(/\/v1\/external-review\/invitations\/bulk["']/);
        expect(ROUTES).toMatch(/\/v1\/external-review\/invitations\/bulk\/revoke/);
        expect(ROUTES).toMatch(/\/v1\/external-review\/invitations\/:id\/resend/);
        expect(ROUTES).toMatch(/\/v1\/external-review\/invitations\/:id\/delivery/);
        expect(ROUTES).toMatch(/\/v1\/external-review\/invitations\/:id\/send-email/);
        expect(ROUTES).toMatch(/\/v1\/external-review\/invitations\/:id\/reveal-token/);
        expect(ROUTES).toMatch(/\/v1\/external-review\/invitations\/:id\/sessions\/revoke/);
    });
    it("mounts SSO start + callback for the reviewer surface", () => {
        expect(ROUTES).toMatch(/\/v1\/portal\/sso\/start\/:grantId/);
        expect(ROUTES).toMatch(/\/v1\/portal\/sso\/callback["']/);
    });
    it("validates bulk inputs with BULK_INVITATION_MAX_ROWS upper bound", () => {
        expect(ROUTES).toMatch(/max\(BULK_INVITATION_MAX_ROWS\)/);
    });
    it("reveal-token enforces a bounded operator reason", () => {
        expect(ROUTES).toMatch(/reason:\s*z\.string\(\)\.min\(10\)\.max\(400\)/);
    });
});
// =============================================================================
// PART 8 — Operator UI surface (External Review Management Console)
// =============================================================================
describe("Phase 2B Closure — Operator Console UI", () => {
    it("renders the named console + tabs nav", () => {
        expect(UI_OPERATOR).toMatch(/External Review Management Console/);
        expect(UI_OPERATOR).toMatch(/data-console-tabs/);
        for (const tab of [
            "Active",
            "Pending",
            "Accepted",
            "Expired",
            "Revoked",
            "Bulk Invite",
        ]) {
            expect(UI_OPERATOR).toMatch(new RegExp(`label:\\s*"${tab}"`));
        }
    });
    it("exposes the bulk invite paste UI + per-row preview", () => {
        expect(UI_OPERATOR).toMatch(/data-bulk-paste/);
        expect(UI_OPERATOR).toMatch(/data-bulk-paste-preview/);
        expect(UI_OPERATOR).toMatch(/data-bulk-paste-valid/);
        expect(UI_OPERATOR).toMatch(/data-bulk-issue-submit/);
        expect(UI_OPERATOR).toMatch(/BULK_INVITATION_MAX_ROWS/);
    });
    it("exposes the delivery status panel + activity timeline", () => {
        expect(UI_OPERATOR).toMatch(/data-drawer-delivery-panel/);
        expect(UI_OPERATOR).toMatch(/data-deliveries-table/);
        expect(UI_OPERATOR).toMatch(/data-drawer-activity-panel/);
        expect(UI_OPERATOR).toMatch(/data-activity-timeline/);
    });
    it("exposes SSO controls — auth method, connection id, allowed domains", () => {
        expect(UI_OPERATOR).toMatch(/data-bulk-auth-method/);
        expect(UI_OPERATOR).toMatch(/data-bulk-sso-connection/);
        expect(UI_OPERATOR).toMatch(/data-bulk-allowed-domains/);
        expect(UI_OPERATOR).toMatch(/data-sso-auth-method/);
        expect(UI_OPERATOR).toMatch(/data-sso-connection-id/);
    });
    it("exposes MFA toggle + watermark policy selector", () => {
        expect(UI_OPERATOR).toMatch(/data-bulk-default-mfa/);
        expect(UI_OPERATOR).toMatch(/data-bulk-default-watermark/);
    });
    it("hides the manual token reveal behind explicit break-glass UI", () => {
        expect(UI_OPERATOR).toMatch(/data-drawer-break-glass/);
        expect(UI_OPERATOR).toMatch(/data-break-glass-arm/);
        expect(UI_OPERATOR).toMatch(/data-break-glass-reason/);
        expect(UI_OPERATOR).toMatch(/data-break-glass-confirm/);
        // Token text only renders inside the revealed state branch.
        expect(UI_OPERATOR).toMatch(/data-break-glass-token/);
        // The default workflow does not surface the raw token.
        expect(UI_OPERATOR).not.toMatch(/<textarea[^>]*data-invitation-raw-token/);
    });
    it("wires bulk resend + bulk revoke + per-row resend buttons", () => {
        expect(UI_OPERATOR).toMatch(/data-bulk-revoke-action/);
        expect(UI_OPERATOR).toMatch(/data-invitation-resend=/);
        expect(UI_OPERATOR).toMatch(/data-invitation-revoke=/);
    });
});
// =============================================================================
// PART 9 — Portal UX (accept + SSO callback + dashboard chips)
// =============================================================================
describe("Phase 2B Closure — Portal UX", () => {
    it("portal accept landing page exists + handles `?token=` capture", () => {
        expect(UI_ACCEPT).toMatch(/data-portal-accept-page/);
        expect(UI_ACCEPT).toMatch(/data-portal-accept-grant-id/);
        expect(UI_ACCEPT).toMatch(/searchParams\.get\("token"\)/);
        // The token is removed from the address bar immediately.
        expect(UI_ACCEPT).toMatch(/url\.searchParams\.delete\("token"\)/);
    });
    it("portal accept page exposes both link + SSO sign-in paths", () => {
        expect(UI_ACCEPT).toMatch(/data-portal-accept-open-with-token/);
        expect(UI_ACCEPT).toMatch(/data-portal-accept-sign-in-with-sso/);
        expect(UI_ACCEPT).toMatch(/startPortalSso/);
        expect(UI_ACCEPT).toMatch(/stashRawTokenForSso/);
    });
    it("portal accept page renders bounded denial + no-token states", () => {
        expect(UI_ACCEPT).toMatch(/data-portal-accept-sso-denied/);
        expect(UI_ACCEPT).toMatch(/data-portal-accept-no-token/);
        expect(UI_ACCEPT).toMatch(/data-portal-accept-fallback-link/);
    });
    it("portal SSO ACS callback route handler is in place", () => {
        expect(UI_SSO_CALLBACK).toMatch(/export async function POST/);
        expect(UI_SSO_CALLBACK).toMatch(/SAMLResponse/);
        expect(UI_SSO_CALLBACK).toMatch(/\/v1\/portal\/sso\/callback/);
        expect(UI_SSO_CALLBACK).toMatch(/portal\/accept/);
        expect(UI_SSO_CALLBACK).toMatch(/SAML_RESPONSE_MISSING/);
        expect(UI_SSO_CALLBACK).toMatch(/sso=denied/);
    });
    it("dashboard ribbon surfaces auth method + MFA + SSO chips", () => {
        expect(UI_DASHBOARD).toMatch(/data-portal-auth-method-chip/);
        expect(UI_DASHBOARD).toMatch(/data-portal-mfa-chip/);
        expect(UI_DASHBOARD).toMatch(/data-portal-sso-chip/);
        expect(UI_DASHBOARD).toMatch(/projection\.session\.authMethod/);
        expect(UI_DASHBOARD).toMatch(/projection\.session\.mfaRequired/);
        expect(UI_DASHBOARD).toMatch(/projection\.session\.mfaSatisfied/);
        expect(UI_DASHBOARD).toMatch(/projection\.session\.ssoConnectionId/);
    });
});
// =============================================================================
// PART 10 — Audit / activity mapping
// =============================================================================
describe("Phase 2B Closure — audit + activity hooks", () => {
    it("invitation list returns delivery + state + federation fields", () => {
        expect(SVC_INVITE).toMatch(/externalReviewInvitationDelivery\.findMany/);
        expect(SVC_INVITE).toMatch(/grantState/);
        expect(SVC_INVITE).toMatch(/expiresAtUtc/);
        expect(SVC_INVITE).toMatch(/authMethod:\s*a\.authMethod/);
        expect(SVC_INVITE).toMatch(/ssoConnectionId:\s*a\.ssoConnectionId/);
        expect(SVC_INVITE).toMatch(/allowedDomains:\s*a\.allowedDomains/);
    });
    it("break-glass token rotation primitive is bounded + audited", () => {
        expect(SVC_GRANT).toMatch(/rotateExternalReviewGrantToken/);
        expect(SVC_GRANT).toMatch(/breakGlass:\s*true/);
        expect(SVC_GRANT).toMatch(/input\.reason\.trim\(\)\.length\s*<\s*10/);
    });
});
