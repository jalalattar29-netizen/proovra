/**
 * ProovraErrorState — the branded full-surface state for route/page-level
 * failures and access denials: 404, 500, global error, forbidden,
 * maintenance/unavailable.
 *
 * Self-contained inline styles (no dependency on globals.css) so it also
 * works inside `app/global-error.tsx`, which replaces the root layout.
 * Pearl surface · deep-navy ink · calm card · clear CTAs · optional
 * support reference. No raw developer text ever passes through here.
 */

import type { CSSProperties } from "react";

import {
  FEEDBACK_SURFACE,
  FeedbackIcon,
  SEVERITY,
  type FeedbackSeverity,
} from "./severity";
import { ProovraSupportReference } from "./ProovraSupportReference";

export interface ProovraErrorAction {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "secondary";
  /**
   * Opt-in: open this action's href in a NEW tab (target=_blank +
   * rel=noopener noreferrer) with a visible ↗ cue. Used for public
   * destinations reached from an authenticated context (e.g. the public
   * /support page from a forbidden gate) so the app stays in the current
   * tab. Off by default — existing same-tab actions are unchanged.
   */
  external?: boolean;
}

export function ProovraErrorState({
  severity = "error",
  title,
  message,
  actions = [],
  supportReference,
  showLogo = true,
  minHeight = "72vh",
}: {
  severity?: FeedbackSeverity;
  title: string;
  message: string;
  actions?: ProovraErrorAction[];
  supportReference?: string | null;
  showLogo?: boolean;
  minHeight?: string;
}) {
  const tone = SEVERITY[severity];

  return (
    <div style={{ ...wrapStyle, minHeight }} data-proovra-error-state data-severity={severity}>
      <div style={cardStyle}>
        {showLogo ? (
          <img
            src="/assets/branding/logo-dark.png"
            alt="PROOVRA"
            style={{ height: 26, width: "auto", marginBottom: 20, objectFit: "contain" }}
          />
        ) : null}

        <span
          aria-hidden
          style={{
            ...iconChipStyle,
            background: tone.tint,
            border: `1px solid ${tone.chipBorder}`,
          }}
        >
          <FeedbackIcon severity={severity} size={22} />
        </span>

        <h1 style={titleStyle}>{title}</h1>
        <p style={messageStyle}>{message}</p>

        {actions.length > 0 ? (
          <div style={actionsRowStyle}>
            {actions.map((a) =>
              a.href ? (
                <a
                  key={a.label}
                  href={a.href}
                  {...(a.external
                    ? {
                        target: "_blank",
                        rel: "noopener noreferrer",
                        "aria-label": `${a.label} — opens in a new tab`,
                      }
                    : {})}
                  style={a.variant === "secondary" ? secondaryBtnStyle : primaryBtnStyle}
                >
                  {a.label}
                  {a.external ? (
                    <span aria-hidden="true" style={{ marginLeft: 4 }}>
                      ↗
                    </span>
                  ) : null}
                </a>
              ) : (
                <button
                  key={a.label}
                  type="button"
                  onClick={a.onClick}
                  style={a.variant === "secondary" ? secondaryBtnStyle : primaryBtnStyle}
                >
                  {a.label}
                </button>
              ),
            )}
          </div>
        ) : null}

        {supportReference ? (
          <ProovraSupportReference reference={supportReference} />
        ) : null}
      </div>
    </div>
  );
}

const wrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "40px 20px",
  background: FEEDBACK_SURFACE.pearl,
  fontFamily:
    "var(--font-jakarta), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  maxWidth: 480,
  width: "100%",
  padding: "36px 32px",
  background: FEEDBACK_SURFACE.card,
  border: `1px solid ${FEEDBACK_SURFACE.border}`,
  borderRadius: 18,
  boxShadow: FEEDBACK_SURFACE.shadow,
};

const iconChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 46,
  height: 46,
  borderRadius: 13,
  marginBottom: 16,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 21,
  fontWeight: 750,
  letterSpacing: "-0.01em",
  color: FEEDBACK_SURFACE.ink,
  lineHeight: 1.25,
};

const messageStyle: CSSProperties = {
  margin: "10px 0 0 0",
  fontSize: 14.5,
  lineHeight: 1.6,
  color: FEEDBACK_SURFACE.inkMuted,
  maxWidth: 380,
};

const actionsRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: 10,
  marginTop: 22,
};

const btnBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 40,
  padding: "0 18px",
  borderRadius: 10,
  fontSize: 13.5,
  fontWeight: 650,
  textDecoration: "none",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const primaryBtnStyle: CSSProperties = {
  ...btnBase,
  background: "linear-gradient(135deg, #0B1F5E 0%, #123B7A 100%)",
  color: "#FFFFFF",
  border: "1px solid #0B1F5E",
  boxShadow: "0 2px 8px rgba(11, 31, 94, 0.24)",
};

const secondaryBtnStyle: CSSProperties = {
  ...btnBase,
  background: FEEDBACK_SURFACE.card,
  color: FEEDBACK_SURFACE.ink,
  border: `1px solid ${FEEDBACK_SURFACE.border}`,
};
