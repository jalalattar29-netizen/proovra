/**
 * ProovraSystemState — the ONE canonical full-surface system-state
 * primitive for PROOVRA (2026-07-21 rebuild).
 *
 * Replaces the old centered-card `ProovraErrorState` and every bespoke
 * error / denial / recovery idiom (route-error red panels, the legacy
 * dark gate cards, the command-center `cc-page` denial chrome, and the
 * ad-hoc invite/token states). ONE visual language for both public and
 * authenticated contexts — only the recovery ACTIONS and whether the
 * App Shell stays mounted differ by context.
 *
 * Composition (deliberately NOT a floating card):
 *   - restrained line symbol (state-specific, ~48px, currentColor, no
 *     filled circle, no decoration);
 *   - quiet status label (e.g. "ERROR · 404");
 *   - strong H1;
 *   - concise message;
 *   - optional context line;
 *   - one primary + one secondary + one quiet text action;
 *   - optional support reference (via ProovraSupportReference).
 *
 * Fully self-contained inline styles (fluid clamp() typography, no
 * globals.css dependency) so it also works inside `app/global-error.tsx`,
 * which replaces the root layout and has no app CSS.
 */

import type { CSSProperties, ReactNode } from "react";

import { FEEDBACK_SURFACE } from "./severity";
import { ProovraSupportReference } from "./ProovraSupportReference";
import { SystemStateSymbol } from "./SystemStateSymbol";

export type SystemStateContext = "authenticated" | "public";

/** full-page paints the page canvas; contained sits inside a surface. */
export type SystemStatePresentation = "full-page" | "contained";

export type SystemStateKind =
  | "not-found"
  | "forbidden"
  | "removed"
  | "unavailable"
  | "server-error"
  | "workspace-unavailable"
  | "organization-unavailable"
  | "capability-unavailable"
  | "invitation-expired"
  | "invitation-invalid"
  | "invitation-revoked"
  | "token-expired";

export type SystemStateAction = {
  label: string;
  href?: string;
  onClick?: () => void;
  variant: "primary" | "secondary" | "text";
  /**
   * Opens `href` in a NEW tab (target=_blank + rel=noopener noreferrer)
   * with a visible ↗ cue and an "opens in a new tab" accessible name.
   * Use for PUBLIC destinations reached from an authenticated context
   * (e.g. /support) so the app stays open in the current tab.
   */
  external?: boolean;
  /** Optional stable `data-testid` for e2e / gate identity. */
  testId?: string;
};

type Preset = {
  statusLabel: string;
  title: string;
  message: string;
};

/**
 * Canonical per-kind defaults. Callers override any field; these keep
 * copy consistent across every surface that reaches a given state.
 */
export const SYSTEM_STATE_PRESETS: Record<SystemStateKind, Preset> = {
  "not-found": {
    statusLabel: "Error · 404",
    title: "We couldn't find that page",
    message:
      "The page may have moved, been renamed, or the link may no longer be available.",
  },
  forbidden: {
    statusLabel: "Access · 403",
    title: "You don't have access to this area",
    message:
      "This surface may require additional permissions, a different workspace, or a plan that includes it.",
  },
  removed: {
    statusLabel: "Removed · 410",
    title: "This resource is no longer available",
    message:
      "The record was removed or archived. Nothing else in your workspace was affected.",
  },
  unavailable: {
    statusLabel: "Unavailable",
    title: "This area isn't available right now",
    message:
      "The feature is temporarily unavailable. Your evidence data has not been changed.",
  },
  "server-error": {
    statusLabel: "Error · 500",
    title: "Something went wrong on our end",
    message:
      "An unexpected error interrupted this page. Your evidence data has not been changed — try again in a moment.",
  },
  "workspace-unavailable": {
    statusLabel: "Workspace",
    title: "This workspace isn't available",
    message:
      "The workspace couldn't be loaded, or this area isn't included in your current workspace. Switch workspaces or set one up to continue.",
  },
  "organization-unavailable": {
    statusLabel: "Organization",
    title: "This organization isn't available",
    message:
      "You may no longer be a member, or the organization was removed. Switch to another workspace to continue.",
  },
  "capability-unavailable": {
    statusLabel: "Access",
    title: "Not available in this workspace",
    message:
      "This surface needs a capability your current workspace doesn't have. Switch workspaces or review your plan.",
  },
  "invitation-expired": {
    statusLabel: "Invitation",
    title: "This invitation has expired",
    message: "Ask an administrator to send a new invitation to continue.",
  },
  "invitation-invalid": {
    statusLabel: "Invitation",
    title: "This invitation is no longer valid",
    message:
      "The link may be incorrect or already used. Ask an administrator for a new invitation.",
  },
  "invitation-revoked": {
    statusLabel: "Invitation",
    title: "This invitation was revoked",
    message:
      "Access for this link was withdrawn. Ask an administrator to send a new invitation.",
  },
  "token-expired": {
    statusLabel: "Link expired",
    title: "This link has expired",
    message: "For your security, request a fresh link and try again.",
  },
};

