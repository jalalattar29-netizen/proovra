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

export function FreeReportsLockedNotice() {
  return (
    <section
      data-free-reports-locked-notice
      role="region"
      aria-label="Reports — upgrade required"
      style={{
        margin: "16px 0",
        padding: 20,
        borderRadius: 12,
        background: "#eef2ff",
        border: "1px solid #c7d2fe",
        color: "#1e1b4b",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span aria-hidden="true" style={{ fontSize: 20 }}>🔒</span>
        <strong style={{ fontSize: 18 }}>Reports unlock with Pay-Per-Evidence, Pro, or Team</strong>
      </div>

      <p style={{ margin: "8px 0 12px", lineHeight: 1.5 }}>
        Reports are included with Pay-Per-Evidence, Pro, and Team. Upgrade
        when you need reviewer-facing PDF reports and verification
        packages. Your existing evidence and public verification links
        remain available on the Free plan.
      </p>

      <div
        data-free-reports-locked-unlocks
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          margin: "12px 0",
          fontSize: 14,
        }}
      >
        <div>✓ PDF verification report</div>
        <div>✓ Verification package</div>
        <div>✓ Shareable verification link</div>
        <div>✓ Report history</div>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        <Link
          href="/billing"
          data-free-reports-cta="upgrade_pro"
          style={{
            padding: "8px 16px",
            background: "#4f46e5",
            color: "white",
            borderRadius: 6,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Upgrade to Pro
        </Link>
        <Link
          href="/billing?plan=payg"
          data-free-reports-cta="try_payg"
          style={{
            padding: "8px 16px",
            background: "white",
            color: "#4f46e5",
            borderRadius: 6,
            textDecoration: "none",
            fontWeight: 600,
            border: "1px solid #4f46e5",
          }}
        >
          Complete with Pay-Per-Evidence
        </Link>
      </div>

      <p
        style={{
          marginTop: 16,
          fontSize: 12,
          opacity: 0.75,
        }}
      >
        Public verification of existing evidence stays free.
      </p>
    </section>
  );
}
