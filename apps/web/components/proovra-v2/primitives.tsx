"use client";

/**
 * PROOVRA V2 — reusable internal UI foundation.
 *
 * Presentation-only building blocks extracted from the Figma source and
 * shared by every future internal-page migration. Nothing in this file
 * fetches data, decides authorization, or mutates state: callers pass
 * already-authorized values and already-gated handlers.
 *
 * Visual contract lives in `proovra-v2.css`; that sheet is inert until a
 * `.pv2-*` class is used or `useProovraV2Surface()` opts a route in.
 */

import type { ReactNode } from "react";

import {
  IconChevronRight,
  IconCopy,
  IconSearch,
} from "./icons";

/* ------------------------------------------------------------------ */
/* Surface / Card                                                      */
/* ------------------------------------------------------------------ */

export type SurfaceVariant = "flush" | "card" | "panel" | "rail";

export function Surface({
  variant = "card",
  as: Tag = "div",
  className,
  children,
  ...rest
}: {
  variant?: SurfaceVariant;
  as?: "div" | "section" | "aside" | "li";
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={`pv2-surface pv2-surface--${variant}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export type ButtonTone = "primary" | "outline" | "quiet" | "danger";

export function Button({
  tone = "outline",
  block,
  small,
  className,
  type = "button",
  children,
  ...rest
}: {
  tone?: ButtonTone;
  block?: boolean;
  small?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={[
        "pv2-btn",
        `pv2-btn--${tone}`,
        block ? "pv2-btn--block" : "",
        small ? "pv2-btn--sm" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Breadcrumbs                                                         */
/* ------------------------------------------------------------------ */

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({
  items,
  label = "Breadcrumb",
  ...rest
}: {
  items: ReadonlyArray<Crumb>;
  label?: string;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <nav className="pv2-crumbs" aria-label={label} {...rest}>
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <span key={`${item.label}-${idx}`} style={{ display: "inline-flex", alignItems: "center" }}>
            {idx > 0 ? (
              <span className="pv2-crumb-sep" aria-hidden="true">
                /
              </span>
            ) : null}
            {item.href && !isLast ? (
              <a href={item.href}>{item.label}</a>
            ) : (
              <span
                className={isLast ? "pv2-crumb-current" : undefined}
                aria-current={isLast ? "page" : undefined}
              >
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Status badge                                                        */
/* ------------------------------------------------------------------ */

export type StatusTone = "success" | "neutral" | "info" | "attention" | "danger";

export function StatusBadge({
  tone = "neutral",
  children,
  ...rest
}: { tone?: StatusTone; children: ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="pv2-status" data-tone={tone} {...rest}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Copyable identifier                                                 */
/* ------------------------------------------------------------------ */

export function CopyField({
  label,
  value,
  onCopy,
  title,
  ...rest
}: {
  label: string;
  value: string;
  onCopy: () => void;
  title?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <span className="pv2-pagehead-idrow">
      <span className="pv2-pagehead-idlabel">
        <span className="pv2-dot" aria-hidden="true" />
        {label}
      </span>
      <button type="button" className="pv2-copyfield" onClick={onCopy} title={title} {...rest}>
        <span className="pv2-copyfield-value">{value}</span>
        <span className="pv2-btn-icon" aria-hidden="true">
          <IconCopy size={16} />
        </span>
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export function Tabs<T extends string>({
  items,
  active,
  onSelect,
  label,
  tabAttr,
  ...rest
}: {
  items: ReadonlyArray<{ id: T; label: string }>;
  active: T;
  onSelect: (id: T) => void;
  label: string;
  /** Callback producing the per-tab data-* attributes the route pins. */
  tabAttr?: (id: T) => Record<string, string>;
} & Omit<React.HTMLAttributes<HTMLElement>, "onSelect">) {
  return (
    <nav className="pv2-tabs" role="tablist" aria-label={label} {...rest}>
      {items.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={isActive ? "pv2-tab is-active" : "pv2-tab"}
            onClick={() => onSelect(tab.id)}
            {...(tabAttr ? tabAttr(tab.id) : {})}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Metric card                                                         */
/* ------------------------------------------------------------------ */

export function MetricCard({
  label,
  value,
  hint,
  ...rest
}: {
  label: string;
  value: string;
  hint?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Surface variant="card" className="pv2-metric" {...rest}>
      <span className="pv2-metric-label">{label}</span>
      <span className="pv2-metric-value">{value}</span>
      {hint ? <span className="pv2-metric-hint">{hint}</span> : null}
    </Surface>
  );
}

export function MetricRow({ children }: { children: ReactNode }) {
  return <div className="pv2-metrics">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Key/value panel                                                     */
/* ------------------------------------------------------------------ */

export function KeyValuePanel({
  rows,
  ...rest
}: {
  rows: ReadonlyArray<{ label: string; value: string }>;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Surface variant="panel" as="section" {...rest}>
      <dl className="pv2-kv">
        {rows.map((row) => (
          <div className="pv2-kv-row" key={row.label}>
            <dt className="pv2-kv-key">{row.label}</dt>
            <dd className="pv2-kv-val">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Surface>
  );
}

/* ------------------------------------------------------------------ */
/* Attention panel                                                     */
/* ------------------------------------------------------------------ */

export function AttentionPanel({
  title,
  children,
  action,
  ...rest
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className="pv2-attention" {...rest}>
      <div className="pv2-attention-body">
        <h2 className="pv2-attention-title">{title}</h2>
        {children}
      </div>
      {action ?? null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Action rail                                                         */
/* ------------------------------------------------------------------ */

export function ActionRail({
  title,
  children,
  ...rest
}: {
  title: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Surface variant="rail" as="aside" className="pv2-rail" {...rest}>
      <h2 className="pv2-rail-title">{title}</h2>
      {children}
    </Surface>
  );
}

/* ------------------------------------------------------------------ */
/* Search field                                                        */
/* ------------------------------------------------------------------ */

export function SearchField({
  value,
  onValueChange,
  placeholder,
  ariaLabel,
  ...rest
}: {
  value: string;
  onValueChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <div className="pv2-search">
      <span className="pv2-search-icon" aria-hidden="true">
        <IconSearch size={20} />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        {...rest}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

export function LoadingSkeleton({
  rows = 3,
  label = "Loading",
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <div className="pv2-skel" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <span
          key={i}
          className="pv2-skel-bar"
          style={{ width: i === 0 ? "38%" : i === rows - 1 ? "62%" : "100%" }}
        />
      ))}
    </div>
  );
}

export function StateBlock({
  tone = "neutral",
  title,
  description,
  actions,
  ...rest
}: {
  tone?: "neutral" | "danger" | "restricted";
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="pv2-state" data-tone={tone} {...rest}>
      <p className="pv2-state-title">{title}</p>
      {description ? <p className="pv2-state-text">{description}</p> : null}
      {actions ? <div className="pv2-state-actions">{actions}</div> : null}
    </div>
  );
}

/** Convenience aliases so callers read as the Figma component names. */
export const EmptyStateV2 = StateBlock;
export const ErrorStateV2 = (props: React.ComponentProps<typeof StateBlock>) => (
  <StateBlock tone="danger" {...props} />
);
export const RestrictedStateV2 = (props: React.ComponentProps<typeof StateBlock>) => (
  <StateBlock tone="restricted" {...props} />
);

/* ------------------------------------------------------------------ */
/* Layout helpers                                                      */
/* ------------------------------------------------------------------ */

export function Split({
  wideRail,
  main,
  rail,
}: {
  wideRail?: boolean;
  main: ReactNode;
  rail: ReactNode;
}) {
  return (
    <div className={`pv2-split${wideRail ? " pv2-split--wide-rail" : ""}`}>
      <div className="pv2-split-main">{main}</div>
      {rail}
    </div>
  );
}

export { IconChevronRight };
