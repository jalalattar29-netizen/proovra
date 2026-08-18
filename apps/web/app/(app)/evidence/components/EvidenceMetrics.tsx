type MetricItem = {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "success" | "warning" | "danger" | "accent";
};

/**
 * Evidence Library KPI grid.
 *
 * FIGMA (decoded, "KPI Summary Row"): eight `Background+Border` cards, each a
 * Container holding {label, value, caption}. That anatomy maps exactly onto
 * the canonical `.app-kpi-card` (`__label` / `__value` / `__meta`) already used
 * by Case Details and the operational dashboards, so the Library reuses it
 * rather than keeping a private card.
 *
 * TONE IS SEMANTIC, never decorative: the product's own tone flag is mapped to
 * the canonical `data-tone` vocabulary, and only a genuine attention state
 * (missing verification packages) can reach `amber`/`red`. Cards with no
 * meaning carry `slate`.
 */
/**
 * The target colours the VALUE, not a rail on the card, and only where the
 * number itself carries meaning:
 *   danger  — a real attention state (verification packages missing > 0)
 *   accent  — the review queue the operator acts on next (review-ready)
 * Everything else uses primary ink. The label and caption always remain, so
 * state is never communicated by colour alone.
 */
const TONE_TO_VALUE: Partial<
  Record<NonNullable<MetricItem["tone"]>, "danger" | "accent">
> = {
  warning: "danger",
  danger: "danger",
  accent: "accent",
};

function MetricCard({ label, value, detail, tone = "default" }: MetricItem) {
  return (
    <div className="app-kpi-card" data-evidence-metric={label}>
      <span className="app-kpi-card__label">{label}</span>
      <span
        className="app-kpi-card__value"
        data-tone={TONE_TO_VALUE[tone] ?? undefined}
      >
        {value}
      </span>
      {detail ? <span className="app-kpi-card__meta">{detail}</span> : null}
    </div>
  );
}

export function EvidenceMetrics({ items }: { items: MetricItem[] }) {
  return (
    <div
      className="app-grid-kpis evidence-library-metrics"
      data-evidence-metrics
    >
      {items.map((item) => (
        <MetricCard key={item.label} {...item} />
      ))}
    </div>
  );
}
