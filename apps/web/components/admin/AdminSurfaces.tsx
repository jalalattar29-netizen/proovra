"use client";

/**
 * THE ADMIN CONTROL PLANE SURFACE VOCABULARY.
 *
 * =============================================================================
 * WHY THESE EXIST
 * =============================================================================
 * `admin-system.css` describes six surfaces. This file is how a page reaches
 * them, and the reason it is components rather than a class-name convention is
 * that half of what the review found wrong was not CSS:
 *
 *   - an oversized "nothing here" box was a component choice, not a padding
 *   - a KPI painted red at zero was a prop passed from the call site
 *   - a UUID wrapped over four lines was a missing truncation decision
 *   - a status carried by hue alone was a missing WORD
 *
 * A class name cannot refuse any of those. `AdmKpi` can, and does: it will not
 * paint a tone on a measured zero, it renders the four non-value states as
 * words rather than as numerals, and `AdmId` always truncates and always
 * offers a copy control.
 *
 * =============================================================================
 * WHAT THIS IS NOT
 * =============================================================================
 * Not a second design system. Every surface here is a thin, typed binding onto
 * the canonical stylesheet, and nothing in this file declares a colour, a
 * radius or a spacing. If a page needs something these do not do, the fix is a
 * new surface in the stylesheet with a reason in its comment — not an inline
 * style at the call site.
 */

import Link from "next/link";
import React, { useCallback, useId, useState } from "react";

import type { Metric, MetricState } from "./AdminMetric";
import { formatMetricNumber } from "./AdminMetric";

/* ==========================================================================
 * PAGE + SECTION
 * ========================================================================== */

export type AdmWidth = "page" | "wide" | "read";

export function AdmPage({
  width = "page",
  children,
  className,
  ...rest
}: {
  /**
   * `wide` for operational tables, `read` for procedures, `page` otherwise.
   * A page family picks once; individual pages do not negotiate.
   */
  width?: AdmWidth;
  children: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div
      {...rest}
      className={["adm-page", className].filter(Boolean).join(" ")}
      data-width={width === "page" ? undefined : width}
    >
      {children}
    </div>
  );
}

