/**
 * THE PUBLIC VERIFY VISUAL VOCABULARY — shared by every Public Verify page: the
 * record page's basic view and PROOVRA's public package record. One state
 * vocabulary (verified / pending / failed / not issued / not checked), one
 * row, one card, one UTC time format, so the package page reads as the same
 * product as the record page.
 */
import type { ReactNode } from "react";

import type { ComponentVerificationState } from "@proovra/shared";

export const STATE_LABEL: Record<ComponentVerificationState, string> = {
  verified: "Verified",
  pending: "Pending",
  failed: "Failed",
  not_issued: "Not issued",
  not_checked: "Not checked",
};

export const STATE_TONE: Record<ComponentVerificationState, { fg: string; bg: string }> = {
  verified: { fg: "#0b5d3b", bg: "rgba(11,93,59,0.08)" },
  pending: { fg: "#7a5a12", bg: "rgba(138,106,47,0.10)" },
  failed: { fg: "#9b1c1c", bg: "rgba(155,28,28,0.08)" },
  not_issued: { fg: "#4b5563", bg: "rgba(75,85,99,0.08)" },
  not_checked: { fg: "#4b5563", bg: "rgba(75,85,99,0.08)" },
};

/** A UTC instant, unambiguous across viewers ("2026-10-07 07:11:00 UTC"). */
export function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export function Row(props: { label: string; state: ComponentVerificationState; detail: ReactNode; badge?: string; testId?: string }) {
  const tone = STATE_TONE[props.state];
  return (
    <div
      data-testid={props.testId}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 12,
        padding: "14px 0",
        borderTop: "1px solid rgba(15,23,42,0.08)",
        alignItems: "start",
      }}
    >
      <div>
        <div style={{ fontWeight: 600 }}>{props.label}</div>
        <div style={{ fontSize: 14, color: "#475569", marginTop: 4, overflowWrap: "anywhere" }}>{props.detail}</div>
      </div>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: tone.fg,
          background: tone.bg,
          borderRadius: 999,
          padding: "4px 10px",
          whiteSpace: "nowrap",
        }}
        aria-label={`${props.label}: ${props.badge ?? STATE_LABEL[props.state]}`}
      >
        {props.badge ?? STATE_LABEL[props.state]}
      </span>
    </div>
  );
}

/** A Public Verify section card with a labelled heading. */
export function VerifyCard({ id, title, children, style }: { id: string; title: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <section
      aria-labelledby={id}
      style={{ background: "#fff", borderRadius: 16, padding: "8px 20px 16px", border: "1px solid rgba(15,23,42,0.08)", ...style }}
    >
      <h2 id={id} style={{ fontSize: 17, margin: "14px 0 4px" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The Public Verify page frame. */
export function VerifyMain({ children, testId, tier }: { children: ReactNode; testId?: string; tier?: string }) {
  return (
    <main
      className="page verify-enterprise-font"
      style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px 64px" }}
      data-testid={testId}
      data-verify-tier={tier}
    >
      {children}
    </main>
  );
}
