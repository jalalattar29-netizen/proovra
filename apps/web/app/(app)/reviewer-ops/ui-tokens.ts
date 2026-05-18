/**
 * Phase 25 — Reviewer Operations UI design tokens.
 *
 * Shared between the reviewer-ops pages so chips, badges, surfaces,
 * and typography stay consistent. Operational, dense, enterprise.
 * No gradients, no glassmorphism, no playful animations.
 */

import type { CSSProperties } from "react";

export const TOKENS = {
  bgPage: "#f8fafc",
  surface: "#ffffff",
  surfaceMuted: "#f1f5f9",
  border: "#e2e8f0",
  borderStrong: "#cbd5e1",
  divider: "#f1f5f9",
  ink: "#0f172a",
  inkMuted: "#475569",
  inkSubtle: "#64748b",
  accent: "#1e293b", // navy/graphite
  accentInk: "#ffffff",
  link: "#1e40af",
} as const;

// -----------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------

export const pageStyle: CSSProperties = {
  padding: "20px 24px 40px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: TOKENS.ink,
  background: TOKENS.bgPage,
  minHeight: "100vh",
};

export const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 24,
  paddingBottom: 16,
  borderBottom: `1px solid ${TOKENS.border}`,
  flexWrap: "wrap",
};

export const titleStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  margin: 0,
  letterSpacing: -0.2,
};

export const subtitleStyle: CSSProperties = {
  fontSize: 13,
  color: TOKENS.inkSubtle,
  margin: "4px 0 0",
  maxWidth: 720,
};

export const sectionTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  textTransform: "uppercase",
  color: TOKENS.inkMuted,
  letterSpacing: 0.5,
  margin: "16px 0 8px",
};

export const cardStyle: CSSProperties = {
  background: TOKENS.surface,
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  padding: 16,
};

export const denseCardStyle: CSSProperties = {
  background: TOKENS.surface,
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  padding: 12,
};

// -----------------------------------------------------------------------------
// Tables
// -----------------------------------------------------------------------------

export const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

export const thStyle: CSSProperties = {
  padding: "8px 10px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  color: TOKENS.inkMuted,
  borderBottom: `1px solid ${TOKENS.border}`,
  position: "sticky",
  top: 0,
  background: TOKENS.surface,
  zIndex: 1,
};

export const tdStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: `1px solid ${TOKENS.divider}`,
  verticalAlign: "top",
  color: TOKENS.ink,
};

export function rowStyle(active: boolean): CSSProperties {
  return {
    cursor: "pointer",
    background: active ? TOKENS.surfaceMuted : "transparent",
    borderLeft: active
      ? `3px solid ${TOKENS.accent}`
      : "3px solid transparent",
  };
}

// -----------------------------------------------------------------------------
// Chips
// -----------------------------------------------------------------------------

export function chipStyle(active: boolean): CSSProperties {
  return {
    padding: "3px 8px",
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 999,
    border: "1px solid",
    background: active ? TOKENS.accent : TOKENS.surface,
    color: active ? TOKENS.accentInk : "#334155",
    borderColor: active ? TOKENS.accent : TOKENS.borderStrong,
    cursor: "pointer",
  };
}

export const slaBadgePalette: Record<
  string,
  { bg: string; fg: string; border: string }
> = {
  HEALTHY: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  COMPLETED: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  DUE_SOON: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
  BREACHED: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  ESCALATED: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  PAUSED: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
  BLOCKED: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
};

export function slaBadgeStyle(state: string): CSSProperties {
  const p = slaBadgePalette[state] ?? slaBadgePalette.HEALTHY;
  return {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 4,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    whiteSpace: "nowrap",
    display: "inline-block",
  };
}

export const severityPalette: Record<
  string,
  { bg: string; fg: string; border: string }
> = {
  INFO: { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
  WARNING: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
  HIGH: { bg: "#fee2e2", fg: "#991b1b", border: "#fecaca" },
  CRITICAL: { bg: "#fef2f2", fg: "#7f1d1d", border: "#fca5a5" },
};

export function severityBadgeStyle(severity: string): CSSProperties {
  const p = severityPalette[severity] ?? severityPalette.INFO;
  return {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 4,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    whiteSpace: "nowrap",
    display: "inline-block",
  };
}

export function lifecycleBadgeStyle(state: string): CSSProperties {
  const palette: Record<
    string,
    { bg: string; fg: string; border: string }
  > = {
    DRAFT: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
    SUBMITTED: { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
    QUEUED: { bg: "#eff6ff", fg: "#1e40af", border: "#bfdbfe" },
    ASSIGNED: { bg: "#ecfeff", fg: "#155e75", border: "#a5f3fc" },
    IN_REVIEW: { bg: "#f5f3ff", fg: "#5b21b6", border: "#ddd6fe" },
    NEEDS_INFORMATION: {
      bg: "#fef3c7",
      fg: "#78350f",
      border: "#fde68a",
    },
    ESCALATED: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
    APPROVED: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
    REJECTED: { bg: "#fef2f2", fg: "#7f1d1d", border: "#fca5a5" },
    ARCHIVED: { bg: "#f1f5f9", fg: "#64748b", border: "#cbd5e1" },
  };
  const p = palette[state] ?? palette.QUEUED;
  return {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 4,
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.border}`,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    whiteSpace: "nowrap",
    display: "inline-block",
  };
}

// -----------------------------------------------------------------------------
// Buttons
// -----------------------------------------------------------------------------

export const primaryButtonStyle: CSSProperties = {
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  background: TOKENS.accent,
  color: TOKENS.accentInk,
  border: `1px solid ${TOKENS.accent}`,
  borderRadius: 6,
  cursor: "pointer",
};

export const ghostButtonStyle: CSSProperties = {
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 500,
  background: TOKENS.surface,
  color: TOKENS.ink,
  border: `1px solid ${TOKENS.borderStrong}`,
  borderRadius: 6,
  cursor: "pointer",
};

export const dangerButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  color: "#991b1b",
  borderColor: "#fecaca",
  background: "#fef2f2",
};

export const inputStyle: CSSProperties = {
  padding: "6px 10px",
  border: `1px solid ${TOKENS.borderStrong}`,
  borderRadius: 6,
  fontSize: 13,
  background: TOKENS.surface,
  color: TOKENS.ink,
  width: "100%",
};

export const selectStyle: CSSProperties = {
  padding: "6px 10px",
  border: `1px solid ${TOKENS.borderStrong}`,
  borderRadius: 6,
  fontSize: 12,
  background: TOKENS.surface,
  color: TOKENS.ink,
};

export const mutedStyle: CSSProperties = {
  fontSize: 12,
  color: TOKENS.inkSubtle,
};

export const errorBoxStyle: CSSProperties = {
  marginTop: 12,
  padding: 10,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 6,
  fontSize: 13,
};

export const emptyStateStyle: CSSProperties = {
  padding: 40,
  textAlign: "center",
  color: TOKENS.inkSubtle,
  fontSize: 13,
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  if (min < 60) return ms >= 0 ? `in ${min}m` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return ms >= 0 ? `in ${hr}h` : `${hr}h ago`;
  const day = Math.round(hr / 24);
  return ms >= 0 ? `in ${day}d` : `${day}d ago`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
