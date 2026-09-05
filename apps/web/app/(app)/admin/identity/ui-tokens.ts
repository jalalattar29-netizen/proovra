/**
 * SHARED STYLE OBJECTS FOR THE IDENTITY AND PLATFORM-OPERATIONS PAGES.
 *
 * =============================================================================
 * WHAT THIS WAS, AND WHY IT WAS THE CONSOLE'S BIGGEST INCONSISTENCY
 * =============================================================================
 * It was a SECOND PALETTE. Twelve colour literals plus eight status palettes
 * carrying twenty-four more, none of them tokens, consumed by SEVENTEEN admin
 * pages — every Identity surface and most of Platform Operations. Its own
 * header called that "reusing the PROOVRA enterprise design language"; what it
 * actually did was fork it.
 *
 * The most visible consequence: `accent` was #1e293b, a near-black NAVY. So
 * every primary button, every active tab indicator and every selected control
 * across those seventeen pages rendered navy while the rest of the console
 * rendered PROOVRA purple. Two thirds of the console disagreed with the other
 * third about what the brand colour is, and nothing in either half looked
 * locally wrong — which is exactly why it survived six phases.
 *
 * Second consequence, in `pageStyle`: an explicit
 * `fontFamily: -apple-system, …` override, so those pages rendered in the
 * platform system font rather than the product typeface.
 *
 * =============================================================================
 * WHAT IT IS NOW
 * =============================================================================
 * The same exported shapes — 208 call sites read `mutedStyle` alone, and
 * rewriting those is churn with no reader benefit — with every VALUE pointing
 * at `lib/design-tokens/tokens.css`. Nothing here declares a colour any more.
 *
 * These are inline styles, so `var(--token)` strings are the mechanism: they
 * resolve in the cascade at the call site, which is also what lets the admin
 * console's own overrides (a WCAG-AA muted ink, the corrected radius scale)
 * reach them without touching this file again.
 *
 * The 44px target floors and the reasons for them are preserved verbatim
 * below; they were the good part.
 */

import type { CSSProperties } from "react";
import { formatUserDateTime } from "../../../../lib/date";

export const TOKENS = {
  bgPage: "var(--surface-page)",
  surface: "var(--surface-card)",
  surfaceMuted: "var(--surface-muted)",
  border: "var(--border-default)",
  borderStrong: "var(--border-standard)",
  divider: "var(--border-subtle)",
  ink: "var(--ink-primary)",
  inkMuted: "var(--ink-secondary)",
  /* Was #64748b. Resolves through --ink-muted, which the admin console pins to
     an AA-passing value; on this palette's own former literal, helper text
     measured 4.48:1 against the page ground. */
  inkSubtle: "var(--ink-muted)",
  /* WAS #1e293b — a near-black navy, on seventeen pages' primary buttons,
     active tabs and selected controls. The brand accent is purple. */
  accent: "var(--accent-500)",
  accentInk: "var(--ink-inverse)",
  link: "var(--accent-600)",
} as const;

/**
 * NO FONT OVERRIDE, AND NO 100vh.
 *
 * `fontFamily: -apple-system, …` made these pages render in the platform
 * system font while the rest of the product rendered the brand typeface —
 * a difference nobody would name but everybody would feel. The app shell
 * already sets the family; inheriting it is the whole point of having one.
 *
 * `minHeight: 100vh` on a pane INSIDE the app shell forces a full viewport of
 * height regardless of content, which is where a short page's trailing
 * whitespace came from.
 */
export const pageStyle: CSSProperties = {
  padding: "20px 24px 40px",
  color: TOKENS.ink,
  background: TOKENS.bgPage,
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
  borderRadius: "var(--radius-md)",
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

/**
 * 44px floor, same argument as `inputStyle` below.
 *
 * The verification matrix measured every button built from these two tokens at
 * 32px tall — Inspect / Close / promote on /admin/platform/signers, the backup
 * and restore validation runs on /admin/platform/recovery, the queue actions —
 * because 6px of padding plus a 12px font lands at 32. A MINIMUM height (not a
 * fixed one) with flex centring keeps a wrapped label growing while a one-line
 * label sits centred in the taller box. Raised here rather than at each call
 * site because these tokens are the shared definition.
 */
export const primaryButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  background: TOKENS.accent,
  color: TOKENS.accentInk,
  border: `1px solid ${TOKENS.accent}`,
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
};

export const ghostButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 500,
  background: TOKENS.surface,
  color: TOKENS.ink,
  border: `1px solid ${TOKENS.borderStrong}`,
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
};

/**
 * 44px floor.
 *
 * The verification matrix measured every text field built from this token at 40px
 * tall across the console — the filter rows on /admin/customers and
 * /admin/security among them. `padding` alone does not guarantee a height,
 * and 6px of it plus a 12-13px font lands at 40.
 *
 * Set as a MINIMUM rather than a fixed height so a multi-line control still
 * grows, and here rather than at each call site because these tokens are the
 * shared definition — thirty call sites is thirty chances to miss one.
 */
