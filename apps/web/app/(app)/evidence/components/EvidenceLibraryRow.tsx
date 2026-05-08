import { Button } from "../../../../components/ui";
import type { EvidenceListItem } from "../lib/evidence-library-types";
import {
  getCaptureMethodLabel,
  getDisplayTitle,
  getEvidenceTypeLabel,
  getRecordStatusLabel,
  getStatusTone,
  getStructureLabel,
  getVerificationStatusLabel,
} from "../lib/evidence-library-status";
import { formatUtcDateTime, shortId } from "../lib/evidence-library-formatters";
import { buildReportAvailability } from "../lib/evidence-library-helpers";
import { buildReviewPriority } from "../lib/evidence-library-alerts";

export function EvidenceLibraryRow({
  item,
  caseName,
  selected,
  canDownloadReport,
  onSelect,
  onOpenRecord,
  onDownloadReport,
}: {
  item: EvidenceListItem;
  caseName: string | null;
  selected: boolean;
  canDownloadReport: boolean;
  onSelect: (id: string) => void;
  onOpenRecord: (id: string) => void;
  onDownloadReport: (id: string) => void;
}) {
  const report = buildReportAvailability(item);
  const priority = buildReviewPriority(item);

  return (
    <div className={`evidence-library-row ${selected ? "is-selected" : ""}`}>
      <button
        type="button"
        className="evidence-library-row__select"
        onClick={() => onSelect(item.id)}
        aria-pressed={selected}
      >
        <div className="evidence-library-row__main">
          <div className="evidence-library-row__title">
            <strong>{getDisplayTitle(item)}</strong>
            <p>{item.displaySubtitle}</p>
          </div>

          <div className="evidence-library-row__badge-stack">
            <span className={`evidence-library-badge evidence-library-badge--${getStatusTone(item)}`}>
              {getRecordStatusLabel(item.status)}
            </span>
            <span className={`evidence-library-badge evidence-library-badge--priority-${priority.level}`}>
              {priority.label}
            </span>
          </div>
        </div>

        <div className="evidence-library-row__grid">
          <span>{shortId(item.id)}</span>
          <span>{getEvidenceTypeLabel(item)}</span>
          <span>{getStructureLabel(item)}</span>
          <span>{item.itemCount} item{item.itemCount === 1 ? "" : "s"}</span>
          <span>{formatUtcDateTime(item.createdAt)}</span>
          <span>{caseName ?? "Unassigned"}</span>
          <span>{report.label}</span>
          <span>{getVerificationStatusLabel(item.verificationStatus)}</span>
          <span>{getCaptureMethodLabel(item.captureMethod)}</span>
        </div>
      </button>

      <div className="evidence-library-row__actions">
        <Button onClick={() => onSelect(item.id)} variant="secondary">
          Open Review
        </Button>
        <Button onClick={() => onOpenRecord(item.id)} variant="secondary">
          Open Evidence
        </Button>
        <Button onClick={() => onDownloadReport(item.id)} disabled={!report.available || !canDownloadReport}>
          Download Report
        </Button>
      </div>
    </div>
  );
}
