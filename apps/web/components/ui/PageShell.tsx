"use client";

/**
 * PageShell — consistent internal page wrapper (Phase 7 foundation).
 *
 * Gives every authenticated page the same top-level rhythm: a
 * PageHeader (eyebrow, title, muted subtitle, optional context strip,
 * primary + secondary actions row) followed by content constrained to a
 * shared max-width with consistent vertical spacing between sections.
 *
 * Consumes the layout tokens from `lib/design-tokens/tokens.css`
 * (`--page-max-w`, `--page-pad-x`, `--page-pad-y`, `--section-gap`,
 * `--ink-*`). Does NOT own the app chrome (sidebar/header live in
 * `components/app-shell-v2/*`) — PageShell is the CONTENT plane only.
 *
 * COMPOSITION
 *   <PageShell>
 *     <PageHeader
 *       eyebrow="Governance"
 *       title="Retention policies"
 *       subtitle="Automatic destruction schedules for sealed evidence."
 *       primaryAction={<Button variant="primary">New policy</Button>}
 *       secondaryActions={<Button variant="secondary">Export</Button>}
 *       contextStrip={<Badge tone="governance">Org scope</Badge>}
 *     />
 *     <PageSection>…</PageSection>
 *     <PageSection title="History">…</PageSection>
 *   </PageShell>
 *
 * `PageShell` can also take `header` / `title` props directly as a
 * shorthand when a page doesn't need the full `PageHeader` element.
 *
 * A11Y: header renders a single <h1> (`title`); sections render <section>
 * with an <h2> when titled. `width="full"` opts out of the max-width clamp
 * for edge-to-edge dashboards.
 */

import React from "react";

// ---------------------------------------------------------------------------
// PageHeader
// ---------------------------------------------------------------------------

export interface PageHeaderProps {
  title: React.ReactNode;
  /** Small uppercase kicker above the title. */
  eyebrow?: React.ReactNode;
  /**
   * Muted supporting line under the title.
   *
   * CONTRACT — INLINE CONTENT ONLY. `PageHeader` renders this inside its own
   * `<p>` (see below), so callers must pass a string, a fragment, or inline
   * elements (`<span>`, `<strong>`, `<a>`…). Passing a block element such as
   * `<p>` or `<div>` produces invalid `<p><p>` nesting, which React reports
   * as a `validateDOMNesting` hydration error and which the HTML parser
   * "fixes" by splitting the paragraph.
   */
  subtitle?: React.ReactNode;
  /** Inline strip below the subtitle — badges, scope, breadcrumbs. */
  contextStrip?: React.ReactNode;
  /** The single primary action (right-aligned). */
  primaryAction?: React.ReactNode;
  /** Additional secondary actions (rendered before the primary). */
  secondaryActions?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  contextStrip,
  primaryAction,
  secondaryActions,
  className,
  style,
}: PageHeaderProps) {
  const hasActions = primaryAction != null || secondaryActions != null;
  return (
    <header
      data-ui-page-header
      className={["ui-page-header", className].filter(Boolean).join(" ")}
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 20,
        flexWrap: "wrap",
        ...style,
      }}
    >
      <div style={{ minWidth: 0, flex: "1 1 320px" }}>
        {eyebrow != null ? (
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--ink-muted, #94a3b8)",
              marginBottom: 6,
            }}
          >
            {eyebrow}
          </div>
        ) : null}
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: "-0.01em",
            color: "var(--ink-primary, #0f172a)",
          }}
        >
          {title}
        </h1>
        {subtitle != null ? (
          <p
            style={{
              margin: "6px 0 0",
              maxWidth: 720,
              fontSize: 14,
              lineHeight: 1.55,
              color: "var(--ink-secondary, #475569)",
            }}
          >
            {subtitle}
          </p>
        ) : null}
        {contextStrip != null ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
            }}
          >
            {contextStrip}
          </div>
        ) : null}
      </div>

      {hasActions ? (
        /* Stable class so a page can control how its header actions wrap at
           narrow widths. `min-width: 0` lets the row shrink inside the header
           instead of overflowing it — without it the actions kept their
           content width and were clipped by the body's overflow-x. */
        <div
          className="ui-page-header__actions"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          {secondaryActions}
          {primaryAction}
        </div>
      ) : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// PageSection
// ---------------------------------------------------------------------------

export interface PageSectionProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned controls in the section header. */
  action?: React.ReactNode;
}

export function PageSection({
  title,
  description,
  action,
  children,
  className,
  style,
  ...rest
}: PageSectionProps) {
  const hasHeader = title != null || description != null || action != null;
  return (
    <section
      {...rest}
      data-ui-page-section
      className={["ui-page-section", className].filter(Boolean).join(" ")}
      style={{ display: "block", ...style }}
    >
      {hasHeader ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <div style={{ minWidth: 0 }}>
            {title != null ? (
              <h2
                style={{
                  margin: 0,
                  fontSize: 15,
                  fontWeight: 650,
                  lineHeight: 1.35,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                {title}
              </h2>
            ) : null}
            {description != null ? (
              <p
                style={{
                  margin: "4px 0 0",
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                {description}
              </p>
            ) : null}
          </div>
          {action != null ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// PageShell
// ---------------------------------------------------------------------------

export interface PageShellProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Full custom header node (usually <PageHeader …/>). */
  header?: React.ReactNode;
  /** Shorthand: renders a minimal <PageHeader> from title/subtitle. */
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Clamp to `--page-max-w` (default) or go edge-to-edge (`full`). */
  width?: "contained" | "full";
}

export function PageShell({
  header,
  title,
  subtitle,
  width = "contained",
  children,
  className,
  style,
  ...rest
}: PageShellProps) {
  const resolvedHeader =
    header ?? (title != null ? <PageHeader title={title} subtitle={subtitle} /> : null);

  return (
    <div
      {...rest}
      data-ui-page-shell
      data-width={width}
      className={["ui-page-shell", className].filter(Boolean).join(" ")}
      style={{
        width: "100%",
        maxWidth: width === "full" ? "none" : "var(--page-max-w, 1360px)",
        marginInline: width === "full" ? undefined : "auto",
        paddingInline: "var(--page-pad-x, 32px)",
        paddingBlock: "var(--page-pad-y, 28px)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--section-gap, 28px)",
        ...style,
      }}
    >
      {resolvedHeader}
      {children}
    </div>
  );
}

export default PageShell;
