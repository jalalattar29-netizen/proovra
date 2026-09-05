/**
 * The runbook master-detail shell.
 *
 * ===========================================================================
 * WHY MASTER-DETAIL, AND WHY THE MASTER IS ALWAYS PRESENT
 * ===========================================================================
 * The catalog used to be a flat list of thirty titles with the slug printed
 * beside each one and a note that "the full markdown text lives in the
 * repository". That is a table of contents for a book the reader does not
 * have. An operator mid-incident, following a `runbookSlug` off an incident,
 * arrived at a page that confirmed the runbook exists and then stopped.
 *
 * So the text is here, and the list stays beside it: a runbook sends you to
 * another runbook often enough — the TSA one points at OTS and at report
 * generation precisely to stop you reasoning from one to the other — that
 * losing the catalog on the way in would make the next hop a trip back.
 *
 * The list is a sticky sidebar on wide viewports and stacks above the reader
 * below 900px, where a 320px column beside prose leaves neither usable.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { RunbookCatalogNav } from "./_RunbookCatalogNav";

// Metadata only. Importing the full catalog here pulled every runbook BODY
// into the client bundle — 125 KB of markdown to render a list of titles.
import {
  RUNBOOK_INDEX,
  RUNBOOK_CATEGORY_ORDER,
  type RunbookCategory,
} from "../../../../../lib/runbooks/index.generated";

export function RunbookSidebar({ activeSlug }: { activeSlug?: string }) {
  const byCategory = new Map<RunbookCategory, typeof RUNBOOK_INDEX>();
  for (const cat of RUNBOOK_CATEGORY_ORDER) {
    const entries = RUNBOOK_INDEX.filter((r) => r.category === cat);
    if (entries.length > 0) byCategory.set(cat, entries);
  }

  return (
    <nav className="rb-sidebar" aria-label="Runbook catalog">
      {RUNBOOK_CATEGORY_ORDER.map((cat) => {
        const entries = byCategory.get(cat);
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
                    // here"; the left rule in CSS is the visual one. Colour
                    // alone would say it to only some readers.
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
      })}
    </nav>
  );
}

export function RunbookLayout({
  activeSlug,
  children,
}: {
  activeSlug?: string;
  children: ReactNode;
}) {
  return (
    <div className="rb-layout">
      {/*
        THE SEARCHABLE CATALOG, not the static list above.

        `RunbookSidebar` is kept and still exported: it is the server-rendered
        list, it needs no JavaScript, and it is what the catalog page's own
        no-script path and the render tests read. The rail beside a runbook is
        the one an operator uses under pressure, and twenty-nine procedures in
        seven categories is a 1,000px scroll to find the one whose symptom you
        already know. That one gets the filter.
      */}
      <RunbookCatalogNav activeSlug={activeSlug} />
      <div>{children}</div>
    </div>
  );
}
