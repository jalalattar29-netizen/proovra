"use client";

/**
 * PROOVRA Phase 3A — Redaction Projects list (Review pillar entry).
 *
 * Bounded landing page that lists the workspace's redaction projects
 * + the per-workspace summary tile. Every interaction round-trips
 * through the workspace-anchored API; the page never assumes a
 * server-side state.
 *
 * Hard rule: original evidence is NEVER referenced as a download
 * target from this page. Project rows link into the bounded
 * redaction workspace at `/redaction/[projectId]`.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import { PageShell, PageHeader, PageSection } from "../../../components/ui/PageShell";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge, type BadgeTone } from "../../../components/ui/Badge";
import { DataTable } from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";

type ProjectRow = {
  id: string;
  evidenceId: string;
  artifactKind: string;
  title: string | null;
  state: string;
  createdAtUtc: string;
  createdByUserId: string;
};

type WorkspaceSummary = {
  pendingDecisionCount: number;
  awaitingApprovalCount: number;
  approvedPendingDerivativeCount: number;
  publishedCount: number;
  rejectedCount: number;
};

type ProviderHealthRow = {
  provider: string;
  state: string;
  reason: string | null;
  policyAllowed: boolean;
};

export default function RedactionProjectsPage() {
  return (
    <PageRouteGate routeId="workspace.review_redaction">
      <RedactionProjectsShell />
    </PageRouteGate>
  );
}

function RedactionProjectsShell() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [providers, setProviders] = useState<ProviderHealthRow[] | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch("/v1/redaction/projects", { method: "GET" });
      setRows((r?.projects ?? []) as ProjectRow[]);
    } catch {
      setRows([]);
    }
    try {
      const s = await apiFetch("/v1/redaction/workspace/summary", {
        method: "GET",
      });
      setSummary((s?.summary ?? null) as WorkspaceSummary | null);
    } catch {
      setSummary(null);
    }
    try {
      const h = await apiFetch("/v1/redaction/providers/health", {
        method: "GET",
      });
      setProviders((h?.providers ?? []) as ProviderHealthRow[]);
    } catch {
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <PageShell
      data-redaction-projects-page
      header={
        <PageHeader
          eyebrow="Redaction"
          title="Enterprise Redaction Platform"
          subtitle="Workspace-anchored redaction projects. Original evidence is NEVER modified — every approved version generates a derivative artifact with its own bounded audit trail."
        />
      }
    >
      <SummaryTiles summary={summary} />

      <ProviderHealthRibbon providers={providers} />

      {banner ? (
        <div
          data-redaction-banner
          style={{
            padding: "10px 12px",
            borderRadius: "var(--radius-md, 8px)",
            background: "var(--status-risk-bg, #fef2f2)",
            border: "1px solid var(--status-risk-border, #fecaca)",
            color: "var(--status-risk-fg, #991b1b)",
            fontSize: 12.5,
          }}
        >
          {banner}
        </div>
      ) : null}

      <RedactionOpenForm
        onOpened={(msg) => {
          setBanner(msg);
          void refresh();
        }}
        onRefuse={(msg) => setBanner(`Refused: ${msg}`)}
      />

      <ProjectsTable rows={rows ?? []} />
    </PageShell>
  );
}

function SummaryTiles({ summary }: { summary: WorkspaceSummary | null }) {
  if (!summary) {
    return (
      <div
        data-redaction-summary-tiles-empty
        style={{ marginBottom: 14, color: "#475569", fontSize: 12 }}
      >
        Loading workspace summary…
      </div>
    );
  }
  const tiles: Array<{ label: string; value: number; key: string }> = [
    { label: "Pending decisions", value: summary.pendingDecisionCount, key: "PENDING_DECISIONS" },
    { label: "Awaiting approval", value: summary.awaitingApprovalCount, key: "AWAITING_APPROVAL" },
    {
      label: "Approved, derivative pending",
      value: summary.approvedPendingDerivativeCount,
      key: "APPROVED_PENDING_DERIVATIVE",
    },
    { label: "Published", value: summary.publishedCount, key: "PUBLISHED" },
    { label: "Rejected", value: summary.rejectedCount, key: "REJECTED" },
  ];
  return (
    <div
      data-redaction-summary-tiles
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
        gap: 12,
      }}
    >
      {tiles.map((t) => (
        <Card key={t.key} padding="compact" data-redaction-summary-tile={t.key}>
          <small style={tileLabelStyle}>{t.label}</small>
          <strong style={tileValueStyle}>{t.value}</strong>
        </Card>
      ))}
    </div>
  );
}

function ProviderHealthRibbon({
  providers,
}: {
  providers: ProviderHealthRow[] | null;
}) {
  if (providers === null) {
    return (
      <div
        data-redaction-provider-health-empty
        style={{ marginBottom: 12, color: "#475569", fontSize: 12 }}
      >
        Loading provider health…
      </div>
    );
  }
  if (providers.length === 0) return null;
  return (
    <Card
      data-redaction-provider-health
      padding="compact"
      title="Detection provider health"
    >
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {providers.map((p) => {
          const tone: BadgeTone =
            p.state === "READY"
              ? "verified"
              : p.state === "RATE_LIMITED" || p.state === "DISABLED_BY_POLICY"
              ? "info"
              : p.state === "ERROR"
              ? "risk"
              : "neutral";
          return (
            <Badge
              key={p.provider}
              tone={tone}
              subtle
              data-redaction-provider-health-row={p.provider}
              data-redaction-provider-health-state={p.state}
              title={p.reason ?? ""}
            >
              {p.provider} · {p.state}
              {p.policyAllowed ? "" : " · disabled"}
            </Badge>
          );
        })}
      </div>
      <small
        style={{
          display: "block",
          marginTop: 8,
          color: "var(--ink-secondary, #475569)",
          fontSize: 11.5,
        }}
      >
        READY = provider credentials are bound for this workspace.
        NOT_CONFIGURED is honest — the provider is wired but the
        credentials are not yet present.
      </small>
    </Card>
  );
}

function RedactionOpenForm({
  onOpened,
  onRefuse,
}: {
  onOpened: (msg: string) => void;
  onRefuse: (msg: string) => void;
}) {
  const [evidenceId, setEvidenceId] = useState("");
  const [artifactKind, setArtifactKind] = useState<
    "IMAGE" | "PDF" | "VIDEO" | "AUDIO"
  >("IMAGE");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const onOpen = useCallback(async () => {
    if (!evidenceId) return;
    setBusy(true);
    try {
      const res = await apiFetch("/v1/redaction/projects", {
        method: "POST",
        body: JSON.stringify({
          evidenceId: evidenceId.trim(),
          artifactKind,
          title: title.trim() || undefined,
        }),
      });
      onOpened(
        `Opened redaction project ${(res?.projectId ?? "").slice(0, 8)}…`,
      );
      setEvidenceId("");
      setTitle("");
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onRefuse(((err as any)?.denial ?? "POLICY_REJECTED") as string);
    } finally {
      setBusy(false);
    }
  }, [evidenceId, artifactKind, title, onOpened, onRefuse]);
  return (
    <Card
      data-redaction-open-form
      title="Open a redaction project"
      subtitle="Original evidence is never modified — this opens a bounded, workspace-anchored project."
    >
      <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
        gap: 10,
        alignItems: "end",
      }}
    >
      <Field label="Evidence id (UUID)">
        <input
          data-redaction-open-evidence
          value={evidenceId}
          onChange={(e) => setEvidenceId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          style={inputStyle}
        />
      </Field>
      <Field label="Artifact">
        <select
          data-redaction-open-artifact
          value={artifactKind}
          onChange={(e) =>
            setArtifactKind(
              e.target.value as "IMAGE" | "PDF" | "VIDEO" | "AUDIO",
            )
          }
          style={inputStyle}
        >
          <option value="IMAGE">IMAGE</option>
          <option value="PDF">PDF</option>
          <option value="VIDEO">VIDEO</option>
          <option value="AUDIO">AUDIO</option>
        </select>
      </Field>
      <Field label="Title (optional)">
        <input
          data-redaction-open-title
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={inputStyle}
        />
      </Field>
      <Button
        variant="primary"
        data-redaction-open-submit
        onClick={onOpen}
        disabled={busy || !evidenceId}
        loading={busy}
      >
        Open project
      </Button>
      </div>
    </Card>
  );
}

function ProjectsTable({ rows }: { rows: ReadonlyArray<ProjectRow> }) {
  return (
    <PageSection title="Redaction projects">
      <div data-redaction-projects-table-wrap>
        <DataTable
          ariaLabel="Redaction projects"
          rows={[...rows]}
          getRowId={(p) => p.id}
          columns={[
            {
              key: "project",
              header: "Project",
              render: (p) => (
                <strong data-redaction-project-row={p.id}>
                  {p.title ?? `Project ${p.id.slice(0, 8)}`}
                </strong>
              ),
            },
            {
              key: "evidence",
              header: "Evidence",
              render: (p) => <code>{p.evidenceId.slice(0, 8)}…</code>,
            },
            {
              key: "artifact",
              header: "Artifact",
              render: (p) => <code>{p.artifactKind}</code>,
            },
            {
              key: "state",
              header: "State",
              render: (p) => (
                <Badge tone={stateTone(p.state)} subtle>
                  {p.state}
                </Badge>
              ),
            },
            {
              key: "created",
              header: "Created",
              nowrap: true,
              render: (p) => formatUserDateTime(p.createdAtUtc),
            },
          ]}
          rowActions={(p) => (
            <Link
              data-redaction-project-open={p.id}
              href={`/redaction/${p.id}`}
              style={{
                color: "var(--ink-primary, #0f172a)",
                textDecoration: "underline",
                fontWeight: 600,
              }}
            >
              Open →
            </Link>
          )}
          emptyState={
            <EmptyState
              data-redaction-projects-empty
              title="No redaction projects yet"
              purpose="Open a project above to redact an evidence artifact. The original is never modified."
            />
          }
        />
      </div>
    </PageSection>
  );
}

function stateTone(state: string): BadgeTone {
  switch (state) {
    case "PUBLISHED":
      return "verified";
    case "APPROVED":
    case "IN_REVIEW":
      return "info";
    case "REJECTED":
      return "risk";
    default:
      return "neutral";
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <small style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>
        {label}
      </small>
      {children}
    </label>
  );
}

const inputStyle = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  boxSizing: "border-box" as const,
};
const tileLabelStyle = {
  fontSize: 11,
  color: "#475569",
  fontWeight: 600,
};
const tileValueStyle = {
  fontSize: 22,
  color: "#0f172a",
  fontWeight: 700,
};
