"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  ChevronDown,
  Menu,
  X,
  LayoutDashboard,
  Camera,
  FileBadge,
  ShieldCheck,
  FileText,
  Package,
  Briefcase,
  Users,
  Scale,
  Building2,
  Search,
  Landmark,
  BookOpen,
  Newspaper,
  Cpu,
  FingerprintPattern,
  KeyRound,
  Clock,
  Anchor,
  Link2,
  Compass,
  Lock,
  Sparkles,
  HelpCircle,
  LifeBuoy,
  BookText,
  Building,
} from "lucide-react";
import { MARKETING_ASSETS, MARKETING_COPY, MARKETING_LINKS } from "./tokens";

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
  {
    label: "Platform",
    cols: 2,
    items: [
      {
        label: "Overview",
        href: MARKETING_LINKS.platform.overview,
        description: "End-to-end evidence operations platform",
        Icon: LayoutDashboard,
        iconColor: "#2563EB",
      },
      {
        label: "Capture",
        href: MARKETING_LINKS.platform.capture,
        description: "Collect evidence from files, devices, and intake links",
        Icon: Camera,
        iconColor: "#F97316",
      },
      {
        label: "Evidence Records",
        href: MARKETING_LINKS.platform.evidenceRecords,
        description: "Structured records with hashes, metadata, and custody events",
        Icon: FileBadge,
        iconColor: "#7C3AED",
      },
      {
        label: "Verification",
        href: MARKETING_LINKS.platform.verification,
        description: "Verify URLs, hashes, and evidence packages",
        Icon: ShieldCheck,
        iconColor: "#06B6D4",
      },
      {
        label: "Reports",
        href: MARKETING_LINKS.platform.reports,
        description: "Court-review-ready reports with audit trail",
        Icon: FileText,
        iconColor: "#EC4899",
      },
      {
        label: "Verification Packages",
        href: MARKETING_LINKS.platform.verificationPackages,
        description: "Portable signed bundles for independent review",
        Icon: Package,
        iconColor: "#2563EB",
      },
      {
        label: "Cases & Matters",
        href: MARKETING_LINKS.platform.cases,
        description: "Organize evidence into claims, incidents, investigations",
        Icon: Briefcase,
        iconColor: "#7C3AED",
      },
      {
        label: "Teams & Workspaces",
        href: MARKETING_LINKS.platform.teams,
        description: "Roles, collaboration, and workspace access control",
        Icon: Users,
        iconColor: "#F97316",
      },
    ],
  },
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
  {
    label: "Technology",
    cols: 2,
    items: [
      {
        label: "Technology Overview",
        href: MARKETING_LINKS.technology.overview,
        description: "How PROOVRA creates verifiable evidence records",
        Icon: Cpu,
        iconColor: "#2563EB",
      },
      {
        label: "Cryptographic Hashing",
        href: MARKETING_LINKS.technology.cryptographicHashing,
        description: "SHA-256 fingerprints for evidence integrity",
        Icon: FingerprintPattern,
        iconColor: "#F97316",
      },
      {
        label: "Digital Signatures",
        href: MARKETING_LINKS.technology.digitalSignatures,
        description: "Signed records, reports, and packages",
        Icon: KeyRound,
        iconColor: "#7C3AED",
      },
      {
        label: "Trusted Timestamping",
        href: MARKETING_LINKS.technology.trustedTimestamps,
        description: "RFC 3161 timestamp signals where available",
        Icon: Clock,
        iconColor: "#06B6D4",
      },
      {
        label: "OpenTimestamps",
        href: MARKETING_LINKS.technology.openTimestamps,
        description: "Bitcoin anchoring through OTS where available",
        Icon: Anchor,
        iconColor: "#EC4899",
      },
      {
        label: "Chain of Custody",
        href: MARKETING_LINKS.technology.chainOfCustody,
        description: "Linked event history for the evidence lifecycle",
        Icon: Link2,
        iconColor: "#2563EB",
      },
      {
        label: "Verification Methodology",
        href: MARKETING_LINKS.technology.verificationMethodology,
        description: "What PROOVRA checks and what it does not claim",
        Icon: Compass,
        iconColor: "#7C3AED",
      },
      {
        label: "Security Architecture",
        href: MARKETING_LINKS.security,
        description: "Identity, access controls, audit logging, and data protection",
        Icon: Lock,
        iconColor: "#06B6D4",
      },
    ],
  },
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
      className="absolute top-0 left-0 right-0 z-50 w-full"
      style={{
        fontFamily: "var(--font-jakarta), Inter, system-ui, sans-serif",
        background: "transparent",
      }}
    >
      <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-4 px-5 md:px-7 py-2.5 lg:gap-6 lg:px-10 2xl:px-12 lg:py-3">
        <Link
          href="/"
          className="flex shrink-0 items-center"
          aria-label={MARKETING_COPY.brandName}
          onClick={() => setOpenDropdown(null)}
        >
          <img
            src={MARKETING_ASSETS.brand.logoHeader}
            alt={`${MARKETING_COPY.brandName} — ${MARKETING_COPY.brandTagline}`}
            className="w-[180px] h-auto object-contain md:w-[210px] lg:w-[230px]"
            style={{ objectFit: "contain" }}
          />
        </Link>

        <nav className="hidden items-center gap-0.5 xl:flex" aria-label="Primary">
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
                  className={`flex items-center gap-1 whitespace-nowrap rounded-full px-3.5 py-2 text-[14.5px] font-medium transition-colors ${
                    openDropdown === group.label
                      ? "text-[#0B1F5E]"
                      : "text-[#0F172A]"
                  }`}
                  style={
                    openDropdown === group.label
                      ? { background: "rgba(37,99,235,0.08)" }
                      : undefined
                  }
                  onMouseEnter={(e) => {
                    if (openDropdown !== group.label) {
                      e.currentTarget.style.background = "rgba(37,99,235,0.06)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (openDropdown !== group.label) {
                      e.currentTarget.style.background = "";
                    }
                  }}
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
                className="whitespace-nowrap rounded-full px-3.5 py-2 text-[14.5px] font-medium text-[#0F172A] transition-colors"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(37,99,235,0.06)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "";
                }}
              >
                {group.label}
              </Link>
            )
          )}
        </nav>

        <div className="hidden shrink-0 items-center gap-2 xl:flex">
          <Link
            href={MARKETING_LINKS.signIn}
            className="whitespace-nowrap rounded-full px-3.5 py-2 text-[14.5px] font-medium text-[#0F172A] transition-colors"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(37,99,235,0.06)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "";
            }}
          >
            Sign in
          </Link>
          <Link
            href={MARKETING_LINKS.requestDemo}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-[#0B1F5E] px-4 py-2.5 text-[14px] font-semibold text-white shadow-[0_6px_18px_rgba(11,31,94,0.22)] transition-all hover:bg-[#0a1c54] hover:shadow-[0_10px_24px_rgba(11,31,94,0.30)]"
          >
            Request a demo
            <ArrowRight size={14} />
          </Link>
        </div>

        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#E5E7EB] bg-white text-[#0F172A] xl:hidden"
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
                src={MARKETING_ASSETS.brand.logoHeader}
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
