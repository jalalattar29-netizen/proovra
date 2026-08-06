"use client";

/**
 * PROOVRA Phase 3A — Redaction project workspace.
 *
 * Bounded operator surface for a single project. Composes:
 *
 *   * Project header with state + artifact kind + provenance link
 *   * Version history panel (newest → oldest, with state chips)
 *   * Per-version: region viewer (image / PDF / video), detection
 *     review panel, approval panel
 *   * Activity timeline
 *
 * Hard rules:
 *   * The viewer renders the ORIGINAL bytes overlaid with redaction
 *     regions ONLY for authoring purposes. The derivative is what
 *     consumers downstream see — this page is the operator surface.
 *   * Every action is server-side gated; the UI just reflects what
 *     the API accepted.
 */

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTeamId, useTenantGuard } from "../../../../lib/platform-context";

import { ImageRedactionViewer } from "../../../../components/redaction/ImageRedactionViewer";
import { PdfRedactionViewer } from "../../../../components/redaction/PdfRedactionViewer";
import { VideoRedactionViewer } from "../../../../components/redaction/VideoRedactionViewer";
import { VideoReviewWorkspace } from "../../../../components/redaction/VideoReviewWorkspace";
import { DetectionReviewPanel } from "../../../../components/redaction/DetectionReviewPanel";
import { ApprovalPanel } from "../../../../components/redaction/ApprovalPanel";
import { VersionHistoryPanel } from "../../../../components/redaction/VersionHistoryPanel";
// PHASE 12B (Evidence Operations) — product surfaces for two previously
// unreachable ops: DELETE /v1/redaction/regions/:id (region removal) and
// GET /v1/redaction/evidence/:evidenceId/detection-manifest.
import {
  RegionListPanel,
  type RedactionRegionRow,
} from "../../../../components/redaction/RegionListPanel";
import { DetectionManifestPanel } from "../../../../components/redaction/DetectionManifestPanel";
import {
  isDerivativeInFlight,
  useDerivativePolling,
} from "../../../../components/redaction/useDerivativePolling";

type ProjectProjection = {
  schemaVersion: string;
  generatedAtUtc: string;
  id: string;
  evidenceId: string;
  artifactKind: "IMAGE" | "PDF" | "VIDEO" | "AUDIO";
  title: string | null;
  state: string;
  publishedVersion: VersionProjection | null;
  versions: VersionProjection[];
  limitations: ReadonlyArray<string>;
};

type VersionProjection = {
  id: string;
  versionOrdinal: number;
  state: string;
  authoredByUserId: string;
  createdAtUtc: string;
  submittedAtUtc: string | null;
  approvedAtUtc: string | null;
  publishedAtUtc: string | null;
  rationale: string | null;
  regionCount: number;
  // PHASE 12B — the server projection now returns the authored regions,
  // so the operator can see and remove what will be masked.
  regions: ReadonlyArray<RedactionRegionRow>;
  acceptedDetectionCount: number;
  rejectedDetectionCount: number;
  approvals: ReadonlyArray<{
    id: string;
    verdict: string;
    approverUserId: string;
    decidedAtUtc: string;
    rationale: string | null;
  }>;
  derivative: {
    id: string;
    state: string;
    kind: string;
    fileSha256: string | null;
    failureReason: string | null;
  } | null;
};

export default function RedactionProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return (
    <PageRouteGate routeId="workspace.review_redaction">
      <RedactionProjectShell params={params} />
    </PageRouteGate>
  );
}

