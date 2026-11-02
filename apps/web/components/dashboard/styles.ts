import type { CSSProperties } from "react";

/**
 * Shared values for the two usage pages. Everything here is a design token or
 * a value from the semantic contract in app-primitives.css: these pages used to
 * carry a private dark teal palette that matched nothing else in the product.
 */
export const dashboardStyles = {
  softCard: {
    border: "1px solid var(--border-subtle)",
    background: "var(--surface-muted)",
  } as const satisfies CSSProperties,

  pageGrid: {
    display: "grid",
    gap: 16,
    paddingBottom: 72,
  } as const satisfies CSSProperties,

  progressTrack: {
    width: "100%",
    height: 9,
    borderRadius: 999,
    background: "var(--surface-muted)",
    overflow: "hidden",
  } as const satisfies CSSProperties,
};

export function getStatusPillStyle(status: string): CSSProperties {
  switch ((status || "").toLowerCase()) {
    case "completed":
    case "signed":
    case "safe":
      return {
        background: "#EAF7F1",
        color: "#167A5B",
        border: "1px solid rgba(22, 122, 91, 0.24)",
      };
    case "processing":
      return {
        background: "#F2ECFE",
        color: "#6D28D9",
        border: "1px solid rgba(109, 40, 217, 0.24)",
      };
    case "low_risk":
    case "medium_risk":
    case "warning":
      return {
        background: "#FFF6E5",
        color: "#7C4A0C",
        border: "1px solid rgba(168, 102, 18, 0.24)",
      };
    case "failed":
    case "cancelled":
    case "critical":
    case "high_risk":
    case "revoked":
      return {
        background: "#FFF1F2",
        color: "#B23442",
        border: "1px solid rgba(178, 52, 66, 0.24)",
      };
    default:
      return {
        background: "#F1F5F9",
        color: "#475569",
        border: "1px solid var(--border-default)",
      };
  }
}
