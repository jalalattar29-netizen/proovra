/**
 * Phase 32.8D — Reports & Artifacts experience frontend types.
 *
 * Mirrors the envelope returned by `/v1/reports/artifacts`.
 */

export type SectionStatus = "ok" | "degraded" | "unavailable";

export type ReportLifecycle =
  | "not_requested"
  | "pending"
  | "ready"
  | "failed"
  | "unavailable";

export type PackageLifecycle =
  | "not_requested"
  | "pending"
  | "ready"
  | "blocked"
  | "failed"
  | "unavailable";

export type ArtifactRow = {
  evidenceId: string;
  title: string;
  type: string;
  status: string;
  verificationStatus: string | null;
  caseId: string | null;
  createdAt: string;
  report: {
    state: ReportLifecycle;
    version: number | null;
    generatedAtUtc: string | null;
  };
  package: {
    state: PackageLifecycle;
    version: number | null;
    generatedAtUtc: string | null;
    blockedReason: string | null;
  };
};

export type ReportsArtifactsEnvelope = {
  generatedAt: string;
  workspace: { id: string; role: string };
  sections: {
    summary: {
      status: SectionStatus;
      data: {
        reportsReady: number;
        reportsPending: number;
        packagesReady: number;
        packagesPending: number;
        packagesBlocked: number;
        totalEvidenceWithArtifacts: number;
      } | null;
    };
    artifacts: {
      status: SectionStatus;
      items: ArtifactRow[];
      nextCursor: string | null;
    };
  };
};

export type LifecycleFilter =
  | "all"
  | "report_ready"
  | "report_pending"
  | "report_failed"
  | "package_ready"
  | "package_pending"
  | "package_blocked";
