import type { CSSProperties } from "react";

export const dashboardStyles = {
  outerCard: {
    border: "1px solid rgba(183,157,132,0.18)",
    boxShadow:
      "0 22px 42px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.03)",
  } as const satisfies CSSProperties,

  softCard: {
    border: "1px solid rgba(158,216,207,0.14)",
    background:
      "linear-gradient(180deg, rgba(62,98,96,0.22) 0%, rgba(14,30,34,0.34) 100%)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
  } as const satisfies CSSProperties,

  primaryButton: {
    borderColor: "rgba(158,216,207,0.14)",
    color: "#dce9e4",
    background:
      "linear-gradient(180deg, rgba(62,98,96,0.28) 0%, rgba(14,30,34,0.42) 100%)",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 28px rgba(0,0,0,0.08)",
  } as const satisfies CSSProperties,

  secondaryButton: {
    borderColor: "rgba(79,112,107,0.18)",
    color: "#dce9e4",
    backgroundImage:
      "linear-gradient(180deg, rgba(8,20,24,0.78) 0%, rgba(7,18,22,0.88) 100%), url('/images/site-velvet-bg.webp.png')",
    backgroundSize: "cover",
    backgroundPosition: "center",
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.03), 0 14px 28px rgba(0,0,0,0.10)",
  } as const satisfies CSSProperties,

  dangerButton: {
    background: "linear-gradient(180deg,#8f2b2b 0%,#6f1f1f 100%)",
    border: "1px solid rgba(248,113,113,0.22)",
    color: "#fff",
    boxShadow: "0 12px 24px rgba(60,12,12,0.22)",
  } as const satisfies CSSProperties,

  pageGrid: {
    display: "grid",
    gap: 16,
    paddingBottom: 72,
  } as const satisfies CSSProperties,

  heroChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
    padding: "8px 16px",
    fontSize: "0.68rem",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.28em",
    color: "#afbbb7",
    boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
  } as const satisfies CSSProperties,

  heroDot: {
    width: 4,
    height: 4,
    borderRadius: 999,
    background: "#b79d84",
    opacity: 0.8,
    display: "inline-block",
  } as const satisfies CSSProperties,

  metricValue: {
    fontSize: 34,
    fontWeight: 800,
    marginTop: 8,
  } as const satisfies CSSProperties,

  textMuted: {
    color: "rgba(194,204,201,0.56)",
  } as const satisfies CSSProperties,

  textSoft: {
    color: "rgba(194,204,201,0.72)",
  } as const satisfies CSSProperties,

  progressTrack: {
    width: "100%",
    height: 9,
    borderRadius: 999,
    background: "rgba(255,255,255,0.08)",
    overflow: "hidden",
  } as const satisfies CSSProperties,
};

export function getStatusPillStyle(
  status: string
): CSSProperties {
  switch ((status || "").toLowerCase()) {
    case "completed":
    case "signed":
    case "safe":
      return {
        background: "rgba(95,170,110,0.14)",
        color: "#9fdfb2",
        border: "1px solid rgba(255,255,255,0.08)",
      };
    case "processing":
      return {
        background: "rgba(120,191,193,0.14)",
        color: "#a7dde0",
        border: "1px solid rgba(255,255,255,0.08)",
      };
    case "low_risk":
    case "medium_risk":
    case "warning":
      return {
        background: "rgba(184,146,73,0.14)",
        color: "#e8d18f",
        border: "1px solid rgba(255,255,255,0.08)",
      };
    case "failed":
    case "cancelled":
    case "critical":
    case "high_risk":
    case "revoked":
      return {
        background: "rgba(157,80,80,0.14)",
        color: "#e4a3a3",
        border: "1px solid rgba(255,255,255,0.08)",
      };
    default:
      return {
        background: "rgba(148,163,184,0.14)",
        color: "#cbd5e1",
        border: "1px solid rgba(255,255,255,0.08)",
      };
  }
}