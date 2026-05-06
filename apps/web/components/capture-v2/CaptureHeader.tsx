type Props = {
  title: string;
  subtitle: string;
};

export function CaptureHeader({
  title,
  subtitle,
}: Props) {
  return (
    <div className="capture-enterprise-title-card">
      <div className="capture-enterprise-eyebrow">
        <span>●</span>
        Evidence intake workspace
      </div>

      <h1 className="capture-enterprise-title">
        {title}
      </h1>

      <p className="capture-enterprise-subtitle">
        {subtitle}
      </p>
    </div>
  );
}