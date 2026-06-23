import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  ClipboardCheck,
  CreditCard,
  FileCheck2,
  Fingerprint,
  Gavel,
  HelpCircle,
  LifeBuoy,
  LockKeyhole,
  Network,
  Scale,
  Shield,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";

export const metadata: Metadata = {
  title: "Support · PROOVRA",
  description:
    "Support Operations Center for PROOVRA. Pick the route that matches your request — product, billing, security disclosure, legal and privacy intake, or enterprise evaluation.",
  alternates: { canonical: "/support" },
};

const HERO_BG = "/assets/hero/support-hero.png";
const SUPPORT_EMAIL = "support@proovra.com";
const BILLING_EMAIL = "billing@proovra.com";
const SECURITY_EMAIL = "security@proovra.com";

// ---------------------------------------------------------------------------
// Section 2 — Support paths
// ---------------------------------------------------------------------------

const SUPPORT_PATHS: ReadonlyArray<{
  label: string;
  title: string;
  body: string;
  href: string;
  cta: string;
  external?: boolean;
}> = [
  {
    label: "Product",
    title: "Product support",
    body: "For questions about capture, evidence records, verification pages, reports, account workflows, and general product usage.",
    href: `mailto:${SUPPORT_EMAIL}`,
    cta: `Email ${SUPPORT_EMAIL}`,
    external: true,
  },
  {
    label: "Billing",
    title: "Account and billing",
    body: "For login, subscription, payment, invoice, refund, and plan questions.",
    href: `mailto:${BILLING_EMAIL}`,
    cta: `Email ${BILLING_EMAIL}`,
    external: true,
  },
  {
    label: "Security",
    title: "Security and responsible disclosure",
    body: "For vulnerability reports, suspected compromise, security concerns, and responsible-disclosure intake.",
    href: "/legal/security",
    cta: "Open Security policy",
  },
  {
    label: "Legal & privacy",
    title: "Legal and privacy requests",
    body: "For law-enforcement, data-subject, privacy, copyright, abuse, and other legally sensitive requests.",
    href: "/trust",
    cta: "Open Trust Center",
  },
];

// ---------------------------------------------------------------------------
// Section 4 — Support scope
// ---------------------------------------------------------------------------

const SUPPORT_CAN_HELP: ReadonlyArray<string> = [
  "Product navigation and getting-started questions",
  "Evidence workflow, capture, intake, and reviewer questions",
  "Verification page, report, and verification-package questions",
  "Account, login, subscription, and billing questions",
  "Security reports and responsible-disclosure intake",
  "Enterprise evaluation, procurement, and security review questions",
];

const SUPPORT_CANNOT_DO: ReadonlyArray<string> = [
  "Does not provide legal advice.",
  "Does not determine factual truth, authorship, identity, or intent.",
  "Does not certify legal admissibility or evidentiary weight.",
  "Does not act as a court, law-enforcement authority, regulator, or forensic-investigation authority.",
  "Cannot bypass customer-controlled access permissions or workspace policies.",
  "Cannot provide real-time emergency response or personal-safety monitoring.",
  "Cannot guarantee recovery of deleted content.",
];

// ---------------------------------------------------------------------------
// Section 5 — Response expectations
// ---------------------------------------------------------------------------

const RESPONSE_EXPECTATIONS: ReadonlyArray<{
  type: string;
  path: string;
  expectation: string;
}> = [
  {
    type: "Product support",
    path: "Support queue",
    expectation: "Reviewed in the ordinary support flow",
  },
  {
    type: "Billing questions",
    path: "Billing support",
    expectation: "Routed to billing support or payment-provider context",
  },
  {
    type: "Security reports",
    path: "Security disclosure path",
    expectation: "Prioritized based on severity and exploitability",
  },
  {
    type: "Privacy requests",
    path: "Privacy request process",
    expectation: "Handled according to applicable privacy law",
  },
  {
    type: "Law-enforcement requests",
    path: "Legal process intake",
    expectation: "Reviewed through the published Law Enforcement Request Policy",
  },
  {
    type: "Enterprise procurement",
    path: "Sales / enterprise review",
    expectation:
      "Routed to sales for documentation, security review, and procurement evaluation",
  },
];

// ---------------------------------------------------------------------------
// Section 6 — Enterprise evaluation
// ---------------------------------------------------------------------------

const ENTERPRISE_CHECKLIST: ReadonlyArray<string> = [
  "Trust Center documentation",
  "Security overview",
  "Subprocessor review",
  "DPA review",
  "TOMs review",
  "Verification Methodology",
  "AI Use Policy",
  "Data Retention Policy",
  "Security questionnaire support",
  "Pilot or proof-of-concept discussion",
];

