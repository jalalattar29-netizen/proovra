import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { EnterpriseFooter } from "../../../components/marketing/EnterpriseFooter";
import PublicPageView from "../../../components/analytics/PublicPageView";
import { LegalHero } from "../../../components/legal/LegalHero";
import { MARKETING_BTN } from "../../../lib/marketing-buttons";
import {
  ALLOWED_LEGAL_SLUGS,
  loadLegalMarkdown,
  renderLegalMarkdown,
  titleFromSlug,
} from "../legal-content";
import { legalHeroFor } from "../legal-hero-meta";
// 2026-07-18 redesign — ONE canonical typography source shared with the
// authenticated LegalDocumentShell (zero drift between public and
// internal documents).
import {
  LEGAL_ARTICLE_CLASSES,
  LEGAL_PAGE_BG,
} from "../../../components/legal/legalArticleStyles";

export default async function LegalPage({
  params,
}: {
  params?: Promise<{ slug: string }>;
}) {
  const resolvedParams = (await params) ?? { slug: "" };
  const slug = resolvedParams.slug;

  if (!ALLOWED_LEGAL_SLUGS.has(slug)) return notFound();

  await headers();

  let content = "";
  try {
    content = await loadLegalMarkdown(slug);
  } catch {
    throw new Error("Missing legal content");
  }

  const title = titleFromSlug(slug);
  const hero = legalHeroFor(slug, title);

  return (
    <div className="page legal-center-page" style={{ background: LEGAL_PAGE_BG }}>
      {/* Legal pages don't use MarketingHeader, so mount the public
          page-view beacon directly (consent-gated inside trackEvent). */}
      <PublicPageView />
      <LegalHero
        label={hero.label}
        title={hero.title}
        summary={hero.summary}
        meta={hero.meta}
        highlight={hero.highlight}
      />

      {/* Content card on silver background. The article keeps its exact
          reading width and card chrome; wide tables are handled entirely
          inside their own isolated scroll container (.legal-table-wrapper
          — overflow-x within the card), so a large table NEVER widens the
          article, stretches text, or breaks the reading flow. The
          wide-table breakout is intentionally NOT enabled here (no
          `data-legal-doc`); it applies only to the authenticated shell. */}
      <section className="mx-auto max-w-5xl px-6 py-12 md:px-8 md:py-16">
        <article className={LEGAL_ARTICLE_CLASSES} data-legal-content>
          {renderLegalMarkdown(content)}
        </article>

        {/* Back to Trust Center */}
        <div className="mt-8 flex justify-center">
          <Link
            href="/trust"
            className={MARKETING_BTN.heroSecondary}
            data-legal-back-to-trust
          >
            <span aria-hidden="true">←</span>
            <span>Back to Trust Center</span>
          </Link>
        </div>
      </section>

      <EnterpriseFooter />
    </div>
  );
}
