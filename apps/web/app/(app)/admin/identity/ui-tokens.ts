/**
 * Phase 26 — Admin identity console UI tokens.
 *
 * Reuses the PROOVRA enterprise design language from the reviewer-ops
 * pages (clean white, restrained navy accent, dense tables). Identity
 * pages share these tokens so SSO / SCIM / Sessions / Access Reviews
 * stay visually consistent.
 */

import type { CSSProperties } from "react";
import { formatUserDateTime } from "../../../../lib/date";

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
  accent: "#1e293b",
  accentInk: "#ffffff",
  link: "#1e40af",
} as const;

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
  margin: "0 0 8px",
};

export const cardStyle: CSSProperties = {
  background: TOKENS.surface,
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  padding: 16,
};

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
  background: TOKENS.surface,
};

export const tdStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: `1px solid ${TOKENS.divider}`,
  verticalAlign: "top",
  color: TOKENS.ink,
};

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

export const successBoxStyle: CSSProperties = {
  ...errorBoxStyle,
  background: "#ecfdf5",
  color: "#065f46",
  borderColor: "#a7f3d0",
};

export const monoStyle: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
};

export function badgeStyle(palette: {
  bg: string;
  fg: string;
  border: string;
}): CSSProperties {
  return {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 4,
    background: palette.bg,
    color: palette.fg,
    border: `1px solid ${palette.border}`,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    whiteSpace: "nowrap",
    display: "inline-block",
  };
}

const STATUS_PALETTES: Record<
  string,
  { bg: string; fg: string; border: string }
> = {
  ACTIVE: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  PENDING: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
  DISABLED: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
  REVOKED: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  ALLOW: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  DENY: { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" },
  STEP_UP_REQUIRED: { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" },
  NOT_APPLICABLE: { bg: "#f1f5f9", fg: "#64748b", border: "#cbd5e1" },
};

export function statusBadgeStyle(status: string): CSSProperties {
  const p = STATUS_PALETTES[status] ?? STATUS_PALETTES.PENDING;
  return badgeStyle(p);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatUserDateTime(iso);
  } catch {
    return iso ?? "—";
  }
}
