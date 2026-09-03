"use client";

/**
 * ProovraToast — the single premium toast surface for the whole product.
 *
 * Replaces the old cheap dark-navy block (#102126). It is a LIGHT card
 * with a subtle border, soft shadow, a small severity accent rail + icon
 * chip, deep-navy ink, a visible close button, and correct ARIA.
 *
 * Each toast owns its own auto-dismiss timer so it can pause on
 * hover/focus. Errors/warnings live longer than success/info. Position
 * (top-right on desktop, full-width top on mobile) is owned by
 * `.toast-container` in globals.css.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import {
  FEEDBACK_SURFACE,
  FeedbackIcon,
  SEVERITY,
  feedbackAriaLive,
  feedbackRole,
  type FeedbackSeverity,
} from "./severity";
import { ProovraSupportReference } from "./ProovraSupportReference";

export interface ProovraToastData {
  id: string;
  /** Body message (already user-safe — never a raw backend string). */
  message: string;
  severity: FeedbackSeverity;
  /** Auto-dismiss in ms; 0 = sticky. */
  duration: number;
  /** Optional short bold title above the message. */
  title?: string;
  /** Optional support/trace reference (rendered via ProovraSupportReference). */
  supportReference?: string;
  /** Optional single inline action. */
  action?: { label: string; href?: string; onClick?: () => void };
}

export function ProovraToast({
  toast,
  onClose,
}: {
  toast: ProovraToastData;
  onClose: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Self-owned auto-dismiss. Pausing (hover/focus) restarts the countdown
  // on resume — a standard, forgiving pattern. Loading/sticky toasts
  // (duration <= 0) never auto-dismiss.
  useEffect(() => {
    if (toast.duration <= 0 || paused) return;
    const t = window.setTimeout(() => closeRef.current(), toast.duration);
    return () => window.clearTimeout(t);
  }, [toast.duration, paused, toast.id]);

  const tone = SEVERITY[toast.severity];

  return (
    <div
      data-proovra-toast
      data-severity={toast.severity}
      role={feedbackRole(toast.severity)}
      aria-live={feedbackAriaLive(toast.severity)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      style={cardStyle}
    >
      {/* Left accent rail — the severity signal. */}
      <span aria-hidden style={{ ...railStyle, background: tone.accent }} />

      <span
        aria-hidden
        style={{
          ...chipStyle,
          background: tone.tint,
          border: `1px solid ${tone.chipBorder}`,
        }}
      >
        <FeedbackIcon severity={toast.severity} size={15} />
      </span>

      <div style={{ minWidth: 0, flex: 1 }}>
        {toast.title ? (
          <div style={titleStyle}>{toast.title}</div>
        ) : null}
        <div style={messageStyle}>{toast.message}</div>

        {toast.action ? (
          toast.action.href ? (
            <a href={toast.action.href} style={{ ...actionStyle, color: tone.accent }}>
              {toast.action.label}
            </a>
          ) : (
            <button
              type="button"
              onClick={toast.action.onClick}
              style={{ ...actionStyle, color: tone.accent, background: "transparent", border: 0, cursor: "pointer", padding: 0 }}
            >
              {toast.action.label}
            </button>
          )
        ) : null}

        {toast.supportReference ? (
          <ProovraSupportReference reference={toast.supportReference} compact />
        ) : null}
      </div>

      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss notification"
        style={closeStyle}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

const cardStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "flex-start",
  gap: 11,
  width: "100%",
  padding: "12px 12px 12px 16px",
  borderRadius: FEEDBACK_SURFACE.radius,
  background: FEEDBACK_SURFACE.card,
  border: `1px solid ${FEEDBACK_SURFACE.border}`,
  boxShadow: FEEDBACK_SURFACE.shadow,
  pointerEvents: "auto",
  overflow: "hidden",
};

const railStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 4,
  borderTopLeftRadius: FEEDBACK_SURFACE.radius,
  borderBottomLeftRadius: FEEDBACK_SURFACE.radius,
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 8,
  flexShrink: 0,
  marginTop: 1,
};

const titleStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 700,
  color: FEEDBACK_SURFACE.ink,
  lineHeight: 1.3,
  marginBottom: 2,
};

const messageStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 500,
  color: FEEDBACK_SURFACE.inkMuted,
  lineHeight: 1.45,
  wordBreak: "break-word",
};

/**
 * Same 44px+ floor as the dismiss button below, same technique: the box
 * reaches 46px (0.98 entry scale keeps it above 44 mid-animation) and the
 * negative block margins hand the growth back, so the card keeps its compact
 * geometry. The block margins replace the old `marginTop: 6` — the top margin
 * is 6 - 12 and the visual offset survives.
 */
const actionStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 46,
  minWidth: 46,
  marginBlock: "-6px -14px",
  fontSize: 12.5,
  fontWeight: 650,
  textDecoration: "none",
};

/**
 * A 44px+ hit target on a 26px visual footprint.
 *
 * The verification matrix measured this button at 26x26 — under the 44px
 * touch floor, on the one control that dismisses an overlay. The box grows
 * and the negative margins hand the growth back to the card's layout, so the
 * toast keeps its compact geometry while the padding around the icon
 * genuinely receives the click.
 *
 * 46, not 44: the `pf-toast-in` entry animation scales the card to 0.98, and
 * a 44px box measured mid-entry is 43.1px — a real sub-floor target for the
 * ~300ms someone is most likely to reach for it. 46 x 0.98 = 45.1 keeps the
 * target above the floor for the whole lifetime of the toast.
 */
const closeStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 46,
  height: 46,
  margin: "-9px -10px -10px -10px",
  borderRadius: 7,
  border: "1px solid transparent",
  background: "transparent",
  color: FEEDBACK_SURFACE.inkSubtle,
  cursor: "pointer",
};
