"use client";

import Link from "next/link";

/**
 * ADM-024 — RENDERING THE FOUR METRIC STATES.
 *
 * The API distinguishes VALUE / NOT_MEASURED / UNKNOWN / ERROR (see
 * `services/admin/metric-state.ts`). The console must not flatten them back
 * into one grey dash, which is what the old "Not measured" string did for
 * everything including a query that threw.
 *
 *   VALUE         the number.
 *   NOT_MEASURED  "Not measured" — the platform does not model this.
 *   UNKNOWN       "Unknown" — measurable, not proven this cycle.
 *   ERROR         "Unavailable" — the read failed. Visually distinct, because
 *                 it is the only one of the four that means something is wrong
 *                 RIGHT NOW and an operator may need to stop trusting the page.
 *
 * The reason travels in `title` so it is available on hover without turning
 * every tile into a paragraph.
 */

export type MetricState = "VALUE" | "NOT_MEASURED" | "UNKNOWN" | "ERROR";

export type Metric<T = number> = {
  state: MetricState;
  value: T | null;
  reason?: string;
};

export type OverviewFigure = {
  metric: Metric<number>;
  drillDown: string | null;
};

const STATE_LABEL: Record<Exclude<MetricState, "VALUE">, string> = {
  NOT_MEASURED: "Not measured",
  UNKNOWN: "Unknown",
  ERROR: "Unavailable",
};

export function formatMetricNumber(m: Metric<number> | undefined): string {
  if (m?.state === "VALUE" && typeof m.value === "number") {
    return new Intl.NumberFormat().format(m.value);
  }
  return STATE_LABEL[(m?.state ?? "UNKNOWN") as Exclude<MetricState, "VALUE">];
}

/** Money is never rendered without the currency it is denominated in (ADM-012). */
export function formatMoney(amountCents: number, currency: string): string {
  const safe = currency && currency !== "UNKNOWN" ? currency : undefined;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: safe ?? "EUR",
      maximumFractionDigits: 0,
    }).format(amountCents / 100);
  } catch {
    // An unrecognised ISO code must still show the amount AND the code, never
    // silently borrow another currency's symbol.
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}

export function AdminStat({
  label,
  figure,
  metric,
  hint,
  emphasis,
}: {
  label: string;
  /** A figure with a drill-down target. Prefer this — see §1.1. */
  figure?: OverviewFigure;
  /** A bare metric, for signals that genuinely have no record list. */
  metric?: Metric<number>;
  hint?: string;
  emphasis?: "attention" | "critical";
}) {
  const m = figure?.metric ?? metric;
  const isProblem = m?.state === "ERROR";
  const text = formatMetricNumber(m);
  const href = figure?.drillDown ?? null;

  /**
   * EMPHASIS IS EARNED BY THE VALUE, NOT BY THE METRIC'S NAME.
   *
   * `emphasis` was applied from the call site unconditionally, so a tile
   * reading `0` for TSA failures, OTS failures, past-due subscriptions, failed
   * payments, SSO outages and high-severity security events rendered in the
   * same red or amber as a tile reading `12`. The Platform Control Center had
   * eleven coloured zeros on it.
   *
   * A count of zero problems is the good state. Painting it as an alarm is not
   * a cosmetic complaint: it is the mechanism by which operators stop reading
   * the colour at all, and then miss the one tile that is genuinely red.
   *
   * ERROR keeps its own treatment regardless — "Unavailable" means the read
   * failed, which IS wrong right now whatever the metric is called.
   */
  const earnsEmphasis =
    m?.state === "VALUE" && typeof m.value === "number" && m.value > 0;
  const appliedEmphasis = earnsEmphasis ? emphasis : undefined;

  const body = (
    <>
      <div className="admin-stat-label">{label}</div>
      <div
        className="admin-stat-value"
        data-state={m?.state ?? "UNKNOWN"}
        data-emphasis={appliedEmphasis ?? undefined}
      >
        {text}
      </div>
      {hint ? <div className="admin-stat-hint">{hint}</div> : null}
      {m && m.state !== "VALUE" && m.reason ? (
        <div className="admin-stat-reason">{m.reason}</div>
      ) : null}
      {href ? <div className="admin-stat-drill">View records →</div> : null}
    </>
  );

  const title =
    m && m.state !== "VALUE" && m.reason ? m.reason : undefined;

  if (href && m?.state === "VALUE") {
    return (
      <Link
        href={href}
        className="admin-stat admin-stat--link"
        data-problem={isProblem || undefined}
        title={title}
      >
        {body}
      </Link>
    );
  }

  return (
    <div className="admin-stat" data-problem={isProblem || undefined} title={title}>
      {body}
    </div>
  );
}

export function AdminStatGrid({ children }: { children: React.ReactNode }) {
  return <div className="admin-stat-grid">{children}</div>;
}
