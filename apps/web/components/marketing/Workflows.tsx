import Link from "next/link";
import {
  Search,
  Scale,
  Briefcase,
  Landmark,
  ArrowRight,
} from "lucide-react";
import { MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";

const WORKFLOWS = [
  {
    title: "Insurance Claim Investigation",
    body: "Collect, verify, and report evidence to accelerate claim resolution and reduce disputes.",
    Icon: Search,
    accent: "#F97316",
    href: MARKETING_LINKS.industries.insurance,
  },
  {
    title: "Legal Matter Review",
    body: "Organize and present court-review-ready evidence with complete audit trails.",
    Icon: Scale,
    accent: "#2563EB",
    href: MARKETING_LINKS.industries.legal,
  },
  {
    title: "Corporate Incident Response",
    body: "Secure and verify digital evidence to protect your organization and accelerate review.",
    Icon: Briefcase,
    accent: "#7C3AED",
    href: MARKETING_LINKS.industries.investigations,
  },
  {
    title: "Government Evidence Collection",
    body: "Standardize evidence collection with transparency, accountability, and integrity.",
    Icon: Landmark,
    accent: "#06B6D4",
    href: MARKETING_LINKS.industries.government,
  },
];

export function Workflows() {
  return (
    <section
      className="relative bg-white"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-[1480px] px-5 md:px-7 py-20 lg:px-10 2xl:px-12 lg:py-30">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <SectionBadge>Purpose-built workflows</SectionBadge>
            <h2 className="mt-3 text-[30px] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#0F172A] md:text-[36px] lg:text-[42px]">
              Designed for how you work.
            </h2>
          </div>
          <Link
            href="/about"
            className="inline-flex items-center gap-1.5 self-start rounded-full border border-[#E5E7EB] bg-white px-4 py-2 text-[13.5px] font-semibold text-[#0F172A] transition-all hover:border-[#CBD5E1] md:self-auto"
          >
            View all workflows
            <ArrowRight size={14} />
          </Link>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {WORKFLOWS.map(({ title, body, Icon, accent, href }) => (
            <Link
              key={title}
              href={href}
              className="group flex flex-col gap-4 rounded-[20px] border border-[#E5E7EB] bg-white p-6 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-1 hover:border-[#CBD5E1] hover:shadow-[0_18px_40px_rgba(15,23,42,0.08)]"
            >
              <span
                className="flex h-12 w-12 items-center justify-center rounded-full"
                style={{
                  background: accent,
                  boxShadow: `0 12px 24px ${accent}38`,
                }}
              >
                <Icon size={22} strokeWidth={2.4} className="text-white" />
              </span>
              <div className="flex flex-col gap-1.5">
                <h3 className="text-[15.5px] font-bold leading-[1.25] tracking-tight text-[#0F172A]">
                  {title}
                </h3>
                <p className="text-[13px] leading-[1.55] text-[#475569]">{body}</p>
              </div>
              <span
                className="mt-auto inline-flex items-center gap-1 text-[12.5px] font-semibold text-[#0B1F5E] transition-all group-hover:gap-2"
                aria-hidden="true"
              >
                Explore workflow
                <ArrowRight size={13} />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
