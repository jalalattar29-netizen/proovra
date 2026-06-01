import type {
  CaseOption,
  DetailWorkspaceState,
  EvidenceListItem,
  WorkspaceCapabilitySnapshot,
} from "./evidence-library-types";
import type {
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
} from "../../../../components/billing/types";

export function deriveWorkspaceCapabilities(params: {
  evidence?:
    | {
        teamId?: string | null;
        caseId?: string | null;
        workspaceNameSnapshot?: string | null;
      }
    | null;
  personal: PersonalWorkspaceSummary | null;
  teams: TeamWorkspaceSummary[];
  cases: CaseOption[];
}): WorkspaceCapabilitySnapshot {
  const explicitTeamId = params.evidence?.teamId ?? null;
  const inferredTeamIdFromCase =
    !explicitTeamId && params.evidence?.caseId
      ? params.cases.find((item) => item.id === params.evidence?.caseId)?.teamId ?? null
      : null;

  const teamId = explicitTeamId || inferredTeamIdFromCase;

  if (teamId) {
    const team = params.teams.find((item) => item.id === teamId);
    if (team) {
      return {
        workspaceType: "TEAM",
        workspaceName:
          (typeof params.evidence?.workspaceNameSnapshot === "string"
            ? params.evidence.workspaceNameSnapshot.trim()
            : "") || team.name || "Workspace",
        plan: team.effectivePlan ?? team.plan ?? "FREE",
        reportsIncluded: Boolean(team.features?.reportsIncluded),
        verificationPackageIncluded: Boolean(team.features?.verificationPackageIncluded),
        publicVerifyIncluded: Boolean(team.features?.publicVerifyIncluded),
      };
    }
  }

  return {
    workspaceType: "PERSONAL",
    workspaceName:
      (typeof params.evidence?.workspaceNameSnapshot === "string"
        ? params.evidence.workspaceNameSnapshot.trim()
        : "") || "Personal Workspace",
    plan: params.personal?.plan ?? "FREE",
    reportsIncluded: Boolean(params.personal?.features?.reportsIncluded),
    verificationPackageIncluded: Boolean(params.personal?.features?.verificationPackageIncluded),
    publicVerifyIncluded: Boolean(params.personal?.features?.publicVerifyIncluded),
  };
}

export function buildReportAvailability(item: EvidenceListItem, detail?: DetailWorkspaceState | null): {
  available: boolean;
  label: string;
} {
  const available = Boolean(detail?.report?.url && detail?.report?.generatedAtUtc) || Boolean(item.latestReportVersion);
  return {
    available,
    label: available ? "Report available" : "Report not recorded",
  };
}

export function buildVerificationPackageAvailability(detail?: DetailWorkspaceState | null): {
  available: boolean;
  label: string;
} {
  // Phase 32.6 — fix verification-package availability check.
  //
  // Previously this required `detail.verificationPackage.url` to be
  // truthy. But the `/v1/evidence/:id/review-workspace` endpoint
  // NEVER returns a `url` field on the verification-package
  // projection — the presigned URL is generated on-demand by the
  // separate `/v1/evidence/:id/verification-package` endpoint when
  // the user clicks download (avoids exposing signed URLs in the
  // workspace projection).
  //
  // Result: legitimate team-workspace evidence with a real package
  // row ALWAYS showed `available: false` and rendered the download
  // button as "Verification package requires detail check" — even
  // though the package existed and was downloadable.
  //
  // Fix: the package is `available` when EITHER:
  //   * the projection carries a `generatedAtUtc` (the canonical
  //     "package exists" signal), OR
  //   * the projection carries a `version` (legacy fallback)
  //
  // The download click still goes through the gated endpoint, which
  // remains the authoritative source of truth on permission and
  // governance state. This change ONLY fixes the button enablement
  // computation in the workspace projection.
  const available = Boolean(
    detail?.verificationPackage?.generatedAtUtc ||
      detail?.verificationPackage?.version,
  );

  return {
    available,
    label: available
      ? "Verification package available"
      : "Verification package not recorded",
  };
}

export function hasPublicVerification(detail?: DetailWorkspaceState | null): boolean {
  return Boolean(
    detail?.capabilities.publicVerifyIncluded &&
      (detail.evidence?.anchor?.configured || detail.evidence?.anchor?.published)
  );
}

export function getCaseName(caseId: string | null | undefined, caseMap: Map<string, string>): string | null {
  if (!caseId) return null;
  return caseMap.get(caseId) ?? null;
}
