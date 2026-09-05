"use client";

/**
 * EmptyState — evidence-aware "nothing here yet" surface (Phase 7).
 *
 * Every empty list / table / section should explain WHY it's empty and
 * offer the next best action, instead of a bare "No results". Consumes
 * design tokens; pairs with the `Card` `empty` variant when a bordered
 * frame is wanted (`framed` prop).
 *
 * SLOTS
 *   - icon      optional glyph (defaults to a neutral document mark).
 *   - title     short headline ("No evidence captured yet").
 *   - purpose   one sentence on what would appear here / why it matters.
 *   - action    next-best-action button (usually a primary <Button>).
 *   - note      optional permission / plan caveat rendered muted below
 *               the action ("Available on the Enterprise plan").
 *
 * A11Y: role="status" so screen readers announce the empty condition;
 * icon is aria-hidden; the action retains its own semantics.
 *
 * USAGE
 *   <EmptyState
 *     title="No evidence captured yet"
 *     purpose="Captured photos and videos are cryptographically sealed and listed here."
 *     action={<Button variant="primary">Capture evidence</Button>}
 *     note="Capture requires the mobile capture entitlement."
 *   />
 */

import React from "react";

export interface EmptyStateProps {
  title: React.ReactNode;
  /** One-sentence explanation of what belongs here. */
  purpose?: React.ReactNode;
  /** Next-best-action control (typically a <Button>). */
  action?: React.ReactNode;
  /** Muted permission / plan caveat under the action. */
  note?: React.ReactNode;
  /** Optional leading icon; a neutral document glyph is used if omitted. */
  icon?: React.ReactNode;
  /** Wrap in a dashed bordered frame (matches Card `empty`). */
  framed?: boolean;
  /** Tighter spacing for inline / in-card use. */
  compact?: boolean;
  /**
   * HOW MUCH PRESENCE THIS EMPTY STATE EARNS.
   *
   *   page    the centred column with an icon. For an empty state that IS the
   *           page — a search with no results, a list the operator navigated
   *           to specifically. ~180px, and worth it there.
   *   inline  a single 56px row: label, sentence, optional action, left
   *           aligned, no icon disc. For a SECTION of six.
   *
   * The distinction exists because the console measured ~25 tables whose
   * "nothing here" row was 156-235px tall, five of them stacked on
   * /admin/costs — over a thousand pixels of "nothing", each box shouting as
   * loudly as the populated panel beside it. The content was right in every
   * case; the presence was not.
   */
  variant?: "page" | "inline";
  className?: string;
  style?: React.CSSProperties;
  "data-testid"?: string;
}

function DefaultIcon() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
    </svg>
  );
}

export function EmptyState({
  title,
  purpose,
  action,
  note,
  icon,
  framed = false,
  compact = false,
  variant = "page",
  className,
  style,
  ...rest
}: EmptyStateProps) {
  /**
   * 48px of vertical padding and a 56px icon put a default empty state at
   * roughly 250px. /admin/costs stacks FIVE of them — per-provider, top
   * operations, budgets, embeddings and entitlements — so an unpopulated cost
   * page was over a thousand pixels of "nothing here", each box shouting as
   * loudly as the one above it.
   *
   * An empty state that IS the page (no search results) earns presence. One
   * that is a single section of six does not. Trimmed to the second case,
   * which is the common one; `compact` stays for dense panels.
   */
  const pad = compact ? "20px 16px" : "28px 24px";

  /**
   * THE INLINE SHAPE.
   *
   * One row. The icon disc is dropped rather than shrunk: a 40px decorative
   * glyph repeated down a page of six empty sections is the decoration this
   * console has too much of, and it carries no information a screen reader or
   * a person can use — the words already say what is empty.
   *
   * `note` follows the sentence rather than stacking below it, because a
   * caveat on one line beside its own claim is read; a caveat 60px under a
   * centred column is not.
   */
  if (variant === "inline") {
    return (
      <div
        {...rest}
        role="status"
        data-ui-empty-state
        data-variant="inline"
        className={["ui-empty-state", className].filter(Boolean).join(" ")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minBlockSize: 56,
          padding: "12px 16px",
          borderRadius: "var(--radius-md, 8px)",
          border: framed
            ? "1px dashed var(--border-strong, rgba(15,23,42,0.14))"
            : "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
          background: framed ? "transparent" : "var(--surface-muted, #f1f4f9)",
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--ink-secondary, #475569)",
          minWidth: 0,
          ...style,
        }}
      >
        <span
          style={{
            fontWeight: 650,
            color: "var(--ink-primary, #0f172a)",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        {purpose != null ? (
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{purpose}</span>
        ) : null}
        {note != null ? (
          <span style={{ color: "var(--ink-muted, #94a3b8)", minWidth: 0 }}>
            {note}
          </span>
        ) : null}
        {action != null ? (
          <span style={{ marginInlineStart: "auto", whiteSpace: "nowrap" }}>
            {action}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      {...rest}
      role="status"
      data-ui-empty-state
      className={["ui-empty-state", className].filter(Boolean).join(" ")}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: compact ? 6 : 8,
        padding: pad,
        borderRadius: "var(--radius-card, 14px)",
        border: framed
          ? "1px dashed var(--border-strong, rgba(15,23,42,0.14))"
          : undefined,
        background: framed ? "rgba(15,23,42,0.015)" : undefined,
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: compact ? 36 : 40,
          height: compact ? 36 : 40,
          borderRadius: 12,
          background: "var(--surface-muted, #f1f4f9)",
          color: "var(--ink-muted, #94a3b8)",
          marginBottom: 2,
        }}
      >
        {icon ?? <DefaultIcon />}
      </span>

      <div
        style={{
          fontSize: compact ? 14 : 15,
          fontWeight: 650,
          color: "var(--ink-primary, #0f172a)",
          lineHeight: 1.3,
        }}
      >
        {title}
      </div>

      {purpose != null ? (
        <p
          style={{
            margin: 0,
            maxWidth: 460,
            fontSize: 13.5,
            lineHeight: 1.6,
            color: "var(--ink-secondary, #475569)",
          }}
        >
          {purpose}
        </p>
      ) : null}

      {action != null ? <div style={{ marginTop: 6 }}>{action}</div> : null}

      {note != null ? (
        <p
          style={{
            margin: "4px 0 0",
            maxWidth: 460,
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--ink-muted, #94a3b8)",
          }}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

export default EmptyState;
