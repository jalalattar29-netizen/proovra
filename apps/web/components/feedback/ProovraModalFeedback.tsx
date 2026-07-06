"use client";

/**
 * ProovraModalFeedback — a focused modal for feedback that requires a
 * decision: a destructive action failed, a payment needs confirmation,
 * an irreversible workflow, or an error the user must acknowledge and
 * choose a next step for. Use a MODAL (not a toast) when the user must
 * decide before continuing.
 *
 * role="alertdialog", Escape-to-close, backdrop click closes (unless
 * blocking). Severity styling matches the rest of the feedback system.
 */

import { useEffect } from "react";
import type { CSSProperties } from "react";

import {
  FEEDBACK_SURFACE,
  FeedbackIcon,
  SEVERITY,
  type FeedbackSeverity,
} from "./severity";
import { ProovraSupportReference } from "./ProovraSupportReference";

export interface ProovraModalAction {
  label: string;
  onClick?: () => void;
  href?: string;
  variant?: "primary" | "secondary" | "danger";
}

export function ProovraModalFeedback({
  open,
  severity = "error",
  title,
  message,
  actions = [],
  supportReference,
  onClose,
}: {
  open: boolean;
  severity?: FeedbackSeverity;
  title: string;
  message: string;
  actions?: ProovraModalAction[];
  supportReference?: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const tone = SEVERITY[severity];

  return (
    <div style={overlayStyle} onClick={onClose} data-proovra-modal-feedback>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-severity={severity}
        onClick={(e) => e.stopPropagation()}
        style={dialogStyle}
      >
        <span aria-hidden style={{ ...chipStyle, background: tone.tint, border: `1px solid ${tone.chipBorder}` }}>
          <FeedbackIcon severity={severity} size={18} />
        </span>
        <h2 style={titleStyle}>{title}</h2>
        <p style={messageStyle}>{message}</p>
        {supportReference ? <ProovraSupportReference reference={supportReference} /> : null}
        {actions.length > 0 ? (
          <div style={actionsStyle}>
            {actions.map((a) =>
              a.href ? (
                <a key={a.label} href={a.href} style={btnFor(a.variant)}>
                  {a.label}
                </a>
              ) : (
                <button key={a.label} type="button" onClick={a.onClick} style={btnFor(a.variant)}>
                  {a.label}
                </button>
              ),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 10000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  background: "rgba(15, 23, 42, 0.44)",
  backdropFilter: "blur(2px)",
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: 440,
  background: FEEDBACK_SURFACE.card,
  border: `1px solid ${FEEDBACK_SURFACE.border}`,
  borderRadius: 18,
  boxShadow: "0 24px 60px rgba(15, 23, 42, 0.28)",
  padding: "28px 26px",
  textAlign: "center",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 42,
  height: 42,
  borderRadius: 12,
  marginBottom: 14,
};

const titleStyle: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 750, color: FEEDBACK_SURFACE.ink };
const messageStyle: CSSProperties = { margin: "8px 0 0 0", fontSize: 14, lineHeight: 1.55, color: FEEDBACK_SURFACE.inkMuted };
const actionsStyle: CSSProperties = { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10, marginTop: 20 };

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
};

function btnFor(variant?: ProovraModalAction["variant"]): CSSProperties {
  if (variant === "danger") {
    return { ...btnBase, background: SEVERITY.error.accent, color: "#fff", border: `1px solid ${SEVERITY.error.accent}` };
  }
  if (variant === "secondary") {
    return { ...btnBase, background: FEEDBACK_SURFACE.card, color: FEEDBACK_SURFACE.ink, border: `1px solid ${FEEDBACK_SURFACE.border}` };
  }
  return { ...btnBase, background: "#0B1F5E", color: "#fff", border: "1px solid #0B1F5E" };
}