function RedactionProjectShell({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const [project, setProject] = useState<ProjectProjection | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null,
  );
  const [banner, setBanner] = useState<string | null>(null);
  // Active workspace id — the step-up challenge is minted against this
  // tenant. Publishing a redacted derivative is a sensitive, irreversible
  // disclosure action, so when the backend answers STEP_UP_REQUIRED the
  // hook opens the modal and resumes the EXACT publish request with the
  // challenge header. Reuses the existing enterprise step-up flow — no
  // parallel implementation, and viewing / authoring are never gated.
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });
  // §10.3 stale-response guard — a workspace switch between request and
  // response makes the payload another tenant's data; drop it.
  const { stamp, isStale } = useTenantGuard();

  const refresh = useCallback(async () => {
    const captured = stamp();
    try {
      const res = await apiFetch(`/v1/redaction/projects/${projectId}`, {
        method: "GET",
      });
      if (isStale(captured)) return; // workspace changed mid-flight — discard
      const p = res?.project as ProjectProjection | undefined;
      setProject(p ?? null);
      if (p && !selectedVersionId && p.versions.length > 0) {
        setSelectedVersionId(p.versions[0].id);
      }
    } catch {
      if (isStale(captured)) return;
      // Keep whatever we already showed on a transient poll failure; only
      // the initial load renders the empty state.
      setProject((prev) => prev ?? null);
    }
  }, [projectId, selectedVersionId, stamp, isStale]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Macro-Wave A1 — while any version's derivative is QUEUED/RENDERING,
  // poll the projection so the operator sees the render progress without
  // reloading. Stops on unmount, when nothing is in flight, and on
  // workspace change (tenant-generation keyed inside the hook).
  const derivativeInFlight = useMemo(
    () =>
      (project?.versions ?? []).some((v) =>
        isDerivativeInFlight(v.derivative?.state),
      ),
    [project],
  );
  useDerivativePolling({ active: derivativeInFlight, refresh });

  const selectedVersion = useMemo(
    () =>
      project?.versions.find((v) => v.id === selectedVersionId) ?? null,
    [project, selectedVersionId],
  );

  const onNewVersion = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/v1/redaction/projects/${projectId}/versions`,
        { method: "POST", body: "{}" },
      );
      setBanner(
        `Created version v${(res?.versionOrdinal ?? "?") as number}.`,
      );
      setSelectedVersionId(res?.versionId ?? null);
      await refresh();
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setBanner(`Refused: ${((err as any)?.denial ?? "POLICY_REJECTED")}`);
    }
  }, [projectId, refresh]);

  const onTransition = useCallback(
    async (
      versionId: string,
      action: "submit" | "approve" | "publish" | "derivative",
      verdict?: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
      rationale?: string,
    ) => {
      const url = `/v1/redaction/versions/${versionId}/${action}`;
      const body =
        action === "approve"
          ? JSON.stringify({ verdict, rationale })
          : JSON.stringify({ rationale });
      try {
        if (action === "publish") {
          // PUBLISH is the sensitive, irreversible disclosure step. Run it
          // INSIDE runStepUpAction: if the backend gate answers
          // STEP_UP_REQUIRED, the modal opens and, on successful step-up,
          // the hook resumes THIS exact publish request with the challenge
          // header injected on retry (never spelled out here). When no
          // challenge is demanded the wrapper is a transparent no-op.
          await stepUp.runStepUpAction(async (headers) =>
            apiFetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(headers ?? {}) },
              body,
            }),
          );
        } else {
          await apiFetch(url, { method: "POST", body });
        }
        setBanner(`Version transitioned (${action}).`);
        await refresh();
      } catch (err) {
        // Cancelling step-up must NOT publish and must NOT surface a scary
        // error — the operator deliberately backed out.
        const code = (err as { code?: string })?.code;
        if (code === "STEP_UP_CANCEL") {
          setBanner("Step-up cancelled — the redaction was not published.");
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const denial = (err as any)?.denial as string | undefined;
        if (denial) {
          setBanner(`Refused: ${denial}`);
          return;
        }
        setBanner(
          toSafeUserError(err, {
            message: `We couldn't complete the ${action} action.`,
          }).message,
        );
      }
    },
    [refresh, stepUp],
  );

  if (!project) {
    return (
      <main style={{ padding: 40, textAlign: "center" }}>Loading…</main>
    );
  }

  return (
    <div
      data-redaction-project-page
      data-redaction-project-id={projectId}
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 12,
          gap: 12,
        }}
      >
        <div>
          <Link href="/redaction" style={{ color: "#475569", fontSize: 12 }}>
            ← All projects
          </Link>
          <h1 style={{ fontSize: 20, marginBottom: 4, marginTop: 6 }}>
            {project.title ?? `Project ${project.id.slice(0, 8)}`}
          </h1>
          <p style={{ color: "#475569", fontSize: 12, margin: 0 }}>
            Evidence <code>{project.evidenceId}</code> ·{" "}
            <code>{project.artifactKind}</code> · state{" "}
            <code data-redaction-project-state>{project.state}</code>
          </p>
        </div>
        <button
          type="button"
          data-redaction-new-version
          onClick={onNewVersion}
          style={primaryButton}
        >
          + New version
        </button>
      </header>

      {/* Reuses the existing step-up flow — the modal opens only when the
          backend answers STEP_UP_REQUIRED for the publish request. */}
      <StepUpModal control={stepUp} />

      {banner ? (
        <div
          data-redaction-banner
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            borderRadius: 8,
            background: "rgba(15, 23, 42, 0.05)",
            fontSize: 12,
          }}
        >
          {banner}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          gap: 14,
        }}
      >
        <aside>
          <VersionHistoryPanel
            versions={project.versions}
            selectedId={selectedVersionId}
            onSelect={setSelectedVersionId}
          />
        </aside>

        <main>
          {selectedVersion ? (
            <VersionWorkspace
              project={project}
              version={selectedVersion}
              onTransition={onTransition}
              onChanged={() => {
                void refresh();
              }}
            />
          ) : (
            <div
              data-redaction-no-version
              style={{
                padding: 20,
                background: "#fff",
                border: "1px solid rgba(15, 23, 42, 0.08)",
                borderRadius: 10,
                color: "#475569",
                fontSize: 13,
              }}
            >
              Create a new version to begin authoring redactions.
            </div>
          )}
        </main>
      </div>

      <footer
        data-redaction-limitations-footer
        style={{
          marginTop: 18,
          padding: 10,
          background: "rgba(15, 23, 42, 0.04)",
          border: "1px dashed rgba(15, 23, 42, 0.18)",
          borderRadius: 8,
          fontSize: 11,
          color: "#475569",
        }}
      >
        <strong style={{ color: "#0f172a" }}>Redaction platform limitations</strong>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {project.limitations.map((l) => (
            <li key={l}>
              <code>{l}</code>
            </li>
          ))}
        </ul>
      </footer>
    </div>
  );
}

