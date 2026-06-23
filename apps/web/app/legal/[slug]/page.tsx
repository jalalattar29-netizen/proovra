import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { EnterpriseFooter } from "../../../components/marketing/EnterpriseFooter";
import { LegalHero } from "../../../components/legal/LegalHero";
import {
  ALLOWED_LEGAL_SLUGS,
  loadLegalMarkdown,
  renderLegalMarkdown,
  titleFromSlug,
} from "../legal-content";
import { legalHeroFor } from "../legal-hero-meta";

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
    <div className="page legal-center-page" style={{ background: "#F6F9FC" }}>
      <LegalHero
        label={hero.label}
        title={hero.title}
        summary={hero.summary}
        meta={hero.meta}
        highlight={hero.highlight}
      />

      {/* Content card on silver background */}
      <section className="mx-auto max-w-5xl px-6 py-12 md:px-8 md:py-16">
        <article
          className="
            legal-page relative overflow-hidden rounded-[24px] border bg-white
            shadow-[0_18px_42px_rgba(8,18,22,0.04)]
            px-6 py-8 md:px-10 md:py-12 lg:px-14 lg:py-14
            text-[#0F172A]
            [&_h1]:hidden
            [&_h2]:mb-4 [&_h2]:mt-10 [&_h2]:text-[1.42rem] [&_h2]:font-semibold [&_h2]:leading-[1.18] [&_h2]:tracking-[-0.02em] [&_h2]:text-[#081426]
            [&_h3]:mb-3 [&_h3]:mt-8 [&_h3]:text-[0.95rem] [&_h3]:font-bold [&_h3]:uppercase [&_h3]:tracking-[0.14em] [&_h3]:text-[#475569]
            [&_p]:my-0 [&_p]:mb-4 [&_p]:text-[0.98rem] [&_p]:leading-[1.88] [&_p]:text-[#475569]
            [&_strong]:font-semibold [&_strong]:text-[#081426]
            [&_em]:text-[#0F172A]
            [&_a.legal-link]:font-medium [&_a.legal-link]:text-[#2563EB] [&_a.legal-link]:underline [&_a.legal-link]:underline-offset-4 hover:[&_a.legal-link]:text-[#1E40AF]
            [&_ul]:my-4 [&_ul]:ml-0 [&_ul]:grid [&_ul]:gap-2.5 [&_ul]:pl-0
            [&_ol]:my-4 [&_ol]:ml-0 [&_ol]:grid [&_ol]:gap-2.5 [&_ol]:pl-0
            [&_li]:relative [&_li]:list-none [&_li]:pl-6 [&_li]:text-[0.98rem] [&_li]:leading-[1.78] [&_li]:text-[#475569]
            [&_ul>li::before]:absolute [&_ul>li::before]:left-0 [&_ul>li::before]:top-[0.75rem] [&_ul>li::before]:h-1.5 [&_ul>li::before]:w-1.5 [&_ul>li::before]:rounded-full [&_ul>li::before]:bg-[#2563EB] [&_ul>li::before]:content-['']
            [&_ol]:counter-reset-[legal-counter]
            [&_ol>li]:pl-10
            [&_ol>li::before]:absolute [&_ol>li::before]:left-0 [&_ol>li::before]:top-[0.15rem] [&_ol>li::before]:flex [&_ol>li::before]:h-7 [&_ol>li::before]:w-7 [&_ol>li::before]:items-center [&_ol>li::before]:justify-center [&_ol>li::before]:rounded-full [&_ol>li::before]:border [&_ol>li::before]:border-[#DDE6F2] [&_ol>li::before]:bg-[#F1F5F9] [&_ol>li::before]:text-[0.78rem] [&_ol>li::before]:font-semibold [&_ol>li::before]:text-[#0B1F4D] [&_ol>li::before]:content-[counter(legal-counter)]
            [&_ol>li]:counter-increment-[legal-counter]
            [&_hr]:my-8 [&_hr]:border-0 [&_hr]:h-px [&_hr]:bg-[linear-gradient(90deg,transparent_0%,#DDE6F2_30%,#DDE6F2_70%,transparent_100%)]
          "
          data-legal-content
        >
          {renderLegalMarkdown(content)}
        </article>

        {/* Back to Trust Center */}
        <div className="mt-8 flex justify-center">
          <Link
            href="/trust"
            className="inline-flex items-center gap-2 rounded-full border border-[#DDE6F2] bg-white px-5 py-2.5 text-[13px] font-semibold text-[#0B1F4D] shadow-[0_2px_8px_rgba(8,18,22,0.04)] transition hover:bg-[#F1F5F9]"
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
