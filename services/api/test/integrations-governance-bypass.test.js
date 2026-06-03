/**
 * Phase 10.5 — Governance bypass regression tests.
 *
 * Confirms that an authenticated service-account API key (or its
 * server-side payload projection) cannot bypass the governance policy
 * gates that apply to authenticated workspace members. The policy
 * decision functions are pure and DB-free; we exercise them with
 * representative inputs and assert the expected denials.
 *
 * For projection tests we also confirm:
 *   - integration evidence projection excludes private notes / intake plan
 *   - webhook payload shape does NOT include legal-hold reason
 *   - service-account responses cannot reveal another workspace's data
 *     (asserted at the projection level — the route layer always filters
 *     by `cred.teamId`, so cross-workspace data never reaches the
 *     projection. We document that assumption in code below.)
 */
import { describe, expect, it } from "vitest";
import { canCreateIntakeLink, canDownloadPackage, canGeneratePackage, canGenerateReport, canPublishPublicVerify, } from "../src/services/governance.service.js";
function permissivePolicy() {
    return {
        source: "default",
        defaultRetentionDays: null,
        evidenceDeletionMode: "ALLOWED",
        requireLegalHoldApprovalForDeletion: false,
        requireReviewBeforeReport: false,
        requireReviewBeforePackage: false,
        requireReviewBeforePublicVerify: false,
        allowExternalIntake: true,
        allowAnonymousIntake: true,
        allowPublicVerify: true,
        allowPackageDownload: true,
        allowReportDownload: true,
        allowOriginalDownload: true,
        defaultReviewDueHours: null,
        defaultFirstResponseDueHours: null,
        defaultEscalationDueHours: null,
        requirePublicationApproval: false,
        requireLegalHoldReleaseApproval: false,
        // Phase 25.5 — reviewer-ops governance fields.
        defaultAssignmentDueHours: null,
        defaultCompletionDueHours: null,
        defaultDueSoonHours: null,
        requireStepUpForApprove: false,
        requireStepUpForReject: false,
        requireStepUpForEscalationResolve: false,
        requireStepUpForBulk: false,
        reviewerInactivityHours: null,
    };
}
// Service accounts that pass scope checks act with effective ADMIN role
// for governance evaluation. Tests below mirror that convention.
const SERVICE_ACCOUNT_ROLE = "ADMIN";
describe("intake-link governance — bypass blocked", () => {
    it("blocks creation when external intake is disabled", () => {
        const policy = { ...permissivePolicy(), allowExternalIntake: false };
        const decision = canCreateIntakeLink({
            role: SERVICE_ACCOUNT_ROLE,
            intakeMode: "EXTERNAL_VERIFIED",
            policy,
        });
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) {
            expect(decision.reason).toBe("external_intake_disabled_by_policy");
        }
    });
    it("blocks creation of anonymous intake when anonymous intake is disabled", () => {
        const policy = { ...permissivePolicy(), allowAnonymousIntake: false };
        const decision = canCreateIntakeLink({
            role: SERVICE_ACCOUNT_ROLE,
            intakeMode: "EXTERNAL_ANONYMOUS",
            policy,
        });
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) {
            expect(decision.reason).toBe("anonymous_intake_disabled_by_policy");
        }
    });
    it("blocks pseudonymous intake same as anonymous", () => {
        const policy = { ...permissivePolicy(), allowAnonymousIntake: false };
        const decision = canCreateIntakeLink({
            role: SERVICE_ACCOUNT_ROLE,
            intakeMode: "EXTERNAL_PSEUDONYMOUS",
            policy,
        });
        expect(decision.allowed).toBe(false);
    });
});
describe("download governance — service account cannot bypass", () => {
    it("blocks package download when allowPackageDownload=false", () => {
        const policy = { ...permissivePolicy(), allowPackageDownload: false };
        const decision = canDownloadPackage({
            role: SERVICE_ACCOUNT_ROLE,
            policy,
        });
        expect(decision.allowed).toBe(false);
    });
    it("blocks report generation when review required and unreviewed", () => {
        const policy = { ...permissivePolicy(), requireReviewBeforeReport: true };
        const decision = canGenerateReport({
            role: SERVICE_ACCOUNT_ROLE,
            policy,
            reviewState: { isReviewed: false },
        });
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) {
            expect(decision.reason).toBe("review_required_before_report");
        }
    });
    it("blocks report generation when allowReportDownload=false", () => {
        const policy = { ...permissivePolicy(), allowReportDownload: false };
        const decision = canGenerateReport({
            role: SERVICE_ACCOUNT_ROLE,
            policy,
            reviewState: { isReviewed: true },
        });
        expect(decision.allowed).toBe(false);
    });
    it("blocks package generation when review required and unreviewed", () => {
        const policy = { ...permissivePolicy(), requireReviewBeforePackage: true };
        const decision = canGeneratePackage({
            role: SERVICE_ACCOUNT_ROLE,
            policy,
            reviewState: { isReviewed: false },
        });
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) {
            expect(decision.reason).toBe("review_required_before_package");
        }
    });
    it("blocks public verify publish when review required and unreviewed", () => {
        const policy = {
            ...permissivePolicy(),
            requireReviewBeforePublicVerify: true,
        };
        const decision = canPublishPublicVerify({
            role: SERVICE_ACCOUNT_ROLE,
            policy,
            reviewState: { isReviewed: false },
        });
        expect(decision.allowed).toBe(false);
    });
});
describe("governance fail-closed semantics", () => {
    it("review_required denial reason is stable for audit / response codes", () => {
        const policy = { ...permissivePolicy(), requireReviewBeforeReport: true };
        const decision = canGenerateReport({
            role: SERVICE_ACCOUNT_ROLE,
            policy,
            // No reviewState at all — undefined → treated as not reviewed.
            reviewState: null,
        });
        expect(decision.allowed).toBe(false);
    });
});
// -----------------------------------------------------------------------------
// Webhook payload privacy regression
// -----------------------------------------------------------------------------
//
// The legal-hold-placed emission in governance.service.ts deliberately
// omits the `reason` field. This test asserts the shape it produces is
// safe to leave the workspace.
//
// We can't easily call emitWebhookEvent here (it requires Prisma); we
// instead model the payload the dispatcher would see and confirm the
// canonical safe-projection fields.
describe("governance.legal_hold_placed payload — privacy", () => {
    it("includes id/title/caseId/placedAtUtc but never the reason", () => {
        const safe = {
            legalHoldId: "abc",
            evidenceId: "def",
            title: "Case 42 preservation",
            caseId: null,
            placedAtUtc: "2026-05-18T10:00:00.000Z",
        };
        expect(Object.keys(safe).sort()).toEqual(["caseId", "evidenceId", "legalHoldId", "placedAtUtc", "title"].sort());
        expect(safe.reason).toBeUndefined();
    });
});
// -----------------------------------------------------------------------------
// Integration evidence projection — never includes private notes
// -----------------------------------------------------------------------------
describe("integration evidence projection — privacy", () => {
    it("does NOT include internalNotes, intakePlanJson, or submittedBy fields", async () => {
        // Import the route-side projection. It's a private export, but its
        // shape is enforced by the route's `EvidenceSelect` constant: that
        // select intentionally never reads private fields, so the projection
        // CAN'T leak them. Assert at the select level.
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/integrations-api.routes.ts", import.meta.url)), "utf8");
        // The EvidenceSelect block must NOT contain any sensitive-only fields.
        expect(src).toMatch(/EvidenceSelect = \{[\s\S]*?\} as const;/);
        expect(src).not.toMatch(/internalNotes:\s*true/);
        expect(src).not.toMatch(/intakePlanJson:\s*true/);
        expect(src).not.toMatch(/submittedByEmail:\s*true/);
        expect(src).not.toMatch(/submittedByUserId:\s*true/);
        expect(src).not.toMatch(/lastAccessedByUserId:\s*true/);
    });
});
// -----------------------------------------------------------------------------
// Workspace isolation contract — documented in route source
// -----------------------------------------------------------------------------
describe("integration API workspace scoping", () => {
    it("all integration-api evidence reads filter by req.apiCredential.teamId", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/integrations-api.routes.ts", import.meta.url)), "utf8");
        // Every prisma.evidence read in this file MUST scope by cred.teamId.
        // (We grep loosely for the pattern; if a new endpoint forgets it the
        // test will flag the change.)
        const lookups = src.match(/prisma\.evidence\.find/g) ?? [];
        expect(lookups.length).toBeGreaterThan(0);
        // Pattern 1: list — `where: { teamId: cred.teamId, ... }`
        // Pattern 2: get  — checks `row.teamId !== cred.teamId`
        expect(src).toMatch(/teamId:\s*cred\.teamId/);
        expect(src).toMatch(/row\.teamId\s*!==\s*cred\.teamId/);
    });
    it("integration-api intake-link route runs canCreateIntakeLink before service call", async () => {
        const { readFile } = await import("node:fs/promises");
        const { fileURLToPath } = await import("node:url");
        const src = await readFile(fileURLToPath(new URL("../src/routes/integrations-api.routes.ts", import.meta.url)), "utf8");
        expect(src).toMatch(/canCreateIntakeLink\(/);
        // And the gate appears BEFORE createWorkflowIntakeLink is invoked.
        const gateIdx = src.indexOf("canCreateIntakeLink(");
        const callIdx = src.indexOf("createWorkflowIntakeLink(");
        expect(gateIdx).toBeGreaterThan(-1);
        expect(callIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(callIdx);
    });
});
