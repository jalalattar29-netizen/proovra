import type { ReactNode } from "react";
import Link from "next/link";
import type { EvidenceListItem } from "../lib/evidence-library-types";
import { EvidenceLibraryRow } from "./EvidenceLibraryRow";
import { Button, Card } from "../../../../components/ui";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { ProovraSystemState } from "../../../../components/feedback/ProovraSystemState";

export function EvidenceList({
  items,
  loading,
  error,
  selectedId,
  caseMap,
  currentScope,
  pageLabel,
  resultsLabel,
  toolbar,
  selectedIds,
  allCurrentPageSelected,
  hasNextPage,
  hasPreviousPage,
  onSelect,
  onToggleSelected,
  onToggleSelectAllCurrentPage,
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
  toolbar?: ReactNode;
  selectedIds: Set<string>;
  allCurrentPageSelected: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onSelect: (id: string) => void;
  onToggleSelected: (id: string, checked: boolean) => void;
  onToggleSelectAllCurrentPage: (checked: boolean) => void;
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
            Dense operational triage for reviewer queues, export readiness, and case-linked evidence operations.
          </p>
        </div>
        <div className="evidence-library-list-shell__meta">
          <span>{currentScope}</span>
          <span>Results are loaded from the server using the selected filters.</span>
        </div>
      </div>

      <div className="evidence-library-list-toolbar">
        <label className="evidence-library-checkbox">
          <input
            type="checkbox"
            checked={allCurrentPageSelected}
            onChange={(event) => onToggleSelectAllCurrentPage(event.target.checked)}
            disabled={items.length === 0}
          />
          <span>Select loaded page</span>
        </label>
        {toolbar}
      </div>

      {loading ? (
        <div className="evidence-library-skeleton-stack">
          <div className="evidence-library-skeleton-row" />
          <div className="evidence-library-skeleton-row" />
          <div className="evidence-library-skeleton-row" />
        </div>
      ) : error ? (
        <ProovraSystemState
          kind="server-error"
          context="authenticated"
          presentation="contained"
          testId="evidence-list-error"
          title="Evidence list unavailable"
          message={error}
          actions={[{ label: "Try again", onClick: onRetry, variant: "primary" }]}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="No evidence records in this scope"
          purpose="Adjust the scope or filters, or capture new evidence to populate the reviewer queue."
          action={
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
              <Link href="/capture">
                <Button variant="primary">Upload / Capture Evidence</Button>
              </Link>
              <Link href="/cases">
                <Button variant="secondary">Review Cases</Button>
              </Link>
            </div>
          }
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
                checked={selectedIds.has(item.id)}
                canDownloadReport={canDownloadReport(item)}
                onSelect={onSelect}
                onToggleChecked={onToggleSelected}
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
