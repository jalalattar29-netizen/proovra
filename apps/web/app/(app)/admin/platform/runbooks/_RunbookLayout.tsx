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

import {
  RUNBOOKS,
  RUNBOOK_CATEGORY_ORDER,
  type RunbookCategory,
} from "../../../../../lib/runbooks/catalog.generated";

export function RunbookSidebar({ activeSlug }: { activeSlug?: string }) {
  const byCategory = new Map<RunbookCategory, typeof RUNBOOKS>();
  for (const cat of RUNBOOK_CATEGORY_ORDER) {
    const entries = RUNBOOKS.filter((r) => r.category === cat);
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
      <RunbookSidebar activeSlug={activeSlug} />
      <div>{children}</div>
    </div>
  );
}
