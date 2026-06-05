/**
 * Phase 5 — Workflow template export-policy overlay.
 *
 * Reads the (already validated, already persisted) `exportPolicyJson`
 * field off `EvidenceWorkflowTemplate` and exposes a tightening overlay
 * that the existing `enforceSensitiveAction` gate consults AFTER the
 * workspace-level decision has already returned `allowed: true`.
 *
 * Hard contract:
 *
 *   - The overlay can ONLY tighten. If the workspace policy denies, the
 *     workspace decision stands. If the workspace policy allows, the
 *     template may flip it to a denial — never the reverse.
 *
 *   - The overlay is OPT-IN per evidence: the caller must supply a
 *     resolved templateId. With no templateId the overlay is a no-op
 *     and behavior is identical to today.
 *
 *   - Every Prisma read and every JSON parse is wrapped in try/catch.
 *     ANY failure resolves to "no template policy" — the existing
 *     workspace decision wins. A bad row, a transient DB error, or an
 *     unexpected JSON shape must never block an otherwise-allowed
 *     export.
 *
 * Phase 1 evidence noted three pre-existing problems with this field:
 *
 *   (1) GET /v1/workflow/templates never echoes it back. That is a
 *       separate concern (read-projection) and not addressed here.
 *
 *   (2) Resolving a UUID-anchored templateId from an Evidence row
 *       requires the joins documented in Phase 1. The
 *       `resolveTemplateIdForEvidence` helper at
 *       reviewer-operations-engine.service.ts already exists and
 *       implements both joins. We reuse it.
 *
 *   (3) For evidence with no resolvable template (legacy, personal,
 *       seed-only capture sessions), the overlay returns null and the
 *       hardcoded baseline behavior is preserved bit-for-bit.
 */

import type { PrismaClient } from "@prisma/client";
import {
  WorkflowExportPolicySchema,
  type WorkflowExportPolicy,
  type WorkflowWorkspaceRole,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * The four "export-shaped" actions defined on `SensitiveAction` that the
 * template can tighten. We deliberately keep this list narrow:
 *
 *   - generate_report / download_report  → gated by allowReportPdf
 *   - generate_package / download_package → gated by allowVerificationPackage
 *   - publish_public_verify              → gated by allowPublicVerify
 *
 * `download_original` is NOT in this set — the template export policy
 * does not describe original-file access. Existing original-download
 * governance is unaffected.
 */
export type TemplateExportAction =
  | "generate_report"
  | "download_report"
  | "generate_package"
  | "download_package"
  | "publish_public_verify";

export type TemplateExportOverlayDecision =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

// -----------------------------------------------------------------------------
// Load + validate the template's exportPolicyJson.
//
// Returns null when:
//   - templateId is null/undefined,
//   - no row exists for the id,
//   - exportPolicyJson is null,
//   - the JSON fails WorkflowExportPolicySchema parsing.
//
// Every failure path is silent-on-purpose: we MUST NOT let template
// resolution break the primary export lifecycle. The existing workspace
// decision stands.
// -----------------------------------------------------------------------------

export async function loadTemplateExportPolicy(
  templateId: string | null | undefined,
  client: PrismaClient = defaultPrisma,
): Promise<WorkflowExportPolicy | null> {
  if (!templateId) return null;
  try {
    const row = await client.evidenceWorkflowTemplate.findUnique({
      where: { id: templateId },
      select: { exportPolicyJson: true },
    });
    if (!row?.exportPolicyJson) return null;
    const parsed = WorkflowExportPolicySchema.safeParse(row.exportPolicyJson);
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    // Fail-safe: any DB/runtime error means no template overlay applies.
    return null;
  }
}

// -----------------------------------------------------------------------------
// Pure overlay decision.
//
// Given an already-ALLOWED workspace decision plus a (possibly-null)
// template export policy and the actor's role, returns either the
// same allow or a denial. Pure — no IO. The only side-effect-free
// way to call this is with a policy you fetched yourself; the
// governance.service wiring does that.
// -----------------------------------------------------------------------------

export function evaluateTemplateExportOverlay(input: {
  action: TemplateExportAction;
  role: WorkflowWorkspaceRole | null | undefined;
  policy: WorkflowExportPolicy | null;
}): TemplateExportOverlayDecision {
  const policy = input.policy;
  // No policy → no override. Existing decision stands.
  if (!policy) return { allowed: true };

  // Per-action gate. Each branch maps to a single boolean on the
  // template policy. We do NOT consult `watermark` here — that is
  // a renderer concern, not a gate.
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

  // Downloader-role gate. Only the downloader-facing actions consult
  // this; generation actions (generate_report / generate_package) are
  // about producing the artifact and are not bounded by who may later
  // download it. publish_public_verify is also out of scope — public
  // verify has no downloader role concept.
  //
  // Empty `allowedDownloaderRoles` means "no override" (preserves the
  // baseline: all four workspace roles allowed). A non-empty list
  // tightens to exactly those roles.
  if (
    (input.action === "download_report" ||
      input.action === "download_package") &&
    policy.allowedDownloaderRoles.length > 0 &&
    input.role != null &&
    !policy.allowedDownloaderRoles.includes(input.role as WorkflowWorkspaceRole)
  ) {
    const code =
      input.action === "download_report"
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
