"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  ChevronDown,
  Menu,
  X,
  ShieldCheck,
  FileText,
  Scale,
  Building2,
  Search,
  Landmark,
  BookOpen,
  Newspaper,
  Compass,
  Sparkles,
  HelpCircle,
  LifeBuoy,
  BookText,
  Building,
} from "lucide-react";
import { MARKETING_COPY, MARKETING_LINKS } from "./tokens";
import { MARKETING_BTN } from "../../lib/marketing-buttons";

type DropdownItem = {
  label: string;
  href: string;
  description: string;
  Icon?: LucideIcon;
  iconColor?: string;
};

type NavGroup = {
  label: string;
  href?: string;
  items?: DropdownItem[];
  cols?: 1 | 2;
};

const NAV: NavGroup[] = [
  // Platform is a single direct link to the unified /platform page.
  // The old mega-menu sub-items (Overview, Capture, Evidence Records,
  // Verification, Reports, Verification Packages, Cases & Matters,
  // Teams & Workspaces) were consolidated into anchors on /platform
  // and are no longer surfaced in navigation. Old `/platform/<sub>`
  // URLs are redirected to /platform in next.config.js.
  { label: "Platform", href: MARKETING_LINKS.platform.overview },
  {
    label: "Solutions",
    cols: 2,
    items: [
      {
        label: "Legal & eDiscovery",
        href: MARKETING_LINKS.solutions.legal,
        description: "Matter review, custody, and verification packages",
        Icon: Scale,
        iconColor: "#2563EB",
      },
      {
        label: "Insurance",
        href: MARKETING_LINKS.solutions.insurance,
        description: "Claims evidence, photo/video, faster review",
        Icon: Building2,
        iconColor: "#F97316",
      },
      {
        label: "Corporate Investigations",
        href: MARKETING_LINKS.solutions.corporateInvestigations,
        description: "Internal incidents, audit trails, defensible workflows",
        Icon: Search,
        iconColor: "#7C3AED",
      },
      {
        label: "Government",
        href: MARKETING_LINKS.solutions.government,
        description: "Transparent public-sector evidence collection",
        Icon: Landmark,
        iconColor: "#06B6D4",
      },
      {
        label: "Compliance & Audit",
        href: MARKETING_LINKS.solutions.compliance,
        description: "Audit-ready records, retention, and verification",
        Icon: BookOpen,
        iconColor: "#EC4899",
      },
      {
        label: "Journalism",
        href: MARKETING_LINKS.solutions.journalism,
        description: "Source protection and media verification",
        Icon: Newspaper,
        iconColor: "#2563EB",
      },
    ],
  },
  // Technology consolidated into a single in-depth architecture page.
  // The mega-menu sub-items (Hashing, Signatures, Timestamps, OTS,
  // Custody) were collapsed into anchored sections on /technology and
  // are no longer surfaced as separate nav entries. Old /technology/<sub>
  // URLs redirect via next.config.js.
  { label: "Technology", href: MARKETING_LINKS.technology.overview },
  {
    label: "Resources",
    cols: 1,
    items: [
      {
        label: "Trust Center",
        href: MARKETING_LINKS.trustCenter,
        description: "Security, privacy, methodology, and trust resources",
        Icon: ShieldCheck,
        iconColor: "#2563EB",
      },
      {
        label: "Verification Demo",
        href: MARKETING_LINKS.verifyDemo,
        description: "Try a public sample verification",
        Icon: Sparkles,
        iconColor: "#06B6D4",
      },
      {
        label: "Sample Report",
        href: MARKETING_LINKS.sampleReport,
        description: "See an example evidence report",
        Icon: FileText,
        iconColor: "#F97316",
      },
      {
        label: "Why PROOVRA",
        href: MARKETING_LINKS.whyProovra,
        description: "Why teams move from ordinary files to evidence records",
        Icon: Compass,
        iconColor: "#EC4899",
      },
      {
        label: "FAQ",
        href: MARKETING_LINKS.faq,
        description: "Common buyer and product questions",
        Icon: HelpCircle,
        iconColor: "#2563EB",
      },
      {
        label: "Contact Support",
        href: MARKETING_LINKS.support,
        description: "Help and support contact",
        Icon: LifeBuoy,
        iconColor: "#06B6D4",
      },
    ],
  },
  {
    label: "Company",
    cols: 1,
    items: [
      {
        label: "About PROOVRA",
        href: MARKETING_LINKS.about,
        description: "Why PROOVRA exists and the problem it solves",
        Icon: Building,
        iconColor: "#2563EB",
      },
      {
        label: "Contact Sales",
        href: MARKETING_LINKS.contactSales,
        description: "Talk to an expert",
        Icon: BookText,
        iconColor: "#F97316",
      },
    ],
  },
  { label: "Pricing", href: MARKETING_LINKS.pricing },
  { label: "Verify", href: MARKETING_LINKS.verify },
];

