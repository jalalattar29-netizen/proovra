"use client";

/**
 * Card — surface container primitive (Phase 7 foundation).
 *
 * A token-driven panel: subtle border, soft shadow, premium radius,
 * consistent padding. Replaces ad-hoc `<div style={{ background:'#fff',
 * border:'1px solid #e2e8f0', borderRadius:14 }}>` blocks scattered
 * across internal pages.
 *
 * VARIANTS
 *   - summary  default white panel — KPI blocks, content sections.
 *   - status   left accent rail keyed to a semantic tone (verified /
 *              pending / risk / neutral / governance / info).
 *   - admin    muted pearl surface — settings / admin config groups.
 *   - action   interactive card (hover lift + pointer) — clickable tiles.
 *   - empty    dashed placeholder surface — "nothing here yet" slots.
 *
 * Optional `title` + `subtitle` render a consistent card header; `header`
 * and `footer` slots override/extend it. `padding` switches the interior
 * density (comfortable | compact | none).
 *
 * A11Y: `action` cards render as a real <button> when `onClick` is set
 * (keyboard + focus for free); otherwise a plain <div>. Hover lift is
 * suppressed under prefers-reduced-motion (see globals.css .ui-card).
 *
 * USAGE
 *   <Card title="Records by type" subtitle="Last 30 days">…</Card>
 *   <Card variant="status" tone="risk" title="3 items need review" />
 *   <Card variant="action" onClick={open}>Open case</Card>
 */

import React from "react";

export type CardVariant = "summary" | "status" | "admin" | "action" | "empty";
export type CardTone =
  | "verified"
  | "pending"
  | "risk"
  | "neutral"
  | "governance"
  | "info";
export type CardPadding = "comfortable" | "compact" | "none";

export interface CardProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  variant?: CardVariant;
  /** Accent tone for the `status` variant left rail. */
  tone?: CardTone;
  padding?: CardPadding;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Full custom header (overrides title/subtitle). */
  header?: React.ReactNode;
  /** Right-aligned slot in the default header (actions / badge). */
  headerAction?: React.ReactNode;
  footer?: React.ReactNode;
  /** Makes the card an interactive button when provided. */
  onClick?: React.MouseEventHandler;
}

const TONE_SOLID: Record<CardTone, string> = {
  verified: "var(--status-verified-solid, #10b981)",
  pending: "var(--status-pending-solid, #f59e0b)",
  risk: "var(--status-risk-solid, #dc2626)",
  neutral: "var(--status-neutral-solid, #64748b)",
  governance: "var(--status-governance-solid, #6b5bff)",
  info: "var(--status-info-solid, #2563eb)",
};

const PAD: Record<CardPadding, string> = {
  comfortable: "20px",
  compact: "14px",
  none: "0",
};

function surfaceStyle(variant: CardVariant): React.CSSProperties {
  switch (variant) {
    case "admin":
      return {
        background: "var(--surface-muted, #f1f4f9)",
        border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
        boxShadow: "none",
      };
    case "empty":
      return {
        background: "transparent",
        border: "1px dashed var(--border-strong, rgba(15,23,42,0.14))",
        boxShadow: "none",
      };
    case "action":
      return {
        background: "var(--surface-card, #ffffff)",
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
      };
    case "status":
    case "summary":
    default:
      return {
        background: "var(--surface-card, #ffffff)",
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
      };
  }
}

export function Card({
  variant = "summary",
  tone = "neutral",
  padding = "comfortable",
  title,
  subtitle,
  header,
  headerAction,
  footer,
  onClick,
  children,
  className,
  style,
  ...rest
}: CardProps) {
  const interactive = variant === "action" || Boolean(onClick);
  const pad = PAD[padding];

  const base: React.CSSProperties = {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--radius-card, 14px)",
    overflow: "hidden",
    textAlign: "left",
    width: "100%",
    color: "var(--ink-primary, #0f172a)",
    transition:
      "border-color 200ms ease, box-shadow 200ms ease, transform 160ms ease",
    cursor: interactive ? "pointer" : undefined,
    ...surfaceStyle(variant),
    ...style,
  };

  const showDefaultHeader = !header && (title != null || subtitle != null);

  const inner = (
    <>
      {variant === "status" ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: 4,
            background: TONE_SOLID[tone],
          }}
        />
      ) : null}

      {header ? (
        <div style={{ padding: pad === "0" ? "16px 16px 0" : `${pad} ${pad} 0` }}>
          {header}
        </div>
      ) : showDefaultHeader ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            padding: pad === "0" ? "16px 16px 0" : `${pad} ${pad} 0`,
          }}
        >
          <div style={{ minWidth: 0 }}>
            {title != null ? (
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 650,
                  lineHeight: 1.35,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                {title}
              </div>
            ) : null}
            {subtitle != null ? (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "var(--ink-secondary, #475569)",
                  marginTop: title != null ? 3 : 0,
                }}
              >
                {subtitle}
              </div>
            ) : null}
          </div>
          {headerAction ? <div style={{ flexShrink: 0 }}>{headerAction}</div> : null}
        </div>
      ) : null}

      {children != null ? (
        <div
          style={{
            padding:
              pad === "0"
                ? 0
                : showDefaultHeader || header
                  ? `12px ${pad} ${pad}`
                  : pad,
            paddingLeft:
              variant === "status" && pad !== "0"
                ? `calc(${pad} + 4px)`
                : undefined,
            flex: 1,
            minWidth: 0,
          }}
        >
          {children}
        </div>
      ) : null}

      {footer ? (
        <div
          style={{
            padding: pad === "0" ? "12px 16px" : `12px ${pad}`,
            borderTop: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
          }}
        >
          {footer}
        </div>
      ) : null}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-ui-card
        data-variant={variant}
        data-interactive="true"
        className={["ui-card", className].filter(Boolean).join(" ")}
        style={{ ...base, appearance: "none", font: "inherit" }}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      {...rest}
      data-ui-card
      data-variant={variant}
      className={["ui-card", className].filter(Boolean).join(" ")}
      style={base}
    >
      {inner}
    </div>
  );
}

export default Card;
