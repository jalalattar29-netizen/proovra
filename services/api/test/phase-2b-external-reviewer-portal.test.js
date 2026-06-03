/**
 * Phase 2B — External Reviewer Portal contract test.
 *
 * Pins the canonical surface introduced by Phase 2B:
 *
 *   1. Shared portal contracts (roles, capabilities, activity codes,
 *      decision verdicts, watermark policy, denial reasons,
 *      session timeouts, projection schema).
 *   2. Prisma models (Activity / Comments / Decisions / Role).
 *   3. Backend services (session, invitation, projection, activity,
 *      decisions, comments, watermark).
 *   4. Routes — internal invite mgmt + token-authenticated portal.
 *   5. Portal UI pages (token entry / dashboard / review surface)
 *      and watermark overlay component.
 *   6. Internal admin surface registered in REVIEW pillar.
 *   7. Runtime sanity: watermark HMAC round-trip + role capability
 *      gates.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTERNAL_REVIEWER_ROLES, EXTERNAL_PORTAL_CAPABILITIES, EXTERNAL_PORTAL_ACTIVITY_CODES, EXTERNAL_DECISION_VERDICTS, WATERMARK_POLICIES, externalPortalCapabilitiesForRole, } from "@proovra/shared";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
const SHARED = readSource("../../../packages/shared/src/external-review-portal.ts");
const SHARED_INDEX = readSource("../../../packages/shared/src/index.ts");
const SCHEMA = readSource("../../../services/api/prisma/schema.prisma");
const SVC_SESSION = readSource("../../../services/api/src/services/external-review/portal-session.service.ts");
const SVC_INVITE = readSource("../../../services/api/src/services/external-review/portal-invitation.service.ts");
const SVC_PROJ = readSource("../../../services/api/src/services/external-review/portal-projection.service.ts");
const SVC_ACTIVITY = readSource("../../../services/api/src/services/external-review/portal-activity.service.ts");
const SVC_DECISIONS = readSource("../../../services/api/src/services/external-review/portal-decisions.service.ts");
const SVC_COMMENTS = readSource("../../../services/api/src/services/external-review/portal-comments.service.ts");
const SVC_WATERMARK = readSource("../../../services/api/src/services/external-review/portal-watermark.service.ts");
const ROUTES = readSource("../../../services/api/src/routes/external-portal.routes.ts");
const SERVER = readSource("../../../services/api/src/server.ts");
const UI_TOKEN_ENTRY = readSource("../../../apps/web/app/portal/page.tsx");
const UI_DASHBOARD = readSource("../../../apps/web/app/portal/[token]/page.tsx");
const UI_REVIEW = readSource("../../../apps/web/app/portal/[token]/work/[workflowId]/page.tsx");
const UI_WATERMARK = readSource("../../../apps/web/components/external-portal/WatermarkOverlay.tsx");
const UI_CLIENT = readSource("../../../apps/web/lib/external-portal/portal-client.ts");
const UI_INTERNAL = readSource("../../../apps/web/app/(app)/review/external/page.tsx");
const ROUTE_REGISTRY = readSource("../../../apps/web/lib/navigation/routeRegistry.ts");
const PILLAR_REGISTRY = readSource("../../../apps/web/lib/navigation/pillarRegistry.ts");
// ===========================================================================
// 1. Shared contracts
// ===========================================================================
describe("Phase 2B — shared portal contracts", () => {
    it("EXTERNAL_REVIEWER_ROLES has the 6 canonical entries", () => {
        for (const r of [
            "EXTERNAL_VIEWER",
            "EXTERNAL_REVIEWER",
            "EXTERNAL_LEGAL_REVIEWER",
            "EXTERNAL_INSURANCE_REVIEWER",
            "EXTERNAL_OBSERVER",
            "EXTERNAL_APPROVER",
        ]) {
            expect(SHARED).toContain(`"${r}"`);
        }
    });
    it("EXTERNAL_PORTAL_CAPABILITIES declares the bounded operator vocabulary", () => {
        for (const c of [
            "portal.view",
            "portal.annotate",
            "portal.comment",
            "portal.decide",
            "portal.history.read",
            "portal.download_package",
        ]) {
            expect(SHARED).toContain(`"${c}"`);
        }
    });
    it("EXTERNAL_DECISION_VERDICTS = APPROVE / REJECT / REQUEST_CHANGES / ABSTAIN / ESCALATE", () => {
        for (const v of [
            "APPROVE",
            "REJECT",
            "REQUEST_CHANGES",
            "ABSTAIN",
            "ESCALATE",
        ]) {
            expect(SHARED).toContain(`"${v}"`);
        }
    });
    it("WATERMARK_POLICIES = ALWAYS / BYTES_ONLY / NEVER", () => {
        for (const p of ["ALWAYS", "BYTES_ONLY", "NEVER"]) {
            expect(SHARED).toContain(`"${p}"`);
        }
    });
    it("activity codes cover full grant + session + review lifecycle", () => {
        for (const code of [
            "GRANT_ISSUED",
            "GRANT_RESENT",
            "GRANT_REVOKED",
            "GRANT_ACCEPTED",
            "GRANT_EXPIRED",
            "LOGIN",
            "LOGOUT",
            "MFA_CHALLENGE_PASSED",
            "MFA_CHALLENGE_FAILED",
            "REVIEW_OPENED",
            "EVIDENCE_VIEWED",
            "ANNOTATION_CREATED",
            "COMMENT_POSTED",
            "DECISION_SUBMITTED",
        ]) {
            expect(SHARED).toContain(`"${code}"`);
        }
    });
    it("shared index re-exports the Phase 2B contracts", () => {
        for (const sym of [
            "EXTERNAL_REVIEWER_ROLES",
            "EXTERNAL_PORTAL_CAPABILITIES",
            "EXTERNAL_DECISION_VERDICTS",
            "WATERMARK_POLICIES",
            "EXTERNAL_PORTAL_LIMITATIONS",
        ]) {
            expect(SHARED_INDEX).toContain(sym);
        }
    });
});
// ===========================================================================
// 2. Role capability matrix runtime
// ===========================================================================
describe("Phase 2B — role capability matrix", () => {
    it("OBSERVER is read-only", () => {
        const caps = externalPortalCapabilitiesForRole("EXTERNAL_OBSERVER");
        expect(caps.has("portal.view")).toBe(true);
        expect(caps.has("portal.decide")).toBe(false);
        expect(caps.has("portal.annotate")).toBe(false);
    });
    it("REVIEWER can annotate + decide", () => {
        const caps = externalPortalCapabilitiesForRole("EXTERNAL_REVIEWER");
        expect(caps.has("portal.annotate")).toBe(true);
        expect(caps.has("portal.decide")).toBe(true);
        expect(caps.has("portal.comment")).toBe(true);
    });
    it("APPROVER can decide but cannot annotate", () => {
        const caps = externalPortalCapabilitiesForRole("EXTERNAL_APPROVER");
        expect(caps.has("portal.decide")).toBe(true);
        expect(caps.has("portal.annotate")).toBe(false);
    });
    it("every role exposes the bounded capability subset only", () => {
        for (const role of EXTERNAL_REVIEWER_ROLES) {
            const caps = externalPortalCapabilitiesForRole(role);
            for (const c of caps) {
                expect(EXTERNAL_PORTAL_CAPABILITIES).toContain(c);
            }
        }
    });
});
// ===========================================================================
// 3. Watermark HMAC round-trip
// ===========================================================================
describe("Phase 2B — watermark HMAC round-trip", () => {
    it("verifies a signature built with the same secret", async () => {
        const before = process.env.PORTAL_WATERMARK_HMAC;
        process.env.PORTAL_WATERMARK_HMAC = "phase-2b-test-hmac-secret-abc12345";
        try {
            const mod = await import("../src/services/external-review/portal-watermark.service.js");
            const signed = mod.buildSignedWatermark({
                grantId: "g-" + "0".repeat(36),
                sessionId: "abcdef0123456789".repeat(2),
                reviewerEmail: "ext@example.test",
                reviewerDisplayName: "Ext Reviewer",
                organization: "Acme Counsel",
                evidenceId: "e-" + "0".repeat(34),
                grantExpiresAtUtc: new Date(Date.now() + 60 * 60 * 1000),
            });
            expect(signed).not.toBeNull();
            expect(typeof signed.signatureHex).toBe("string");
            const verdict = mod.verifySignedWatermark(signed);
            expect(verdict.valid).toBe(true);
        }
        finally {
            if (before === undefined)
                delete process.env.PORTAL_WATERMARK_HMAC;
            else
                process.env.PORTAL_WATERMARK_HMAC = before;
        }
    });
    it("rejects tampered payload", async () => {
        const before = process.env.PORTAL_WATERMARK_HMAC;
        process.env.PORTAL_WATERMARK_HMAC = "phase-2b-test-hmac-secret-abc12345";
        try {
            const mod = await import("../src/services/external-review/portal-watermark.service.js");
            const signed = mod.buildSignedWatermark({
                grantId: "g-" + "0".repeat(36),
                sessionId: "abcdef0123456789".repeat(2),
                reviewerEmail: "ext@example.test",
                reviewerDisplayName: null,
                organization: null,
                evidenceId: null,
                grantExpiresAtUtc: new Date(Date.now() + 60 * 60 * 1000),
            });
            expect(signed).not.toBeNull();
            const tampered = {
                payload: { ...signed.payload, reviewerEmail: "evil@evil.test" },
                signatureHex: signed.signatureHex,
            };
            const verdict = mod.verifySignedWatermark(tampered);
            expect(verdict.valid).toBe(false);
        }
        finally {
            if (before === undefined)
                delete process.env.PORTAL_WATERMARK_HMAC;
            else
                process.env.PORTAL_WATERMARK_HMAC = before;
        }
    });
});
// ===========================================================================
// 4. Prisma schema
// ===========================================================================
describe("Phase 2B — Prisma schema", () => {
    it("declares ExternalReviewerRoleAssignment", () => {
        expect(SCHEMA).toMatch(/^model ExternalReviewerRoleAssignment \{/m);
    });
    it("declares ExternalReviewActivity", () => {
        expect(SCHEMA).toMatch(/^model ExternalReviewActivity \{/m);
    });
    it("declares ExternalReviewComment (threaded)", () => {
        expect(SCHEMA).toMatch(/^model ExternalReviewComment \{/m);
        const block = SCHEMA.match(/^model ExternalReviewComment \{[\s\S]*?\n\}/m)[0];
        expect(block).toContain("parentCommentId");
        expect(block).toContain("ExternalReviewCommentThread");
    });
    it("declares ExternalReviewDecision with grant+workflow uniqueness", () => {
        expect(SCHEMA).toMatch(/^model ExternalReviewDecision \{/m);
        const block = SCHEMA.match(/^model ExternalReviewDecision \{[\s\S]*?\n\}/m)[0];
        expect(block).toMatch(/@@unique\(\[grantId,\s*workflowId\]/);
    });
});
// ===========================================================================
// 5. Services
// ===========================================================================
describe("Phase 2B — backend services", () => {
    it("session service establishes + ends a portal session", () => {
        expect(SVC_SESSION).toMatch(/establishPortalSession/);
        expect(SVC_SESSION).toMatch(/endPortalSession/);
        expect(SVC_SESSION).toMatch(/MFA_REQUIRED/);
        expect(SVC_SESSION).toMatch(/MFA_INVALID/);
    });
    it("invitation service exposes issue / revoke / accept / list", () => {
        expect(SVC_INVITE).toMatch(/export\s+async\s+function\s+issueInvitation/);
        expect(SVC_INVITE).toMatch(/export\s+async\s+function\s+revokeInvitation/);
        expect(SVC_INVITE).toMatch(/export\s+async\s+function\s+acceptInvitation/);
        expect(SVC_INVITE).toMatch(/export\s+async\s+function\s+listInvitationsForTeam/);
    });
    it("projection assembles the bounded dashboard shape", () => {
        expect(SVC_PROJ).toMatch(/projectPortalDashboard/);
        expect(SVC_PROJ).toMatch(/EXTERNAL_PORTAL_LIMITATIONS/);
        expect(SVC_PROJ).toMatch(/buildSignedWatermark/);
    });
    it("activity service emits bounded codes only", () => {
        expect(SVC_ACTIVITY).toMatch(/EXTERNAL_PORTAL_ACTIVITY_CODES/);
        expect(SVC_ACTIVITY).toMatch(/emitPortalActivity/);
        expect(SVC_ACTIVITY).toMatch(/listPortalActivity/);
    });
    it("decisions service records one decision per (grant, workflow)", () => {
        expect(SVC_DECISIONS).toMatch(/submitExternalDecision/);
        expect(SVC_DECISIONS).toMatch(/external_review_decision_grant_workflow_uniq/);
    });
    it("comments service enforces one-level threading", () => {
        expect(SVC_COMMENTS).toMatch(/postCommentInWorkflow/);
        expect(SVC_COMMENTS).toMatch(/parent\.parentCommentId !== null/);
    });
    it("watermark service signs + verifies bounded payload", () => {
        expect(SVC_WATERMARK).toMatch(/buildSignedWatermark/);
        expect(SVC_WATERMARK).toMatch(/verifySignedWatermark/);
        expect(SVC_WATERMARK).toMatch(/createHmac/);
    });
});
// ===========================================================================
// 6. Routes
// ===========================================================================
describe("Phase 2B — routes", () => {
    for (const path of [
        '"/v1/external-review/invitations"',
        '"/v1/external-review/invitations/:id/revoke"',
        '"/v1/external-review/invitations/:id/activity"',
        '"/v1/portal/auth"',
        '"/v1/portal/logout"',
        '"/v1/portal/dashboard"',
        '"/v1/portal/work/:workflowId/comments"',
        '"/v1/portal/work/:workflowId/decision"',
        '"/v1/portal/work/:workflowId/decisions"',
        '"/v1/portal/work/:workflowId/view"',
        '"/v1/portal/activity"',
    ]) {
        it(`registers ${path}`, () => {
            expect(ROUTES).toContain(path);
        });
    }
    it("server.ts registers externalPortalRoutes", () => {
        expect(SERVER).toMatch(/externalPortalRoutes/);
        expect(SERVER).toMatch(/app\.register\(externalPortalRoutes\)/);
    });
    it("portal session resolver enforces bounded denial reasons", () => {
        expect(ROUTES).toMatch(/TOKEN_INVALID/);
        expect(ROUTES).toMatch(/NOT_PERMITTED/);
        expect(ROUTES).toMatch(/portal\.decide/);
        expect(ROUTES).toMatch(/portal\.comment/);
    });
});
// ===========================================================================
// 7. Portal UI
// ===========================================================================
describe("Phase 2B — portal UI", () => {
    it("token entry page authenticates + reveals an MFA challenge when required", () => {
        expect(UI_TOKEN_ENTRY).toMatch(/data-portal-token-input/);
        expect(UI_TOKEN_ENTRY).toMatch(/data-portal-mfa-input/);
        expect(UI_TOKEN_ENTRY).toMatch(/MFA_REQUIRED/);
    });
    it("portal dashboard renders ribbon + assigned table + limitations", () => {
        expect(UI_DASHBOARD).toMatch(/data-portal-dashboard/);
        expect(UI_DASHBOARD).toMatch(/data-portal-assigned-row/);
        expect(UI_DASHBOARD).toMatch(/data-portal-limitations/);
        expect(UI_DASHBOARD).toMatch(/data-portal-logout/);
    });
    it("portal review surface mounts WatermarkOverlay + decision + comments", () => {
        expect(UI_REVIEW).toMatch(/WatermarkOverlay/);
        expect(UI_REVIEW).toMatch(/data-portal-decision-panel/);
        expect(UI_REVIEW).toMatch(/data-portal-comments-panel/);
        expect(UI_REVIEW).toMatch(/data-portal-decision-btn/);
        expect(UI_REVIEW).toMatch(/EXTERNAL_DECISION_VERDICTS/);
    });
    it("WatermarkOverlay uses pointer-events: none + bounded fields", () => {
        expect(UI_WATERMARK).toMatch(/pointerEvents:\s*["']none["']/);
        expect(UI_WATERMARK).toMatch(/data-portal-watermark-overlay/);
        expect(UI_WATERMARK).toMatch(/userSelect:\s*["']none["']/);
    });
    it("portal client never persists the bearer to localStorage", () => {
        // Strip block + line comments so the documentation mention of
        // "localStorage" in the rationale paragraph doesn't trigger.
        const code = UI_CLIENT.replace(/\/\*[\s\S]*?\*\//g, "")
            .split(/\n/)
            .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
            .join("\n");
        expect(code).not.toMatch(/localStorage/);
        expect(code).toMatch(/sessionStorage/);
        expect(UI_CLIENT).toMatch(/Authorization/);
        expect(UI_CLIENT).toMatch(/x-portal-session/);
    });
});
// ===========================================================================
// 8. Internal invitation admin surface
// ===========================================================================
describe("Phase 2B — internal invitation admin", () => {
    it("page renders the operator console + bulk-issue submit + revoke action", () => {
        // Phase 2B Closure replaced the single-issue admin shell with the
        // External Review Management Console. The bulk-issue form is the
        // primary issue path; the raw-token reveal is hidden behind the
        // explicit `data-break-glass-token` UI surface. Both are pinned
        // exhaustively in `phase-2b-closure-external-portal.test.ts` —
        // here we only assert the closure-era replacement landed.
        expect(UI_INTERNAL).toMatch(/data-bulk-issue-submit/);
        expect(UI_INTERNAL).toMatch(/data-break-glass-token/);
        expect(UI_INTERNAL).toMatch(/data-invitation-revoke/);
        expect(UI_INTERNAL).toMatch(/EXTERNAL_REVIEWER_ROLES/);
        expect(UI_INTERNAL).toMatch(/WATERMARK_POLICIES/);
    });
    it("registered in REVIEW pillar nav", () => {
        expect(ROUTE_REGISTRY).toMatch(/id:\s*"workspace\.review_external"/);
        expect(PILLAR_REGISTRY).toMatch(/"workspace\.review_external"[\s,]+"REVIEW"/);
    });
});
// ===========================================================================
// 9. Closure sanity — enum bounds
// ===========================================================================
describe("Phase 2B — enum bound check", () => {
    it("EXTERNAL_REVIEWER_ROLES has exactly 6 entries", () => {
        expect(EXTERNAL_REVIEWER_ROLES.length).toBe(6);
    });
    it("EXTERNAL_PORTAL_CAPABILITIES has exactly 6 entries", () => {
        expect(EXTERNAL_PORTAL_CAPABILITIES.length).toBe(6);
    });
    it("EXTERNAL_DECISION_VERDICTS has exactly 5 entries", () => {
        expect(EXTERNAL_DECISION_VERDICTS.length).toBe(5);
    });
    it("WATERMARK_POLICIES has exactly 3 entries", () => {
        expect(WATERMARK_POLICIES.length).toBe(3);
    });
    it("activity catalog covers 19 bounded codes", () => {
        expect(EXTERNAL_PORTAL_ACTIVITY_CODES.length).toBeGreaterThanOrEqual(19);
    });
});
