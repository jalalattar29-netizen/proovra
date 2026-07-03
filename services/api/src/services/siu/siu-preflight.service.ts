/**
 * PROOVRA Insurance SIU — export pre-flight (Phase M3).
 *
 * Evaluates whether a case's SIU profile + the associated evidence
 * meet the bounded readiness contract for an insurer-ready export
 * bundle. Returns one of `ready` / `ready_with_warnings` / `blocked`
 * / `unavailable`.
 *
 * Hard rules:
 *   * Workspace-scoped — every evaluation requires a `teamId`.
 *   * Bounded enums on every finding code.
 *   * Findings are operational signals; they NEVER constitute a fraud
 *     determination.
 *   * `blocked` is a hard refusal; the route MUST decline to produce
 *     an export when this state is returned.
 */

import { prisma } from "../../db.js";
import {
  SIU_STANDING_LIMITATIONS,
  type SiuExportReadinessState,
  type SiuPreflightCode,
  type SiuPreflightFinding,
  type SiuPreflightResult,
  type SiuProfile,
} from "@proovra/shared";
import { loadSiuProfile } from "./siu-profile.service.js";
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";

export type RunSiuPreflightInput = {
  caseId: string;
  teamId: string;
};

export async function runSiuExportPreflight(
  input: RunSiuPreflightInput,
): Promise<SiuPreflightResult | null> {
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.SIU_EXPORT_PREFLIGHT,
    { caseId: input.caseId, teamId: input.teamId },
    () => runSiuExportPreflightInner(input),
  );
}

async function runSiuExportPreflightInner(
  input: RunSiuPreflightInput,
): Promise<SiuPreflightResult | null> {
  const profile = await loadSiuProfile({
    caseId: input.caseId,
    teamId: input.teamId,
    exposePii: false,
  });
  if (!profile) return null;

  const findings: SiuPreflightFinding[] = [];

  // 1. Required checklist coverage.
  const required = profile.checklist.filter((c) => c.required);
  const satisfied = required.filter(
    (c) => c.status === "satisfied" || c.status === "mapped",
  );
  const missingRequired = required.filter(
    (c) => c.status === "missing" || c.status === "submitted",
  );
  for (const m of missingRequired) {
    findings.push(warning("REQUIRED_EVIDENCE_MISSING", {
      detail: `Required checklist item "${m.label}" has not been satisfied.`,
      evidenceId: null,
    }));
  }

  // 2. Evidence presence: fetch the case's evidence and inspect for
  //    report / verification-package / hash-mismatch / legal hold.
  const evidence = await prisma.evidence.findMany({
    where: { caseId: input.caseId, teamId: input.teamId },
    select: {
      id: true,
      status: true,
      legalHolds: { select: { id: true } },
      hashSemantics: true,
      lifecycleState: true,
      verificationPackageMetadata: true,
      reportGeneratedAtUtc: true,
      verificationPackageGeneratedAtUtc: true,
    },
    take: 500,
  });

  if (evidence.length === 0) {
    findings.push(blocker("EVIDENCE_INTEGRITY_FAILED", {
      detail: "No evidence is linked to this case; cannot export an SIU bundle.",
      evidenceId: null,
    }));
  }

  for (const ev of evidence) {
    if ((ev.status as string) === "FAILED_HASH_MISMATCH") {
      findings.push(blocker("EVIDENCE_INTEGRITY_FAILED", {
        detail: "An evidence record on this case has a hash-integrity failure.",
        evidenceId: ev.id,
      }));
    }
    if (ev.legalHolds && ev.legalHolds.length > 0) {
      findings.push(blocker("LEGAL_HOLD_EXPORT_BLOCK", {
        detail: "Active legal hold prevents SIU export of this evidence.",
        evidenceId: ev.id,
      }));
    }
    if ((ev.lifecycleState as string | null) === "DESTROYED") {
      findings.push(blocker("RETENTION_POLICY_BLOCK", {
        detail: "Evidence has been operationally destroyed; cannot include in export.",
        evidenceId: ev.id,
      }));
    }
    if (!ev.reportGeneratedAtUtc) {
      findings.push(warning("REPORT_PDF_MISSING", {
        detail: "Evidence does not yet have a generated report PDF.",
        evidenceId: ev.id,
      }));
    }
    if (!ev.verificationPackageGeneratedAtUtc) {
      findings.push(warning("VERIFICATION_PACKAGE_MISSING", {
        detail: "Evidence does not yet have a generated Verification Package.",
        evidenceId: ev.id,
      }));
    }
  }

  // 3. Follow-ups still open.
  const openFollowUps = profile.followUps.filter(
    (f) =>
      f.status === "open" ||
      f.status === "sent" ||
      f.status === "received",
  );
  for (const fu of openFollowUps) {
    findings.push(warning("FOLLOW_UP_INCOMPLETE", {
      detail: `Follow-up ${fu.id} (item ${fu.checklistItemId}) is not yet satisfied.`,
      evidenceId: null,
    }));
  }

  // 4. Severe review indicators block export.
  for (const ind of profile.reviewIndicators) {
    if (ind.severity === "block_export") {
      findings.push(blocker("CORE_INTEGRITY_WARNING_PRESENT", {
        detail: `Review indicator \`${ind.code}\` is configured to block export.`,
        evidenceId: ind.evidenceId,
      }));
    } else if (ind.severity === "warning") {
      findings.push(warning("CORE_INTEGRITY_WARNING_PRESENT", {
        detail: `Review indicator \`${ind.code}\` recorded.`,
        evidenceId: ind.evidenceId,
      }));
    }
  }

  const warnings = findings.filter((f) => f.severity === "warning").length;
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const readiness: SiuExportReadinessState =
    blockers > 0
      ? "blocked"
      : warnings > 0
        ? "ready_with_warnings"
        : "ready";

  return {
    caseId: input.caseId,
    evaluatedAtUtc: new Date().toISOString(),
    readiness,
    findings,
    totals: {
      warnings,
      blockers,
      requiredChecklistItems: required.length,
      satisfiedChecklistItems: satisfied.length,
      openFollowUps: openFollowUps.length,
    },
    limitations: SIU_STANDING_LIMITATIONS,
  };
}

function warning(code: SiuPreflightCode, input: {
  detail: string;
  evidenceId: string | null;
}): SiuPreflightFinding {
  return {
    code,
    severity: "warning",
    detail: input.detail.slice(0, 240),
    evidenceId: input.evidenceId,
  };
}

function blocker(code: SiuPreflightCode, input: {
  detail: string;
  evidenceId: string | null;
}): SiuPreflightFinding {
  return {
    code,
    severity: "blocker",
    detail: input.detail.slice(0, 240),
    evidenceId: input.evidenceId,
  };
}

// Re-export the profile type for convenience.
export type { SiuProfile };