const REVIEW_PACKET: ReadonlyArray<{
  label: string;
  href: string;
  Icon: LucideIcon;
}> = [
  { label: "Trust Center", href: "/trust", Icon: BadgeCheck },
  { label: "Data Processing Addendum", href: "/legal/dpa", Icon: ClipboardCheck },
  { label: "Security Overview", href: "/legal/security", Icon: LockKeyhole },
  { label: "Subprocessors", href: "/legal/subprocessors", Icon: Network },
  { label: "Verification Methodology", href: "/legal/verification-methodology", Icon: Fingerprint },
];

// ---------------------------------------------------------------------------
// Section 7 — Security review resources
// ---------------------------------------------------------------------------

const SECURITY_REVIEW: ReadonlyArray<{
  title: string;
  body: string;
  href: string;
  cta: string;
  external?: boolean;
}> = [
  {
    title: "Security Overview",
    body: "PROOVRA's security posture, governance, key management, evidence-integrity controls, and responsible disclosure.",
    href: "/legal/security",
    cta: "Open Security Overview",
  },
  {
    title: "Technical and Organizational Measures",
    body: "TOMs covering access control, authentication, audit logging, data protection, and operational controls.",
    href: "/legal/toms",
    cta: "Open TOMs",
  },
  {
    title: "Incident Response",
    body: "Severity classification, notification expectations, and processor-role handling consistent with applicable law.",
    href: "/legal/incident-response",
    cta: "Open Incident Response",
  },
  {
    title: "Subprocessors",
    body: "Current subprocessor register with provider, purpose, data categories, region, role, and status.",
    href: "/legal/subprocessors",
    cta: "Open Subprocessors",
  },
];

// ---------------------------------------------------------------------------
// Section 8 — Sensitive / legal request paths
// ---------------------------------------------------------------------------

const SENSITIVE_REQUESTS: ReadonlyArray<{
  title: string;
  body: string;
  href: string;
  label: string;
  Icon: typeof Gavel;
}> = [
  {
    title: "Law-enforcement requests",
    body: "Government, law-enforcement, regulator, court, and legal-process requests follow a published intake path.",
    href: "/legal/law-enforcement",
    label: "Law Enforcement Requests",
    Icon: Gavel,
  },
  {
    title: "Abuse reports",
    body: "Reports of misuse, abusive content, impersonation, fraudulent verification use, or unlawful activity have a dedicated intake.",
    href: "/legal/abuse-reporting",
    label: "Abuse Reporting",
    Icon: ShieldAlert,
  },
  {
    title: "Privacy / data-subject requests",
    body: "Access, rectification, deletion, restriction, portability, objection, and consent-withdrawal requests under applicable privacy law.",
    href: "/legal/privacy-requests",
    label: "Privacy Requests",
    Icon: Scale,
  },
  {
    title: "Security vulnerabilities",
    body: "Responsible-disclosure intake for vulnerabilities discovered in PROOVRA's public or product surfaces.",
    href: "/legal/security",
    label: "Security Overview",
    Icon: Shield,
  },
];

// ---------------------------------------------------------------------------
// Section 10 — Helpful resources grouped
// ---------------------------------------------------------------------------

