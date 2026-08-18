import type { ReactNode } from "react";
import Link from "next/link";
import type { EvidenceListItem } from "../lib/evidence-library-types";
import { EvidenceLibraryRow } from "./EvidenceLibraryRow";
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
  onPrevPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <section className="app-panel app-panel__body evidence-library-list-shell">
      <header className="evidence-library-list-shell__header">
        <div>
          <h2 className="evidence-library-list-shell__title">Evidence queue</h2>
          <p className="app-hint">
            Dense operational triage for reviewer queues, export readiness, and case-linked evidence operations.
          </p>
        </div>
        <div className="evidence-library-list-shell__meta">
          <span className="app-chip">{currentScope}</span>
          <span className="app-hint">Results are loaded from the server using the selected filters.</span>
        </div>
      </header>

      {/* Selection + bulk-action bar. It renders whenever a page is loaded;
          the bulk controls inside `toolbar` are supplied by the page and only
          appear when its own selection state requires them. */}
      <div className="evidence-library-list-toolbar" data-evidence-selection-bar>
        <span className="evidence-library-checkbox">
          <input
            id="evidence-select-all-loaded"
            className="app-checkbox"
            type="checkbox"
            checked={allCurrentPageSelected}
            onChange={(event) => onToggleSelectAllCurrentPage(event.target.checked)}
            disabled={items.length === 0}
          />
          <label htmlFor="evidence-select-all-loaded">Select all loaded pages</label>
        </span>
        {toolbar}
      </div>

      {loading ? (
        <div
          className="evidence-library-skeleton-stack"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="Loading evidence records"
        >
          <span className="app-skeleton evidence-library-skeleton-row" />
          <span className="app-skeleton evidence-library-skeleton-row" />
          <span className="app-skeleton evidence-library-skeleton-row" />
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
            /* ONE interactive element per action — the previous build nested a
               <button> inside each <a>, which is invalid and gave assistive
               tech two overlapping controls. */
            <div className="app-empty__actions">
              <Link href="/capture" className="app-header-primary-action">
                Upload / Capture Evidence
              </Link>
              <Link href="/cases" className="app-secondary-action">
                Review Cases
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <ul className="evidence-library-list" data-evidence-list>
            {items.map((item) => (
              <EvidenceLibraryRow
                key={item.id}
                item={item}
                caseName={item.caseId ? caseMap.get(item.caseId) ?? null : null}
                selected={item.id === selectedId}
                checked={selectedIds.has(item.id)}
                onSelect={onSelect}
                onToggleChecked={onToggleSelected}
              />
            ))}
          </ul>

          <div className="evidence-library-pagination">
            <span>{pageLabel}</span>
            <span>{resultsLabel}</span>
            <div className="evidence-library-pagination__actions">
              <button
                type="button"
                className="app-secondary-action"
                onClick={onPrevPage}
                disabled={!hasPreviousPage}
              >
                Previous
              </button>
              <button
                type="button"
                className="app-secondary-action"
                onClick={onNextPage}
                disabled={!hasNextPage}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
