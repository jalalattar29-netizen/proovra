/**
 * Internal legal document reader (2026-07-19 routing correction).
 *
 * The AUTHENTICATED route for viewing canonical legal documents WITHOUT
 * leaving the PROOVRA App Shell. Fixes the defect where Settings/Trust
 * legal links escaped to the PUBLIC routes (MarketingHeader + footer, no
 * sidebar — the user appeared signed out).
 *
 * Architecture (SAME DESIGN, not SAME PUBLIC ROUTE):
 *
 *   CanonicalLegalContent  (app/legal/legal-content — markdown loader,
 *   + legal-hero-meta       renderer, titles, hero metadata; ONE source)
 *        ├── PUBLIC  /legal/[slug]        → LegalHero + MarketingHeader/footer
 *        └── INTERNAL /settings/legal/[slug] → LegalDocumentShell inside
 *                                             the (app) layout: sidebar +
 *                                             app header stay mounted; no
 *                                             public chrome; workspace and
 *                                             session context preserved.
 *
 * The content is READ from the shared loader — never copied. Both shells
 * always resolve the identical document version.
 *
 * This is a SERVER component (the markdown loader reads from disk); the
 * client-side `PageRouteGate` + shell receive the rendered article as
 * children, so authorization behavior matches every other (app) route.
 */

import { notFound } from "next/navigation";

import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { LegalDocumentShell } from "../../../../../components/legal/LegalDocumentShell";
import {
  ALLOWED_LEGAL_SLUGS,
  internalLegalDocumentHref,
  loadLegalMarkdown,
  renderLegalMarkdown,
  titleFromSlug,
} from "../../../../legal/legal-content";
import { legalHeroFor } from "../../../../legal/legal-hero-meta";

// The slug universe is closed (ALLOWED_LEGAL_SLUGS): prerender every
// document and reject unknown params at the router level, so unknown
// slugs get a REAL HTTP 404 instead of a streamed 200 + not-found body.
export const dynamicParams = false;

export function generateStaticParams() {
  return Array.from(ALLOWED_LEGAL_SLUGS, (slug) => ({ slug }));
}

/**
 * Default related-documents navigation (labels/descriptions are
 * navigation copy, not legal text). The current document is filtered
 * out; the shell caps the panel at 4 entries.
 */
const CORE_RELATED = [
  { slug: "privacy", label: "Privacy Policy", description: "How we collect, use, and protect personal data." },
  { slug: "cookies", label: "Cookie Policy", description: "How cookies and similar technologies are used." },
  { slug: "dpa", label: "Data Processing Agreement", description: "Our obligations under GDPR and data protection laws." },
  { slug: "subprocessors", label: "Subprocessors", description: "Third-party service providers we use." },
  { slug: "terms", label: "Terms of Service", description: "The terms that govern access to and use of the platform." },
] as const;

export default async function InternalLegalDocumentPage({
  params,
}: {
  params?: Promise<{ slug: string }>;
}) {
  const resolvedParams = (await params) ?? { slug: "" };
  const slug = resolvedParams.slug;

  if (!ALLOWED_LEGAL_SLUGS.has(slug)) return notFound();

  let content = "";
  try {
    content = await loadLegalMarkdown(slug);
  } catch {
    throw new Error("Missing legal content");
  }

  const title = titleFromSlug(slug);
  const hero = legalHeroFor(slug, title);

  return (
    <div data-testid="internal-legal-document-page" data-internal-legal-slug={slug}>
      <PageRouteGate routeId="account.legal_document">
        <LegalDocumentShell
          label={hero.label}
          title={hero.title}
          highlight={hero.highlight}
          summary={hero.summary}
          meta={hero.meta}
          scope="ACCOUNT"
          backHref="/settings#privacy"
          backLabel="Back to Privacy & legal records"
          relatedLinks={CORE_RELATED.filter((r) => r.slug !== slug).map((r) => ({
            label: r.label,
            href: `/settings/legal/${r.slug}`,
            description: r.description,
          }))}
        >
          {/* Document cross-references stay in-app (mapHref) and
              structured legal content renders as Information Panels,
              contact rows, and chip rows (enhance) — the markdown
              source is untouched; public pages render verbatim.
              externalizePublicExits: body links to the PUBLIC Trust
              Center (/trust) open in a NEW tab so the App Shell stays
              open in the current tab (2026-07-21). */}
          {renderLegalMarkdown(content, {
            mapHref: internalLegalDocumentHref,
            enhance: true,
            externalizePublicExits: true,
          })}
        </LegalDocumentShell>
      </PageRouteGate>
    </div>
  );
}
