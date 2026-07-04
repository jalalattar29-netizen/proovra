/**
 * Phase C #17 — tests for the new forensic-semantics behavior.
 *
 * These tests are intentionally pure-function focused so they can run
 * without a database / S3 fixture. Database-backed behavior (e.g. that
 * EVIDENCE_LOCKED is not appended on no-op retention; that public verify
 * rejects pre-finalized records; that the reaper marks expired drafts) is
 * exercised end-to-end in the deployed integration suite.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROOVRA_FORBIDDEN_SURFACE_PATTERNS, } from "@proovra/shared-evidence-presentation";
import { sanitizePageContextPath } from "../src/services/ai/ai-chat.service.js";
import { buildDefaultCaptureDraftExpiry, CAPTURE_DRAFT_EXPIRY_DAYS, CAPTURE_DRAFT_EXPIRY_MS, sanitizeCaptureSessionItem, } from "../src/services/capture-draft-governance.js";
import { buildTrustDecisionConsistency } from "../src/services/trust-decision-consistency.service.js";
import { resolveReviewerArtifactRole } from "@proovra/shared";
const SNAPSHOT_TRUST_DECISION = {
    verdict: "VERIFIED",
    level: "standard",
    tone: "warning",
    presentationState: "VERIFIED_PENDING_ANCHORING",
    presentationTone: "warning",
    anchoringState: "pending",
    score: 84,
    maxScore: 100,
    scoreLabel: "84/100",
    verdictLabel: "Recorded integrity verified; Bitcoin anchoring pending",
    shortLabel: "Anchoring pending",
    summary: "Recorded integrity is verified, but public anchoring is still pending.",
    narrative: "Recorded integrity is verified, but independent public anchoring is not finalized yet.",
    primaryReason: "Publication is pending.",
    reviewerAction: "Recheck publication later if independent anchoring is required.",
    legalBoundary: "Integrity verification is not a truth finding.",
    degradedButUsable: true,
    relianceLevel: "high",
    signals: [
        {
            key: "core_integrity",
            label: "Core integrity",
            status: "passed",
            tone: "success",
            points: 25,
            maxPoints: 25,
            summary: "Core integrity verified",
            detail: "Core materials are present and consistent.",
        },
        {
            key: "signature",
            label: "Digital signature",
            status: "passed",
            tone: "success",
            points: 15,
            maxPoints: 15,
            summary: "Signature package recorded",
            detail: "Signature materials are available.",
        },
        {
            key: "trusted_timestamp",
            label: "Trusted timestamp",
            status: "passed",
            tone: "success",
            points: 15,
            maxPoints: 15,
            summary: "Trusted timestamp recorded",
            detail: "RFC 3161 timestamp material is present.",
        },
        {
            key: "bitcoin_anchoring",
            label: "Bitcoin anchoring",
            status: "pending",
            tone: "warning",
            points: 9,
            maxPoints: 15,
            summary: "OpenTimestamps proof present; Bitcoin anchoring pending",
            detail: "Independent public anchoring has not completed yet.",
        },
        {
            key: "immutable_storage",
            label: "Immutable storage",
            status: "passed",
            tone: "success",
            points: 15,
            maxPoints: 15,
            summary: "Immutable retention verified",
            detail: "Object Lock metadata is verified.",
        },
    ],
    passedSignals: 4,
    degradedSignals: 1,
    failedSignals: 0,
};
function cloneTrustDecision() {
    return JSON.parse(JSON.stringify(SNAPSHOT_TRUST_DECISION));
}
function readRepoFile(...segments) {
    return readFileSync(resolve("D:/digital-witness", ...segments), "utf8");
}
describe("ai-chat sanitizePageContextPath (Phase C #3)", () => {
    it("returns null for empty/missing input", () => {
        expect(sanitizePageContextPath(null)).toBeNull();
        expect(sanitizePageContextPath(undefined)).toBeNull();
        expect(sanitizePageContextPath("")).toBeNull();
        expect(sanitizePageContextPath("   ")).toBeNull();
    });
    it("rejects suspiciously long input", () => {
        const longPath = "/a/" + "x".repeat(300);
        expect(sanitizePageContextPath(longPath)).toBeNull();
    });
    it("redacts UUID segments to :id", () => {
        expect(sanitizePageContextPath("/evidence/123e4567-e89b-12d3-a456-426614174000")).toBe("/evidence/:id");
    });
    it("redacts long hex tokens to :token", () => {
        expect(sanitizePageContextPath("/invite/abcdef1234567890abcdef1234567890")).toBe("/invite/:token");
    });
    it("redacts other long dynamic segments to :dynamic", () => {
        expect(sanitizePageContextPath("/case/Long-Case-Name-That-Looks-Sensitive")).toBe("/case/:dynamic");
    });
    it("preserves short, structural segments", () => {
        expect(sanitizePageContextPath("/evidence/list")).toBe("/evidence/list");
        expect(sanitizePageContextPath("/capture")).toBe("/capture");
    });
});
describe("public verify semantics (Governance Item 1)", () => {
    it("keeps meaningful verification separate from public-view analytics in API + UI", () => {
        const routeSource = readRepoFile("services", "api", "src", "routes", "evidence.routes.ts");
        const verifyPageSource = readRepoFile("apps", "web", "app", "verify", "[token]", "page.tsx");
        expect(routeSource).toContain("lastVerifiedAtUtc: evidence.lastVerifiedAtUtc");
        expect(routeSource).toContain("currentPublicVerifyViewAtUtc: verifiedAt");
        expect(routeSource).toContain("lastPublicVerifyViewAtUtc: verifiedAt");
        expect(routeSource).toContain('custodyEventSampled: false');
        expect(routeSource).toContain('code: "EVIDENCE_NOT_FINALIZED"');
        expect(verifyPageSource).toContain('label: "Last meaningful verification"');
        expect(verifyPageSource).toContain('label: "Last public verify page view"');
        expect(verifyPageSource).toContain('label: "Current public verify page view"');
        expect(verifyPageSource).not.toContain('label: "Last Verified At"');
        expect(verifyPageSource).toContain("getTrustDecisionConfidenceLabel");
        expect(verifyPageSource).toContain("Recorded integrity verified; Bitcoin anchoring pending");
    });
    it("classifies access-only divergence as informational and non-integrity-critical", () => {
        const result = buildTrustDecisionConsistency({
            snapshotTrustDecision: cloneTrustDecision(),
            liveTrustDecision: cloneTrustDecision(),
            source: "REPORT_SNAPSHOT",
            snapshotGeneratedAtUtc: "2026-01-01T00:00:00.000Z",
            latestReportGeneratedAtUtc: "2026-01-01T00:00:00.000Z",
            latestVerificationPackageGeneratedAtUtc: "2026-01-01T00:00:00.000Z",
            forensicEventsAtSnapshot: 5,
            currentForensicEvents: 5,
            accessEventsAfterSnapshot: 3,
        });
        expect(result.consistentWithSnapshot).toBe(false);
        expect(result.accessOnly).toBe(true);
        expect(result.integrityCritical).toBe(false);
        expect(result.tone).toBe("info");
        expect(result.reasons).toHaveLength(1);
        expect(result.reasons[0]?.code).toBe("ACCESS_ACTIVITY_CHANGED");
    });
    it("classifies integrity-critical divergence separately from access drift", () => {
        const live = cloneTrustDecision();
        const timestampSignal = live.signals.find((signal) => signal.key === "trusted_timestamp");
        if (!timestampSignal) {
            throw new Error("trusted_timestamp signal missing from test fixture");
        }
        timestampSignal.status = "failed";
        timestampSignal.tone = "danger";
        timestampSignal.summary = "Trusted timestamp failed";
        live.presentationTone = "danger";
        live.tone = "danger";
        const result = buildTrustDecisionConsistency({
            snapshotTrustDecision: cloneTrustDecision(),
            liveTrustDecision: live,
            source: "REPORT_SNAPSHOT",
            snapshotGeneratedAtUtc: "2026-01-01T00:00:00.000Z",
            latestReportGeneratedAtUtc: "2026-01-01T00:00:00.000Z",
            latestVerificationPackageGeneratedAtUtc: "2026-01-01T00:00:00.000Z",
            forensicEventsAtSnapshot: 5,
            currentForensicEvents: 5,
            accessEventsAfterSnapshot: 0,
        });
        expect(result.consistentWithSnapshot).toBe(false);
        expect(result.accessOnly).toBe(false);
        expect(result.integrityCritical).toBe(true);
        expect(result.tone).toBe("danger");
        expect(result.reasons.some((reason) => reason.code === "CORE_INTEGRITY_SIGNALS_CHANGED")).toBe(true);
    });
});
describe("intake + TSA semantics", () => {
    it("marks initial upload authorization as intake authorization instead of single-upload finality", () => {
        const source = readRepoFile("services", "api", "src", "services", "evidence.service.ts");
        expect(source).toContain('uploadKind: "intake_authorization"');
        expect(source).toContain("final evidence structure may still become multipart");
    });
    it("labels multipart timestamp input as canonical package digest", () => {
        const source = readRepoFile("services", "api", "src", "services", "evidence-complete.service.ts");
        expect(source).toContain('multipartItemCount > 1 ? "CANONICAL_PACKAGE_SHA256" : "FILE_SHA256"');
    });
});
describe("capture role/mapping semantics", () => {
    const intakePlanJson = {
        steps: [
            {
                id: "primary_media",
                title: "Primary media",
                purposeLabel: "Primary evidence",
            },
            {
                id: "supporting_context",
                title: "Supporting context",
                purposeLabel: "Supporting evidence",
            },
        ],
    };
    it("prefers explicit private roles over fallback heuristics", () => {
        const resolved = resolveReviewerArtifactRole({
            privateRole: "PRIMARY",
            checklistStepId: null,
            intakePlanJson,
            fallbackRole: "supporting_evidence",
            fallbackRoleSource: "fallback_first",
        });
        expect(resolved.artifactRole).toBe("primary_evidence");
        expect(resolved.roleSource).toBe("private_role");
    });
    it("respects checklist mappings when no explicit role is set", () => {
        const resolved = resolveReviewerArtifactRole({
            privateRole: null,
            checklistStepId: "supporting_context",
            intakePlanJson,
            fallbackRole: "primary_evidence",
            fallbackRoleSource: "fallback_root",
        });
        expect(resolved.artifactRole).toBe("supporting_evidence");
        expect(resolved.roleSource).toBe("checklist_step");
        expect(resolved.checklistStepLabel).toContain("Supporting");
    });
    it("falls back safely for legacy records with no role metadata", () => {
        const resolved = resolveReviewerArtifactRole({
            privateRole: null,
            checklistStepId: null,
            intakePlanJson: null,
            fallbackRole: "primary_evidence",
            fallbackRoleSource: "fallback_single",
        });
        expect(resolved.artifactRole).toBe("primary_evidence");
        expect(resolved.roleSource).toBe("fallback_single");
    });
    it("keeps API evidence-content construction wired to explicit role metadata", () => {
        const routeSource = readRepoFile("services", "api", "src", "routes", "evidence.routes.ts");
        expect(routeSource).toContain("artifactRole: resolvedRole.artifactRole");
        expect(routeSource).toContain("artifactRoleLabel: getReviewerArtifactRoleLabel(");
        expect(routeSource).toContain("checklistStepLabel: resolvedRole.checklistStepLabel");
        expect(routeSource).toContain("sortPublicEvidenceItems");
    });
});
describe("capture draft governance (Governance Item 2)", () => {
    it("sanitizes draft filenames and strips raw relative paths before persistence", () => {
        const sanitized = sanitizeCaptureSessionItem({
            fileName: "../../Patients/John Doe/MRI.pdf",
            relativePath: "Clients/ACME/case-123/photos/scene.jpg",
            role: "primary",
        }, 0);
        expect(sanitized.fileName).toBe("MRI.pdf");
        expect(sanitized.relativePath).toBe("scene.jpg");
    });
    it("exposes an explicit, changeable metadata-retention window", () => {
        const now = Date.UTC(2026, 0, 1, 0, 0, 0);
        const expiry = buildDefaultCaptureDraftExpiry(now);
        expect(CAPTURE_DRAFT_EXPIRY_DAYS).toBe(7);
        expect(CAPTURE_DRAFT_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
        expect(expiry.getTime()).toBe(now + CAPTURE_DRAFT_EXPIRY_MS);
    });
    it("shows the compact metadata-only privacy note on the capture page", () => {
        const capturePageSource = readRepoFile("apps", "web", "app", "(app)", "capture", "page.tsx");
        // Phase 28-I — normalise JSX whitespace (the prose can wrap across
        // multiple lines in the source) before asserting the bounded copy.
        const normalised = capturePageSource.replace(/\s+/g, " ");
        expect(normalised).toContain("Drafts save metadata only. File contents are not stored until");
        expect(normalised).toContain("finalization, and draft metadata expires automatically.");
    });
});
describe("claims governance surfaces (Governance Item 3)", () => {
    it("keeps verify and evidence-detail copy inside the claims matrix boundary", () => {
        const surfaces = [
            readRepoFile("apps", "web", "app", "verify", "[token]", "page.tsx"),
            readRepoFile("apps", "web", "app", "(app)", "evidence", "[id]", "page.tsx"),
        ];
        for (const surface of surfaces) {
            for (const pattern of PROOVRA_FORBIDDEN_SURFACE_PATTERNS) {
                expect(surface).not.toMatch(pattern);
            }
        }
    });
    it("keeps AI policy/prompt language advisory and anti-overclaim", () => {
        const aiPolicy = readRepoFile("services", "api", "src", "services", "ai", "ai-policy.ts");
        const openAiPrompt = readRepoFile("services", "api", "src", "services", "ai", "openai-provider.ts");
        expect(aiPolicy).toContain("AI assistance is advisory and does not determine factual truth, authorship, or legal admissibility.");
        expect(openAiPrompt).toContain("Do not claim that evidence is authentic, true, authored by a specific person, admissible, accepted by a court, accepted by an insurer, or accepted by police.");
        expect(openAiPrompt).toContain("Do not claim that PROOVRA proves factual truth, proves authorship, or guarantees legal admissibility.");
    });
});
describe("multipart reviewer wording (Governance Item 4)", () => {
    it("uses the shared multipart explanation on the verify and evidence-detail surfaces", () => {
        const verifyPageSource = readRepoFile("apps", "web", "app", "verify", "[token]", "page.tsx");
        const evidenceDetailSource = readRepoFile("apps", "web", "app", "(app)", "evidence", "[id]", "page.tsx");
        expect(verifyPageSource).toContain("PROOVRA_MULTIPART_REVIEWER_EXPLANATION");
        expect(evidenceDetailSource).toContain("PROOVRA_MULTIPART_REVIEWER_EXPLANATION");
    });
});