const LOGO_SRC = "/assets/branding/logo-dark.png";

// Nav glass pill removed. Header items now sit DIRECTLY over the hero
// — no translucent container, no backdrop blur, no faux-frosted border.
//
// Hover affordance is a CENTER-OUT underline animation using the PROOVRA
// warm gradient (the same #FF7A1A → #E83FAE accent used in the
// Solutions hero highlight). Implementation uses a `::after`
// pseudo-element scaled along X from origin-center, so the underline
// grows symmetrically from the center of the word to both edges.
//
// Duration 250ms, ease-out — premium without being flashy. Matches the
// quality bar of Stripe / Vercel / Linear / Notion-enterprise nav.
const navTextClass = [
  "relative",
  "text-[#0F172A] hover:text-[#0F172A]",
  // pseudo-element setup — invisible by default
  "after:pointer-events-none after:absolute after:left-3 after:right-3 after:bottom-[6px]",
  "after:h-[2px] after:rounded-full",
  "after:bg-[linear-gradient(90deg,#FF7A1A_0%,#FF4D5E_50%,#E83FAE_100%)]",
  // origin center + scale-x-0 means the line is hidden but ready to grow
  // outward; scale-x-100 on hover/focus grows it from the centre to
  // both edges.
  "after:origin-center after:scale-x-0",
  "after:transition-transform after:duration-[250ms] after:ease-out",
  "hover:after:scale-x-100 focus-visible:after:scale-x-100",
].join(" ");

const navActiveStyle = {
  color: "#0F172A",
};

