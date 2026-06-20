"use client";
import Link from "next/link";
// Workflows icon set — lucide-react only. Phosphor-named aliases keep
// the existing JSX (<MagnifyingGlass/>, <Scales/>, <Bank/>) intact.
import {
  ArrowRight,
  Search as MagnifyingGlass,
  Scale as Scales,
  Briefcase,
  Landmark as Bank,
} from "lucide-react";
import { MARKETING_LINKS } from "./tokens";
import { SectionBadge } from "./SectionBadge";

const WORKFLOWS = [
  {
    title: "Insurance Claim Investigation",
    body: "Collect, verify, and report evidence to accelerate claim resolution and reduce disputes.",
    Icon: MagnifyingGlass,
    href: MARKETING_LINKS.industries.insurance,
  },
  {
    title: "Legal Matter Review",
    body: "Organize and present court-review-ready evidence with complete audit trails.",
    Icon: Scales,
    href: MARKETING_LINKS.industries.legal,
  },
  {
    title: "Corporate Incident Response",
    body: "Secure and verify digital evidence to protect your organization and accelerate review.",
    Icon: Briefcase,
    href: MARKETING_LINKS.industries.investigations,
  },
  {
    title: "Government Evidence Collection",
    body: "Standardize evidence collection with transparency, accountability, and integrity.",
    Icon: Bank,
    href: MARKETING_LINKS.industries.government,
  },
];

function GradientIcon({ Icon }: { Icon: typeof MagnifyingGlass }) {
  return (
    <span
      className="inline-flex h-12 w-12 items-center justify-center rounded-2xl p-[2.5px] shadow-[0_8px_18px_rgba(15,23,42,0.05)]"
      style={{
        background:
          "linear-gradient(135deg,#2D2A7B 0%,#8A2F9B 48%,#E91E7A 100%)",
      }}
    >
      <span className="flex h-full w-full items-center justify-center rounded-[15px] bg-[var(--proovra-surface)]">
<Icon size={25} strokeWidth={2.4} color="#8A2F9B" />
      </span>
    </span>
  );
}

export function Workflows() {
  return (
    <section
      className="relative bg-[var(--proovra-page-bg)]"
      style={{ fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif" }}
    >
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="workflowIconGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#2D2A7B" />
            <stop offset="48%" stopColor="#8A2F9B" />
            <stop offset="100%" stopColor="#E91E7A" />
          </linearGradient>
        </defs>
      </svg>

      <div className="mx-auto max-w-[1480px] px-5 py-20 md:px-7 lg:px-10 lg:py-30 2xl:px-12">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <SectionBadge>Purpose-built workflows</SectionBadge>
            <h2 className="mt-3 text-[30px] font-extrabold leading-[1.1] tracking-[-0.02em] text-[#0F172A] md:text-[36px] lg:text-[42px]">
              Designed for how you work.
            </h2>
          </div>

          <Link
            href="/about"
            className="inline-flex items-center gap-1.5 self-start rounded-full border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] px-4 py-2 text-[13.5px] font-semibold text-[#0F172A] transition-all hover:border-[var(--proovra-border-warm-hover)] md:self-auto"
          >
            View all workflows
            <ArrowRight size={14} />
          </Link>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {WORKFLOWS.map(({ title, body, Icon, href }) => (
            <Link
              key={title}
              href={href}
              className="group flex flex-col gap-4 rounded-[20px] border border-[var(--proovra-border-warm)] bg-[var(--proovra-surface)] p-6 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-1 hover:border-[var(--proovra-border-warm-hover)] hover:shadow-[0_18px_40px_rgba(15,23,42,0.08)]"
            >
              <GradientIcon Icon={Icon} />

              <div className="flex flex-col gap-1.5">
                <h3 className="text-[15.5px] font-bold leading-[1.25] tracking-tight text-[#0F172A]">
                  {title}
                </h3>
                <p className="text-[13px] leading-[1.55] text-[#475569]">
                  {body}
                </p>
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