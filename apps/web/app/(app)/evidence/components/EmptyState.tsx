import Link from "next/link";

export function EmptyState({
  title,
  description,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
}: {
  title: string;
  description: string;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <div className="evidence-library-state">
      <strong>{title}</strong>
      <p>{description}</p>
      <div className="evidence-library-state__actions">
        {primaryHref && primaryLabel ? (
          <Link href={primaryHref} className="evidence-library-link-button evidence-library-link-button--primary">
            {primaryLabel}
          </Link>
        ) : null}
        {secondaryHref && secondaryLabel ? (
          <Link href={secondaryHref} className="evidence-library-link-button">
            {secondaryLabel}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
