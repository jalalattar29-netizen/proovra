/**
 * ONE RUNBOOK, RENDERED.
 *
 * ===========================================================================
 * THE PAGE THE CATALOG POINTED AT AND DID NOT HAVE
 * ===========================================================================
 * Three surfaces already linked a runbook by slug:
 *
 *   - `CommandCenter` and `GovernanceControlPlane` built
 *     `/admin/platform/runbooks#<slug>` — a fragment link to an anchor the
 *     catalog never rendered, so both landed at the top of a list of thirty;
 *   - the catalog itself printed each slug beside its title and explained that
 *     "the full markdown text lives in the repository", which is a table of
 *     contents for a book the reader does not have.
 *
 * An operator following a `runbookSlug` off an incident got confirmation that
 * a procedure exists. This is the procedure.
 *
 * ===========================================================================
 * THE TEXT IS THE REPOSITORY'S, NOT A COPY OF IT
 * ===========================================================================
 * `docs/runbooks/*.md` stays the single authority. `catalog.generated.ts` is
 * built from it by `apps/web/scripts/generate-runbook-catalog.mjs`, and
 * `apps/web/__tests__/runbook-catalog-freshness.test.ts` fails the moment the
 * two diverge — so this page cannot show a stale procedure while the
 * repository shows a corrected one. Generating rather than reading at request
 * time keeps a `standalone` build from depending on a path outside
 * `apps/web`.
 *
 * `dynamicParams = false` means an unknown slug is a real HTTP 404 rather than
 * a 200 that streams a "not found" body — a dynamic page under the (app)
 * layout would otherwise have already sent its status line.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
} from "../../../../../../components/ui/PageShell";
import { Badge } from "../../../../../../components/ui/Badge";
import {
  RUNBOOKS,
  runbookBySlug,
} from "../../../../../../lib/runbooks/catalog.generated";
import { renderRunbookMarkdown } from "../../../../../../lib/runbooks/render";
import { RunbookLayout } from "../_RunbookLayout";
import "../runbooks.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return RUNBOOKS.map((r) => ({ slug: r.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const rb = runbookBySlug(slug);
  return { title: rb ? `${rb.title} — Runbook` : "Runbook" };
}

export default async function RunbookDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const rb = runbookBySlug(slug);
  if (!rb) notFound();

  return (
    <PageRouteGate routeId="platform.runbooks">
      <PageShell
        width="full"
        header={
          <PageHeader
            eyebrow="Operator runbook"
            title={rb.title}
            subtitle={rb.summary}
            secondaryActions={
              <Link
                href="/admin/platform/runbooks"
                style={{ textDecoration: "none" }}
              >
                ← All runbooks
              </Link>
            }
          />
        }
      >
        <RunbookLayout activeSlug={rb.slug}>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              marginBottom: 20,
            }}
          >
            <Badge tone="info" subtle>
              {rb.category}
            </Badge>
            {rb.subsystems.map((s) => (
              <Badge key={s} tone="neutral" subtle>
                {s}
              </Badge>
            ))}
            {/* The slug is the identifier an incident carries. Showing it
                lets an operator confirm they opened the runbook the incident
                named, not one with a similar title. */}
            <code
              className="rb-code-inline"
              data-runbook-slug={rb.slug}
              style={{ marginInlineStart: "auto" }}
            >
              {rb.slug}
            </code>
          </div>

          <article className="rb-doc" data-runbook={rb.slug}>
            {renderRunbookMarkdown(rb.body)}
          </article>

          <p
            style={{
              marginTop: 28,
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--ink-muted, #94a3b8)",
            }}
          >
            Source: <code className="rb-code-inline">docs/runbooks/{rb.slug}.md</code>{" "}
            · content sha256 <code className="rb-code-inline">{rb.sha256.slice(0, 16)}…</code>
            {/* The hash is here so an operator comparing this page against a
                repository checkout can tell whether they are the same text,
                rather than assuming. */}
          </p>
        </RunbookLayout>
      </PageShell>
    </PageRouteGate>
  );
}