export function MarketingHeader() {
    const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
<header
className="absolute top-0 left-0 right-0 z-50 w-full"style={{
  fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif",
  background: "transparent",
}}
>
    <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-5 py-1.5 md:px-7 lg:gap-5 lg:px-10 2xl:px-12">
<Link
  href="/"
className="flex shrink-0 items-center"
            aria-label={MARKETING_COPY.brandName}
          onClick={() => setOpenDropdown(null)}
        >
<img
  src={LOGO_SRC}
  alt={`${MARKETING_COPY.brandName} — ${MARKETING_COPY.brandTagline}`}
className="h-auto w-[210px] object-contain drop-shadow-[0_2px_12px_rgba(15,23,42,0.10)] md:w-[235px] lg:w-[250px]"
  style={{ objectFit: "contain" }}
/>
        </Link>

<nav
  className="hidden items-center gap-0.5 xl:flex"
  aria-label="Primary"
>
            {NAV.map((group) =>
            group.items ? (
              <div
                key={group.label}
                className="relative"
                onMouseEnter={() => setOpenDropdown(group.label)}
                onMouseLeave={() => setOpenDropdown(null)}
              >
                <button
                  type="button"
                  className={`flex items-center gap-1 whitespace-nowrap rounded-full px-3.5 py-2 text-[14.5px] font-medium transition-colors ${navTextClass} ${
                    openDropdown === group.label
                      ? "after:scale-x-100"
                      : ""
                  }`}
                  style={openDropdown === group.label ? navActiveStyle : undefined}
                  aria-expanded={openDropdown === group.label}
                  aria-haspopup="menu"
                >
                  {group.label}
                  <ChevronDown
                    size={14}
                    className={`transition-transform ${
                      openDropdown === group.label ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {openDropdown === group.label && (
                  <div role="menu" className="absolute left-0 top-full pt-3">
                    <div
                      className={`rounded-[24px] border border-[#E5E7EB] bg-white p-3 shadow-[0_24px_60px_rgba(15,23,42,0.12)] ${
                        group.cols === 2 ? "w-[640px]" : "w-[340px]"
                      }`}
                    >
                      <div
                        className={`grid gap-1 ${
                          group.cols === 2 ? "grid-cols-2" : "grid-cols-1"
                        }`}
                      >
                        {group.items.map((item) => {
                          const Icon = item.Icon;
                          return (
                            <Link
                              key={item.label}
                              href={item.href}
                              role="menuitem"
                              onClick={() => setOpenDropdown(null)}
                              className="group/item flex items-start gap-3 rounded-[14px] p-3 transition-colors hover:bg-[#F8FAFC]"
                            >
                              {Icon ? (
                                <span
                                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors"
                                  style={{ background: `${item.iconColor ?? "#2563EB"}14` }}
                                >
                                  <Icon
                                    size={16}
                                    style={{ color: item.iconColor ?? "#2563EB" }}
                                  />
                                </span>
                              ) : null}
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[14px] font-semibold text-[#0F172A] group-hover/item:text-[#0B1F5E]">
                                  {item.label}
                                </span>
                                <span className="text-[12.5px] leading-[1.45] text-[#64748B]">
                                  {item.description}
                                </span>
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <Link
                key={group.label}
                href={group.href ?? "#"}
className={`whitespace-nowrap rounded-full px-3.5 py-2 text-[14.5px] font-medium transition-colors ${navTextClass}`}
              >
                {group.label}
              </Link>
            )
          )}
        </nav>

        <div className="hidden shrink-0 items-center gap-2 xl:flex">
          <Link
            href={MARKETING_LINKS.signIn}
            className={`whitespace-nowrap rounded-full px-3.5 py-2 text-[14.5px] font-medium transition-colors ${navTextClass}`}
          >
            Sign in
          </Link>
          {/* Primary dark CTA — homepage hero language. Deep navy +
              white text, soft enterprise shadow, no glow. */}
          <Link
            href={MARKETING_LINKS.requestDemo}
            className={`${MARKETING_BTN.primaryDark} shrink-0`}
          >
            Request a demo
            <ArrowRight size={14} />
          </Link>
        </div>

        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white/85 text-[#0F172A] xl:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-[100] flex flex-col bg-white xl:hidden">
          <div className="flex items-center justify-between border-b border-[#E5E7EB] px-6 py-3">
            <Link
              href="/"
              className="flex items-center"
              onClick={() => setMobileOpen(false)}
            >
              <img
src={LOGO_SRC}
                alt={`${MARKETING_COPY.brandName} — ${MARKETING_COPY.brandTagline}`}
className="w-[170px] h-auto object-contain"
                style={{ objectFit: "contain" }}
              />
            </Link>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#E5E7EB] text-[#0F172A]"
              aria-label="Close menu"
            >
              <X size={20} />
            </button>
          </div>
          <nav className="flex-1 overflow-y-auto px-4 py-4" aria-label="Mobile">
            {NAV.map((group) => (
              <details key={group.label} className="border-b border-[#EEF1F5] py-1" open={!group.items}>
                <summary
                  className={`flex cursor-pointer items-center justify-between rounded-xl px-2 py-3 text-[16px] font-semibold text-[#0F172A] ${
                    group.items ? "" : "list-none"
                  }`}
                >
                  {group.href ? (
                    <Link
                      href={group.href}
                      onClick={() => setMobileOpen(false)}
                      className="flex-1"
                    >
                      {group.label}
                    </Link>
                  ) : (
                    <span>{group.label}</span>
                  )}
                  {group.items ? (
                    <ChevronDown size={16} className="text-[#475569]" />
                  ) : null}
                </summary>
                {group.items ? (
                  <div className="flex flex-col gap-1 pb-3 pl-2">
                    {group.items.map((item) => (
                      <Link
                        key={item.label}
                        href={item.href}
                        onClick={() => setMobileOpen(false)}
                        className="rounded-xl px-3 py-2.5 text-[14.5px] text-[#475569] hover:bg-[#F8FAFC]"
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </details>
            ))}
          </nav>
          <div className="flex flex-col gap-3 border-t border-[#E5E7EB] p-6">
            <Link
              href={MARKETING_LINKS.signIn}
              onClick={() => setMobileOpen(false)}
              className="flex h-12 items-center justify-center rounded-2xl border border-[#E5E7EB] text-[15px] font-semibold text-[#0F172A]"
            >
              Sign in
            </Link>
            <Link
              href={MARKETING_LINKS.requestDemo}
              onClick={() => setMobileOpen(false)}
              className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-[#0B1F5E] text-[15px] font-semibold text-white shadow-[0_8px_24px_rgba(11,31,94,0.25)]"
            >
              Request a demo
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
