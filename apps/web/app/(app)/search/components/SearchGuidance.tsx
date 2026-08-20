"use client";

/**
 * The guidance column: what you searched before, what you saved, and what this
 * console can actually find.
 *
 * It stands in for the Inspector while nothing is selected, so the right-hand
 * region is never an empty white gutter. Every list is REAL: recent searches
 * come from the console's own tenant-scoped store and saved views from the
 * saved-views API. When either is empty it says so in upright operational
 * text — no italics, no invented persistence.
 */

import { Filter, Lightbulb, MessageSquare, Type } from "lucide-react";

export type SavedSearchEntry = { id: string; name: string };

export function SearchGuidancePanel({
  recent,
  onApplyRecent,
  saved,
  onApplySaved,
  supportHref,
}: {
  recent: readonly string[];
  onApplyRecent: (query: string) => void;
  /** `null` when this workspace has no saved-search authority at all. */
  saved: readonly SavedSearchEntry[] | null;
  onApplySaved: (id: string) => void;
  supportHref: string;
}) {
  return (
    <div className="app-panel search-guidance" data-search-guidance>
      <section className="search-guidance__section" aria-labelledby="search-recent-label">
        <h2 className="search-guidance__label" id="search-recent-label">
          Recent searches
        </h2>
        {recent.length === 0 ? (
          <p className="search-guidance__empty">Your recent searches will appear here.</p>
        ) : (
          <ul className="search-guidance__list">
            {recent.map((query) => (
              <li key={query}>
                <button
                  type="button"
                  className="search-guidance__item"
                  onClick={() => onApplyRecent(query)}
                  data-search-recent-item
                >
                  {query}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="search-guidance__section" aria-labelledby="search-saved-label">
        <h2 className="search-guidance__label" id="search-saved-label">
          Saved searches
        </h2>
        {saved === null || saved.length === 0 ? (
          <p className="search-guidance__empty">No saved searches yet.</p>
        ) : (
          <ul className="search-guidance__list">
            {saved.map((view) => (
              <li key={view.id}>
                <button
                  type="button"
                  className="search-guidance__item"
                  onClick={() => onApplySaved(view.id)}
                  data-search-saved-item={view.id}
                >
                  {view.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="search-guidance__section" aria-labelledby="search-tips-label">
        <h2 className="search-guidance__label" id="search-tips-label">
          Search tips
        </h2>
        {/* Each tip describes something this console really does. OCR and
            transcript text is qualified with "when available" because it
            depends on what a record carries. */}
        <p className="search-tip">
          <span className="search-tip__icon" aria-hidden="true">
            <Lightbulb size={15} strokeWidth={2} />
          </span>
          <span>
            Search by filename, case name, report title, package, note, or record ID.
          </span>
        </p>
        <p className="search-tip">
          <span className="search-tip__icon" aria-hidden="true">
            <Type size={15} strokeWidth={2} />
          </span>
          <span>OCR and transcript text appear in results when available.</span>
        </p>
        <p className="search-tip">
          <span className="search-tip__icon" aria-hidden="true">
            <Filter size={15} strokeWidth={2} />
          </span>
          <span>Use the filters on the left to narrow by type, status, case, or date.</span>
        </p>
      </section>

      <div className="search-support" data-search-support-card>
        <span className="search-support__icon" aria-hidden="true">
          <MessageSquare size={18} strokeWidth={2} />
        </span>
        <span>
          <span className="search-support__title">Need help?</span>
          <a className="search-support__action" href={supportHref}>
            Contact system admin
          </a>
        </span>
      </div>
    </div>
  );
}
