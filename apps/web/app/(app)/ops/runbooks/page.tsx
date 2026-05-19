"use client";

/**
 * Phase 28-I — Operator runbook catalog.
 *
 * Static, dense, enterprise reference page that mirrors the runbook
 * catalog at `docs/runbooks/`. Each entry names the failure mode the
 * runbook covers, the affected subsystem, and a one-line operator
 * summary. The page deliberately does NOT render markdown bodies — the
 * authoritative text lives in the repository, and the catalog is the
 * navigation surface that prevents broken "/docs/runbooks" links from
 * existing inside the Operations Center / Observability / governance
 * empty-state cards.
 *
 * The list is hand-curated rather than filesystem-discovered so this
 * page is build-time-stable (no fs read at request time) and reads the
 * same on Vercel / a local build / a serverless edge build.
 */

import Link from "next/link";

import {
  OPS_INK,
  OPS_LINK,
  OPS_SURFACE,
  OPS_TONES,
} from "../../../../components/operational";

type RunbookCategory =
  | "Governance & lifecycle"
  | "Reviewer Ops"
  | "Storage & integrity"
  | "Workers & queues"
  | "Identity & security"
  | "Integrations & notifications";

type RunbookEntry = {
  slug: string;
  title: string;
  category: RunbookCategory;
  summary: string;
  /** Subsystem this runbook is wired into (so operators searching by
   *  subsystem id from the readiness banner can find it). */
  subsystems: ReadonlyArray<string>;
};

