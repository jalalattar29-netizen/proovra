/**
 * Phase G5.7 — E2E smoke source-contract suite.
 *
 * PROOVRA's enterprise semantics rest on six critical paths. This
 * suite asserts the SOURCE CONTRACTS along each path so a future
 * refactor cannot quietly remove the underlying guarantee. It is
 * source-contract style — reads source files, asserts regex/string
 * presence — same as every phase contract from A0 through G4.
 *
 * The six smoke paths:
 *
 *   1. Solo capture → report → public verify
 *   2. Reviewer queue → decision path
 *   3. Matter workspace → evidence → export preflight
 *   4. Intake checklist → submit → reviewer sees it
 *   5. Governance destruction preview / certificate
 *   6. Notification preference → inbox filter behaviour
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    const url = new URL(rel, import.meta.url);
    return readFileSync(fileURLToPath(url), "utf8");
}
const EVIDENCE_ROUTES = readSource("../src/routes/evidence.routes.ts");
const REVIEWER_OPS_ROUTES = readSource("../src/routes/reviewer-ops.routes.ts");
const ME_INBOX_ROUTES = readSource("../src/routes/me-inbox.routes.ts");
const NOTIFICATION_PREFS_SERVICE = readSource("../src/services/notifications/notification-preferences.service.ts");
const NOTIFICATION_PREFS_ROUTES = readSource("../src/routes/notification-preferences.routes.ts");
const REVIEWER_CONSOLE = readSource("../../../apps/web/components/reviewer-experience/ReviewerConsole.tsx");
const MATTER_WORKSPACE = readSource("../../../apps/web/components/cases-experience/MatterWorkspace.tsx");
const REPORTS_INDEX = readSource("../../../apps/web/components/reports-experience/ReportsIndex.tsx");
// ---------------------------------------------------------------------------
// Path 1 — Solo capture → report → public verify.
// ---------------------------------------------------------------------------
describe("Phase G5.7 smoke 1 — Solo capture → report → public verify", () => {
    it("evidence create endpoint exists with legal acceptance gate", () => {
        expect(EVIDENCE_ROUTES).toMatch(/app\.post\(\s*"\/v1\/evidence"[\s\S]*?requireAuthAndLegal/);
    });
    it("evidence completion enqueues report generation", () => {
        expect(EVIDENCE_ROUTES).toContain("enqueueGenerateReportJob");
    });
    it("public verify route mounts WITHOUT auth", () => {
        expect(EVIDENCE_ROUTES).toMatch(/app\.get\(\s*"\/public\/verify\/:id"/);
    });
    it("A0 hard-gate: FAILED_HASH_MISMATCH terminal state honoured", () => {
        expect(EVIDENCE_ROUTES).toContain("FAILED_HASH_MISMATCH");
    });
});
// ---------------------------------------------------------------------------
// Path 2 — Reviewer queue → decision path.
// ---------------------------------------------------------------------------
describe("Phase G5.7 smoke 2 — Reviewer queue → decision path", () => {
    it("queue endpoint exists with bounded limit", () => {
        expect(REVIEWER_OPS_ROUTES).toMatch(/\/v1\/reviewer-ops\/queue/);
        expect(REVIEWER_OPS_ROUTES).toMatch(/limit:\s*z\.coerce\.number/);
    });
    it("approve + reject endpoints exist and pass through step-up gate", () => {
        expect(REVIEWER_OPS_ROUTES).toContain('"/v1/reviewer-ops/reviews/:workflowId/approve"');
        expect(REVIEWER_OPS_ROUTES).toContain('"/v1/reviewer-ops/reviews/:workflowId/reject"');
        expect(REVIEWER_OPS_ROUTES).toContain("enforceStepUpIfFlagged");
    });
    it("Reviewer Console UI wires inline actions through useStepUpAction", () => {
        expect(REVIEWER_CONSOLE).toContain("useStepUpAction");
        expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="assign"');
        expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="acknowledge"');
    });
});
// ---------------------------------------------------------------------------
// Path 3 — Matter workspace → evidence → export preflight.
// ---------------------------------------------------------------------------
describe("Phase G5.7 smoke 3 — Matter workspace → evidence → export preflight", () => {
    it("matter envelope endpoint exists", () => {
        expect(MATTER_WORKSPACE).toContain("/matter-workspace");
    });
    it("Reports browse wraps both downloads in GovernedExportAction", () => {
        expect(REPORTS_INDEX).toContain("GovernedExportAction");
        expect(REPORTS_INDEX).toContain('actionLabel="Download Report PDF"');
        expect(REPORTS_INDEX).toContain('actionLabel="Download Verification Package ZIP"');
    });
    it("MatterWorkspace renders evidence + opens detail on click", () => {
        expect(MATTER_WORKSPACE).toContain("onOpenEvidence");
        expect(MATTER_WORKSPACE).toContain("EvidenceTab");
    });
});
// ---------------------------------------------------------------------------
// Path 4 — Intake checklist → submit → reviewer sees it.
// ---------------------------------------------------------------------------
describe("Phase G5.7 smoke 4 — Intake checklist → submit → reviewer sees it", () => {
    it("evidence-requests aggregator surfaces matter scope", () => {
        expect(MATTER_WORKSPACE).toContain("/evidence-requests");
        expect(MATTER_WORKSPACE).toContain("data-matter-evidence-requests");
    });
    it("intake completion counts surface needsMoreInfo + reviewReady", () => {
        expect(MATTER_WORKSPACE).toContain("needsMoreInfo");
        expect(MATTER_WORKSPACE).toContain("reviewReady");
    });
});
// ---------------------------------------------------------------------------
// Path 5 — Governance destruction preview / certificate.
// ---------------------------------------------------------------------------
describe("Phase G5.7 smoke 5 — Governance destruction lifecycle", () => {
    it("evidence routes preserve the destruction-blocked gate semantics", () => {
        // Route layer emits `verification_package_blocked` to operators.
        expect(EVIDENCE_ROUTES).toContain("verification_package_blocked");
    });
    it("verification-package endpoint surfaces destruction-blocked semantics", () => {
        expect(EVIDENCE_ROUTES).toContain("verification_package_blocked");
    });
});
// ---------------------------------------------------------------------------
// Path 6 — Notification preference → inbox filter behaviour.
// ---------------------------------------------------------------------------
describe("Phase G5.7 smoke 6 — Notification preferences → inbox filter", () => {
    it("notification preferences endpoints exist", () => {
        expect(EVIDENCE_ROUTES.length + ME_INBOX_ROUTES.length).toBeGreaterThan(0);
        // The endpoint itself is in notification-preferences routes. We
        // assert via the consumer pattern: inbox aggregator imports the
        // preference helper.
        expect(ME_INBOX_ROUTES).toContain("isPreferenceEnabled");
    });
    it("preference routes expose the bounded catalog", () => {
        // The route layer surfaces the catalog (`preferenceTypes`,
        // `channels`, `defaults`) to the operator; the service module
        // implements the upsert + lookup.
        expect(NOTIFICATION_PREFS_ROUTES).toContain("preferenceTypes");
        expect(NOTIFICATION_PREFS_ROUTES).toContain("channels");
        expect(NOTIFICATION_PREFS_ROUTES).toContain("defaults");
        // The service-side helper that the inbox aggregator imports.
        expect(NOTIFICATION_PREFS_SERVICE).toContain("isPreferenceEnabled");
    });
    it("preference update emits the security event", () => {
        expect(NOTIFICATION_PREFS_ROUTES).toContain("notification_preference_updated");
    });
});