function VersionWorkspace({
  project,
  version,
  onTransition,
  onChanged,
}: {
  project: ProjectProjection;
  version: VersionProjection;
  onTransition: (
    versionId: string,
    action: "submit" | "approve" | "publish" | "derivative",
    verdict?: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
    rationale?: string,
  ) => Promise<void>;
  onChanged: () => void;
}) {
  return (
    <div
      data-redaction-version-workspace
      data-redaction-version-id={version.id}
      style={{
        display: "grid",
        gap: 12,
      }}
    >
      <header
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          background: "#fff",
          padding: 10,
          borderRadius: 10,
          border: "1px solid rgba(15, 23, 42, 0.08)",
        }}
      >
        <strong style={{ fontSize: 14 }}>
          Version v{version.versionOrdinal}
        </strong>
        <code style={{ fontSize: 11, color: "#475569" }}>
          state: {version.state}
        </code>
        <span style={{ flex: 1 }} />
        <small style={{ color: "#475569", fontSize: 11 }}>
          {version.regionCount} regions ·{" "}
          {version.acceptedDetectionCount} accepted ·{" "}
          {version.rejectedDetectionCount} rejected
        </small>
      </header>

      {project.artifactKind === "IMAGE" ? (
        <ImageRedactionViewer
          evidenceId={project.evidenceId}
          versionId={version.id}
          versionLocked={version.state !== "DRAFT"}
          regions={version.regions ?? []}
          onChanged={onChanged}
        />
      ) : project.artifactKind === "PDF" ? (
        <PdfRedactionViewer
          evidenceId={project.evidenceId}
          versionId={version.id}
          versionLocked={version.state !== "DRAFT"}
          onChanged={onChanged}
        />
      ) : project.artifactKind === "VIDEO" ? (
        <>
          <VideoRedactionViewer
            evidenceId={project.evidenceId}
            versionId={version.id}
            versionLocked={version.state !== "DRAFT"}
            onChanged={onChanged}
          />
          <VideoReviewWorkspace
            evidenceId={project.evidenceId}
            versionLocked={version.state !== "DRAFT"}
            onChanged={onChanged}
          />
        </>
      ) : (
        <div
          data-redaction-viewer-audio
          style={{
            padding: 12,
            background: "#fff",
            border: "1px solid rgba(15, 23, 42, 0.08)",
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          Audio redaction uses time-range regions only. Add regions
          via the API <code>AUDIO_RANGE_MS</code> region kind.
        </div>
      )}

      {/* PHASE 12B — authored regions, with server-gated removal. The
          list is the server projection; removal calls
          DELETE /v1/redaction/regions/:id and then re-reads. */}
      <RegionListPanel
        regions={version.regions ?? []}
        versionLocked={version.state !== "DRAFT"}
        onChanged={onChanged}
      />

      <DetectionReviewPanel
        versionId={version.id}
        versionLocked={version.state !== "DRAFT"}
        onChanged={onChanged}
      />

      {/* PHASE 12B — bounded, count-only detection record for every
          published version of this evidence. Read-only. */}
      <DetectionManifestPanel evidenceId={project.evidenceId} />

      <ApprovalPanel
        version={version}
        artifactKind={project.artifactKind}
        onTransition={onTransition}
      />
    </div>
  );
}

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
