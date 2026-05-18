"use client";

/**
 * Phase 23 — Workflow instances list page.
 *
 * Workspace-internal operator view of running workflows with filters
 * by status + sector. Each row links to the workflow instance detail
 * page. Templates summary is rendered as a side card so operators can
 * see what sectors / intake modes the workspace supports.
 *
 * Wording invariant: operational only.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";

type InstanceStatus =
  | "DRAFT"
  | "ACTIVE"
  | "SUBMITTED"
  | "NEEDS_REVIEW"
  | "APPROVED"
  | "REPORT_READY"
  | "PACKAGE_READY"
  | "SHARED_EXTERNALLY"
  | "ARCHIVED"
  | "RETAINED"
  | "LEGAL_HOLD"
  | "CANCELLED"
  | "CHANGES_REQUESTED";

type Instance = {
  id: string;
  status: InstanceStatus;
  intakeMode: string;
  actorRole: string;
  templateSlug: string | null;
  templateVersion: number | null;
  title: string | null;
  assignedReviewerUserId: string | null;
  createdAt: string;
  submittedAtUtc: string | null;
  approvedAtUtc: string | null;
};

type TemplateSummary = {
  slug: string;
  version: number;
  name: string;
  description: string | null;
  workspaceCategory: string | null;
  intakeModes: string[];
  requiredStepCount: number;
  stepCount: number;
  source: string;
};

const STATUSES: InstanceStatus[] = [
  "DRAFT",
  "ACTIVE",
  "SUBMITTED",
  "NEEDS_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "REPORT_READY",
  "PACKAGE_READY",
  "SHARED_EXTERNALLY",
  "LEGAL_HOLD",
  "ARCHIVED",
  "RETAINED",
  "CANCELLED",
];

const SECTORS: ReadonlyArray<string> = [
  "GENERAL",
  "INSURANCE",
  "LEGAL",
  "JOURNALISM",
  "INVESTIGATIONS",
  "COMPLIANCE",
  "FIELD_OPERATIONS",
  "RESEARCH",
  "OTHER",
];

export default function WorkflowsListPage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [status, setStatus] = useState<InstanceStatus | "">("");
  const [sector, setSector] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((r: { user?: { currentWorkspaceId?: string | null } }) => {
        if (!cancelled) setTeamId(r?.user?.currentWorkspaceId ?? null);
      })
      .catch(() => setTeamId(null));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    if (status) qs.set("status", status);
    qs.set("limit", "200");
    const templatesQs = new URLSearchParams();
    templatesQs.set("teamId", teamId);
    if (sector) templatesQs.set("sector", sector);
    templatesQs.set("limit", "50");
    Promise.all([
      apiFetch(
        `/v1/workflows/instances?${qs.toString()}`,
        { method: "GET" },
      ),
      apiFetch(
        `/v1/workflows/templates?${templatesQs.toString()}`,
        { method: "GET" },
      ).catch(() => ({ templates: [] })),
    ])
      .then(([i, t]: [{ instances: Instance[] }, { templates: TemplateSummary[] }]) => {
        if (cancelled) return;
        setInstances(i.instances ?? []);
        setTemplates(t.templates ?? []);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Could not load workflows.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, status, sector]);

  const counts = useMemo(() => {
    if (!instances) return null;
    return {
      total: instances.length,
      active: instances.filter((i) => i.status === "ACTIVE" || i.status === "SUBMITTED" || i.status === "NEEDS_REVIEW" || i.status === "CHANGES_REQUESTED").length,
      approved: instances.filter((i) => i.status === "APPROVED" || i.status === "REPORT_READY" || i.status === "PACKAGE_READY" || i.status === "SHARED_EXTERNALLY").length,
      blocked: instances.filter((i) => i.status === "LEGAL_HOLD" || i.status === "CANCELLED").length,
    };
  }, [instances]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Workflows</h1>
        <p style={mutedStyle}>
          Operational workflows in this workspace. The list reflects the
          backend engine state; templates the workspace supports are
          shown alongside.
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to view workflows.</p>
      ) : (
        <>
          {counts ? (
            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Summary</h2>
              <div style={healthGridStyle}>
                <Stat label="Total" value={String(counts.total)} />
                <Stat label="In review" value={String(counts.active)} />
                <Stat label="Approved" value={String(counts.approved)} />
                <Stat label="Blocked" value={String(counts.blocked)} />
              </div>
            </section>
          ) : null}

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Instances</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as InstanceStatus | "")}
                  style={selectStyle}
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {instances === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : instances.length === 0 ? (
              <p style={mutedStyle}>No workflows match the filters.</p>
            ) : (
              <ul style={listStyle}>
                {instances.map((i) => (
                  <li key={i.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        <Link
                          href={`/workflows/${i.id}`}
                          style={{ color: "#0f172a", textDecoration: "none" }}
                        >
                          {i.title ?? "Untitled workflow"}
                        </Link>{" "}
                        <span style={chipStyle}>
                          {i.templateSlug ?? "no template"}
                        </span>
                      </div>
                      <div style={mutedStyle}>
                        intake {i.intakeMode} · actor {i.actorRole}
                        {i.assignedReviewerUserId
                          ? ` · reviewer ${i.assignedReviewerUserId.slice(0, 8)}…`
                          : ""}
                      </div>
                      <div style={mutedStyle}>
                        created {new Date(i.createdAt).toLocaleString()}
                        {i.submittedAtUtc
                          ? ` · submitted ${new Date(i.submittedAtUtc).toLocaleString()}`
                          : ""}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(i.status)}>{i.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Templates available</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={sector}
                  onChange={(e) => setSector(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">All sectors</option>
                  {SECTORS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {templates === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : templates.length === 0 ? (
              <p style={mutedStyle}>No templates match the sector filter.</p>
            ) : (
              <ul style={listStyle}>
                {templates.map((t) => (
                  <li key={`${t.slug}-v${t.version}`} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {t.name}{" "}
                        <span style={chipStyle}>{t.slug}</span>{" "}
                        <span style={chipStyle}>v{t.version}</span>
                      </div>
                      <div style={mutedStyle}>
                        {t.description ?? "No description."}
                      </div>
                      <div style={mutedStyle}>
                        {t.requiredStepCount}/{t.stepCount} required steps ·{" "}
                        {t.workspaceCategory ?? "GENERAL"} · intake{" "}
                        {t.intakeModes.join(", ")} · source {t.source}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statStyle}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
        {value}
      </div>
      <div style={mutedStyle}>{label}</div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 1040,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 12,
};
const healthGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
};
const statStyle: React.CSSProperties = {
  padding: 10,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 8px",
  borderBottom: "1px solid #e2e8f0",
};
const chipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
  marginLeft: 6,
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
};

function statusBadgeStyle(status: InstanceStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (
    status === "APPROVED" ||
    status === "REPORT_READY" ||
    status === "PACKAGE_READY" ||
    status === "SHARED_EXTERNALLY"
  ) {
    return { ...base, background: "#f0fdf4", borderColor: "#86efac", color: "#166534" };
  }
  if (
    status === "NEEDS_REVIEW" ||
    status === "CHANGES_REQUESTED" ||
    status === "SUBMITTED"
  ) {
    return { ...base, background: "#fffbeb", borderColor: "#fcd34d", color: "#92400e" };
  }
  if (
    status === "LEGAL_HOLD" ||
    status === "CANCELLED" ||
    status === "ARCHIVED"
  ) {
    return { ...base, background: "#fef2f2", borderColor: "#fca5a5", color: "#7f1d1d" };
  }
  return { ...base, background: "#eff6ff", borderColor: "#93c5fd", color: "#1e40af" };
}