const RESOURCE_GROUPS: ReadonlyArray<{
  title: string;
  subtitle: string;
  links: ReadonlyArray<{ href: string; label: string }>;
}> = [
  {
    title: "Trust & governance",
    subtitle: "Where the platform's boundary, posture, and policies are described.",
    links: [
      { href: "/trust", label: "Trust Center" },
      { href: "/legal/privacy-requests", label: "Privacy Requests" },
      { href: "/legal/security", label: "Security Overview" },
      { href: "/legal/support", label: "Support Policy" },
    ],
  },
  {
    title: "Evidence & verification",
    subtitle: "How PROOVRA records, verifies, and bounds evidence operations.",
    links: [
      { href: "/legal/evidence-handling", label: "Evidence Handling Policy" },
      { href: "/legal/toms", label: "Technical and Organizational Measures" },
      { href: "/legal/verification-disclaimer", label: "Verification Disclaimer" },
      { href: "/legal/verification-methodology", label: "Verification Methodology" },
    ],
  },
  {
    title: "Legal & sensitive requests",
    subtitle: "Dedicated intake paths for legally sensitive matters.",
    links: [
      { href: "/legal/abuse-reporting", label: "Abuse Reporting" },
      { href: "/legal/refund-policy", label: "Consumer Cancellation and Refund Policy" },
      { href: "/legal/dmca", label: "Copyright and DMCA Policy" },
      { href: "/legal/law-enforcement", label: "Law Enforcement Requests" },
    ],
  },
  {
    title: "Enterprise adoption",
    subtitle: "What enterprise reviewers usually request before adoption.",
    links: [
      { href: "/legal/ai-use-policy", label: "AI Use Policy" },
      { href: "/contact-sales", label: "Contact Sales" },
      { href: "/legal/dpa", label: "Data Processing Addendum" },
      { href: "/legal/subprocessors", label: "Subprocessors" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionEyebrow({
  children,
  tone = "blue",
}: {
  children: React.ReactNode;
  tone?: "blue" | "violet" | "slate" | "white";
}) {
  const colorMap: Record<string, string> = {
    blue: "#2563EB",
    violet: "#7C3AED",
    slate: "#64748B",
    white: "rgba(255,255,255,0.78)",
  };
  return (
    <div
      className="text-[12px] font-bold uppercase tracking-[0.16em]"
      style={{ color: colorMap[tone] }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SupportPage() {
  return (
    <div className="page support-page" style={{ background: "#F6F9FC" }}>
      {/* ───────────────── Section 1 — Hero ───────────────── */}
      <section
        className="relative min-h-[720px] overflow-hidden bg-white"
        style={{
          backgroundImage: `url("${HERO_BG}")`,
          backgroundSize: "100% 100%",
          backgroundPosition: "center center",
          backgroundRepeat: "no-repeat",
        }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, rgba(255,255,255,0.78) 0%, rgba(255,255,255,0.42) 42%, rgba(255,255,255,0) 72%)",
          }}
        />
        <div className="relative z-10">
          <MarketingHeader />

          <div className="mx-auto max-w-[1320px] px-6 pb-24 pt-20 md:px-8 lg:pb-28 lg:pt-28">
            <div className="max-w-[640px]">
              <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-[#F8FAFC] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#2563EB]">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#7A3CFF]" />
                Support
              </span>

              <h1 className="mt-4 text-[2rem] font-semibold leading-[1.06] tracking-[-0.025em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
                Get the{" "}
                <span
                  className="bg-clip-text text-transparent"
                  style={{
                    backgroundImage:
                      "linear-gradient(90deg, #2563EB 0%, #7C3AED 50%, #C026D3 100%)",
                  }}
                >
                  right help path.
                </span>
              </h1>

              <p className="mt-4 max-w-[560px] text-[15px] leading-[1.65] text-[#475569]">
                Choose the support route that matches your request — product
                help, billing, security reports, legal and privacy requests, or
                enterprise evaluation.
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[#071B4D] px-5 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(7,27,77,0.22)] transition hover:-translate-y-0.5"
                >
                  Email support
                </a>
                <Link
                  href="/contact-sales"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-[#E5E7EB] bg-white px-5 text-[13.5px] font-semibold text-[#0F172A] transition hover:-translate-y-0.5 hover:border-[#CBD5E1]"
                >
                  Talk to sales
                </Link>
              </div>

              {/* Hero chips — quick route hints */}
              <div className="mt-6 flex flex-wrap gap-2">
                {[
                  "Product help",
                  "Billing",
                  "Security reports",
                  "Legal routing",
                ].map((chip) => (
                  <span
                    key={chip}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white/85 px-3 py-1 text-[12px] font-medium text-[#0F172A]"
                  >
                    <span
                      aria-hidden="true"
                      className="block h-1.5 w-1.5 rounded-full bg-[#2563EB]"
                    />
                    {chip}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────── Section 2 — Support paths ───────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div className="mb-8 max-w-[760px]">
            <SectionEyebrow tone="blue">Support paths</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              Pick the route that matches your request.
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              Each path routes your request to the correct operational,
              security, legal, or enterprise workflow.
            </p>
          </div>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {SUPPORT_PATHS.map((p, idx) => {
              const accent = ["#2563EB", "#7C3AED", "#0F766E", "#B45309"][idx % 4];
              const LinkComp = p.external ? "a" : Link;
              const linkProps = p.external
                ? { href: p.href }
                : { href: p.href };
              return (
                <div
                  key={p.title}
                  className="relative flex flex-col rounded-[20px] border bg-white p-6 shadow-[0_2px_10px_rgba(8,18,22,0.03)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(8,18,22,0.05)]"
                  style={{ borderColor: "#DDE6F2" }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-6 h-7 w-[3px] rounded-r"
                    style={{ background: accent }}
                  />
                  <div
                    className="text-[11.5px] font-bold uppercase tracking-[0.14em]"
                    style={{ color: accent }}
                  >
                    {p.label}
                  </div>
                  <h3 className="mt-2 text-[1.1rem] font-semibold tracking-[-0.01em] text-[#081426]">
                    {p.title}
                  </h3>
                  <p className="mt-2 flex-1 text-[14px] leading-[1.65] text-[#475569]">
                    {p.body}
                  </p>
                  <LinkComp
                    {...linkProps}
                    className="mt-4 inline-flex items-center gap-1 text-[13.5px] font-semibold text-[#2563EB] hover:gap-2"
                  >
                    {p.cta} <ArrowRight size={14} aria-hidden="true" />
                  </LinkComp>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ───────────────── Section 3 — Routing diagram ─────────────────
          Card surface now uses /assets/cards/icon-card.png as the
          background image (cover · center). A dark scrim keeps the
          three step-node sub-cards readable; the three sub-cards stay
          white so the step content reads cleanly against the artwork.
          ─────────────────────────────────────────────────────────── */}
      <section style={{ background: "#F8FAFC" }}>
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div className="mb-10 max-w-[760px]">
            <SectionEyebrow tone="violet">Support routing</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              From question to the right team.
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              PROOVRA support is routed by request type so sensitive matters
              reach the correct operational, security, legal, or enterprise
              path.
            </p>
          </div>

          {/* Diagram — desktop horizontal, mobile vertical */}
          <div
            className="relative overflow-hidden rounded-[24px] border p-7 shadow-[0_18px_42px_rgba(8,18,22,0.10)] md:p-9"
            style={{
              borderColor: "rgba(255,255,255,0.10)",
              backgroundImage: "url('/assets/cards/icon-card.png')",
              backgroundSize: "cover",
              backgroundPosition: "center center",
              backgroundRepeat: "no-repeat",
              backgroundColor: "#050F33",
            }}
          >
            {/* Readability scrim */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "linear-gradient(180deg, rgba(5,15,51,0.42) 0%, rgba(5,15,51,0.55) 100%)",
              }}
            />
            <div className="relative grid items-stretch gap-7 lg:grid-cols-[1fr_auto_1.4fr_auto_1.2fr]">
              {/* Node 1 — Start (translucent dark glass) */}
              <div className="flex items-center">
                <div
                  className="w-full rounded-[16px] border p-5 backdrop-blur-[2px]"
                  style={{
                    borderColor: "rgba(255,255,255,0.14)",
                    background: "rgba(15,23,42,0.45)",
                  }}
                >
                  <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#A5B4FC]">
                    Step 1
                  </div>
                  <div className="mt-2 text-[15px] font-semibold text-white">
                    Start with your request
                  </div>
                  <p className="mt-2 text-[13px] leading-[1.55] text-[#CBD5F5]">
                    Describe what you need. Most requests fall into one of five
                    types.
                  </p>
                </div>
              </div>

              {/* Connector arrow */}
              <div
                aria-hidden="true"
                className="hidden lg:flex items-center justify-center text-[#A78BFA]"
              >
                <ArrowRight size={22} />
              </div>

              {/* Node 2 — Choose request type */}
              <div className="flex items-center">
                <div
                  className="w-full rounded-[16px] p-5 text-white shadow-[0_8px_22px_rgba(8,18,22,0.18)]"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(7,27,77,0.92) 0%, rgba(45,26,107,0.92) 100%)",
                    border: "1px solid rgba(255,255,255,0.10)",
                  }}
                >
                  <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/75">
                    Step 2
                  </div>
                  <div className="mt-2 text-[15px] font-semibold">
                    Choose request type
                  </div>
                  <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {[
                      "Product",
                      "Billing",
                      "Security",
                      "Legal / privacy",
                      "Enterprise review",
                    ].map((label) => (
                      <li
                        key={label}
                        className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[12px] font-medium"
                      >
                        <span
                          aria-hidden="true"
                          className="block h-1.5 w-1.5 rounded-full bg-[#A78BFA]"
                        />
                        {label}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Connector arrow */}
              <div
                aria-hidden="true"
                className="hidden lg:flex items-center justify-center text-[#A78BFA]"
              >
                <ArrowRight size={22} />
              </div>

              {/* Node 3 — Correct path (translucent dark glass) */}
              <div className="flex items-center">
                <div
                  className="w-full rounded-[16px] border p-5 backdrop-blur-[2px]"
                  style={{
                    borderColor: "rgba(255,255,255,0.14)",
                    background: "rgba(15,23,42,0.45)",
                  }}
                >
                  <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#A5B4FC]">
                    Step 3
                  </div>
                  <div className="mt-2 text-[15px] font-semibold text-white">
                    Correct path
                  </div>
                  <ul className="mt-3 grid gap-1.5 text-[13px] text-[#CBD5F5]">
                    {[
                      "Support team",
                      "Billing support",
                      "Security disclosure path",
                      "Legal / privacy intake",
                      "Sales / enterprise review",
                    ].map((label) => (
                      <li key={label} className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="block h-[5px] w-[5px] rounded-full bg-[#A78BFA]"
                        />
                        {label}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────── Section 4 — Support scope ───────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div className="mb-10 max-w-[820px]">
            <SectionEyebrow tone="blue">Support scope</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              What support can help with — and where support must draw the line.
            </h2>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div
              className="rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{ borderColor: "#DDE6F2", borderLeft: "4px solid #2563EB" }}
            >
              <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#2563EB]">
                <FileCheck2 size={15} aria-hidden="true" />
                What support can help with
              </div>
              <ul className="mt-5 grid gap-3">
                {SUPPORT_CAN_HELP.map((t) => (
                  <li
                    key={t}
                    className="flex gap-3 text-[14.5px] leading-[1.65] text-[#0F172A]"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[0.45em] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                      style={{ background: "#EFF6FF", color: "#2563EB" }}
                    >
                      <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                        <path
                          d="M1 4.5L3.5 7L8 1.5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div
              className="rounded-[20px] border p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{
                borderColor: "#F1D5C3",
                borderLeft: "4px solid #B45309",
                background: "#FEF9F2",
              }}
            >
              <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#B45309]">
                <ShieldAlert size={15} aria-hidden="true" />
                What support cannot do
              </div>
              <ul className="mt-5 grid gap-3">
                {SUPPORT_CANNOT_DO.map((t) => (
                  <li
                    key={t}
                    className="flex gap-3 text-[14.5px] leading-[1.65] text-[#0F172A]"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[0.55em] block h-[5px] w-[5px] shrink-0 rounded-full bg-[#B45309]"
                    />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────── Section 5 — Response expectations ───────────────── */}
      <section style={{ background: "#F8FAFC" }}>
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div className="mb-8 max-w-[820px]">
            <SectionEyebrow tone="violet">Response expectations</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              How requests are prioritized.
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              PROOVRA routes requests by severity, risk, plan, contractual
              commitments, and operational capacity. Unless an enterprise
              agreement states otherwise, these expectations are not guaranteed
              response or resolution times.
            </p>
          </div>

          <div
            className="overflow-x-auto rounded-[20px] border bg-white shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
            style={{ borderColor: "#E2E8F0" }}
          >
            <table className="min-w-[760px] w-full border-collapse text-left">
              <thead style={{ background: "#F8FAFC" }}>
                <tr>
                  <th className="px-5 py-3 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#0F172A]">
                    Request type
                  </th>
                  <th className="px-5 py-3 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#0F172A]">
                    Typical handling path
                  </th>
                  <th className="px-5 py-3 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#0F172A]">
                    Expectation
                  </th>
                </tr>
              </thead>
              <tbody>
                {RESPONSE_EXPECTATIONS.map((row, idx) => (
                  <tr
                    key={row.type}
                    style={{
                      borderTop: idx === 0 ? "none" : "1px solid #F1F5F9",
                    }}
                  >
                    <td className="px-5 py-4 align-top text-[14px] font-semibold text-[#0F172A]">
                      {row.type}
                    </td>
                    <td className="px-5 py-4 align-top text-[14px] text-[#475569]">
                      {row.path}
                    </td>
                    <td className="px-5 py-4 align-top text-[14px] text-[#475569]">
                      {row.expectation}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ───────────────── Section 6 — Enterprise evaluation ─────────────────
          Panel surface now uses /assets/cards/icon-card.png as the
          background image (cover · center) instead of the prior dark
          navy gradient. A readability scrim keeps the checklist + CTA
          row legible against the artwork.
          ─────────────────────────────────────────────────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div
            className="relative overflow-hidden rounded-[28px] p-8 text-white shadow-[0_24px_60px_rgba(7,27,77,0.22)] md:p-12"
            style={{
              backgroundImage: "url('/assets/cards/icon-card.png')",
              backgroundSize: "cover",
              backgroundPosition: "center center",
              backgroundRepeat: "no-repeat",
              backgroundColor: "#050F33",
            }}
          >
            {/* Readability scrim — keeps body copy + checklist legible
                without flattening the icon-card artwork. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "linear-gradient(180deg, rgba(5,15,51,0.46) 0%, rgba(5,15,51,0.60) 100%)",
              }}
            />

            <div className="relative grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
              <div>
                <SectionEyebrow tone="white">
                  Enterprise evaluation
                </SectionEyebrow>
                <h2 className="mt-3 text-[1.85rem] font-semibold tracking-[-0.02em] text-white md:text-[2.2rem]">
                  Support for procurement, security review, and enterprise
                  adoption.
                </h2>
                <p className="mt-4 max-w-[560px] text-[15px] leading-[1.7] text-white/80">
                  Organizations evaluating PROOVRA may need technical, legal,
                  privacy, and security materials before adoption. The
                  enterprise path routes these requests to the right team
                  instead of mixing them with ordinary product support.
                </p>

                <div className="mt-7">
                  <div className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-white/65">
                    Enterprise reviewers may ask for
                  </div>
                  <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                    {ENTERPRISE_CHECKLIST.map((item) => (
                      <li
                        key={item}
                        className="flex gap-2 text-[13.5px] leading-[1.55] text-white/85"
                      >
                        <span
                          aria-hidden="true"
                          className="mt-[0.5em] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/10 text-[#A78BFA]"
                        >
                          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                            <path
                              d="M1 4.5L3.5 7L8 1.5"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-8 flex flex-wrap gap-3">
                  <Link
                    href="/trust"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-white px-5 text-[13.5px] font-semibold text-[#071B4D] transition hover:-translate-y-0.5"
                  >
                    Trust Center
                  </Link>
                  <Link
                    href="/contact-sales"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-white/30 bg-white/5 px-5 text-[13.5px] font-semibold text-white transition hover:bg-white/15"
                  >
                    Talk to sales
                  </Link>
                </div>
              </div>

              {/* Review packet mini-visual */}
              <div className="relative">
                <div
                  className="rounded-[20px] border border-white/10 bg-white/[0.06] p-6 backdrop-blur-[2px]"
                >
                  <div className="flex items-center gap-2 text-[11.5px] font-bold uppercase tracking-[0.14em] text-white/65">
                    <Building2 size={15} aria-hidden="true" />
                    Review packet
                  </div>
                  <div className="mt-4 grid gap-2.5">
                    {REVIEW_PACKET.map(({ Icon, ...item }) => (
                      <Link
                        key={item.label}
                        href={item.href}
                        className="group flex items-center justify-between rounded-[12px] border border-white/10 bg-white/[0.04] px-4 py-3 transition hover:border-white/25 hover:bg-white/[0.08]"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="flex h-8 w-8 items-center justify-center rounded-full border"
                            style={{
                              background: "rgba(255,255,255,0.08)",
                              borderColor: "rgba(255,255,255,0.18)",
                              color: "#A78BFA",
                            }}
                          >
                            <Icon size={15} strokeWidth={1.9} />
                          </span>
                          <span className="text-[14px] font-medium text-white">
                            {item.label}
                          </span>
                        </div>
                        <ArrowRight
                          size={14}
                          aria-hidden="true"
                          className="text-white/55 transition group-hover:translate-x-0.5 group-hover:text-white"
                        />
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────── Section 7 — Security reviews ───────────────── */}
      <section style={{ background: "#F8FAFC" }}>
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div className="mb-8 max-w-[820px]">
            <SectionEyebrow tone="blue">Security reviews</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              Security questions should go through the right path.
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              Before adopting PROOVRA, organizations may review security
              documentation, architecture boundaries, subprocessors, incident
              response posture, and verification controls.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {SECURITY_REVIEW.map((r) => (
              <Link
                key={r.title}
                href={r.href}
                className="group flex flex-col rounded-[20px] border bg-white p-6 shadow-[0_2px_10px_rgba(8,18,22,0.03)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(8,18,22,0.05)]"
                style={{ borderColor: "#DDE6F2" }}
              >
                <div
                  aria-hidden="true"
                  className="flex h-9 w-9 items-center justify-center rounded-[10px]"
                  style={{
                    background: "#EFF6FF",
                    color: "#2563EB",
                  }}
                >
                  <Shield size={16} />
                </div>
                <h3 className="mt-4 text-[1rem] font-semibold tracking-[-0.01em] text-[#081426]">
                  {r.title}
                </h3>
                <p className="mt-2 flex-1 text-[13.5px] leading-[1.6] text-[#475569]">
                  {r.body}
                </p>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-[#2563EB] transition group-hover:gap-2">
                  {r.cta} <ArrowRight size={13} aria-hidden="true" />
                </span>
              </Link>
            ))}
          </div>

          <div
            className="mt-7 grid gap-4 rounded-[20px] border bg-white p-6 md:grid-cols-2"
            style={{ borderColor: "#E2E8F0" }}
          >
            <div className="flex gap-3">
              <ShieldAlert
                size={18}
                aria-hidden="true"
                className="mt-[2px] shrink-0 text-[#B45309]"
              />
              <div>
                <div className="text-[13px] font-semibold text-[#0F172A]">
                  Report a vulnerability
                </div>
                <p className="mt-1 text-[13px] leading-[1.55] text-[#475569]">
                  Vulnerability reports should go to{" "}
                  <a
                    href={`mailto:${SECURITY_EMAIL}`}
                    className="font-medium text-[#2563EB] underline-offset-2 hover:underline"
                  >
                    {SECURITY_EMAIL}
                  </a>
                  .
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <Building2
                size={18}
                aria-hidden="true"
                className="mt-[2px] shrink-0 text-[#2563EB]"
              />
              <div>
                <div className="text-[13px] font-semibold text-[#0F172A]">
                  Enterprise security questionnaire
                </div>
                <p className="mt-1 text-[13px] leading-[1.55] text-[#475569]">
                  Enterprise security questionnaires should go through{" "}
                  <Link
                    href="/contact-sales"
                    className="font-medium text-[#2563EB] underline-offset-2 hover:underline"
                  >
                    /contact-sales
                  </Link>
                  .
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────── Section 8 — Sensitive / legal requests ───────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div className="mb-8 max-w-[820px]">
            <SectionEyebrow tone="violet">
              Sensitive or legal requests
            </SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              Use the dedicated request path.
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              For legally sensitive matters, use the dedicated intake path so
              the request is logged and routed correctly. Each path links to
              the relevant policy with the full submission process.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {SENSITIVE_REQUESTS.map(({ Icon, ...s }) => (
              <Link
                key={s.title}
                href={s.href}
                className="group flex flex-col rounded-[20px] border bg-white p-6 shadow-[0_2px_10px_rgba(8,18,22,0.03)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(8,18,22,0.05)]"
                style={{ borderColor: "#DDE6F2" }}
              >
                <div
                  aria-hidden="true"
                  className="flex h-9 w-9 items-center justify-center rounded-[10px]"
                  style={{ background: "#F5F3FF", color: "#7C3AED" }}
                >
                  <Icon size={16} />
                </div>
                <h3 className="mt-4 text-[1rem] font-semibold tracking-[-0.01em] text-[#081426]">
                  {s.title}
                </h3>
                <p className="mt-2 flex-1 text-[13.5px] leading-[1.6] text-[#475569]">
                  {s.body}
                </p>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-[#2563EB] transition group-hover:gap-2">
                  {s.label} <ArrowRight size={13} aria-hidden="true" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ───────────────── Section 9 — Support vs Support Policy ───────────────── */}
      <section style={{ background: "#F8FAFC" }}>
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div className="mb-8 max-w-[820px]">
            <SectionEyebrow tone="slate">Support vs policy</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              Public Support and Support Policy are different surfaces.
            </h2>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            {/* You are here */}
            <div
              className="relative flex flex-col rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{
                borderColor: "#DDE6F2",
                borderLeft: "4px solid #2563EB",
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-[8px]"
                  style={{ background: "#EFF6FF", color: "#2563EB" }}
                >
                  <LifeBuoy size={13} />
                </span>
                <span
                  className="inline-flex items-center rounded-full bg-[#EFF6FF] px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#2563EB]"
                >
                  /support
                </span>
              </div>
              <h3 className="mt-4 text-[1.15rem] font-semibold tracking-[-0.01em] text-[#081426]">
                Public Support
              </h3>
              <p className="mt-2 flex-1 text-[14px] leading-[1.65] text-[#475569]">
                The operational support page for product help, billing routing,
                sensitive-request paths, and enterprise evaluation.
              </p>
              <span className="mt-5 inline-flex w-fit items-center gap-1.5 rounded-full border border-[#2563EB] bg-white px-3 py-1 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2563EB]">
                You are here
              </span>
            </div>

            {/* Support Policy */}
            <div
              className="relative flex flex-col rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{
                borderColor: "#DDE6F2",
                borderLeft: "4px solid #7C3AED",
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-[8px]"
                  style={{ background: "#F5F3FF", color: "#7C3AED" }}
                >
                  <Scale size={13} />
                </span>
                <span
                  className="inline-flex items-center rounded-full bg-[#F5F3FF] px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#7C3AED]"
                >
                  /legal/support
                </span>
              </div>
              <h3 className="mt-4 text-[1.15rem] font-semibold tracking-[-0.01em] text-[#081426]">
                Support Policy
              </h3>
              <p className="mt-2 flex-1 text-[14px] leading-[1.65] text-[#475569]">
                The legal policy document describing support scope, severity
                prioritization, escalation, limitations, and availability
                expectations.
              </p>
              <Link
                href="/legal/support"
                className="mt-5 inline-flex w-fit items-center gap-1.5 rounded-full bg-[#7C3AED] px-4 py-1.5 text-[12px] font-bold uppercase tracking-[0.12em] text-white transition hover:-translate-y-0.5"
              >
                Open Support Policy
                <ArrowRight size={12} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────── Section 10 — Helpful resources ───────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div className="mb-8 max-w-[820px]">
            <SectionEyebrow tone="blue">Helpful resources</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              Read the documents behind each support path.
            </h2>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {RESOURCE_GROUPS.map((group, idx) => {
              const accent = ["#2563EB", "#7C3AED", "#0F766E", "#B45309"][idx];
              return (
                <div
                  key={group.title}
                  className="flex flex-col rounded-[20px] border bg-white p-6 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
                  style={{ borderColor: "#DDE6F2" }}
                >
                  <div
                    className="text-[11.5px] font-bold uppercase tracking-[0.14em]"
                    style={{ color: accent }}
                  >
                    {group.title}
                  </div>
                  <p className="mt-2 text-[13px] leading-[1.6] text-[#475569]">
                    {group.subtitle}
                  </p>
                  <ul className="mt-4 grid gap-2 border-t pt-4" style={{ borderColor: "#F1F5F9" }}>
                    {group.links.map((link) => (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          className="inline-flex items-center gap-2 text-[13.5px] text-[#0B1F4D] underline-offset-4 hover:text-[#2563EB] hover:underline"
                        >
                          <span
                            aria-hidden="true"
                            className="block h-[5px] w-[5px] rounded-full"
                            style={{ background: accent }}
                          />
                          <span>{link.label}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ───────────────── Section 11 — Final CTA — matches Request Demo
          page BottomCTA style (teal → slate → red linear gradient, no
          grid pattern). ───────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 pb-20 md:px-8">
          <div
            className="relative overflow-hidden rounded-[24px] p-7 text-white shadow-[0_20px_44px_rgba(15,23,42,0.10)] md:p-9"
            style={{
              background:
                "linear-gradient(135deg,#1F8E8E 0%,#64717A 48%,#D83A3A 100%)",
              border: "1px solid rgba(255,255,255,0.10)",
            }}
          >
            {/* Subtle tone-down layer — keeps the gradient calm rather than neon. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(ellipse at 70% 110%, rgba(15,23,42,0.18), transparent 55%)",
                mixBlendMode: "soft-light",
              }}
            />
            <div className="relative grid gap-6 md:grid-cols-[1.15fr_0.85fr] md:items-center">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/80">
                  <HelpCircle size={12} aria-hidden="true" />
                  Not sure yet?
                </div>
                <h2 className="mt-4 text-[1.75rem] font-semibold tracking-[-0.02em] text-white md:text-[2.1rem]">
                  Still not sure where your request belongs?
                </h2>
                <p className="mt-3 max-w-[540px] text-[15px] leading-[1.7] text-white/80">
                  Email the team and we will route it to the right path. For
                  enterprise procurement, security review, or vendor
                  evaluation, talk to sales.
                </p>
              </div>
              <div className="flex flex-wrap gap-3 md:justify-end">
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-white px-5 text-[13.5px] font-semibold text-[#071B4D] shadow-[0_10px_24px_rgba(15,23,42,0.18)] transition hover:-translate-y-0.5"
                >
                  Email support
                </a>
                <Link
                  href="/contact-sales"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-white/30 bg-white/5 px-5 text-[13.5px] font-semibold text-white transition hover:bg-white/15"
                >
                  Talk to sales
                  <CreditCard size={14} aria-hidden="true" className="opacity-0" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <EnterpriseFooter />
    </div>
  );
}
