"use client";

/**
 * ProovraAlert — in-flow / page-section feedback. Use for degraded
 * service, plan/quota notices, security/trust warnings, report issues —
 * anything that belongs INSIDE the page rather than as a transient toast.
 *
 * Light card, severity accent rail + icon chip, deep-navy ink. Consistent
 * with ProovraToast and ProovraErrorState.
 */

import type { CSSProperties, ReactNode } from "react";

import {
  FEEDBACK_SURFACE,
  FeedbackIcon,
  SEVERITY,
  feedbackAriaLive,
  feedbackRole,
  type FeedbackSeverity,
} from "./severity";

export interface ProovraAlertAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export function ProovraAlert({
  severity = "info",
  title,
  children,
  actions = [],
  onDismiss,
  variant = "card",
}: {
  severity?: FeedbackSeverity;
  title?: string;
  children: ReactNode;
  actions?: ProovraAlertAction[];
  onDismiss?: () => void;
  variant?: "card" | "inline";
}) {
  const tone = SEVERITY[severity];
  return (
    <div
      data-proovra-alert
      data-severity={severity}
      role={feedbackRole(severity)}
      aria-live={feedbackAriaLive(severity)}
      style={variant === "inline" ? inlineStyle : { ...cardStyle, borderLeft: `3px solid ${tone.accent}` }}
    >
      <span
        aria-hidden
        style={{ ...chipStyle, background: tone.tint, border: `1px solid ${tone.chipBorder}` }}
      >
        <FeedbackIcon severity={severity} size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title ? <div style={titleStyle}>{title}</div> : null}
        <div style={bodyStyle}>{children}</div>
        {actions.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8 }}>
            {actions.map((a) =>
              a.href ? (
                <a key={a.label} href={a.href} style={{ ...linkStyle, color: tone.accent }}>
                  {a.label}
                </a>
              ) : (
                <button
                  key={a.label}
                  type="button"
                  onClick={a.onClick}
                  style={{ ...linkStyle, color: tone.accent, background: "transparent", border: 0, cursor: "pointer", padding: 0 }}
                >
                  {a.label}
                </button>
              ),
            )}
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" style={dismissStyle}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

const cardStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 11,
  padding: "13px 14px",
  borderRadius: 12,
  background: FEEDBACK_SURFACE.card,
  border: `1px solid ${FEEDBACK_SURFACE.border}`,
  boxShadow: FEEDBACK_SURFACE.shadowSoft,
};

const inlineStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  borderRadius: 7,
  flexShrink: 0,
  marginTop: 1,
};

const titleStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 700,
  color: FEEDBACK_SURFACE.ink,
  lineHeight: 1.35,
  marginBottom: 2,
};

const bodyStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: FEEDBACK_SURFACE.inkMuted,
  lineHeight: 1.5,
};

const linkStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 650,
  textDecoration: "none",
};

const dismissStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  borderRadius: 6,
  border: "1px solid transparent",
  background: "transparent",
  color: FEEDBACK_SURFACE.inkSubtle,
  cursor: "pointer",
};