const RUNBOOKS: ReadonlyArray<RunbookEntry> = [
  {
    slug: "export-blocked",
    title: "Export / package blocked by policy",
    category: "Governance & lifecycle",
    summary:
      "An evidence export or verification package was blocked. Diagnose lifecycle state, hold conflicts, retention immutability, and active destruction reviews.",
    subsystems: ["governance", "export"],
  },
  {
    slug: "hold-override",
    title: "Legal hold override / release",
    category: "Governance & lifecycle",
    summary:
      "Steps for legitimate hold release, including capturing the release-note audit row. Hold overrides are internal preservation controls — they never assert evidentiary status.",
    subsystems: ["governance", "legal_hold"],
  },
  {
    slug: "retention-precedence",
    title: "Retention policy precedence conflict",
    category: "Governance & lifecycle",
    summary:
      "Two retention policies disagree on a record. Use the canonical pickHighestPrecedencePolicy helper output to decide; never edit policy rows directly.",
    subsystems: ["governance", "retention"],
  },
  {
    slug: "lifecycle-bypass",
    title: "Lifecycle bypass attempt",
    category: "Governance & lifecycle",
    summary:
      "A request attempted an invalid lifecycle transition. Inspect the canonical lifecycle decision, the requesting actor, and any active hold/destruction review.",
    subsystems: ["governance", "lifecycle"],
  },
  {
    slug: "immutable-drift",
    title: "Storage governance / immutable drift",
    category: "Storage & integrity",
    summary:
      "Database immutability flag and object-lock state disagree. This is a storage governance state — NOT a content-tampering finding. Reconcile via the immutable-storage reconciliation worker.",
    subsystems: ["storage", "immutable_storage"],
  },
  {
    slug: "audit-chain-drift",
    title: "Admin audit chain drift",
    category: "Storage & integrity",
    summary:
      "AdminAuditLog HMAC chain failed self-verification. Quarantine the chain segment and inspect recent writers.",
    subsystems: ["audit"],
  },
  {
    slug: "ots-degradation",
    title: "OpenTimestamps degradation",
    category: "Storage & integrity",
    summary:
      "OTS upgrades are stalled or the OTS calendar provider is degraded. The OTS upgrade worker should keep retrying; do not regenerate verification packages on top of stale anchors.",
    subsystems: ["ots", "anchor"],
  },
  {
    slug: "storage-write-failure",
    title: "Storage write failure",
    category: "Storage & integrity",
    summary:
      "Object storage writes are failing. Stalled uploads back up in the queue and capture metrics. Check bucket health and lifecycle.",
    subsystems: ["storage"],
  },
  {
    slug: "privacy-leak",
    title: "Privacy leak incident",
    category: "Storage & integrity",
    summary:
      "A surface unexpectedly rendered private reviewer notes / legal notes / storage keys / signatures. Quarantine the route and audit the projection layer.",
    subsystems: ["privacy"],
  },
  {
    slug: "reviewer-sla-breach",
    title: "Reviewer SLA breach",
    category: "Reviewer Ops",
    summary:
      "A workflow has breached its configured SLA. The reviewer reconciliation worker raises this; resolve by reassigning, escalating, or completing the workflow.",
    subsystems: ["reviewer_ops"],
  },
  {
    slug: "reviewer-escalation-backlog",
    title: "Reviewer escalation backlog",
    category: "Reviewer Ops",
    summary:
      "Open escalations are accumulating faster than they're being acknowledged. Check workload snapshots and policy thresholds.",
    subsystems: ["reviewer_ops"],
  },
  {
    slug: "reviewer-escalation-storm",
    title: "Reviewer escalation storm",
    category: "Reviewer Ops",
    summary:
      "A spike of escalations was raised in a short window. Often caused by a stalled worker or a workspace SLA misconfiguration.",
    subsystems: ["reviewer_ops"],
  },
  {
    slug: "reviewer-inactivity",
    title: "Reviewer inactivity",
    category: "Reviewer Ops",
    summary:
      "An assigned reviewer has not acted within the configured inactivity threshold. Reassign or escalate.",
    subsystems: ["reviewer_ops"],
  },
  {
    slug: "reviewer-queue-stuck",
    title: "Reviewer queue stuck",
    category: "Reviewer Ops",
    summary:
      "The review queue is not draining. Verify the reviewer-reconciliation worker heartbeat and the saved-view filter.",
    subsystems: ["reviewer_ops"],
  },
  {
    slug: "worker-wedged",
    title: "Worker wedged",
    category: "Workers & queues",
    summary:
      "A worker stopped consuming. Check heartbeat, queue depth, and recent worker errors in observability.",
    subsystems: ["workers"],
  },
  {
    slug: "workflow-stuck",
    title: "Workflow instance stuck",
    category: "Workers & queues",
    summary:
      "An EvidenceWorkflowInstance has not progressed past a step. Inspect the step config and any external dependency the step blocks on.",
    subsystems: ["workflows"],
  },
  {
    slug: "stuck-upload",
    title: "Stuck upload",
    category: "Workers & queues",
    summary:
      "Multipart upload session is stalled. Check the storage object-lock state and the upload reaper job.",
    subsystems: ["capture", "storage"],
  },
  {
    slug: "observability-degraded",
    title: "Observability subsystem degraded",
    category: "Workers & queues",
    summary:
      "Metrics provider or alert provider is reporting non-healthy state. Operational dashboards may be stale until the readiness check recovers.",
    subsystems: ["observability"],
  },
  {
    slug: "database-readiness-failure",
    title: "Database readiness failure",
    category: "Workers & queues",
    summary:
      "Postgres readiness probe failed. Treat all dependent dashboards as stale. Do not attempt destructive ops.",
    subsystems: ["database"],
  },
  {
    slug: "failed-report-generation",
    title: "Failed report generation",
    category: "Workers & queues",
    summary:
      "A PDF report generation job failed. Re-queue from /reports if the failure is transient; check signing key availability if it is not.",
    subsystems: ["reports"],
  },
  {
    slug: "failed-verification-package",
    title: "Failed verification package",
    category: "Workers & queues",
    summary:
      "A verification package build failed. Inspect anchor + OTS state and the immutable-storage reconciliation worker before retrying.",
    subsystems: ["packages", "anchor"],
  },
  {
    slug: "suspicious-login-burst",
    title: "Suspicious login burst",
    category: "Identity & security",
    summary:
      "Adaptive-auth heuristics flagged a burst of high-risk logins. Inspect /admin/identity for the affected actors and step-up policy.",
    subsystems: ["identity"],
  },
  {
    slug: "twilio-outage",
    title: "Twilio outage",
    category: "Integrations & notifications",
    summary:
      "SMS / WhatsApp delivery is failing. Communications fallback policy decides whether downstream notifications should buffer or be downgraded.",
    subsystems: ["communications"],
  },
  {
    slug: "webhook-invalid-signature-burst",
    title: "Webhook invalid-signature burst",
    category: "Integrations & notifications",
    summary:
      "An external integration is sending payloads with invalid signatures. Verify the rotated webhook signing key and possible replay attempts.",
    subsystems: ["integrations"],
  },
  {
    slug: "workflow-intake-abuse",
    title: "Workflow intake-link abuse",
    category: "Integrations & notifications",
    summary:
      "An intake link is being hit at abuse-like volume. Revoke and re-issue the link; review the workflow's external_submission policy.",
    subsystems: ["intake"],
  },
];

const CATEGORY_ORDER: ReadonlyArray<RunbookCategory> = [
  "Governance & lifecycle",
  "Reviewer Ops",
  "Storage & integrity",
  "Workers & queues",
  "Identity & security",
  "Integrations & notifications",
];

