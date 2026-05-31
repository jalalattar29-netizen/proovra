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
import { apiFetch } from "../../../../lib/api";

import { ImageRedactionViewer } from "../../../../components/redaction/ImageRedactionViewer";
import { PdfRedactionViewer } from "../../../../components/redaction/PdfRedactionViewer";
import { VideoRedactionViewer } from "../../../../components/redaction/VideoRedactionViewer";
import { VideoReviewWorkspace } from "../../../../components/redaction/VideoReviewWorkspace";
import { DetectionReviewPanel } from "../../../../components/redaction/DetectionReviewPanel";
import { ApprovalPanel } from "../../../../components/redaction/ApprovalPanel";
import { VersionHistoryPanel } from "../../../../components/redaction/VersionHistoryPanel";

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
    fileSha256: string | null;
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

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(`/v1/redaction/projects/${projectId}`, {
        method: "GET",
      });
      const p = res?.project as ProjectProjection | undefined;
      setProject(p ?? null);
      if (p && !selectedVersionId && p.versions.length > 0) {
        setSelectedVersionId(p.versions[0].id);
      }
    } catch {
      setProject(null);
    }
  }, [projectId, selectedVersionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      action: "submit" | "approve" | "publish",
      verdict?: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
      rationale?: string,
    ) => {
      try {
        const url = `/v1/redaction/versions/${versionId}/${action}`;
        const body =
          action === "approve"
            ? JSON.stringify({ verdict, rationale })
            : JSON.stringify({ rationale });
        await apiFetch(url, { method: "POST", body });
        setBanner(`Version transitioned (${action}).`);
        await refresh();
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setBanner(`Refused: ${((err as any)?.denial ?? "POLICY_REJECTED")}`);
      }
    },
    [refresh],
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
    action: "submit" | "approve" | "publish",
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

      <DetectionReviewPanel
        versionId={version.id}
        versionLocked={version.state !== "DRAFT"}
        onChanged={onChanged}
      />

      <ApprovalPanel
        version={version}
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
