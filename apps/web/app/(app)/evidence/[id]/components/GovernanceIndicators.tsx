"use client";

/**
 * Phase 9.5 — Governance indicators panel.
 *
 * Authenticated-only badge strip on the evidence detail page showing:
 *   - Active legal hold (with title; reason never displayed)
 *   - Retention-until date when set
 *   - Policy-restricted exports (report / package / public verify)
 *   - Review-required gates that block report/package/public-verify
 *   - Deletion mode (admin-only / disabled)
 *
 * Renders nothing when no governance constraint is active so the
 * evidence page stays clean for non-governed workspaces.
 *
 * Privacy: this component fetches from
 * `GET /v1/governance/evidence/:id/status` which already strips reason
 * fields and is workspace-membership-scoped. Public verify never reads
 * any of this data.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";

type Status = {
  legalHold: {
    id: string;
    title: string;
    status: "ACTIVE" | "RELEASED";
    placedAtUtc: string;
  } | null;
  retention: {
    retentionUntilUtc: string | null;
    policyDefaultDays: number | null;
  };
  policy: {
    source: "workspace_row" | "default";
    evidenceDeletionMode: "ALLOWED" | "ADMIN_ONLY" | "DISABLED";
    requireReviewBeforeReport: boolean;
    requireReviewBeforePackage: boolean;
    requireReviewBeforePublicVerify: boolean;
    allowReportDownload: boolean;
    allowPackageDownload: boolean;
    allowPublicVerify: boolean;
  };
};

export default function GovernanceIndicators({
  evidenceId,
  teamId,
}: {
  evidenceId: string;
  teamId: string | null;
}) {
  const [status, setStatus] = useState<Status | null | undefined>(undefined);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(
      `/v1/governance/evidence/${encodeURIComponent(evidenceId)}/status?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((res: Status) => {
        if (cancelled) return;
        setStatus(res);
      })
      .catch(() => {
        if (cancelled) return;
        setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId, teamId]);

  if (!teamId || status === undefined || status === null) return null;

  const items: Array<{ tone: "warn" | "info" | "danger"; label: string }> = [];

  if (status.legalHold) {
    items.push({
      tone: "danger",
      label: `Legal hold active: ${status.legalHold.title}`,
    });
  }

  if (status.retention.retentionUntilUtc) {
    const until = new Date(status.retention.retentionUntilUtc);
    const expired = until.getTime() <= Date.now();
    items.push({
      tone: expired ? "info" : "warn",
      label: expired
        ? `Retention period ended ${until.toLocaleDateString()}`
        : `Retained until ${until.toLocaleDateString()}`,
    });
  }

  if (status.policy.evidenceDeletionMode === "DISABLED") {
    items.push({ tone: "info", label: "Deletion disabled by workspace policy" });
  } else if (status.policy.evidenceDeletionMode === "ADMIN_ONLY") {
    items.push({ tone: "info", label: "Deletion restricted to admins" });
  }

  if (!status.policy.allowReportDownload) {
    items.push({ tone: "info", label: "Report download restricted by policy" });
  }
  if (!status.policy.allowPackageDownload) {
    items.push({ tone: "info", label: "Package download restricted by policy" });
  }
  if (!status.policy.allowPublicVerify) {
    items.push({ tone: "info", label: "Public verify restricted by policy" });
  }

  if (status.policy.requireReviewBeforeReport) {
    items.push({
      tone: "info",
      label: "Review required before report finalization",
    });
  }
  if (status.policy.requireReviewBeforePackage) {
    items.push({
      tone: "info",
      label: "Review required before verification package",
    });
  }
  if (status.policy.requireReviewBeforePublicVerify) {
    items.push({
      tone: "info",
      label: "Review required before public verify",
    });
  }

  if (items.length === 0) return null;

  return (
    <section style={wrapperStyle} aria-label="Governance indicators">
      <p style={mutedStyle}>Governance</p>
      <ul style={listStyle}>
        {items.map((it, i) => (
          <li key={i} style={badgeStyle(it.tone)}>
            {it.label}
          </li>
        ))}
      </ul>
      <p style={{ ...mutedStyle, marginTop: 8, fontSize: 11 }}>
        Governance indicators reflect internal preservation and workflow
        controls. They do not assert authenticity, legal admissibility, or
        evidentiary truth.
      </p>
    </section>
  );
}

const wrapperStyle: React.CSSProperties = {
  marginTop: 16,
  marginBottom: 16,
  padding: 14,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const mutedStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "#64748b",
  margin: 0,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "8px 0 0",
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

function badgeStyle(tone: "warn" | "info" | "danger"): React.CSSProperties {
  const palette: Record<"warn" | "info" | "danger", [string, string, string]> = {
    warn: ["#fef3c7", "#fde68a", "#92400e"],
    info: ["#eff6ff", "#bfdbfe", "#1e40af"],
    danger: ["#fef2f2", "#fecaca", "#7f1d1d"],
  };
  const [bg, border, color] = palette[tone];
  return {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
  };
}
