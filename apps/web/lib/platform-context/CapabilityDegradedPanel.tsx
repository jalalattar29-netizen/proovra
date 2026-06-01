"use client";

/**
 * Phase 32.8 Foundation — Capability-degraded canonical panel.
 *
 * Used by ReviewerOps and Governance pages when the active workspace
 * lacks the capability required for the surface (e.g. personal
 * workspaces lacking REVIEWER_OPS_VIEW or GOVERNANCE_VIEW).
 *
 * This is a STRUCTURED surface — it is NOT a hard fallback page. It
 * tells the user:
 *   - what they're looking at
 *   - why it isn't available in their current workspace
 *   - what they can do about it (switch workspace, upgrade)
 *
 * Hard rules:
 *   - NO plain text fallback like "Switch to a workspace" alone.
 *   - NO raw UUID leaks. The component reads workspace.name + scope
 *     from the canonical context, never displays workspace.id.
 *   - NO local role / capability derivation. The page determined
 *     this state via ctx.can(capability) === false BEFORE rendering.
 */

import Link from "next/link";
import { usePlatformContext } from "./PlatformContextProvider";

export type CapabilityDegradedPanelProps = {
  /** Page title (e.g. "Reviewer Ops"). */
  surface: string;
  /** Short why-line. */
  reason: string;
  /** Capability key the page is gated on (for diagnostics). */
  requiredCapability: string;
  /**
   * Optional list of features that DO work in the current workspace
   * — surfaces the "enterprise-lite" alternative paths.
   */
  alternatives?: ReadonlyArray<{ label: string; href: string }>;
};

export function CapabilityDegradedPanel({
  surface,
  reason,
  requiredCapability,
  alternatives,
}: CapabilityDegradedPanelProps) {
  const { envelope } = usePlatformContext();

  // Workspace name fallback is the canonical scope label — NEVER a
  // raw workspace.id.
  const workspaceLabel =
    envelope?.workspace.name ??
    (envelope?.workspace.scope === "PERSONAL"
      ? "your personal workspace"
      : "your active workspace");

  return (
    <section
      data-capability-degraded-panel
      data-surface={surface}
      data-required-capability={requiredCapability}
      style={{
        padding: "32px 28px",
        borderRadius: 18,
        border: "1px solid rgba(255,255,255,0.10)",
        background:
          "linear-gradient(180deg, rgba(8,18,22,0.55) 0%, rgba(8,18,22,0.32) 100%)",
        color: "#dce1de",
        maxWidth: 720,
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#b8c7c3",
          }}
        >
          {surface}
        </div>
        <h2
          style={{
            margin: "6px 0 0",
            fontSize: 22,
            fontWeight: 700,
            color: "#f0f4f2",
          }}
        >
          Not available in {workspaceLabel}
        </h2>
      </header>

      <p style={{ marginBottom: 16, lineHeight: 1.55 }}>{reason}</p>

      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: alternatives && alternatives.length > 0 ? 18 : 0,
        }}
      >
        <Link
          href="/workspaces"
          data-action="switch-or-create-team"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "9px 16px",
            borderRadius: 12,
            border: "1px solid rgba(183,157,132,0.55)",
            background: "rgba(183,157,132,0.16)",
            color: "#f1decb",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          Switch or create a team workspace
        </Link>
        <Link
          href="/billing"
          data-action="review-plan"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "9px 16px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.18)",
            background: "rgba(255,255,255,0.04)",
            color: "#dce1de",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          Review plan
        </Link>
      </div>

      {alternatives && alternatives.length > 0 ? (
        <div
          data-capability-degraded-alternatives
          style={{
            paddingTop: 18,
            borderTop: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "#b8c7c3",
              marginBottom: 10,
            }}
          >
            Available here instead
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, gap: 6 }}>
            {alternatives.map((a) => (
              <li key={a.href} style={{ marginBottom: 6 }}>
                <Link
                  href={a.href}
                  style={{
                    color: "#d6b89d",
                    fontWeight: 600,
                    textDecoration: "underline",
                    textUnderlineOffset: 3,
                  }}
                >
                  {a.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