export default function OpsRunbooksPage() {
  const byCategory = new Map<RunbookCategory, RunbookEntry[]>();
  for (const cat of CATEGORY_ORDER) {
    byCategory.set(cat, []);
  }
  for (const r of RUNBOOKS) {
    byCategory.get(r.category)?.push(r);
  }

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <p style={kickerStyle}>Operations</p>
        <h1 style={titleStyle}>Operator runbooks</h1>
        <p style={subtitleStyle}>
          Bounded catalog of operator runbooks. Each entry names a failure
          mode, the affected subsystem(s), and a one-line summary. The
          authoritative text lives in the repository at{" "}
          <code style={inlineCodeStyle}>docs/runbooks/&lt;slug&gt;.md</code> —
          this page is the navigation surface so operational pages link
          here rather than to a 404 route.
        </p>
      </header>

      <section style={countersRowStyle} aria-label="Runbook counts">
        <CounterTile label="Runbooks" value={RUNBOOKS.length} />
        <CounterTile label="Categories" value={CATEGORY_ORDER.length} />
        <CounterTile
          label="Subsystems covered"
          value={new Set(RUNBOOKS.flatMap((r) => r.subsystems)).size}
        />
      </section>

      {CATEGORY_ORDER.map((cat) => {
        const entries = byCategory.get(cat) ?? [];
        if (entries.length === 0) return null;
        return (
          <section key={cat} style={categorySectionStyle}>
            <h2 style={categoryTitleStyle}>{cat}</h2>
            <ul style={listStyle}>
              {entries.map((r) => (
                <li key={r.slug} style={listItemStyle}>
                  <div style={listItemHeadStyle}>
                    <div style={listItemTitleStyle}>{r.title}</div>
                    <code style={slugCodeStyle}>{r.slug}</code>
                  </div>
                  <p style={summaryStyle}>{r.summary}</p>
                  <div style={subsystemRowStyle}>
                    {r.subsystems.map((s) => (
                      <span key={s} style={subsystemChipStyle}>
                        {s}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section style={referenceBoxStyle}>
        <strong>Reference</strong>
        <p style={referenceCopyStyle}>
          The full markdown text lives in the repository under{" "}
          <code style={inlineCodeStyle}>docs/runbooks/</code>. Operators with
          repository access can open the file by slug. Cross-reference from
          dashboards always uses the canonical{" "}
          <code style={inlineCodeStyle}>runbookSlug</code> emitted by the
          incident — never a hardcoded URL.
        </p>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
          <Link href="/ops" style={referenceLinkStyle}>
            ← Operations Center
          </Link>
          <Link href="/ops/observability" style={referenceLinkStyle}>
            Observability dashboard →
          </Link>
        </div>
      </section>
    </main>
  );
}

function CounterTile({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div style={counterTileStyle}>
      <div style={counterValueStyle}>{value}</div>
      <div style={counterLabelStyle}>{label}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles — enterprise dense layout, light surface
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 1080,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: OPS_INK.default,
};
const headerStyle: React.CSSProperties = { marginBottom: 16 };
const kickerStyle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: OPS_INK.subtle,
  fontWeight: 700,
  margin: 0,
  marginBottom: 4,
};
const titleStyle: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  margin: 0,
  letterSpacing: -0.4,
  color: OPS_INK.default,
};
const subtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: OPS_INK.muted,
  marginTop: 6,
  lineHeight: 1.5,
};
const countersRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
  marginBottom: 24,
};
const counterTileStyle: React.CSSProperties = {
  border: `1px solid ${OPS_SURFACE.border}`,
  background: OPS_SURFACE.card,
  borderRadius: 8,
  padding: "12px 16px",
};
const counterValueStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  color: OPS_INK.default,
  fontVariantNumeric: "tabular-nums",
};
const counterLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: OPS_INK.subtle,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  fontWeight: 600,
  marginTop: 4,
};
const categorySectionStyle: React.CSSProperties = {
  marginBottom: 24,
};
const categoryTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: OPS_INK.muted,
  marginBottom: 8,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const listItemStyle: React.CSSProperties = {
  border: `1px solid ${OPS_SURFACE.border}`,
  background: OPS_SURFACE.card,
  borderRadius: 8,
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const listItemHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
};
const listItemTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: OPS_INK.default,
};
const slugCodeStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 11,
  color: OPS_INK.subtle,
  background: OPS_SURFACE.cardMuted,
  border: `1px solid ${OPS_SURFACE.border}`,
  padding: "1px 6px",
  borderRadius: 4,
};
const summaryStyle: React.CSSProperties = {
  fontSize: 13,
  color: OPS_INK.muted,
  lineHeight: 1.5,
  margin: 0,
};
const subsystemRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
  marginTop: 2,
};
const subsystemChipStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.4,
  fontWeight: 600,
  color: OPS_TONES.info.inkMuted,
  background: OPS_TONES.info.bg,
  border: `1px solid ${OPS_TONES.info.border}`,
  padding: "1px 8px",
  borderRadius: 999,
};
const referenceBoxStyle: React.CSSProperties = {
  border: `1px solid ${OPS_SURFACE.border}`,
  background: OPS_SURFACE.cardMuted,
  borderRadius: 8,
  padding: 16,
  marginTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const referenceCopyStyle: React.CSSProperties = {
  fontSize: 13,
  color: OPS_INK.muted,
  lineHeight: 1.5,
  margin: 0,
};
const referenceLinkStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: OPS_LINK.default,
  textDecoration: "underline",
  textUnderlineOffset: 3,
};
const inlineCodeStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 12,
  color: OPS_INK.default,
  background: OPS_SURFACE.cardMuted,
  border: `1px solid ${OPS_SURFACE.border}`,
  padding: "1px 6px",
  borderRadius: 4,
};
