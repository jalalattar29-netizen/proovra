/**
 * Phase 32.8D — Reports & Artifacts experience frontend types.
 *
 * Mirrors the envelope returned by `/v1/reports/artifacts`.
 */

/** `skipped` = the caller did not ask for it. NOT a failure. */
export type SectionStatus = "ok" | "degraded" | "unavailable" | "skipped";

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
  /**
   * The stored title, VERBATIM — `null` when the record has none.
   *
   * Do NOT render this directly. Pass the row through `getDisplayTitle`, the
   * same cascade the Evidence Library and Case Detail use: many records carry
   * their name in `displayFileName` / `originalFileName` with `title` null,
   * and reading `title` alone is exactly what filled this page with
   * "Untitled evidence".
   */
  title: string | null;
  /** Cascade inputs. Never a display value on their own. */
  displayFileName: string | null;
  originalFileName: string | null;
  mimeType: string | null;
  type: string;
  status: string;
  verificationStatus: string | null;
  caseId: string | null;
  /** The linked case's NAME. Null only when the case genuinely has none. */
  caseTitle: string | null;
  /** Organization-supplied Customer ID from the intake link. Null unless intake. */
  intakeCustomerId: string | null;
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

/** The six operational counters the summary strip renders. */
export type ReportsSummary = {
  reportsReady: number;
  reportsPending: number;
  packagesReady: number;
  packagesPending: number;
  packagesBlocked: number;
  totalEvidenceWithArtifacts: number;
};

export type ReportsArtifactsEnvelope = {
  generatedAt: string;
  workspace: { id: string; role: string };
  sections: {
    summary: {
      status: SectionStatus;
      data: ReportsSummary | null;
    };
    artifacts: {
      status: SectionStatus;
      items: ArtifactRow[];
      nextCursor: string | null;
      /**
       * Rows matching the CURRENT query across the whole workspace — not the
       * length of this page. Null only when the list itself failed.
       */
      total: number | null;
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
