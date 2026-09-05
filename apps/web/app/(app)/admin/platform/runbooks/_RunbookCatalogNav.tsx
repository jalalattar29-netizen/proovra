"use client";

/**
 * THE RUNBOOK CATALOG, SEARCHABLE.
 *
 * =============================================================================
 * WHY SEARCH, AND WHY IT IS NOT OPTIONAL
 * =============================================================================
 * The catalog is twenty-nine procedures in seven categories, rendered as a
 * sticky 320px rail. At 1440px that rail is a 1,000px scroll, and the operator
 * reaching for it is mid-incident with a symptom in mind — "the timestamp
 * failed", "the queue is wedged", "exports are blocked" — not a category name.
 * Finding the right procedure by scrolling a categorised list means already
 * knowing which category somebody filed it under.
 *
 * =============================================================================
 * WHAT IT MATCHES, AND WHY THAT SET
 * =============================================================================
 * Title, slug, subsystems and summary. The SUBSYSTEMS field is the one that
 * earns its place: an operator looking at a failing `tsa` probe types "tsa",
 * and the runbook whose title is "RFC3161 timestamp failure" does not contain
 * that string anywhere a title search would find it.
 *
 * =============================================================================
 * WHAT IT DOES NOT DO
 * =============================================================================
 * It does not search runbook BODIES. The index is metadata only, deliberately:
 * importing the full catalog here pulled 125 KB of markdown into the client
 * bundle to render a list of titles, and that regression is recorded in
 * `_RunbookLayout.tsx`. Full-text search over procedures is a real feature and
 * it belongs on the server, not in a sidebar filter that quietly ships the
 * corpus to the browser.
 *
 * A11Y: a labelled search input, a live region announcing the result count,
 * and `aria-current` on the open runbook. An empty result is stated in words
 * with the query echoed, so "nothing matches" is never confused with "the
 * catalog is empty".
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  RUNBOOK_INDEX,
  RUNBOOK_CATEGORY_ORDER,
  type RunbookCategory,
  type RunbookIndexEntry,
} from "../../../../../lib/runbooks/index.generated";

function matches(r: RunbookIndexEntry, q: string): boolean {
  if (q === "") return true;
  const hay = [r.title, r.slug, r.summary, ...r.subsystems]
    .join(" ")
    .toLowerCase();
  // Every term must appear somewhere. "queue stuck" should find the runbook
  // whose title says "stuck" and whose subsystems say "queue"; requiring one
  // field to contain the whole phrase would not.
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

export function RunbookCatalogNav({ activeSlug }: { activeSlug?: string }) {
  const [query, setQuery] = useState("");
  const q = query.trim();

  const { groups, total } = useMemo(() => {
    const hits = RUNBOOK_INDEX.filter((r) => matches(r, q));
    const byCategory = new Map<RunbookCategory, RunbookIndexEntry[]>();
    for (const cat of RUNBOOK_CATEGORY_ORDER) {
      const entries = hits.filter((r) => r.category === cat);
      if (entries.length > 0) byCategory.set(cat, entries);
    }
    return { groups: byCategory, total: hits.length };
  }, [q]);

  return (
    <nav className="rb-sidebar" aria-label="Runbook catalog">
      <div className="rb-search">
        <label className="rb-search__label" htmlFor="rb-search-input">
          Find a runbook
        </label>
        <input
          id="rb-search-input"
          className="rb-search__input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Symptom, subsystem or slug…"
          autoComplete="off"
        />
        {/*
          THE COUNT IS TRUTHFUL AND IT DISTINGUISHES ITS TWO STATES.
          An unfiltered list says how many procedures exist; a filtered one says
          how many matched, out of how many. "0 of 29" and "no runbooks" are
          different facts and the review found surfaces that rendered them the
          same way.
        */}
        <p className="rb-search__count" role="status" aria-live="polite">
          {q === ""
            ? `${total} runbook${total === 1 ? "" : "s"}`
            : `${total} of ${RUNBOOK_INDEX.length} match “${q}”`}
        </p>
      </div>

      {total === 0 ? (
        <p className="rb-search__empty">
          No runbook mentions that. Try a subsystem — <code>tsa</code>,{" "}
          <code>queue</code>, <code>export</code> — or{" "}
          <button
            type="button"
            className="rb-search__clear"
            onClick={() => setQuery("")}
 >
            clear the filter
          </button>
          .
        </p>
      ) : (
        RUNBOOK_CATEGORY_ORDER.map((cat) => {
          const entries = groups.get(cat);
          if (!entries) return null;
          return (
            <div key={cat}>
              <div className="rb-group-title">{cat}</div>
              <ul className="rb-nav-list">
                {entries.map((r) => (
                  <li key={r.slug}>
                    <Link
                      href={`/admin/platform/runbooks/${r.slug}`}
                      className="rb-nav-link"
                      // `aria-current` is the accessible statement of "you are
                      // here"; the inline-start rule in CSS is the visual one.
                      // Colour alone would say it to only some readers.
                      aria-current={r.slug === activeSlug ? "page" : undefined}
 >
                      {r.title}
                      <span className="rb-nav-slug">{r.slug}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </nav>
  );
}

export default RunbookCatalogNav;
