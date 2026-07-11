"use client";

/**
 * Phase IA-self-serve-simplification — FREE Reports locked notice.
 *
 * The pricing page sells PDF reports + verification packages as a
 * paid feature. FREE users can still SEE the /reports surface — the
 * brief is explicit that Reports stays in the sidebar — but the page
 * must render a polished upgrade-locked state, NOT an empty list or a
 * broken-looking placeholder.
 *
 * Backend gating is unchanged. The report download endpoints are still
 * authorization-gated on the plan/entitlement; this component is the
 * UX-layer affordance that explains the gate to the operator and offers
 * the upgrade path.
 *
 * Copy is plan-safe:
 *   * Names PDF report, verification package, shareable verification
 *     link as the unlocked-by-upgrade outputs.
 *   * Does NOT claim legal admissibility / factual truth / authenticity.
 *   * Mentions Pay-Per-Evidence (PAYG) as a per-evidence alternative.
 *   * Mentions Pro as the upgrade path for recurring use.
 *
 * Rendered ABOVE the existing ReportsIndex when the active workspace
 * is on the FREE plan. PAYG / PRO / TEAM / Enterprise see ReportsIndex
 * directly without this notice.
 */

import Link from "next/link";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";

export function FreeReportsLockedNotice() {
  return (
    <section
      data-free-reports-locked-notice
      role="region"
      aria-label="Reports — upgrade required"
      style={{
        marginInline: "auto",
        maxWidth: "var(--page-max-w, 1360px)",
        paddingInline: "var(--page-pad-x, 32px)",
        paddingTop: "var(--page-pad-y, 28px)",
      }}
    >
      <Card variant="status" tone="governance" padding="comfortable">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 8,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 20 }}>
            🔒
          </span>
          <strong
            style={{ fontSize: 18, color: "var(--ink-primary, #0f172a)" }}
          >
            Reports unlock with Pay-Per-Evidence, Pro, or Team
          </strong>
          <Badge tone="governance" subtle>
            Upgrade
          </Badge>
        </div>

        <p
          style={{
            margin: "8px 0 12px",
            lineHeight: 1.55,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          Reports are included with Pay-Per-Evidence, Pro, and Team. Upgrade
          when you need reviewer-facing PDF reports and verification packages.
          Your existing evidence and public verification links remain available
          on the Free plan.
        </p>

        <div
          data-free-reports-locked-unlocks
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 8,
            margin: "12px 0",
            fontSize: 14,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          <div>✓ PDF verification report</div>
          <div>✓ Verification package</div>
          <div>✓ Shareable verification link</div>
          <div>✓ Report history</div>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
          <Link
            href="/billing"
            data-free-reports-cta="upgrade_pro"
            className="app-header-primary-action"
          >
            Upgrade to Pro
          </Link>
          <Link
            href="/billing?plan=payg"
            data-free-reports-cta="try_payg"
            style={{
              display: "inline-flex",
              alignItems: "center",
              minHeight: 42,
              padding: "0 18px",
              borderRadius: 12,
              textDecoration: "none",
              fontSize: 14,
              fontWeight: 650,
              background: "var(--surface-card, #ffffff)",
              color: "var(--ink-primary, #0f172a)",
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
              boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
            }}
          >
            Complete with Pay-Per-Evidence
          </Link>
        </div>

        <p
          style={{
            marginTop: 16,
            fontSize: 12,
            color: "var(--ink-muted, #94a3b8)",
          }}
        >
          Public verification of existing evidence stays free.
        </p>
      </Card>
    </section>
  );
}
