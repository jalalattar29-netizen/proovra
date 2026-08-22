import Link from "next/link";
import { Archive, FolderPlus, RefreshCw, Upload } from "lucide-react";
import { PageHeader } from "../../../../components/ui";
import {
  EVIDENCE_LIBRARY_LEGAL_BOUNDARY,
  EVIDENCE_LIBRARY_TITLE,
  EVIDENCE_LIBRARY_DESCRIPTION,
  EVIDENCE_LIBRARY_LEGAL_BOUNDARY_TITLE,
} from "../lib/evidence-library-formatters";

/**
 * Evidence Library header + legal boundary.
 *
 * Every control resolves to a canonical authority — `.app-header-primary-action`
 * for the primary, `.app-secondary-action` for the two secondaries — so the
 * page reads as the same product as Case Details. No inline style objects, no
 * legacy Button/Card/Badge, no colour declared here.
 *
 * Behaviour is unchanged: New Case still navigates to /cases, Upload / Capture
 * still navigates to /capture, and Refresh still calls the same handler with
 * the same disabled-while-refreshing contract.
 */
export function EvidenceLibraryHeader({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <>
      <PageHeader
        className="evidence-library-header"
        title={
          /* THE CANONICAL TITLE TREATMENT, reused — the same
             `.app-title-row` / `.app-title-icon` pair /cases and
             /notifications render, so all three page titles are one
             definition rather than three that resemble each other.

             `Archive` is the evidence glyph: the Library is the preserved
             record store, and the icon library is the one the app already
             uses. Decorative — the heading beside it names the page, so a
             second announcement is noise in a screen reader. */
          <span className="app-title-row">
            <span aria-hidden="true" className="app-title-icon">
              <Archive strokeWidth={1.75} data-evidence-title-icon />
            </span>
            <span data-evidence-title>{EVIDENCE_LIBRARY_TITLE}</span>
          </span>
        }
        subtitle={
          /* INLINE element — PageHeader wraps `subtitle` in its own <p>. */
          <span className="evidence-library-subtitle" data-evidence-subtitle>
            {EVIDENCE_LIBRARY_DESCRIPTION}
          </span>
        }
        secondaryActions={
          <>
            <Link
              href="/cases"
              className="app-secondary-action app-secondary-action--lg"
              data-evidence-new-case
            >
              <FolderPlus size={16} strokeWidth={1.9} aria-hidden="true" />
              New Case
            </Link>
            <button
              type="button"
              className="app-secondary-action app-secondary-action--lg"
              onClick={onRefresh}
              disabled={refreshing}
              aria-busy={refreshing}
              data-evidence-refresh
            >
              <RefreshCw size={16} strokeWidth={1.9} aria-hidden="true" />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </>
        }
        primaryAction={
          <Link
            href="/capture"
            className="app-header-primary-action app-primary-action--lg"
            data-evidence-upload
          >
            <Upload size={16} strokeWidth={2} aria-hidden="true" />
            Upload / Capture Evidence
          </Link>
        }
      />

      {/* LEGAL BOUNDARY — canonical panel with a 4px accent on the LOGICAL
          start edge, so it mirrors to the right-hand edge in Arabic. The
          heading carries the accent ink; the body stays neutral and upright.
          Wording and localization are untouched. */}
      <section
        className="app-panel app-panel__body evidence-library-boundary"
        data-evidence-legal-boundary
        aria-labelledby="evidence-legal-boundary-title"
      >
        <h2
          id="evidence-legal-boundary-title"
          className="evidence-library-boundary-title"
        >
          {EVIDENCE_LIBRARY_LEGAL_BOUNDARY_TITLE}
        </h2>
        <p className="evidence-library-boundary-text">
          {EVIDENCE_LIBRARY_LEGAL_BOUNDARY}
        </p>
      </section>
    </>
  );
}
