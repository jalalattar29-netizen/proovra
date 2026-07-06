"use client";

/**
 * ProovraEmptyState — the calm "nothing here yet" surface for lists and
 * panels. Light card, optional icon, title + description, up to two CTAs.
 *
 * NOTE: the authenticated app already has richer, governed empty-state
 * systems (OperationalEmptyState, personaEmptyStates, evidence EmptyState)
 * — DO NOT replace those. Use this primitive for surfaces that don't yet
 * have one, so new empties stay on-brand.
 */

import type { CSSProperties, ReactNode } from "react";

import { FEEDBACK_SURFACE } from "./severity";

export interface ProovraEmptyAction {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "secondary";
}

export function ProovraEmptyState({
  title,
  description,
  icon,
  actions = [],
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ProovraEmptyAction[];
}) {
  return (
    <div data-proovra-empty-state style={cardStyle}>
      {icon ? <div style={{ marginBottom: 12 }}>{icon}</div> : null}
      <div style={titleStyle}>{title}</div>
      {description ? <p style={descStyle}>{description}</p> : null}
      {actions.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10, marginTop: 16 }}>
          {actions.map((a) =>
            a.href ? (
              <a key={a.label} href={a.href} style={a.variant === "secondary" ? secondaryBtn : primaryBtn}>
                {a.label}
              </a>
            ) : (
              <button key={a.label} type="button" onClick={a.onClick} style={a.variant === "secondary" ? secondaryBtn : primaryBtn}>
                {a.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  padding: "32px 24px",
  background: FEEDBACK_SURFACE.card,
  border: `1px solid ${FEEDBACK_SURFACE.border}`,
  borderRadius: 14,
};

const titleStyle: CSSProperties = { fontSize: 15, fontWeight: 700, color: FEEDBACK_SURFACE.ink };
const descStyle: CSSProperties = { margin: "6px 0 0 0", fontSize: 13, lineHeight: 1.55, color: FEEDBACK_SURFACE.inkMuted, maxWidth: 380 };

const btnBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 38,
  padding: "0 16px",
  borderRadius: 9,
  fontSize: 13,
  fontWeight: 650,
  textDecoration: "none",
  cursor: "pointer",
};
const primaryBtn: CSSProperties = { ...btnBase, background: "#0B1F5E", color: "#fff", border: "1px solid #0B1F5E" };
const secondaryBtn: CSSProperties = { ...btnBase, background: FEEDBACK_SURFACE.card, color: FEEDBACK_SURFACE.ink, border: `1px solid ${FEEDBACK_SURFACE.border}` };
