import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { MARKETING_ASSETS, MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";

const INDUSTRIES = [
  {
    title: "Insurance",
    body: "Accelerate claims investigation with verifiable evidence.",
    image: MARKETING_ASSETS.industries.insurance,
    href: MARKETING_LINKS.industries.insurance,
  },
  {
    title: "Legal & eDiscovery",
    body: "Strengthen your case with court-review-ready digital evidence.",
    image: MARKETING_ASSETS.industries.legal,
    href: MARKETING_LINKS.industries.legal,
  },
  {
    title: "Government",
    body: "Maintain trust and transparency in every official process.",
    image: MARKETING_ASSETS.industries.government,
    href: MARKETING_LINKS.industries.government,
  },
  {
    title: "Corporate Investigations",
    body: "Investigate incidents and protect your organization with confidence.",
    image: MARKETING_ASSETS.industries.investigations,
    href: MARKETING_LINKS.industries.investigations,
  },
  {
    title: "Compliance & Audit",
    body: "Document regulated processes with tamper-evident records.",
    image: MARKETING_ASSETS.industries.compliance,
    href: MARKETING_LINKS.industries.compliance,
  },
  {
    title: "Journalism",
    body: "Verify sources and protect the integrity of your story.",
    image: MARKETING_ASSETS.industries.journalism,
    href: MARKETING_LINKS.industries.journalism,
  },
];

export function IndustriesGrid() {
  return (
<section className="relative bg-[var(--proovra-page-bg)]">
  <div
  aria-hidden="true"
className="pointer-events-none absolute inset-x-0 bottom-0 h-[500px] opacity-100"
  style={{ zIndex: 0 }}
>
</div>
<div className="mx-auto max-w-[1480px] px-5 md:px-7 py-20 lg:px-10 2xl:px-12 lg:py-30">
                <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <SectionBadge>Solutions for every industry</SectionBadge>
            <h2 className="mt-3 text-[30px] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#0F172A] md:text-[36px] lg:text-[44px]">
              Empowering mission-critical industries.
            </h2>
          </div>
          <Link
            href="/about"
            className="inline-flex items-center gap-1.5 self-start rounded-full border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] px-4 py-2 text-[13.5px] font-semibold text-[#0F172A] transition-all hover:border-[var(--proovra-border-warm-hover)] md:self-auto"
          >
            View all industries
            <ArrowRight size={14} />
          </Link>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {INDUSTRIES.map(({ title, body, image, href }) => (
            <Link
              key={title}
              href={href}
              className="group flex flex-col overflow-hidden rounded-[20px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-1 hover:border-[var(--proovra-border-warm-hover)] hover:shadow-[0_18px_40px_rgba(15,23,42,0.10)]"
            >
              <div className="relative h-40 w-full overflow-hidden bg-[#0F172A] lg:h-36 xl:h-32">
                <img
                  src={image}
                  alt={title}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(180deg, rgba(15,23,42,0) 40%, rgba(15,23,42,0.55) 100%)",
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5 p-4">
                <h3 className="text-[15px] font-bold leading-[1.25] tracking-tight text-[#0F172A]">
                  {title}
                </h3>
                <p className="text-[12.5px] leading-[1.5] text-[#475569]">
                  {body}
                </p>
                <span
                  className="mt-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#F1F5F9] text-[#0B1F5E] transition-all group-hover:bg-[#0B1F5E] group-hover:text-white"
                  aria-hidden="true"
                >
                  <ArrowRight size={13} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
