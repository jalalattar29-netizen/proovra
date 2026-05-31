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
    <div
      data-redaction-projects-page
      style={{
        padding: 20,
        maxWidth: 1180,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, marginBottom: 4, marginTop: 0 }}>
          Enterprise Redaction Platform
        </h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Workspace-anchored redaction projects. Original evidence is
          NEVER modified — every approved version generates a
          derivative artifact with its own bounded audit trail.
        </p>
      </header>

      <SummaryTiles summary={summary} />

      <ProviderHealthRibbon providers={providers} />

      {banner ? (
        <div
          data-redaction-banner
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            borderRadius: 8,
            background: "rgba(239, 68, 68, 0.08)",
            border: "1px solid rgba(239, 68, 68, 0.35)",
            color: "#7f1d1d",
            fontSize: 12,
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
    </div>
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
        gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
        gap: 10,
        marginBottom: 14,
      }}
    >
      {tiles.map((t) => (
        <div
          key={t.key}
          data-redaction-summary-tile={t.key}
          style={tileStyle}
        >
          <small style={tileLabelStyle}>{t.label}</small>
          <strong style={tileValueStyle}>{t.value}</strong>
        </div>
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
    <section
      data-redaction-provider-health
      style={{
        marginBottom: 14,
        padding: 10,
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
      }}
    >
      <strong style={{ display: "block", fontSize: 12, marginBottom: 6 }}>
        Detection provider health
      </strong>
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {providers.map((p) => {
          const tone =
            p.state === "READY"
              ? "ok"
              : p.state === "RATE_LIMITED" || p.state === "DISABLED_BY_POLICY"
              ? "info"
              : p.state === "ERROR"
              ? "warn"
              : "muted";
          return (
            <span
              key={p.provider}
              data-redaction-provider-health-row={p.provider}
              data-redaction-provider-health-state={p.state}
              title={p.reason ?? ""}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                background:
                  tone === "ok"
                    ? "rgba(34, 197, 94, 0.12)"
                    : tone === "info"
                    ? "rgba(59, 130, 246, 0.1)"
                    : tone === "warn"
                    ? "rgba(239, 68, 68, 0.1)"
                    : "rgba(15, 23, 42, 0.06)",
                color:
                  tone === "ok"
                    ? "#166534"
                    : tone === "info"
                    ? "#1e3a8a"
                    : tone === "warn"
                    ? "#7f1d1d"
                    : "#0f172a",
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              {p.provider} · {p.state}
              {p.policyAllowed ? "" : " · disabled"}
            </span>
          );
        })}
      </div>
      <small
        style={{
          display: "block",
          marginTop: 6,
          color: "#475569",
          fontSize: 11,
        }}
      >
        READY = provider credentials are bound for this workspace.
        NOT_CONFIGURED is honest — the provider is wired but the
        credentials are not yet present.
      </small>
    </section>
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
    <section
      data-redaction-open-form
      style={{
        marginBottom: 16,
        padding: 12,
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        display: "grid",
        gridTemplateColumns: "2fr 1fr 1fr auto",
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
      <button
        type="button"
        data-redaction-open-submit
        onClick={onOpen}
        disabled={busy || !evidenceId}
        style={{
          padding: "8px 14px",
          borderRadius: 8,
          border: "1px solid #0f172a",
          background: busy || !evidenceId ? "#94a3b8" : "#0f172a",
          color: "#fafafa",
          fontWeight: 600,
          fontSize: 13,
          cursor: busy || !evidenceId ? "not-allowed" : "pointer",
        }}
      >
        Open project
      </button>
    </section>
  );
}

function ProjectsTable({ rows }: { rows: ReadonlyArray<ProjectRow> }) {
  if (rows.length === 0) {
    return (
      <div
        data-redaction-projects-empty
        style={{
          padding: 20,
          background: "#fff",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 10,
          color: "#475569",
          fontSize: 13,
        }}
      >
        No redaction projects yet. Open one above to begin.
      </div>
    );
  }
  return (
    <section
      data-redaction-projects-table-wrap
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <table
        data-redaction-projects-table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
      >
        <thead>
          <tr style={{ textAlign: "left", color: "#475569" }}>
            <th style={th}>Project</th>
            <th style={th}>Evidence</th>
            <th style={th}>Artifact</th>
            <th style={th}>State</th>
            <th style={th}>Created</th>
            <th style={th}>Open</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} data-redaction-project-row={p.id}>
              <td style={td}>
                <strong>{p.title ?? `Project ${p.id.slice(0, 8)}`}</strong>
              </td>
              <td style={td}>
                <code>{p.evidenceId.slice(0, 8)}…</code>
              </td>
              <td style={td}>
                <code>{p.artifactKind}</code>
              </td>
              <td style={td}>
                <Chip label={p.state} tone={stateTone(p.state)} />
              </td>
              <td style={td}>
                {new Date(p.createdAtUtc).toLocaleString()}
              </td>
              <td style={td}>
                <Link
                  data-redaction-project-open={p.id}
                  href={`/redaction/${p.id}`}
                  style={{
                    color: "#0f172a",
                    textDecoration: "underline",
                    fontWeight: 600,
                  }}
                >
                  Open →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Chip({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "info" | "muted" | "warn";
}) {
  const palette = {
    ok: { bg: "rgba(34, 197, 94, 0.12)", fg: "#166534" },
    info: { bg: "rgba(59, 130, 246, 0.1)", fg: "#1e3a8a" },
    muted: { bg: "rgba(15, 23, 42, 0.06)", fg: "#0f172a" },
    warn: { bg: "rgba(239, 68, 68, 0.1)", fg: "#7f1d1d" },
  }[tone];
  return (
    <span
      style={{
        padding: "1px 8px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

function stateTone(state: string): "ok" | "info" | "muted" | "warn" {
  switch (state) {
    case "PUBLISHED":
      return "ok";
    case "APPROVED":
    case "IN_REVIEW":
      return "info";
    case "REJECTED":
      return "warn";
    default:
      return "muted";
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
const th = {
  padding: "6px 8px",
  borderBottom: "1px solid #e2e8f0",
} as const;
const td = {
  padding: "6px 8px",
  borderBottom: "1px solid #f1f5f9",
} as const;
const tileStyle = {
  padding: 10,
  background: "#fff",
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 10,
  display: "flex",
  flexDirection: "column" as const,
  gap: 4,
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