export function AdmSection({
  title,
  note,
  actions,
  headingId,
  children,
  className,
  ...rest
}: {
  /** The H2. Omit for a section whose content is self-describing. */
  title?: React.ReactNode;
  /** ONE line of orientation. Held to 78ch by the stylesheet. */
  note?: React.ReactNode;
  actions?: React.ReactNode;
  headingId?: string;
  children: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title" | "children">) {
  const auto = useId();
  const id = headingId ?? `sec-${auto}`;
  return (
    <section
      {...rest}
      className={["adm-section", className].filter(Boolean).join(" ")}
      aria-labelledby={title ? id : undefined}
    >
      {title || note || actions ? (
        <div className="adm-section__head">
          <div className="adm-section__heading">
            {title ? (
              <h2 id={id} className="adm-section__title">
                {title}
              </h2>
            ) : null}
            {note ? <p className="adm-section__note">{note}</p> : null}
          </div>
          {actions ? <div className="adm-section__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/* ==========================================================================
 * KPI
 * ========================================================================== */

export type AdmTone = "critical" | "attention" | "healthy";

/**
 * TONE IS EARNED BY THE VALUE, NOT BY THE METRIC'S NAME.
 *
 * The same rule `AdminStat` already applies, enforced here so a second call
 * site cannot reintroduce the eleven coloured zeros. A tone is dropped unless
 * the metric resolved to a real number greater than zero — except `healthy`,
 * which is precisely the claim that a zero is good news, and which is refused
 * for anything that is not a measured VALUE.
 */
function earnedTone(
  metric: Metric<number> | undefined,
  tone: AdmTone | undefined,
): AdmTone | undefined {
  if (!tone) return undefined;
  if (metric?.state !== "VALUE" || typeof metric.value !== "number") {
    return undefined;
  }
  if (tone === "healthy") return tone;
  return metric.value > 0 ? tone : undefined;
}

export function AdmKpiGrid({
  cols,
  children,
  className,
}: {
  /** Fixed column count, when a row must not reflow into an orphan tile. */
  cols?: 2 | 3 | 4;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={["adm-kpis", className].filter(Boolean).join(" ")}
      data-cols={cols}
    >
      {children}
    </div>
  );
}

export function AdmKpi({
  label,
  metric,
  value,
  state,
  context,
  tone,
  rail,
  href,
  drillLabel = "View records",
}: {
  label: React.ReactNode;
  /** The canonical four-state metric. Prefer this. */
  metric?: Metric<number>;
  /** A value that is not a `Metric` — a string, a formatted amount. */
  value?: React.ReactNode;
  /** Non-value state for a bare `value`, so honesty survives without a Metric. */
  state?: MetricState;
  /** One line. Three lines is the hard budget; the stylesheet clamps it. */
  context?: React.ReactNode;
  tone?: AdmTone;
  rail?: "critical" | "attention";
  href?: string | null;
  drillLabel?: string;
}) {
  const resolvedState: MetricState = metric?.state ?? state ?? "VALUE";
  const shown = metric ? formatMetricNumber(metric) : value;
  const appliedTone = metric ? earnedTone(metric, tone) : tone;

  /**
   * The REASON a figure is not a number belongs on the tile, not only in a
   * tooltip. A `title` alone is unreachable by touch and by keyboard.
   */
  const reason =
    metric && metric.state !== "VALUE" && metric.reason ? metric.reason : null;

  const body = (
    <>
      <span className="adm-kpi__label">{label}</span>
      <span
        className="adm-kpi__value"
        data-state={resolvedState === "VALUE" ? undefined : resolvedState}
        data-tone={appliedTone}
      >
        {shown}
      </span>
      {context ? <span className="adm-kpi__context">{context}</span> : null}
      {!context && reason ? (
        <span className="adm-kpi__context">{reason}</span>
      ) : null}
      {href ? <span className="adm-kpi__drill">{drillLabel} →</span> : null}
    </>
  );

  /**
   * A WHOLE TILE IS A LINK ONLY WHEN IT HAS ONE DESTINATION AND A REAL VALUE.
   * A tile reading "Not measured" that navigates to an empty record list is a
   * dead end dressed as a drill-down.
   */
  if (href && (resolvedState === "VALUE" || resolvedState === "PARTIAL")) {
    return (
      <Link href={href} className="adm-kpi" data-rail={rail}>
        {body}
      </Link>
    );
  }

  return (
    <div className="adm-kpi" data-rail={rail}>
      {body}
    </div>
  );
}

/* ==========================================================================
 * CARD
 * ========================================================================== */

export function AdmCard({
  title,
  note,
  headerAction,
  footer,
  pad,
  children,
  className,
  ...rest
}: {
  title?: React.ReactNode;
  note?: React.ReactNode;
  headerAction?: React.ReactNode;
  footer?: React.ReactNode;
  pad?: "compact" | "none";
  children?: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title" | "children">) {
  return (
    <div
      {...rest}
      className={["adm-card", className].filter(Boolean).join(" ")}
      data-pad={pad}
    >
      {title || headerAction ? (
        <div className="adm-card__head">
          <div style={{ minInlineSize: 0 }}>
            {title ? <h3 className="adm-card__title">{title}</h3> : null}
            {note ? <p className="adm-card__note">{note}</p> : null}
          </div>
          {headerAction ?? null}
        </div>
      ) : null}
      {children ? <div className="adm-card__body">{children}</div> : null}
      {footer ? <div className="adm-card__foot">{footer}</div> : null}
    </div>
  );
}

export function AdmCardGrid({
  cols,
  peer,
  children,
  className,
}: {
  cols?: 2 | 3;
  /** Equal height. Only for a row of genuine peers. */
  peer?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={["adm-cards", className].filter(Boolean).join(" ")}
      data-cols={cols}
      data-peer={peer ? "true" : undefined}
    >
      {children}
    </div>
  );
}

/* ==========================================================================
 * FACTS + TECHNICAL IDENTITY
 * ========================================================================== */

export function AdmFacts({
  items,
  layout,
  className,
}: {
  items: Array<{ label: React.ReactNode; value: React.ReactNode; key?: string }>;
  layout?: "stack";
  className?: string;
}) {
  return (
    <dl
      className={["adm-facts", className].filter(Boolean).join(" ")}
      data-layout={layout}
    >
      {items.map((f, i) => (
        <React.Fragment key={f.key ?? i}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/**
 * A TECHNICAL IDENTIFIER: truncated, titled, copyable.
 *
 * The console rendered raw UUIDs as primary identity in table cells, where a
 * 36-character value in a 70px column wrapped to four lines and took the row
 * with it. Truncation without a copy control would trade one defect for
 * another — an operator needs the whole value to paste into a query — so the
 * two ship together and neither is optional.
 */
export function AdmId({
  value,
  label = "identifier",
  short,
}: {
  value: string;
  /** Names the copy control for assistive technology. */
  label?: string;
  /** Render only the first segment; the full value stays in title + copy. */
  short?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const shown = short ? value.split("-")[0] : value;

  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_600);
      })
      .catch(() => {
        /* A clipboard the browser refuses is not an error worth a banner:
           the full value is already in `title` and selectable. */
      });
  }, [value]);

  return (
    <span className="adm-id">
      <span className="adm-id__value" title={value}>
        {shown}
      </span>
      <button
        type="button"
        className="adm-copy"
        onClick={copy}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
      >
        {copied ? <CheckGlyph /> : <CopyGlyph />}
      </button>
      {/* The result is announced, not only drawn. */}
      <span role="status" aria-live="polite" className="app-visually-hidden">
        {copied ? `${label} copied` : ""}
      </span>
    </span>
  );
}

function CopyGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      /* 2.2 on a 24 box at 15px renders ~1.35px — the console's one glyph
         weight. See the note on the icon normalisation: a declared width is
         not a rendered one, and this glyph was the lightest of the nine. */
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/* ==========================================================================
 * ATTENTION
 * ========================================================================== */

export type AdmSeverity = "critical" | "warning" | "unknown" | "healthy";

const SEVERITY_WORD: Record<AdmSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  unknown: "Unknown",
  healthy: "Healthy",
};

/**
 * An ACTIONABLE warning or failure. Informational prose does not belong here.
 *
 * The severity WORD is rendered unconditionally and cannot be suppressed by a
 * prop: that is what keeps status off hue alone, and it is the one thing a
 * caller must not be able to opt out of.
 */
export function AdmAttention({
  severity,
  statement,
  detail,
  scope,
  action,
  as: As = "div",
}: {
  severity: AdmSeverity;
  /** What is true, in one sentence. */
  statement: React.ReactNode;
  /** Why, and what it affects. */
  detail?: React.ReactNode;
  /** The affected scope — a workspace, a provider, a queue. */
  scope?: React.ReactNode;
  /** The one next step: an investigation view or a runbook. */
  action?: { href: string; label: string };
  as?: "div" | "li";
}) {
  return (
    <As className="adm-attention" data-severity={severity}>
      <span className="adm-attention__severity">{SEVERITY_WORD[severity]}</span>
      <span className="adm-attention__body">
        <span className="adm-attention__statement">{statement}</span>
        {scope ? <span className="adm-secondary">{scope}</span> : null}
        {detail ? <p className="adm-attention__detail">{detail}</p> : null}
      </span>
      {action ? (
        <Link href={action.href} className="adm-attention__action">
          {action.label}
        </Link>
      ) : (
        <span />
      )}
    </As>
  );
}

export function AdmAttentionList({ children }: { children: React.ReactNode }) {
  return <ul className="adm-attention-list">{children}</ul>;
}

/* ==========================================================================
 * INLINE STATE
 * ========================================================================== */

export type AdmInlineState =
  | "empty"
  | "filtered"
  | "loading"
  | "error"
  | "unavailable"
  | "not-measured"
  /** The operator's action succeeded. Not a state of the data. */
  | "done";

const STATE_WORD: Record<AdmInlineState, string> = {
  empty: "Nothing yet",
  filtered: "No matches",
  loading: "Loading",
  error: "Could not load",
  unavailable: "Unavailable",
  "not-measured": "Not measured",
  done: "Done",
};

/**
 * The 56px answer to every state that is not "here is the data".
 *
 * Replaces a 156-235px centred box with an icon disc. The states stay visually
 * distinct from each other and from a measured zero — which is the Phase 2
 * truth contract, drawn.
 */
export function AdmInline({
  state,
  label,
  children,
  action,
}: {
  state: AdmInlineState;
  /** Overrides the default word. The word is never absent. */
  label?: React.ReactNode;
  /** One sentence: what is empty, why that is expected, or what failed. */
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="adm-inline"
      data-state={state}
      role={state === "error" || state === "unavailable" ? "alert" : "status"}
    >
      <span className="adm-inline__label">{label ?? STATE_WORD[state]}</span>
      {children ? <span className="adm-inline__text">{children}</span> : null}
      {action ? <span className="adm-inline__action">{action}</span> : null}
    </div>
  );
}

/** A skeleton shaped like the answer, so nothing jumps when it arrives. */
export function AdmSkeleton({
  shape = "line",
  count = 1,
}: {
  shape?: "line" | "value" | "row";
  count?: number;
}) {
  return (
    <div className="adm-stack" data-gap="tight" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="adm-skeleton" data-shape={shape} />
      ))}
    </div>
  );
}

/* ==========================================================================
 * TABLE
 * ========================================================================== */

export function AdmTableWrap({
  narrow = "scroll",
  label,
  children,
}: {
  /**
   * The narrow-viewport strategy, decided per table. `cards` requires every
   * cell to carry `data-label`; see the stylesheet.
   */
  narrow?: "scroll" | "cards";
  /** Names the scroll region, which is focusable when it scrolls. */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="adm-tablewrap"
      data-narrow={narrow}
      // A scrollable region must be reachable by keyboard, or its content is
      // unreachable without a mouse.
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}

/* ==========================================================================
 * ACTION
 * ========================================================================== */

export function AdmAction({
  title,
  consequence,
  target,
  controls,
  caveat,
  risk,
}: {
  title: React.ReactNode;
  /** What happens, stated as a consequence rather than as a feature. */
  consequence: React.ReactNode;
  /** What it acts on. Named, not implied. */
  target?: React.ReactNode;
  controls: React.ReactNode;
  /** Authority, step-up, or why the control is unavailable. */
  caveat?: React.ReactNode;
  risk?: "destructive" | "elevated";
}) {
  return (
    <div className="adm-action" data-risk={risk}>
      <h3 className="adm-card__title">{title}</h3>
      <p className="adm-action__consequence">{consequence}</p>
      {target ? <div className="adm-action__target">{target}</div> : null}
      <div className="adm-action__controls">{controls}</div>
      {caveat ? <p className="adm-action__caveat">{caveat}</p> : null}
    </div>
  );
}

/* ==========================================================================
 * DETAIL HEADER
 * ========================================================================== */

export function AdmDetailHead({
  eyebrow,
  name,
  id,
  idLabel,
  states,
  actions,
  facts,
}: {
  eyebrow?: React.ReactNode;
  name: React.ReactNode;
  /** The technical identity, rendered truncated + copyable, never as the name. */
  id?: string;
  idLabel?: string;
  states?: React.ReactNode;
  actions?: React.ReactNode;
  /** The few facts that belong in the header. Not every field the record has. */
  facts?: Array<{ label: React.ReactNode; value: React.ReactNode; key?: string }>;
}) {
  return (
    <div className="adm-detail-head">
      <div className="adm-detail-head__identity">
        {eyebrow ? <span className="adm-subhead">{eyebrow}</span> : null}
        <h2 className="adm-detail-head__name">{name}</h2>
        {id ? <AdmId value={id} label={idLabel ?? "identifier"} /> : null}
        {states ? (
          <div className="adm-detail-head__states">{states}</div>
        ) : null}
        {facts && facts.length > 0 ? <AdmFacts items={facts} /> : null}
      </div>
      {actions ? (
        <div className="adm-detail-head__actions">{actions}</div>
      ) : null}
    </div>
  );
}

/* ==========================================================================
 * PANEL TABS
 *
 * Peer views of ONE entity. Unrelated destinations are links, not tabs.
 * ========================================================================== */

export interface AdmTabDef {
  id: string;
  label: React.ReactNode;
  /** A truthful count, or omitted. A count badge that guesses is worse than none. */
  count?: number;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * The ARIA tab pattern, including the arrow-key behaviour it requires.
 *
 * Roving tabindex: the tablist is ONE tab stop and the arrows move between
 * tabs. A tablist where Tab visits every tab is the common mistake, and on a
 * nine-tab panel it is nine stops between the page and its content.
 */
export function AdmTabs({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: AdmTabDef[];
  active: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const enabled = tabs.filter((t) => !t.disabled);
    const at = enabled.findIndex((t) => t.id === active);
    if (at < 0) return;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (at + 1) % enabled.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = enabled[next];
    onSelect(target.id);
    // Move focus with selection, which is what the pattern specifies for
    // automatic activation.
    document.getElementById(`admtab-${target.id}`)?.focus();
  };

  return (
    <div className="adm-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            id={`admtab-${t.id}`}
            type="button"
            role="tab"
            className="adm-tab"
            aria-selected={selected}
            aria-controls={`admpanel-${t.id}`}
            aria-disabled={t.disabled || undefined}
            title={t.disabled ? t.disabledReason : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!t.disabled) onSelect(t.id);
            }}
          >
            {t.label}
            {typeof t.count === "number" ? (
              <span className="adm-tab__count">{t.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function AdmTabPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: string;
  children: React.ReactNode;
}) {
  const selected = id === active;
  return (
    <div
      id={`admpanel-${id}`}
      role="tabpanel"
      aria-labelledby={`admtab-${id}`}
      className="adm-tabpanel"
      // `hidden` rather than unmounting: the panel keeps its scroll position
      // and any unsaved input when the operator looks at a sibling and back.
      hidden={!selected}
      tabIndex={selected ? 0 : -1}
    >
      {children}
    </div>
  );
}

/* ==========================================================================
 * OVERLAY — the drawer and the focused dialog
 *
 * Four admin panels each hand-rolled `role="dialog"` in inline styles and each
 * shipped the same four defects: a physical `right: 0` that did not mirror
 * under RTL, no scrim, no focus handling of any kind, and no Escape. This is
 * the one implementation they now share.
 *
 * What it does that the four copies did not:
 *
 *   - anchors to the INLINE-END edge, so the panel follows the writing
 *     direction instead of the screen;
 *   - traps Tab. `aria-modal` tells a screen reader the page behind is
 *     unavailable; it does nothing to the Tab order, so without a trap a
 *     keyboard operator tabs out of the panel into content the attribute has
 *     just told their screen reader does not exist;
 *   - marks the page behind `inert`, which removes it from the accessibility
 *     tree and from pointer and focus targeting;
 *   - moves focus in on open and returns it to the opener on close;
 *   - closes on Escape and on a scrim click.
 * ========================================================================== */

/**
 * Everything focusable, in DOM order, that is not disabled or hidden.
 *
 * `tabIndex="-1"` is deliberately excluded: it is how an element says it is
 * programmatically focusable but not a tab stop, and the panel itself carries
 * one.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "details > summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.hasAttribute("inert") &&
      el.offsetParent !== null &&
      // A zero-size control is present but unreachable by pointer; keeping it
      // in the cycle is how a trap appears to swallow Tab.
      (el.offsetWidth > 0 || el.offsetHeight > 0),
  );
}

export function AdmOverlay({
  shape = "drawer",
  title,
  subtitle,
  onClose,
  footer,
  testId,
  children,
}: {
  shape?: "drawer" | "dialog";
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    restoreRef.current = document.activeElement as HTMLElement | null;

    // Focus the first real control if there is one, so a drawer whose first
    // action is "Retry" does not make the operator tab to it; otherwise the
    // panel itself, so the title is announced.
    const first = focusableWithin(panel)[0];
    (first ?? panel).focus();

    // The page behind. `inert` is set imperatively because React 18 serialises
    // a `false` JSX boolean on an unknown attribute as the STRING "false",
    // which is itself inert — the opposite of the intent.
    const siblings = Array.from(document.body.children).filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && !el.contains(panel),
    );
    const previouslyInert = siblings.map((el) => el.hasAttribute("inert"));
    siblings.forEach((el) => el.toggleAttribute("inert", true));

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const stops = focusableWithin(panel);
      if (stops.length === 0) {
        // Nothing to cycle through, so Tab would leave the panel entirely.
        event.preventDefault();
        panel.focus();
        return;
      }
      const firstStop = stops[0]!;
      const lastStop = stops[stops.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && (active === firstStop || active === panel)) {
        event.preventDefault();
        lastStop.focus();
      } else if (!event.shiftKey && active === lastStop) {
        event.preventDefault();
        firstStop.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      siblings.forEach((el, i) => {
        if (!previouslyInert[i]) el.removeAttribute("inert");
      });
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className={`adm-overlay adm-overlay--${shape}`}
      onMouseDown={(event) => {
        // mousedown, not click: a click that STARTED inside the panel and
        // ended on the scrim (releasing a text selection past the edge) would
        // otherwise close the panel and lose the selection.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={shape === "drawer" ? "adm-drawer" : "adm-dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
      >
        <header className="adm-overlay__head">
          <div>
            <h2 className="adm-overlay__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? (
              <p className="adm-overlay__subtitle">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="adm-overlay__close"
            onClick={onClose}
            aria-label={`Close ${title.toLowerCase()}`}
          >
            <span aria-hidden="true">&#215;</span>
          </button>
        </header>
        <div className="adm-overlay__body">{children}</div>
        {footer ? <div className="adm-overlay__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