export interface ProovraSystemStateProps {
  kind: SystemStateKind;
  context: SystemStateContext;
  presentation?: SystemStatePresentation;
  /** Overrides the preset title. */
  title?: string;
  /** Overrides the preset message. */
  message?: string;
  /** Overrides the preset status label; pass "" to hide it. */
  statusLabel?: string;
  /** Optional one-line context beneath the message (e.g. surface name). */
  detail?: ReactNode;
  actions?: ReadonlyArray<SystemStateAction>;
  /** Trace / request id — rendered via ProovraSupportReference only. */
  supportReference?: string | null;
  /**
   * Min-height for full-page presentation. Defaults are context-aware:
   * PUBLIC full-page fills the viewport (`100dvh`) so the pearl canvas is
   * full-bleed with no short two-tone band; AUTHENTICATED full-page uses
   * `70vh` because it renders inside the App Shell content area (which is
   * already viewport-minus-chrome) and is transparent, so it never needs
   * to paint the whole screen. Pass an explicit value to override.
   */
  minHeight?: string;
  /** data-testid passthrough. */
  testId?: string;
}

export function ProovraSystemState({
  kind,
  context,
  presentation = "full-page",
  title,
  message,
  statusLabel,
  detail,
  actions = [],
  supportReference,
  minHeight,
  testId,
}: ProovraSystemStateProps) {
  const preset = SYSTEM_STATE_PRESETS[kind];
  const resolvedTitle = title ?? preset.title;
  const resolvedMessage = message ?? preset.message;
  const resolvedLabel = statusLabel ?? preset.statusLabel;
  const isFull = presentation === "full-page";
  // Context-aware default height (see prop docs): public fills the viewport
  // for a full-bleed pearl canvas; authenticated stays 70vh inside the shell.
  const effectiveMinHeight =
    minHeight ?? (context === "public" ? "100dvh" : "70vh");

  // Horizontal inset — PUBLIC full-page renders against the whole viewport,
  // so it takes a larger (capped) inset to compose the canvas; AUTHENTICATED
  // full-page renders inside the App Shell content area (already offset by
  // the sidebar), so it takes only a modest inset and aligns to the content
  // grid — never re-computing the sidebar offset from the full browser width.
  // Public: a `vw − offset` term so mobile stays a tight, safe ~22px gutter
  // while wide screens still open to a composed inset (≈130px @1280, ≈150px
  // @1440, ≈206px @1920) that then caps at 220px on ultrawide — never a
  // marooned, centre-floated island. Authenticated: a modest inset only,
  // since the App Shell already offsets the content past the sidebar.
  const fullInline =
    context === "public"
      ? "clamp(20px, calc(12vw - 24px), 220px)"
      : "clamp(20px, 4vw, 64px)";

  const wrap: CSSProperties = isFull
    ? {
        ...regionBase,
        minHeight: effectiveMinHeight,
        // Upper-middle placement (~32–40% down): anchor to the top with a
        // bounded, viewport-scaled top inset instead of dead-centre. Never
        // marooned centre on ultrawide; never top-heavy.
        alignItems: "flex-start",
        justifyContent: "flex-start",
        padding: `clamp(48px, 18vh, 210px) ${fullInline} clamp(40px, 8vh, 96px)`,
        // Public carries the pearl surface; authenticated lets the App Shell
        // canvas show through (transparent).
        background: context === "public" ? FEEDBACK_SURFACE.pearl : "transparent",
      }
    : {
        ...regionBase,
        minHeight: undefined,
        alignItems: "flex-start",
        justifyContent: "flex-start",
        padding: "clamp(24px, 4vw, 48px) 0",
      };

  const column: CSSProperties = { ...columnBase, maxWidth: isFull ? 840 : 720 };
  const symbol: CSSProperties = {
    ...symbolBase,
    marginBottom: isFull ? "clamp(18px, 2.2vw, 26px)" : 16,
  };
  const titleS = isFull ? titleFullStyle : titleContainedStyle;
  const messageS = isFull ? messageFullStyle : messageContainedStyle;
  const actionsRow: CSSProperties = {
    ...actionsRowBase,
    marginTop: isFull ? "clamp(26px, 3vw, 36px)" : "clamp(18px, 2vw, 22px)",
  };

  return (
    <div
      style={wrap}
      data-proovra-system-state
      data-system-state-kind={kind}
      data-system-state-context={context}
      data-system-state-presentation={presentation}
      data-testid={testId}
    >
      <div style={column}>
        <span aria-hidden style={symbol}>
          <SystemStateSymbol kind={kind} size={isFull ? 54 : 40} />
        </span>

        {resolvedLabel ? <span style={labelStyle}>{resolvedLabel}</span> : null}

        <h1 style={titleS}>{resolvedTitle}</h1>
        <p style={messageS}>{resolvedMessage}</p>
        {detail ? <p style={detailStyle}>{detail}</p> : null}

        {actions.length > 0 ? (
          <div style={actionsRow} data-system-state-actions>
            {actions.map((a) => renderAction(a, isFull))}
          </div>
        ) : null}

        {supportReference ? (
          <div style={{ marginTop: isFull ? 24 : 18 }}>
            <ProovraSupportReference reference={supportReference} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderAction(a: SystemStateAction, big: boolean) {
  const base = big ? btnBaseLarge : btnBase;
  const style =
    a.variant === "primary"
      ? { ...base, ...primaryBtnColors }
      : a.variant === "secondary"
        ? { ...base, ...secondaryBtnColors }
        : { ...base, ...textBtnColors, padding: "0 6px" };

  if (a.href) {
    const externalProps = a.external
      ? {
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": `${a.label} — opens in a new tab`,
        }
      : {};
    return (
      <a
        key={a.label}
        href={a.href}
        {...externalProps}
        style={style}
        data-system-state-action
        data-testid={a.testId}
      >
        {a.label}
        {a.external ? (
          <span aria-hidden="true" style={{ marginLeft: 5 }}>
            ↗
          </span>
        ) : null}
      </a>
    );
  }
  return (
    <button
      key={a.label}
      type="button"
      onClick={a.onClick}
      style={style}
      data-system-state-action
      data-testid={a.testId}
    >
      {a.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Styles — fluid, tokenized, self-contained (works without globals.css).
// ---------------------------------------------------------------------------

const regionBase: CSSProperties = {
  display: "flex",
  width: "100%",
  boxSizing: "border-box",
  fontFamily:
    "var(--font-jakarta), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

const columnBase: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  textAlign: "left",
  width: "100%",
};

const symbolBase: CSSProperties = {
  display: "inline-flex",
  color: FEEDBACK_SURFACE.inkSubtle,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: FEEDBACK_SURFACE.inkSubtle,
  marginBottom: 10,
};

// Full-page = page-level H1 authority (≈30px mobile → ≈50px desktop).
const titleFullStyle: CSSProperties = {
  margin: 0,
  fontSize: "clamp(1.9rem, 1.2rem + 2.6vw, 3.15rem)",
  fontWeight: 770,
  letterSpacing: "-0.025em",
  lineHeight: 1.1,
  color: FEEDBACK_SURFACE.ink,
};

// Contained = component heading (unchanged, compact).
const titleContainedStyle: CSSProperties = {
  margin: 0,
  fontSize: "clamp(1.35rem, 1.15rem + 0.7vw, 1.7rem)",
  fontWeight: 760,
  letterSpacing: "-0.02em",
  lineHeight: 1.18,
  color: FEEDBACK_SURFACE.ink,
};

const messageFullStyle: CSSProperties = {
  margin: "clamp(14px, 1.6vw, 22px) 0 0 0",
  fontSize: "clamp(1.0625rem, 1rem + 0.4vw, 1.3125rem)",
  lineHeight: 1.6,
  color: FEEDBACK_SURFACE.inkMuted,
  maxWidth: "62ch",
};

const messageContainedStyle: CSSProperties = {
  margin: "clamp(10px, 1.4vw, 14px) 0 0 0",
  fontSize: "clamp(0.95rem, 0.9rem + 0.2vw, 1.0625rem)",
  lineHeight: 1.6,
  color: FEEDBACK_SURFACE.inkMuted,
  maxWidth: "60ch",
};

const detailStyle: CSSProperties = {
  margin: "10px 0 0 0",
  fontSize: "0.9rem",
  lineHeight: 1.55,
  color: FEEDBACK_SURFACE.inkSubtle,
  maxWidth: "60ch",
};

const actionsRowBase: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "clamp(8px, 1vw, 12px)",
};

const btnLayout: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 10,
  fontWeight: 650,
  textDecoration: "none",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 120ms ease, border-color 120ms ease",
};

// Contained buttons — compact.
const btnBase: CSSProperties = {
  ...btnLayout,
  height: 42,
  padding: "0 18px",
  fontSize: "0.875rem",
};

// Full-page buttons — larger touch target + presence.
const btnBaseLarge: CSSProperties = {
  ...btnLayout,
  height: 46,
  padding: "0 22px",
  borderRadius: 11,
  fontSize: "0.9375rem",
};

const primaryBtnColors: CSSProperties = {
  background: "linear-gradient(135deg, #0B1F5E 0%, #123B7A 100%)",
  color: "#FFFFFF",
  border: "1px solid #0B1F5E",
  boxShadow: "0 1px 2px rgba(11, 31, 94, 0.18)",
};

const secondaryBtnColors: CSSProperties = {
  background: FEEDBACK_SURFACE.card,
  color: FEEDBACK_SURFACE.ink,
  border: `1px solid ${FEEDBACK_SURFACE.border}`,
};

const textBtnColors: CSSProperties = {
  background: "transparent",
  color: FEEDBACK_SURFACE.inkMuted,
  border: "1px solid transparent",
};