export const inputStyle: CSSProperties = {
  minHeight: 44,
  padding: "6px 10px",
  border: `1px solid ${TOKENS.borderStrong}`,
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  background: TOKENS.surface,
  color: TOKENS.ink,
  width: "100%",
};

/**
 * 44px floor.
 *
 * The verification matrix measured every dropdown built from this token at 40px
 * tall across the console — the filter rows on /admin/customers and
 * /admin/security among them. `padding` alone does not guarantee a height,
 * and 6px of it plus a 12-13px font lands at 40.
 *
 * Set as a MINIMUM rather than a fixed height so a multi-line control still
 * grows, and here rather than at each call site because these tokens are the
 * shared definition — thirty call sites is thirty chances to miss one.
 */
export const selectStyle: CSSProperties = {
  minHeight: 44,
  padding: "6px 10px",
  border: `1px solid ${TOKENS.borderStrong}`,
  borderRadius: "var(--radius-sm)",
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
  background: "var(--danger-subtle-bg)",
  color: "var(--danger-strong)",
  border: "1px solid var(--danger-border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
};

export const successBoxStyle: CSSProperties = {
  ...errorBoxStyle,
  background: "var(--success-subtle-bg)",
  color: "var(--success-strong)",
  borderColor: "var(--success-border)",
};

export const monoStyle: CSSProperties = {
  // The canonical stack, so an id or a hash has the same metrics wherever it
  // appears. A bare generic `monospace` also inherits the browser's separate
  // monospace default SIZE, which is not the same as the surrounding text's.
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  direction: "ltr",
  unicodeBidi: "isolate",
};

export function badgeStyle(palette: {
  bg: string;
  fg: string;
  border: string;
}): CSSProperties {
  return {
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 700,
    borderRadius: "var(--radius-sm)",
    background: palette.bg,
    color: palette.fg,
    border: `1px solid ${palette.border}`,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    whiteSpace: "nowrap",
    display: "inline-block",
  };
}

/**
 * THE STATE PALETTES, ON THE SEMANTIC FAMILIES.
 *
 * Twenty-four literals became four families, and the mapping is the meaning:
 *
 *   ACTIVE / ALLOW        success — a confirmed, healthy, permitted state
 *   PENDING / STEP_UP     warning — waiting for a person to do something
 *   REVOKED / DENY        danger  — a refusal or a withdrawal
 *   DISABLED / N/A        neutral — not applicable, never a warning
 *
 * NOT_APPLICABLE is deliberately NEUTRAL and not a lighter amber. "This
 * permission does not apply to this role" is the absence of a question, not a
 * caution, and painting it as one puts it beside the genuine ones.
 */
const STATUS_PALETTES: Record<
  string,
  { bg: string; fg: string; border: string }
> = {
  ACTIVE: {
    bg: "var(--success-subtle-bg)",
    fg: "var(--success-strong)",
    border: "var(--success-border)",
  },
  PENDING: {
    bg: "var(--warning-subtle-bg)",
    fg: "var(--warning-strong)",
    border: "var(--warning-border)",
  },
  DISABLED: {
    bg: "var(--surface-muted)",
    fg: "var(--ink-secondary)",
    border: "var(--border-standard)",
  },
  REVOKED: {
    bg: "var(--danger-subtle-bg)",
    fg: "var(--danger-strong)",
    border: "var(--danger-border)",
  },
  ALLOW: {
    bg: "var(--success-subtle-bg)",
    fg: "var(--success-strong)",
    border: "var(--success-border)",
  },
  DENY: {
    bg: "var(--danger-subtle-bg)",
    fg: "var(--danger-strong)",
    border: "var(--danger-border)",
  },
  STEP_UP_REQUIRED: {
    bg: "var(--warning-subtle-bg)",
    fg: "var(--warning-strong)",
    border: "var(--warning-border)",
  },
  NOT_APPLICABLE: {
    bg: "var(--surface-muted)",
    fg: "var(--ink-muted)",
    border: "var(--border-standard)",
  },
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

/**
 * A radio or checkbox row, sized to be hit.
 *
 * A native radio is 13x13 and always will be — that is the platform widget —
 * so the <label> wrapping it is the target a person actually clicks. Three
 * separate choice rows in the security console measured 43px, 39px and 39px
 * tall: near-misses that only a measurement finds, and that would have been
 * patched three times and missed a fourth.
 *
 * `alignItems: flex-start` is deliberate. These rows carry a bold label above
 * a description, and centring makes the radio float beside the second line.
 */
export const choiceRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  minHeight: 44,
  paddingBlock: 2,
};
