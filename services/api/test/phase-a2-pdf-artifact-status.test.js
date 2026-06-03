/**
 * Phase A2 — PDF artifact signing default-on + Report vs Package
 * vocabulary, contract suite.
 *
 * Source-contract style (same as Phase A0 / A1). Asserts:
 *
 *   1. Migration adds the four PDF artifact columns to `reports`.
 *
 *   2. Migration adds `REPORT_PDF_SIGNED` and
 *      `REPORT_PDF_UNSIGNED_OPT_OUT` to `CustodyEventType` (NOT
 *      `REPORT_PDF_SIGNING_FAILED` — see schema comment for why).
 *
 *   3. `@proovra/shared` exports the bounded vocabulary:
 *      `ARTIFACT_TYPES`, `PDF_SIGNATURE_STATUSES`,
 *      `VERIFICATION_PACKAGE_SIGNATURE_STATUSES`,
 *      `ARTIFACT_LABELS`, the two canonical warning copy strings,
 *      and `FORBIDDEN_ARTIFACT_PHRASES`.
 *
 *   4. Startup config validation refuses production when neither
 *      `PDF_SIGNING_ENABLED=true` nor
 *      `PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true` is set.
 *
 *   5. `EvidenceArtifactStatus` carries `report.pdfSignature` AND
 *      `verificationPackage.manifestSignature` projections.
 *
 *   6. Vocabulary discipline — the forbidden artifact phrases never
 *      appear in critical user-facing surfaces.
 *
 *   7. The download buttons on `ArtifactPanel` and the evidence
 *      detail hero use the disambiguated labels.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_LABELS, ARTIFACT_TYPES, FORBIDDEN_ARTIFACT_PHRASES, PDF_SIGNATURE_STATUSES, PDF_SIGNING_UNAVAILABLE_COPY, PDF_UNSIGNED_OPT_OUT_WARNING_COPY, VERIFICATION_PACKAGE_SIGNATURE_STATUSES, } from "@proovra/shared";
import { collectStartupViolations } from "../src/config/index.js";
function readSource(rel) {
    const url = new URL(rel, import.meta.url);
    return readFileSync(fileURLToPath(url), "utf8");
}
const MIGRATION_SQL = readSource("../prisma/migrations/20261002000000_phase_a2_pdf_artifact_status/migration.sql");
const SCHEMA = readSource("../prisma/schema.prisma");
const ARTIFACT_STATUS_SERVICE = readSource("../src/services/evidence-artifact-status.service.ts");
const ARTIFACT_PANEL = readSource("../../../apps/web/app/(app)/evidence/components/ArtifactPanel.tsx");
const EVIDENCE_DETAIL_PAGE = readSource("../../../apps/web/app/(app)/evidence/[id]/page.tsx");
describe("Phase A2 — PDF artifact status (source contract)", () => {
    it("migration adds the four PDF artifact columns to reports", () => {
        expect(MIGRATION_SQL).toMatch(/ADD COLUMN IF NOT EXISTS pdf_signature_status\s+VARCHAR\(32\)/i);
        expect(MIGRATION_SQL).toMatch(/ADD COLUMN IF NOT EXISTS pdf_signed_at_utc\s+TIMESTAMPTZ/i);
        expect(MIGRATION_SQL).toMatch(/ADD COLUMN IF NOT EXISTS pdf_signer_key_id\s+VARCHAR\(120\)/i);
        expect(MIGRATION_SQL).toMatch(/ADD COLUMN IF NOT EXISTS pdf_signing_warning\s+VARCHAR\(400\)/i);
    });
    it("migration adds REPORT_PDF_SIGNED + REPORT_PDF_UNSIGNED_OPT_OUT custody events", () => {
        expect(MIGRATION_SQL).toMatch(/ALTER\s+TYPE\s+"CustodyEventType"\s+ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'REPORT_PDF_SIGNED'/i);
        expect(MIGRATION_SQL).toMatch(/ALTER\s+TYPE\s+"CustodyEventType"\s+ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'REPORT_PDF_UNSIGNED_OPT_OUT'/i);
        // Intentionally NOT emitted: REPORT_PDF_SIGNING_FAILED. The
        // worker DLQ's on signing failure and no Report row is written,
        // so no evidence-custody entry is appropriate. The schema
        // comment documents this.
        expect(MIGRATION_SQL).not.toMatch(/REPORT_PDF_SIGNING_FAILED/i);
    });
    it("schema.prisma Report model declares the four PDF artifact columns", () => {
        const reportBlock = SCHEMA.match(/model\s+Report\s*\{[\s\S]*?@@map\("reports"\)\s*\}/)?.[0];
        expect(reportBlock, "Report model block").toBeTruthy();
        expect(reportBlock).toMatch(/pdfSignatureStatus\s+String\?/);
        expect(reportBlock).toMatch(/pdfSignedAtUtc\s+DateTime\?/);
        expect(reportBlock).toMatch(/pdfSignerKeyId\s+String\?/);
        expect(reportBlock).toMatch(/pdfSigningWarning\s+String\?/);
    });
    it("shared package exports the bounded artifact + signature vocabulary", () => {
        expect(ARTIFACT_TYPES).toEqual([
            "REPORT_PDF",
            "VERIFICATION_PACKAGE_ZIP",
        ]);
        expect(PDF_SIGNATURE_STATUSES).toEqual([
            "SIGNED",
            "UNSIGNED_OPT_OUT",
            "SIGNING_UNAVAILABLE",
            "SIGNING_FAILED",
            "NOT_APPLICABLE",
        ]);
        expect(VERIFICATION_PACKAGE_SIGNATURE_STATUSES).toEqual([
            "SIGNED",
            "UNSIGNED",
            "NOT_APPLICABLE",
        ]);
        expect(ARTIFACT_LABELS.REPORT_PDF).toBe("Report PDF");
        expect(ARTIFACT_LABELS.REPORT_PDF_SIGNED).toBe("Signed Report PDF");
        expect(ARTIFACT_LABELS.REPORT_PDF_UNSIGNED).toBe("Unsigned Report PDF artifact");
        expect(ARTIFACT_LABELS.VERIFICATION_PACKAGE_ZIP).toBe("Verification Package ZIP");
        // Canonical warning copy must be non-trivial — backed strings
        // must be present, NOT empty.
        expect(PDF_UNSIGNED_OPT_OUT_WARNING_COPY.length).toBeGreaterThan(40);
        expect(PDF_SIGNING_UNAVAILABLE_COPY.length).toBeGreaterThan(40);
        expect(FORBIDDEN_ARTIFACT_PHRASES).toContain("legally admissible");
        expect(FORBIDDEN_ARTIFACT_PHRASES).toContain("tamper-proof");
        expect(FORBIDDEN_ARTIFACT_PHRASES).toContain("verified report");
    });
    it("artifact-status service projects pdfSignature for the Report block", () => {
        expect(ARTIFACT_STATUS_SERVICE).toContain("pdfSignature");
        expect(ARTIFACT_STATUS_SERVICE).toContain("ReportPdfSignatureProjection");
        // Legacy reports without the column fall through to a known
        // status, NEVER a silent signed badge.
        expect(ARTIFACT_STATUS_SERVICE).toContain('"SIGNING_UNAVAILABLE"');
    });
    it("artifact-status service projects manifestSignature for the Package block", () => {
        expect(ARTIFACT_STATUS_SERVICE).toContain("manifestSignature");
        expect(ARTIFACT_STATUS_SERVICE).toContain("VerificationPackageSignatureProjection");
    });
    it("ArtifactPanel uses the disambiguated labels", () => {
        expect(ARTIFACT_PANEL).toContain("Download Report PDF");
        expect(ARTIFACT_PANEL).toContain("Download Verification Package ZIP");
        expect(ARTIFACT_PANEL).toContain("Report PDF readiness");
        expect(ARTIFACT_PANEL).toContain("Verification Package ZIP");
    });
    it("Evidence detail hero uses the disambiguated labels", () => {
        expect(EVIDENCE_DETAIL_PAGE).toContain("Download Report PDF");
        expect(EVIDENCE_DETAIL_PAGE).toContain("Download Verification Package ZIP");
        // The pre-A2 ambiguous labels are gone from the executable code
        // (allowed only inside comments).
        const executable = EVIDENCE_DETAIL_PAGE.split("\n").filter((l) => !l.trim().startsWith("//"));
        expect(executable.find((l) => />Download report</.test(l))).toBeUndefined();
        expect(executable.find((l) => />Download package</.test(l))).toBeUndefined();
    });
    it("ArtifactPanel renders Signed Report PDF ONLY when status === SIGNED", () => {
        // The badge must be gated on `=== "SIGNED"` literal, not on a
        // truthy check or a label-string heuristic.
        expect(ARTIFACT_PANEL).toMatch(/pdfSignature\.status\s*===\s*"SIGNED"/);
        expect(ARTIFACT_PANEL).toContain("Signed Report PDF");
        expect(ARTIFACT_PANEL).toContain("Unsigned Report PDF artifact");
    });
    it("vocabulary discipline — forbidden artifact phrases are absent from critical artifact UI", () => {
        const criticalSources = [
            ARTIFACT_PANEL,
            EVIDENCE_DETAIL_PAGE,
            ARTIFACT_STATUS_SERVICE,
        ];
        for (const source of criticalSources) {
            for (const phrase of FORBIDDEN_ARTIFACT_PHRASES) {
                const re = new RegExp(`\\b${phrase}\\b`, "i");
                // The forbidden phrase may appear inside the shared
                // `FORBIDDEN_ARTIFACT_PHRASES` constant import; that's the
                // contract definition, not user-facing copy. We skip lines
                // that look like type-import / array-literal text.
                const offenders = source.split("\n").filter((line) => {
                    if (!re.test(line))
                        return false;
                    if (/FORBIDDEN_ARTIFACT_PHRASES|\/\/|\/\*|\*/.test(line)) {
                        return false;
                    }
                    return true;
                });
                expect(offenders, `forbidden phrase "${phrase}" should not appear in user-facing copy`).toEqual([]);
            }
        }
    });
});
describe("Phase A2 — startup config validation (PDF signing)", () => {
    let snapshot;
    beforeEach(() => {
        snapshot = {
            NODE_ENV: process.env.NODE_ENV,
            PDF_SIGNING_ENABLED: process.env.PDF_SIGNING_ENABLED,
            PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK: process.env.PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK,
            DATABASE_URL: process.env.DATABASE_URL,
            AUTH_JWT_SECRET: process.env.AUTH_JWT_SECRET,
            SIGNING_PRIVATE_KEY_PATH: process.env.SIGNING_PRIVATE_KEY_PATH,
        };
        // Provide non-PDF prerequisites so the assertions below isolate
        // the PDF-specific violation.
        process.env.DATABASE_URL = "postgres://test/test";
        process.env.AUTH_JWT_SECRET = "test-secret-test-secret-test-secret";
        process.env.SIGNING_PRIVATE_KEY_PATH = "keys/signing-private.pem";
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(snapshot)) {
            if (v === undefined) {
                delete process.env[k];
            }
            else {
                process.env[k] = v;
            }
        }
    });
    it("non-production never raises the PDF signing violation", () => {
        process.env.NODE_ENV = "development";
        delete process.env.PDF_SIGNING_ENABLED;
        delete process.env.PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK;
        const violations = collectStartupViolations();
        expect(violations.find((v) => v.reason === "pdf_signing_unconfigured_in_production")).toBeUndefined();
    });
    it("production WITHOUT signing AND WITHOUT opt-out raises pdf_signing_unconfigured_in_production", () => {
        process.env.NODE_ENV = "production";
        delete process.env.PDF_SIGNING_ENABLED;
        delete process.env.PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK;
        const violations = collectStartupViolations();
        const v = violations.find((x) => x.reason === "pdf_signing_unconfigured_in_production");
        expect(v).toBeTruthy();
        expect(v.envName).toBe("PDF_SIGNING_ENABLED");
    });
    it("production WITH PDF_SIGNING_ENABLED=true does NOT raise the violation", () => {
        process.env.NODE_ENV = "production";
        process.env.PDF_SIGNING_ENABLED = "true";
        delete process.env.PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK;
        const violations = collectStartupViolations();
        expect(violations.find((v) => v.reason === "pdf_signing_unconfigured_in_production")).toBeUndefined();
    });
    it("production WITH opt-out ACK does NOT raise the violation", () => {
        process.env.NODE_ENV = "production";
        delete process.env.PDF_SIGNING_ENABLED;
        process.env.PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK = "true";
        const violations = collectStartupViolations();
        expect(violations.find((v) => v.reason === "pdf_signing_unconfigured_in_production")).toBeUndefined();
    });
});
