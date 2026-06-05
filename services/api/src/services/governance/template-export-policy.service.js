/**
 * Phase 5 — Workflow template export-policy overlay.
 *
 * Reads the (already validated, already persisted) `exportPolicyJson`
 * field off `EvidenceWorkflowTemplate` and exposes a tightening overlay
 * that the existing `enforceSensitiveAction` gate consults AFTER the
 * workspace-level decision has already returned `allowed: true`.
 */
import { WorkflowExportPolicySchema, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
// -----------------------------------------------------------------------------
// Load + validate the template's exportPolicyJson.
// Returns null when templateId is null/undefined, no row exists, the row
// has a null exportPolicyJson, the JSON fails schema parsing, or the
// query itself throws. Every failure path is silent-on-purpose.
// -----------------------------------------------------------------------------
export async function loadTemplateExportPolicy(templateId, client = defaultPrisma) {
    if (!templateId)
        return null;
    try {
        const row = await client.evidenceWorkflowTemplate.findUnique({
            where: { id: templateId },
            select: { exportPolicyJson: true },
        });
        if (!row?.exportPolicyJson)
            return null;
        const parsed = WorkflowExportPolicySchema.safeParse(row.exportPolicyJson);
        if (!parsed.success)
            return null;
        return parsed.data;
    }
    catch {
        return null;
    }
}
// -----------------------------------------------------------------------------
// Pure overlay decision. Given an already-ALLOWED workspace decision
// plus a (possibly-null) template export policy and the actor's role,
// returns either the same allow or a denial. Pure — no IO.
// -----------------------------------------------------------------------------
export function evaluateTemplateExportOverlay(input) {
    const policy = input.policy;
    if (!policy)
        return { allowed: true };
    switch (input.action) {
        case "generate_report":
        case "download_report": {
            if (!policy.allowReportPdf) {
                return {
                    allowed: false,
                    code: "REPORT_BLOCKED_BY_TEMPLATE_POLICY",
                    reason: "report_disabled_by_template_policy",
                };
            }
            break;
        }
        case "generate_package":
        case "download_package": {
            if (!policy.allowVerificationPackage) {
                return {
                    allowed: false,
                    code: "PACKAGE_BLOCKED_BY_TEMPLATE_POLICY",
                    reason: "verification_package_disabled_by_template_policy",
                };
            }
            break;
        }
        case "publish_public_verify": {
            if (!policy.allowPublicVerify) {
                return {
                    allowed: false,
                    code: "PUBLIC_VERIFY_BLOCKED_BY_TEMPLATE_POLICY",
                    reason: "public_verify_disabled_by_template_policy",
                };
            }
            break;
        }
    }
    if ((input.action === "download_report" ||
        input.action === "download_package") &&
        policy.allowedDownloaderRoles.length > 0 &&
        input.role != null &&
        !policy.allowedDownloaderRoles.includes(input.role)) {
        const code = input.action === "download_report"
            ? "REPORT_BLOCKED_BY_TEMPLATE_POLICY"
            : "PACKAGE_BLOCKED_BY_TEMPLATE_POLICY";
        return {
            allowed: false,
            code,
            reason: `role_${input.role}_not_in_template_allowed_downloader_roles`,
        };
    }
    return { allowed: true };
}
