import { Button } from "../../../../components/ui";
import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { getDisplayTitle } from "../lib/evidence-library-status";

export function ReviewSurface({
  item,
  detail,
  onOpenRecord,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
  onOpenRecord: () => void;
}) {
  const previewItem =
    detail.evidence?.contentItems?.find(
      (contentItem) => contentItem.id === detail.evidence?.defaultPreviewItemId
    ) ??
    detail.evidence?.primaryContentItem ??
    detail.evidence?.contentItems?.find((contentItem) => contentItem.previewable) ??
    null;

  const previewUrl = previewItem?.viewUrl ?? null;
  const previewKind = previewItem?.kind ?? "other";

  return (
    <section className="evidence-library-panel">
      <div className="evidence-library-panel__header">
        <div>
          <strong>Review surface</strong>
          <p>Preview content is loaded only for the selected record and follows the backend content access policy.</p>
        </div>
      </div>

      {previewUrl ? (
        <div className="evidence-library-preview">
          {previewKind === "image" ? <img src={previewUrl} alt={getDisplayTitle(detail.evidence ?? item)} /> : null}
          {previewKind === "video" ? <video src={previewUrl} controls preload="metadata" /> : null}
          {previewKind === "audio" ? <audio src={previewUrl} controls preload="metadata" /> : null}
          {previewKind === "pdf" || previewKind === "text" ? (
            <iframe src={previewUrl} title={getDisplayTitle(detail.evidence ?? item)} />
          ) : null}
          {previewKind === "other" ? (
            <div className="evidence-library-preview-placeholder">
              <strong>Preview not available</strong>
              <p>Open the full evidence record to review preserved content.</p>
              <Button onClick={onOpenRecord} variant="secondary">
                Open Full Record
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="evidence-library-preview-placeholder">
          <strong>Preview not available</strong>
          <p>Open the full evidence record to review preserved content.</p>
          <Button onClick={onOpenRecord} variant="secondary">
            Open Full Record
          </Button>
        </div>
      )}

      {detail.parts.length > 1 ? (
        <div className="evidence-library-part-grid">
          {detail.parts.slice(0, 6).map((part) => (
            <div key={part.id} className="evidence-library-part-card">
              <strong>{part.displayName || part.label || `Item ${part.partIndex + 1}`}</strong>
              <span>{part.mimeType ?? "Type not recorded"}</span>
              <span>{part.displaySizeLabel ?? "Size not recorded"}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
