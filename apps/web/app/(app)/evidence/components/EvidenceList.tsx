import type { EvidenceListItem } from "../lib/evidence-library-types";
import { EvidenceLibraryRow } from "./EvidenceLibraryRow";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { Button, Card } from "../../../../components/ui";

export function EvidenceList({
  items,
  loading,
  error,
  selectedId,
  caseMap,
  currentScope,
  pageLabel,
  resultsLabel,
  hasNextPage,
  hasPreviousPage,
  onSelect,
  onRetry,
  onOpenRecord,
  onDownloadReport,
  canDownloadReport,
  onPrevPage,
  onNextPage,
}: {
  items: EvidenceListItem[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  caseMap: Map<string, string>;
  currentScope: string;
  pageLabel: string;
  resultsLabel: string;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onOpenRecord: (id: string) => void;
  onDownloadReport: (id: string) => void;
  canDownloadReport: (item: EvidenceListItem) => boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <Card className="evidence-library-list-shell">
      <div className="evidence-library-list-shell__header">
        <div>
          <strong>Evidence queue</strong>
          <p>
            Dense operational view for reviewer triage, export preparation, and case-linked record management.
          </p>
        </div>
        <div className="evidence-library-list-shell__meta">
          <span>{currentScope}</span>
          <span>Results are loaded from the server using the selected filters.</span>
        </div>
      </div>

      {loading ? (
        <div className="evidence-library-skeleton-stack">
          <div className="evidence-library-skeleton-row" />
          <div className="evidence-library-skeleton-row" />
          <div className="evidence-library-skeleton-row" />
        </div>
      ) : error ? (
        <ErrorState
          title="Evidence list unavailable"
          description={error}
          onRetry={onRetry}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="No evidence records in this scope"
          description="Adjust the scope or filters, or capture new evidence to populate the reviewer queue."
          primaryHref="/capture"
          primaryLabel="Upload / Capture Evidence"
          secondaryHref="/cases"
          secondaryLabel="Review Cases"
        />
      ) : (
        <>
          <div className="evidence-library-list">
            {items.map((item) => (
              <EvidenceLibraryRow
                key={item.id}
                item={item}
                caseName={item.caseId ? caseMap.get(item.caseId) ?? null : null}
                selected={item.id === selectedId}
                canDownloadReport={canDownloadReport(item)}
                onSelect={onSelect}
                onOpenRecord={onOpenRecord}
                onDownloadReport={onDownloadReport}
              />
            ))}
          </div>

          <div className="evidence-library-pagination">
            <span>{pageLabel}</span>
            <span>{resultsLabel}</span>
            <div className="evidence-library-pagination__actions">
              <Button variant="secondary" onClick={onPrevPage} disabled={!hasPreviousPage}>
                Previous
              </Button>
              <Button onClick={onNextPage} disabled={!hasNextPage}>
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
