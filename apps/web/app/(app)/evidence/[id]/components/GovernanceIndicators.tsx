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
import { formatUserDate } from "../../../../../lib/date";

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
        ? `Retention period ended ${formatUserDate(until)}`
        : `Retained until ${formatUserDate(until)}`,
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
    <section className="evd-panel" aria-label="Governance indicators">
      <p className="evd-muted">Governance</p>
      <ul className="evd-list">
        {items.map((it, i) => (
          <li key={i} className="app-status-badge" data-tone={toneFor(it.tone)}>
            {it.label}
          </li>
        ))}
      </ul>
      <p className="evd-muted">
        Governance indicators reflect internal preservation and workflow
        controls. They do not assert authenticity, legal admissibility, or
        evidentiary truth.
      </p>
    </section>
  );
}


/**
 * Governance tone -> canonical badge tone. The previous helper carried a
 * private three-colour palette; the canonical app-status-badge owns it now.
 */
function toneFor(tone: "warn" | "info" | "danger"): "amber" | "blue" | "red" {
  return tone === "warn" ? "amber" : tone === "info" ? "blue" : "red";
}
