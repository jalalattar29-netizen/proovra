/**
 * OPERATOR RUNBOOK CATALOG — the master half of a master-detail pair.
 *
 * ===========================================================================
 * WHAT CHANGED, AND WHY
 * ===========================================================================
 * This page used to be a flat list of thirty titles, each with its slug
 * printed beside it and a closing note that "the full markdown text lives in
 * the repository. Operators with repository access can open the file by slug."
 *
 * That sentence describes the failure. An operator mid-incident, handed a
 * `runbookSlug` by an incident, does not have a repository checkout open —
 * and two surfaces (`CommandCenter`, `GovernanceControlPlane`) were already
 * linking `/admin/platform/runbooks#<slug>`, a fragment pointing at an anchor
 * this page never rendered, so both landed at the top of the list.
 *
 * The text now lives at `/admin/platform/runbooks/<slug>`, this page indexes
 * it, and the catalog stays beside the reader as a sidebar.
 *
 * ===========================================================================
 * THE LIST IS GENERATED, NOT CURATED TWICE
 * ===========================================================================
 * It was previously hand-maintained here, which is why it had drifted: the
 * catalog listed 25 runbooks while `docs/runbooks/` held 29, and the four
 * missing ones were invisible in the product. Titles and summaries now come
 * from `catalog.generated.ts`, built from the markdown itself and gated on
 * freshness, so a new runbook appears here by existing.
 */

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../../components/ui/PageShell";
import { Card } from "../../../../../components/ui/Card";
import { Badge } from "../../../../../components/ui/Badge";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../../components/ui";
// Metadata only — see _RunbookLayout. The reader is the one page that needs
// bodies, and it prerenders them into static HTML rather than shipping them.
import {
  RUNBOOK_INDEX,
  RUNBOOK_CATEGORY_ORDER,
} from "../../../../../lib/runbooks/index.generated";
import { RunbookSidebar } from "./_RunbookLayout";
import "./runbooks.css";

function RunbookCatalog() {
  const [query, setQuery] = useState("");

  /**
   * Match on title, slug, summary AND subsystem.
   *
   * The subsystem is not decoration: a readiness banner hands an operator a
   * subsystem id (`ots`, `reviewer`, `s3`) rather than a runbook slug, and
   * searching for it has to find the runbook or the id is a dead end.
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return RUNBOOK_INDEX;
    return RUNBOOK_INDEX.filter((r) =>
      [r.title, r.slug, r.summary, ...r.subsystems]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [query]);

  const grouped = RUNBOOK_CATEGORY_ORDER.map((cat) => ({
    category: cat,
    entries: matches.filter((r) => r.category === cat),
  })).filter((g) => g.entries.length > 0);

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform control center"
          title="Operator runbooks"
          subtitle="The procedure an incident's runbook slug points at. Every runbook here is the text from the repository, not a summary of it — open one to read the steps, not to confirm it exists."
        />
      }
 >
      <div className="rb-layout">
        <RunbookSidebar />

        <div>
          <FilterBar>
            <FilterBar.Search
              label="Search"
              value={query}
              onChange={setQuery}
              placeholder="Title, slug, or subsystem (ots, reviewer, s3…)"
            />
          </FilterBar>

          <div
            style={{
              fontSize: 12.5,
              color: "var(--ink-muted)",
              margin: "12px 0 16px",
            }}
 >
            {matches.length} of {RUNBOOK_INDEX.length} runbook
            {RUNBOOK_INDEX.length === 1 ? "" : "s"}
            {query.trim() === "" ? "" : ` matching “${query.trim()}”`}
          </div>

          {grouped.length === 0 ? (
            <EmptyState variant="inline"
              framed
              title="No runbook matches that"
              purpose="Try a subsystem id instead — a readiness banner names the subsystem, not the runbook. Every runbook is listed in the sidebar."
            />
          ) : (
            grouped.map((g) => (
              <section key={g.category} style={{ marginBottom: 28 }}>
                <h2 className="rb-group-title" style={{ padding: 0 }}>
                  {g.category}
                </h2>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(300px, 1fr))",
                    gap: 12,
                  }}
 >
                  {g.entries.map((r) => (
                    <Link
                      key={r.slug}
                      href={`/admin/platform/runbooks/${r.slug}`}
                      style={{ textDecoration: "none", color: "inherit" }}
                      data-runbook-link={r.slug}
 >
                      <Card variant="summary" padding="comfortable">
                        <div style={{ fontWeight: 650, fontSize: 14.5 }}>
                          {r.title}
                        </div>
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 13,
                            lineHeight: 1.5,
                            color: "var(--ink-secondary)",
                          }}
 >
                          {r.summary}
                        </div>
                        <div
                          style={{
                            marginTop: 10,
                            display: "flex",
                            gap: 6,
                            flexWrap: "wrap",
                            alignItems: "center",
                          }}
 >
                          {r.subsystems.map((s) => (
                            <Badge key={s} tone="neutral" subtle>
                              {s}
                            </Badge>
                          ))}
                          <code
                            className="rb-code-inline"
                            style={{ marginInlineStart: "auto" }}
 >
                            {r.slug}
                          </code>
                        </div>
                      </Card>
                    </Link>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </PageShell>
  );
}

export default function OpsRunbooksPage() {
  return (
    <PageRouteGate routeId="platform.runbooks">
      <RunbookCatalog />
    </PageRouteGate>
  );
}
