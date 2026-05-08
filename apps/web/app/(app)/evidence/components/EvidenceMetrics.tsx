import { Card } from "../../../../components/ui";

type MetricItem = {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "success" | "warning" | "danger";
};

function MetricCard({ label, value, detail, tone = "default" }: MetricItem) {
  return (
    <Card className={`evidence-library-metric evidence-library-metric--${tone}`}>
      <span className="evidence-library-metric__label">{label}</span>
      <strong className="evidence-library-metric__value">{value}</strong>
      {detail ? <span className="evidence-library-metric__detail">{detail}</span> : null}
    </Card>
  );
}

export function EvidenceMetrics({
  items,
}: {
  items: MetricItem[];
}) {
  return (
    <div className="evidence-library-metrics">
      {items.map((item) => (
        <MetricCard key={item.label} {...item} />
      ))}
    </div>
  );
}
