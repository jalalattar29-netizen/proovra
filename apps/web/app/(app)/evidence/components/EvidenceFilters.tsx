import type { ReactNode } from "react";
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
   * Phase HOME-PROOF — backend-side trust signal filters used by Home
   * priority deep-links. "" / "all" = no filter.
   */
  tsaStatus: string;
  otsStatus: string;
  publicVerifyState: string;
};

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
    <div className="evidence-library-filters">
      <div className="evidence-library-filters__header">
        <div>
          <strong>Smart filters</strong>
          <p>Group filters by operational review, integrity, export, case, and retention context.</p>
        </div>
        {headerActions ? <div className="evidence-library-placeholder-strip">{headerActions}</div> : null}
      </div>

      <div className="evidence-library-filters__grid">
        <div className="evidence-library-filter-group evidence-library-filter-group--wide">
          <label htmlFor="evidence-search">Search</label>
          <input
            id="evidence-search"
            value={value.search}
            onChange={(event) => update("search", event.target.value)}
            placeholder="Search title, filename, or record ID"
          />
        </div>

        <div className="evidence-library-filter-group">
          <label htmlFor="scope-filter">Workspace scope</label>
          <select
            id="scope-filter"
            value={value.scope}
            onChange={(event) => update("scope", event.target.value as EvidenceListScope)}
          >
            <option value="active">Active</option>
            <option value="locked">Locked</option>
            <option value="archived">Archived</option>
            <option value="deleted">Deleted</option>
          </select>
        </div>

        <div className="evidence-library-filter-group">
          <label htmlFor="status-filter">Status</label>
          <select id="status-filter" value={value.status} onChange={(event) => update("status", event.target.value)}>
            <option value="all">All</option>
            <option value="created">Created</option>
            <option value="uploading">Uploading</option>
            <option value="uploaded">Uploaded</option>
            <option value="signed">Signed</option>
            <option value="reported">Reported</option>
          </select>
        </div>

        <div className="evidence-library-filter-group">
          <label htmlFor="type-filter">Evidence type</label>
          <select id="type-filter" value={value.type} onChange={(event) => update("type", event.target.value)}>
            <option value="all">All</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
            <option value="document">Document</option>
            <option value="multipart">Multipart</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div className="evidence-library-filter-group">
          <label htmlFor="review-filter">Review</label>
          <select id="review-filter" value={value.review} onChange={(event) => update("review", event.target.value)}>
            <option value="all">All</option>
            <option value="review-ready">Review-ready marker recorded</option>
            <option value="review-required">Review required</option>
            <option value="verification-failed">Verification failed</option>
          </select>
        </div>

        <div className="evidence-library-filter-group">
          <label htmlFor="export-filter">Export</label>
          <select
            id="export-filter"
            value={value.exportReadiness}
            onChange={(event) => update("exportReadiness", event.target.value)}
          >
            <option value="all">All</option>
            <option value="report-available">Report available</option>
            <option value="report-missing">Report not recorded</option>
          </select>
        </div>

        <div className="evidence-library-filter-group">
          <label htmlFor="case-filter">Case</label>
          <select
            id="case-filter"
            value={value.caseAssignment}
            onChange={(event) => update("caseAssignment", event.target.value)}
          >
            <option value="all">All</option>
            <option value="assigned">Assigned</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </div>

        <div className="evidence-library-filter-group">
          <label htmlFor="retention-filter">Retention</label>
          <select id="retention-filter" value={value.retention} onChange={(event) => update("retention", event.target.value)}>
            <option value="all">All</option>
            <option value="protected">Storage protection recorded</option>
            <option value="unprotected">Protection not recorded</option>
          </select>
        </div>

        <div className="evidence-library-filter-group">
          <label htmlFor="sort-filter">Sort</label>
          <select id="sort-filter" value={value.sort} onChange={(event) => update("sort", event.target.value)}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="priority">Reviewer priority</option>
          </select>
        </div>
      </div>
    </div>
  );
}
