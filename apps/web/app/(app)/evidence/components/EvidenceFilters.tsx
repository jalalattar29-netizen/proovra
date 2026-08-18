import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { AppListbox, type AppListboxOption } from "../../../../components/app-primitives";
import type { EvidenceListScope } from "../lib/evidence-library-types";

export type EvidenceFilterState = {
  search: string;
  scope: EvidenceListScope;
  status: string;
  type: string;
  review: string;
  exportReadiness: string;
  caseAssignment: string;
  retention: string;
  sort: string;
  /**
   * Phase HOME-PROOF / HOME-CLOSURE — backend-side trust signal
   * filters used by Home priority deep-links. "" / "all" = no filter.
   * Values may be single (`FAILED`) or comma-separated
   * (`FAILED,REJECTED,ERROR`) to match the Home bucket count exactly.
   */
  tsaStatus: string;
  otsStatus: string;
  publicVerifyState: string;
  verificationStatus: string;
};

/**
 * One filter control = the CANONICAL AppListbox plus a decorative prefix.
 *
 * This is a composition around the shared control, not a second dropdown:
 * AppListbox still owns the button, the popup, the WAI-ARIA listbox roles and
 * the whole keyboard contract. The prefix is aria-hidden decoration and the
 * real accessible name is supplied through `ariaLabel`, so the control reads
 * as "Workspace scope" to assistive tech and as "Scope: Active" on screen.
 */
function FilterChip<T extends string>({
  id,
  label,
  prefix,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  prefix: string;
  value: T;
  options: ReadonlyArray<AppListboxOption<T>>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="evidence-library-filter-chip">
      <span className="evidence-library-filter-chip__prefix" aria-hidden="true">
        {prefix}
      </span>
      <AppListbox<T>
        id={id}
        className="evidence-library-filter-chip__control"
        ariaLabel={label}
        value={value}
        options={options}
        onChange={onChange}
      />
    </div>
  );
}

export function EvidenceFilters({
  value,
  onChange,
  headerActions,
}: {
  value: EvidenceFilterState;
  onChange: (next: EvidenceFilterState) => void;
  headerActions?: ReactNode;
}) {
  const update = <K extends keyof EvidenceFilterState>(key: K, nextValue: EvidenceFilterState[K]) => {
    onChange({ ...value, [key]: nextValue });
  };

  return (
    <section
      className="app-panel app-panel__body evidence-library-filters"
      data-evidence-filters
      aria-label="Evidence filters"
    >
      {/* Search + saved-view controls. The saved-view menu itself is
          unchanged in Part 1 — only its position in the canonical toolbar. */}
      <div className="evidence-library-filters__search-row">
        <div className="app-search-field app-search-field--block">
          <span className="app-search-icon" aria-hidden="true">
            <Search size={16} strokeWidth={1.9} />
          </span>
          <label htmlFor="evidence-search" className="sr-only">
            Search title, filename, or record ID
          </label>
          <input
            id="evidence-search"
            className="app-search-input"
            type="search"
            value={value.search}
            onChange={(event) => update("search", event.target.value)}
            placeholder="Search title, filename, or record ID"
          />
        </div>
        {headerActions ? (
          <div className="evidence-library-filters__views" data-evidence-saved-views>
            {headerActions}
          </div>
        ) : null}
      </div>

      <div className="evidence-library-filters__grid">
        <FilterChip<EvidenceListScope>
          id="scope-filter"
          label="Workspace scope"
          prefix="Scope:"
          value={value.scope}
          onChange={(next) => update("scope", next)}
          options={[
            { value: "active", label: "Active" },
            { value: "locked", label: "Locked" },
            { value: "archived", label: "Archived" },
            { value: "deleted", label: "Deleted" },
          ]}
        />
        <FilterChip
          id="status-filter"
          label="Status"
          prefix="Status:"
          value={value.status}
          onChange={(next) => update("status", next)}
          options={[
            { value: "all", label: "All" },
            { value: "created", label: "Created" },
            { value: "uploading", label: "Uploading" },
            { value: "uploaded", label: "Uploaded" },
            { value: "signed", label: "Signed" },
            { value: "reported", label: "Reported" },
          ]}
        />
        <FilterChip
          id="type-filter"
          label="Evidence type"
          prefix="Type:"
          value={value.type}
          onChange={(next) => update("type", next)}
          options={[
            { value: "all", label: "All" },
            { value: "image", label: "Image" },
            { value: "video", label: "Video" },
            { value: "audio", label: "Audio" },
            { value: "document", label: "Document" },
            { value: "multipart", label: "Multipart" },
            { value: "other", label: "Other" },
          ]}
        />
        <FilterChip
          id="review-filter"
          label="Review"
          prefix="Review:"
          value={value.review}
          onChange={(next) => update("review", next)}
          options={[
            { value: "all", label: "All" },
            { value: "review-ready", label: "Review-ready marker recorded" },
            { value: "review-required", label: "Review required" },
            { value: "verification-failed", label: "Verification failed" },
          ]}
        />
        <FilterChip
          id="export-filter"
          label="Export"
          prefix="Export:"
          value={value.exportReadiness}
          onChange={(next) => update("exportReadiness", next)}
          options={[
            { value: "all", label: "All" },
            { value: "report-available", label: "Report available" },
            { value: "report-missing", label: "Report not recorded" },
          ]}
        />
        <FilterChip
          id="case-filter"
          label="Case"
          prefix="Case:"
          value={value.caseAssignment}
          onChange={(next) => update("caseAssignment", next)}
          options={[
            { value: "all", label: "All" },
            { value: "assigned", label: "Assigned" },
            { value: "unassigned", label: "Unassigned" },
          ]}
        />
        <FilterChip
          id="retention-filter"
          label="Retention"
          prefix="Retention:"
          value={value.retention}
          onChange={(next) => update("retention", next)}
          options={[
            { value: "all", label: "All" },
            { value: "protected", label: "Storage protection recorded" },
            { value: "unprotected", label: "Protection not recorded" },
          ]}
        />
        <FilterChip
          id="sort-filter"
          label="Sort"
          prefix="Sort:"
          value={value.sort}
          onChange={(next) => update("sort", next)}
          options={[
            { value: "newest", label: "Newest" },
            { value: "oldest", label: "Oldest" },
            { value: "priority", label: "Reviewer priority" },
          ]}
        />
      </div>
    </section>
  );
}
