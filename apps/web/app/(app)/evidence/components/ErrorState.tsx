import { Button } from "../../../../components/ui";

export function ErrorState({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <div className="evidence-library-state evidence-library-state--error">
      <strong>{title}</strong>
      <p>{description}</p>
      {onRetry ? <Button onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}
