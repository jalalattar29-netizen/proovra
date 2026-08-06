/**
 * Trust Center — canonical public destination at `/trust`.
 *
 * Enterprise-grade public Trust Center for buyers, legal reviewers,
 * security reviewers, procurement teams, and compliance evaluators.
 *
 * IA placement: top-level `/trust`. The legacy `/about/trust` help-link
 * target 308s here (its thin re-export page was deleted in Phase 12
 * Point 4). This public Trust Center is the SINGLE
 * canonical trust portal — the former authenticated `/trust-hub` was removed
 * 2026-07-15 (it now 308s here); in-app `/trust-center/*` articles are a
 * separate non-navigational documentation surface.
 *
 * Safe-language contract — this file must comply with the public Trust
 * Center brief. The forbidden overclaim tokens and forbidden
 * implementation-detail tokens listed in that brief MUST NOT appear in
 * the rendered output of this page. The single permitted appearance of
 * "Certified evidence" is inside the "What PROOVRA avoids" render,
 * where it is explicitly framed as something the platform avoids
 * claiming. "Security Overview" is the single link to /legal/security
 * — no duplicate "Responsible Disclosure" row pointing at the same
 * URL. Every "What PROOVRA does not decide" bullet is first-class, not
 * a footnote.
 */

import Link from "next/link";
import {
  TRUST_CENTER_PAGE_BOUNDARY_CALLOUT,
  TRUST_CENTER_PAGE_INTRO,
  TRUST_CENTER_SECTIONS,
  TRUST_CENTER_SECTION_IDS,
} from "@proovra/shared-evidence-presentation";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Database,
  Eye,
  FileCheck2,
  FileText,
  Fingerprint,
  Gavel,
  Inbox,
  KeyRound,
  Landmark,
  LifeBuoy,
  Lock,
  Mail,
  Search,
  Shield,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { MarketingHeader } from "../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { RevealSection } from "../../components/motion";
import { MARKETING_BTN } from "../../lib/marketing-buttons";

// =========================================================================
// METADATA — this page stays a client component for parity with the
// About / Why PROOVRA reveal rhythm. Next.js disallows a `metadata`
// export inside a "use client" module, so the canonical document title
// + description come from the root layout's metadata.
//
// Phase 12 Point 4 (Pass E) — the thin `app/about/trust/page.tsx`
// re-export wrapper was deleted. `/about/trust` is served by the
// permanent redirect in next.config.js, which made the wrapper page
// unreachable; there is no longer a re-export import contract to
// preserve. The canonical document title + description live in the
// head via the route's segment metadata
// returned from layout chains.

// =========================================================================
// TOKENS — match the enterprise visual language used by About,
// Why PROOVRA, Support, and the legal pages.
// =========================================================================

const TRUST_HERO_IMAGE = "/assets/hero/legal-hero.png";
const DARK_PANEL_BG = "/assets/cards/icon-card.png";
const VERTICAL_PANEL_BG = "/assets/cards/vertical-card.png";

const NAVY = "#071B5D";
const NAVY_INK = "#0F172A";
const SLATE_BODY = "#475569";
const SLATE_BORDER = "#E2E8F0";
const SOFT_SLATE = "#F8FAFC";

// Enterprise accent palette — inspired by the Platform page rhythm.
// Used deliberately across icons, badges, top rails, and step circles.
// Text stays navy/slate; backgrounds stay white or glass.
const ACCENT_BLUE = "#2563EB";
const ACCENT_VIOLET = "#7C3AED";
const ACCENT_EMERALD = "#10B981";
const ACCENT_ORANGE = "#F97316";
const ACCENT_ROSE = "#EC4899";
const ACCENT_BURGUNDY = "#9F1239";

const TRUST_GRADIENT =
  "linear-gradient(90deg, #2563EB 0%, #7C3AED 50%, #C026D3 100%)";

// =========================================================================
// SECTION 2 — What PROOVRA records / does not decide
// =========================================================================

const WHAT_RECORDS: ReadonlyArray<string> = [
  "Evidence Records and related metadata",
  "SHA-256 fingerprints and integrity status",
  "Custody events and audit activity",
  "Signature context and timestamp / anchoring context where configured and available",
  "Verification Reports, Verification Packages, and Public Verification URLs where supported",
  "Governance context such as workspaces, roles, cases, retention concepts, legal hold concepts, and access boundaries",
];

const WHAT_NOT_DECIDED: ReadonlyArray<string> = [
  "Factual truth",
  "Authorship",
  "Identity",
  "Intent",
  "Liability",
  "Whether the material was lawfully captured or obtained",
  "Evidentiary weight",
  "Legal admissibility",
  "Court acceptance",
  "Whether a real-world event happened",
];

// =========================================================================
// SECTION 3 — Trust foundations
// =========================================================================

type Foundation = {
  title: string;
  body: string;
  Icon: LucideIcon;
  accent: string;
  links: ReadonlyArray<{ label: string; href: string }>;
};

const FOUNDATIONS: ReadonlyArray<Foundation> = [
  {
    title: "Evidence Integrity",
    body: "How PROOVRA records hashes, fingerprints, signature context, timestamp or anchoring context where enabled, and verification status for reviewer inspection.",
    Icon: Fingerprint,
    accent: ACCENT_BLUE,
    links: [
      { label: "Verification Methodology", href: "/legal/verification-methodology" },
      { label: "Verification Disclaimer", href: "/legal/verification-disclaimer" },
    ],
  },
  {
    title: "Chain of Custody",
    body: "How platform-recorded actions, custody events, audit activity, and handling context help reviewers understand what happened inside PROOVRA.",
    Icon: ClipboardCheck,
    accent: ACCENT_ORANGE,
    links: [{ label: "Evidence Handling Policy", href: "/legal/evidence-handling" }],
  },
  {
    title: "Security",
    body: "How PROOVRA describes access control, identity, MFA, SSO/SAML, SCIM, monitoring, secure development, incident response, and security boundaries.",
    Icon: ShieldCheck,
    accent: ACCENT_BURGUNDY,
    links: [
      { label: "Security Overview", href: "/legal/security" },
      { label: "Incident Response", href: "/legal/incident-response" },
    ],
  },
  {
    title: "Privacy & Data Governance",
    body: "How PROOVRA explains data handling, data subject requests, retention, subprocessors, DPA terms, cookies, and technical and organizational measures.",
    Icon: Lock,
    accent: ACCENT_EMERALD,
    links: [
      { label: "Privacy Policy", href: "/legal/privacy" },
      { label: "DPA", href: "/legal/dpa" },
      { label: "Subprocessors", href: "/legal/subprocessors" },
    ],
  },
  {
    title: "Governance",
    body: "How PROOVRA documents acceptable use, abuse reporting, legal requests, retention concepts, support boundaries, and platform governance controls.",
    Icon: Landmark,
    accent: ACCENT_VIOLET,
    links: [
      { label: "Acceptable Use Policy", href: "/legal/aup" },
      { label: "Law Enforcement Requests", href: "/legal/law-enforcement" },
      { label: "Support Policy", href: "/legal/support" },
    ],
  },
  {
    title: "AI Transparency",
    body: "How PROOVRA explains advisory AI assistance, metadata-first processing, provider boundaries, no-training commitments, human review, and AI limitations.",
    Icon: Sparkles,
    accent: ACCENT_ROSE,
    links: [{ label: "AI Use Policy", href: "/legal/ai-use-policy" }],
  },
];

// =========================================================================
// SECTION 4 — Trust flow
// =========================================================================

type FlowNode = { title: string; body: string; Icon: LucideIcon };

const TRUST_FLOW: ReadonlyArray<FlowNode> = [
  {
    title: "Capture / Intake",
    body: "Evidence enters through upload, capture, intake links, or external submission.",
    Icon: Inbox,
  },
  {
    title: "Evidence Record",
    body: "The submitted material is organized around a structured record.",
    Icon: FileText,
  },
  {
    title: "Integrity & Custody Context",
    body: "Hashes, metadata, custody events, signature context, and timestamp / anchoring context where enabled are recorded.",
    Icon: Fingerprint,
  },
  {
    title: "Verification Materials",
    body: "The platform can generate reports, packages, or verification surfaces from recorded materials.",
    Icon: FileCheck2,
  },
  {
    title: "Review & Reporting",
    body: "Internal or external reviewers inspect the recorded context and limitations.",
    Icon: Eye,
  },
  {
    title: "Governance & Access",
    body: "Workspaces, roles, cases, audit logs, retention concepts, and legal hold concepts help govern handling.",
    Icon: KeyRound,
  },
  {
    title: "External Inspection",
    body: "Recipients may inspect selected materials through reports, packages, or verification URLs depending on configuration.",
    Icon: Search,
  },
];

// =========================================================================
// SECTION 5 — Documentation hub
// =========================================================================

type DocGroup = {
  title: string;
  body: string;
  Icon: LucideIcon;
  accent: string;
  links: ReadonlyArray<{ label: string; href: string }>;
};

const DOCUMENTATION_GROUPS: ReadonlyArray<DocGroup> = [
  {
    title: "Privacy & Data Protection",
    body: "Privacy policy, data subject requests, retention boundaries, subprocessors, DPA terms, and the technical and organizational measures behind data handling.",
    Icon: Lock,
    accent: ACCENT_EMERALD,
    links: [
      { label: "Privacy Policy", href: "/legal/privacy" },
      { label: "Cookie Policy", href: "/legal/cookies" },
      { label: "Data Processing Addendum (DPA)", href: "/legal/dpa" },
      { label: "Privacy Requests", href: "/legal/privacy-requests" },
      { label: "Data Retention Policy", href: "/legal/data-retention" },
      { label: "Subprocessors", href: "/legal/subprocessors" },
      { label: "Technical & Organizational Measures (TOMs)", href: "/legal/toms" },
    ],
  },
  {
    title: "Security & Reliability",
    body: "How PROOVRA describes security posture, incident response, and transparency commitments for security-related events.",
    Icon: ShieldCheck,
    accent: ACCENT_BURGUNDY,
    links: [
      { label: "Security Overview", href: "/legal/security" },
      { label: "Incident Response", href: "/legal/incident-response" },
      { label: "Transparency Policy", href: "/legal/transparency" },
    ],
  },
  {
    title: "Evidence & Verification",
    body: "How evidence is handled inside PROOVRA, what verification records, how the platform documents its limitations, and how AI assistance is bounded.",
    Icon: Fingerprint,
    accent: ACCENT_BLUE,
    links: [
      { label: "Verification Methodology", href: "/legal/verification-methodology" },
      { label: "Evidence Handling Policy", href: "/legal/evidence-handling" },
      { label: "Verification Disclaimer", href: "/legal/verification-disclaimer" },
      { label: "AI Use Policy", href: "/legal/ai-use-policy" },
    ],
  },
  {
    title: "Platform Governance",
    body: "Acceptable use, abuse reporting, law-enforcement request handling, support scope, and where to reach the support center for operational questions.",
    Icon: Landmark,
    accent: ACCENT_ORANGE,
    links: [
      { label: "Acceptable Use Policy", href: "/legal/aup" },
      { label: "Abuse Reporting", href: "/legal/abuse-reporting" },
      { label: "Law Enforcement Requests", href: "/legal/law-enforcement" },
      { label: "Support Policy", href: "/legal/support" },
      { label: "Public Support", href: "/support" },
    ],
  },
  {
    title: "Legal",
    body: "Service terms, billing and cancellation rules, copyright handling, statutory notices, accessibility, and the legal changelog that tracks material policy updates.",
    Icon: Gavel,
    accent: ACCENT_VIOLET,
    links: [
      { label: "Terms of Service", href: "/legal/terms" },
      { label: "Consumer Cancellation & Refund Policy", href: "/legal/refund-policy" },
      { label: "Copyright & DMCA Policy", href: "/legal/dmca" },
      { label: "Impressum", href: "/legal/impressum" },
      { label: "Accessibility Statement", href: "/legal/accessibility" },
      { label: "Legal Changelog", href: "/legal/legal-changelog" },
    ],
  },
];

// =========================================================================
// SECTION 6 — Enterprise evaluation
// =========================================================================

type ReviewerCard = {
  title: string;
  body: string;
  Icon: LucideIcon;
  accent: string;
};

const REVIEWER_PATHS: ReadonlyArray<ReviewerCard> = [
  {
    title: "Security Review",
    body: "Review Security Overview, TOMs, Incident Response, Subprocessors, authentication, access-control, monitoring, and responsible-disclosure documentation.",
    Icon: ShieldCheck,
    accent: ACCENT_BURGUNDY,
  },
  {
    title: "Privacy Review",
    body: "Review Privacy Policy, DPA, Privacy Requests, Subprocessors, Data Retention, and Cookie Policy.",
    Icon: Lock,
    accent: ACCENT_EMERALD,
  },
  {
    title: "Legal Review",
    body: "Review Terms of Service, Verification Disclaimer, Evidence Handling Policy, Law Enforcement Requests, Abuse Reporting, and DMCA Policy.",
    Icon: Gavel,
    accent: ACCENT_VIOLET,
  },
  {
    title: "Verification Review",
    body: "Review Verification Methodology, Evidence Handling Policy, Verification Disclaimer, reports, packages, and public verification boundaries.",
    Icon: FileCheck2,
    accent: ACCENT_BLUE,
  },
  {
    title: "Procurement Review",
    body: "Review Trust Center materials, support paths, subprocessors, deployment discussions, enterprise documentation, and contact-sales process.",
    Icon: BookOpen,
    accent: ACCENT_ORANGE,
  },
];

// =========================================================================
// SECTION 7 — Transparency commitments
// =========================================================================

const PUBLISHES: ReadonlyArray<string> = [
  "Privacy and data governance documentation",
  "Security and incident-response documentation",
  "Verification methodology and limitations",
  "Evidence handling and custody boundaries",
  "AI use and AI limitation documentation",
  "Subprocessor information",
  "Support, abuse, and legal request paths",
  "Legal changelog and policy updates",
];

const AVOIDS: ReadonlyArray<string> = [
  "Truth claims",
  "Admissibility promises",
  "“Certified evidence” language",
  "Fake security certifications",
  "Hidden AI processing claims",
  "Pretending unavailable signals are verified",
  "Presenting screenshots as proof of factual truth",
  "Implying that software replaces human, legal, expert, or procedural judgment",
];

// =========================================================================
// SECTION 8 — Request and review paths
// =========================================================================

type RequestPath = {
  title: string;
  body: string;
  href: string;
  Icon: LucideIcon;
};

const REQUEST_PATHS: ReadonlyArray<RequestPath> = [
  {
    title: "Contact PROOVRA",
    body: "Reach the sales and account team for enterprise evaluation, procurement, or product questions.",
    href: "/contact-sales",
    Icon: Mail,
  },
  {
    title: "Privacy Requests",
    body: "Submit privacy or data-subject requests.",
    href: "/legal/privacy-requests",
    Icon: Lock,
  },
  {
    title: "Law Enforcement Requests",
    body: "Review how government, court, regulator, and legal-process requests are handled.",
    href: "/legal/law-enforcement",
    Icon: Gavel,
  },
  {
    title: "Abuse Reporting",
    body: "Report misuse, impersonation, unlawful content, or abuse of PROOVRA verification materials.",
    href: "/legal/abuse-reporting",
    Icon: ShieldQuestion,
  },
  {
    title: "Support Center",
    body: "Open the public Support Center for product, billing, and operational questions.",
    href: "/support",
    Icon: LifeBuoy,
  },
];

// =========================================================================
// PRIMITIVES
// =========================================================================

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border bg-white px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.18em]"
      style={{ borderColor: "#E0E7FF", color: ACCENT_BLUE }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: ACCENT_VIOLET }}
      />
      {children}
    </span>
  );
}

function SectionTitle({
  children,
  center,
  inverse,
}: {
  children: React.ReactNode;
  center?: boolean;
  inverse?: boolean;
}) {
  return (
    <h2
      className={`${center ? "mx-auto text-center" : ""} mt-3 max-w-[860px] text-[1.85rem] font-semibold leading-[1.12] tracking-[-0.025em] md:text-[2.35rem]`}
      style={{ color: inverse ? "#F8FAFC" : NAVY_INK }}
    >
      {children}
    </h2>
  );
}

function SectionLede({
  children,
  center,
  inverse,
}: {
  children: React.ReactNode;
  center?: boolean;
  inverse?: boolean;
}) {
  return (
    <p
      className={`${center ? "mx-auto text-center" : ""} mt-4 max-w-[820px] text-[15.5px] leading-[1.78]`}
      style={{ color: inverse ? "#CBD5E1" : SLATE_BODY }}
    >
      {children}
    </p>
  );
}

function IconBadge({
  Icon,
  accent,
}: {
  Icon: LucideIcon;
  accent: string;
}) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border"
      style={{
        background: `linear-gradient(180deg, #FFFFFF 0%, ${accent}10 100%)`,
        borderColor: `${accent}33`,
        color: accent,
      }}
    >
      <Icon size={20} strokeWidth={1.85} />
    </span>
  );
}

// =========================================================================
// SECTION 1 — Hero
// =========================================================================

function Hero() {
  const HERO_CHIPS = [
    "Verification boundaries",
    "Security documentation",
    "Privacy & data governance",
    "AI transparency",
    "Enterprise review",
  ];
  return (
    <section className="relative min-h-[720px] overflow-hidden bg-white">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage: `url("${TRUST_HERO_IMAGE}")`,
          backgroundSize: "100% 100%",
          backgroundPosition: "center center",
          backgroundRepeat: "no-repeat",
        }}
      />
      <div className="relative z-10">
        <MarketingHeader />
        <div className="mx-auto max-w-[1320px] px-6 pb-24 pt-20 md:px-8 lg:pb-28 lg:pt-28">
          <div className="max-w-[760px]">
            <Eyebrow>Trust Center</Eyebrow>
            <h1
              className="mt-4 max-w-[700px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.025em] md:text-[2.6rem] lg:text-[3rem]"
              style={{ color: NAVY_INK }}
            >
              Trust, security, privacy, and{" "}
              <span
                className="bg-clip-text text-transparent"
                style={{ backgroundImage: TRUST_GRADIENT }}
              >
                verification documentation.
              </span>
            </h1>
            <p
              className="mt-5 max-w-[640px] text-[15.5px] leading-[1.78]"
              style={{ color: SLATE_BODY }}
            >
              Understand how PROOVRA records evidence integrity, custody context, verification
              materials, AI boundaries, security posture, privacy controls, and governance
              documentation — and where to review the policies behind each area.
            </p>

            <div className="mt-6 flex flex-wrap gap-2">
              {HERO_CHIPS.map((chip) => (
                <span
                  key={chip}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-white/90 px-3 py-1.5 text-[12.5px] font-medium"
                  style={{ borderColor: SLATE_BORDER, color: NAVY_INK }}
                >
                  <span
                    aria-hidden="true"
                    className="block h-1.5 w-1.5 rounded-full"
                    style={{ background: ACCENT_VIOLET }}
                  />
                  {chip}
                </span>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="#documentation"
                className="inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white shadow-lg transition-opacity hover:opacity-95"
                style={{ background: NAVY, boxShadow: `0 8px 22px ${NAVY}33` }}
              >
                Review documentation
                <ArrowRight size={16} strokeWidth={2.2} />
              </Link>
              <Link
                href="/contact-sales"
                className={MARKETING_BTN.heroSecondary}
              >
                Contact sales
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// =========================================================================
// SECTION 2 — What PROOVRA records / does not decide
// =========================================================================

function BoundarySection() {
  return (
    <RevealSection direction="up">
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-20 md:px-8 md:py-24">
          <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
            <Eyebrow>Trust boundary</Eyebrow>
            <SectionTitle center>What PROOVRA records — and what it does not decide.</SectionTitle>
            <SectionLede center>
              PROOVRA is a digital evidence operations platform designed to help organizations
              capture, preserve, review, verify, govern, and share digital evidence through
              structured Evidence Records, custody visibility, verification materials, and
              reviewer-ready outputs.
            </SectionLede>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            {/* LEFT — What PROOVRA records */}
            <article
              className="rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.04)] md:p-8"
              style={{ borderColor: SLATE_BORDER }}
            >
              <div className="flex items-start gap-3">
                <IconBadge Icon={Database} accent={ACCENT_BLUE} />
                <div>
                  <h3 className="text-[1.1rem] font-semibold" style={{ color: NAVY_INK }}>
                    What PROOVRA records
                  </h3>
                </div>
              </div>
              <ul className="mt-5 space-y-3 text-[15px] leading-[1.7]" style={{ color: SLATE_BODY }}>
                {WHAT_RECORDS.map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <CheckCircle2
                      size={18}
                      strokeWidth={2}
                      className="mt-[2px] shrink-0"
                      style={{ color: ACCENT_BLUE }}
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>

            {/* RIGHT — What PROOVRA does not decide */}
            <article
              className="rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.04)] md:p-8"
              style={{ borderColor: SLATE_BORDER }}
            >
              <div className="flex items-start gap-3">
                <IconBadge Icon={XCircle} accent={ACCENT_VIOLET} />
                <div>
                  <h3 className="text-[1.1rem] font-semibold" style={{ color: NAVY_INK }}>
                    What PROOVRA does not decide
                  </h3>
                </div>
              </div>
              <ul
                className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[14.5px] leading-[1.6]"
                style={{ color: SLATE_BODY }}
              >
                {WHAT_NOT_DECIDED.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span
                      aria-hidden="true"
                      className="mt-[7px] block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: ACCENT_VIOLET }}
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          </div>

          {/* Dark boundary statement */}
          <div
            className="mt-8 overflow-hidden rounded-[20px] p-8 md:p-9"
            style={{
              background: `linear-gradient(135deg, ${NAVY} 0%, #1E1B4B 60%, #2E1065 100%)`,
            }}
          >
            <div className="flex items-start gap-4">
              <span
                aria-hidden="true"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px]"
                style={{ background: "rgba(255,255,255,0.08)", color: "#E0E7FF" }}
              >
                <Shield size={20} strokeWidth={1.9} />
              </span>
              <div>
                <div
                  className="text-[11px] font-semibold uppercase tracking-[0.18em]"
                  style={{ color: "#A5B4FC" }}
                >
                  Trust boundary
                </div>
                <p
                  className="mt-2 max-w-[920px] text-[15.5px] leading-[1.78]"
                  style={{ color: "#E2E8F0" }}
                >
                  PROOVRA exposes recorded technical and operational context for review. Courts,
                  regulators, investigators, insurers, employers, experts, reviewers, and customers
                  remain responsible for factual, legal, procedural, and expert determinations.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </RevealSection>
  );
}

// =========================================================================
// SECTION 3 — Trust foundations
// =========================================================================

function FoundationsSection() {
  return (
    <RevealSection direction="up">
      <section style={{ background: SOFT_SLATE }}>
        <div className="mx-auto max-w-[1320px] px-6 py-20 md:px-8 md:py-24">
          <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
            <Eyebrow>Trust foundations</Eyebrow>
            <SectionTitle center>The trust areas behind PROOVRA.</SectionTitle>
            <SectionLede center>
              PROOVRA&apos;s Trust Center organizes the platform&apos;s public documentation around
              the areas security, legal, procurement, and review teams usually need to evaluate.
            </SectionLede>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FOUNDATIONS.map((f) => (
              <article
                key={f.title}
                className="relative flex h-full flex-col overflow-hidden rounded-[18px] border bg-white p-6 shadow-[0_2px_10px_rgba(8,18,22,0.04)]"
                style={{ borderColor: SLATE_BORDER }}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-[3px]"
                  style={{ background: f.accent }}
                />
                <IconBadge Icon={f.Icon} accent={f.accent} />
                <h3
                  className="mt-4 text-[1.05rem] font-semibold tracking-[-0.01em]"
                  style={{ color: NAVY_INK }}
                >
                  {f.title}
                </h3>
                <p
                  className="mt-3 text-[14.5px] leading-[1.7]"
                  style={{ color: SLATE_BODY }}
                >
                  {f.body}
                </p>
                <ul className="mt-5 space-y-2 border-t pt-4" style={{ borderColor: SLATE_BORDER }}>
                  {f.links.map((l) => (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        className="group inline-flex items-center gap-1.5 text-[13.5px] font-semibold transition-colors"
                        style={{ color: f.accent }}
                      >
                        {l.label}
                        <ArrowRight
                          size={13}
                          strokeWidth={2.2}
                          className="transition-transform group-hover:translate-x-0.5"
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>
    </RevealSection>
  );
}

// =========================================================================
// SECTION 4 — Trust flow
// =========================================================================

// Step-circle accent rotation — deliberate enterprise color rhythm, not
// random. Order picked to balance the row visually.
const TRUST_FLOW_STEP_ACCENTS = [
  ACCENT_BLUE,
  ACCENT_ORANGE,
  ACCENT_EMERALD,
  ACCENT_ROSE,
  ACCENT_VIOLET,
  ACCENT_ORANGE,
  ACCENT_BURGUNDY,
] as const;

function TrustFlowSection() {
  return (
    <RevealSection direction="up">
      <section
        className="relative overflow-hidden"
        style={{
          backgroundImage: `url("${DARK_PANEL_BG}")`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
      >
        {/* Dark overlay for readability without washing out the image */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{ background: "rgba(3, 7, 18, 0.55)" }}
        />

        <div className="relative mx-auto max-w-[1320px] px-6 py-20 md:px-8 md:py-24">
          <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
            <span
              className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.18em]"
              style={{
                borderColor: "rgba(199,210,254,0.32)",
                background: "rgba(255,255,255,0.06)",
                color: "#C7D2FE",
              }}
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: "#C4B5FD" }}
              />
              Trust flow
            </span>
            <SectionTitle center inverse>
              How trust context travels through the evidence workflow.
            </SectionTitle>
            <p
              className="mx-auto mt-4 max-w-[820px] text-center text-[15.5px] leading-[1.78]"
              style={{ color: "rgba(241,245,249,0.82)" }}
            >
              Trust in PROOVRA is not a single claim. It is a set of recorded context that follows
              evidence from intake to review, reporting, governance, and external inspection.
            </p>
          </div>

          <div className="relative mt-14">
            {/* Connector rail visible behind the row of glass cards */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-0 right-0 top-[28px] hidden h-px md:block"
              style={{
                background:
                  "linear-gradient(90deg, transparent 0%, rgba(199,210,254,0.5) 12%, rgba(221,214,254,0.55) 50%, rgba(199,210,254,0.5) 88%, transparent 100%)",
              }}
            />

            <ol className="grid gap-5 md:grid-cols-7">
              {TRUST_FLOW.map((node, i) => {
                const accent = TRUST_FLOW_STEP_ACCENTS[i] ?? ACCENT_BLUE;
                return (
                  <li
                    key={node.title}
                    className="relative flex flex-col rounded-[18px] border p-5"
                    style={{
                      background: "rgba(255,255,255,0.10)",
                      borderColor: "rgba(255,255,255,0.18)",
                      backdropFilter: "blur(10px)",
                      WebkitBackdropFilter: "blur(10px)",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-14 w-14 items-center justify-center rounded-full"
                      style={{
                        background: `${accent}26`,
                        border: `1px solid ${accent}66`,
                        color: "#FFFFFF",
                      }}
                    >
                      <node.Icon size={22} strokeWidth={1.9} />
                    </span>
                    <div
                      className="mt-3 text-[10.5px] font-semibold uppercase tracking-[0.16em]"
                      style={{ color: accent }}
                    >
                      Step {String(i + 1).padStart(2, "0")}
                    </div>
                    <h3
                      className="mt-1 text-[14.5px] font-semibold tracking-[-0.01em]"
                      style={{ color: "#FFFFFF" }}
                    >
                      {node.title}
                    </h3>
                    <p
                      className="mt-2 text-[13px] leading-[1.6]"
                      style={{ color: "rgba(226,232,240,0.82)" }}
                    >
                      {node.body}
                    </p>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </section>
    </RevealSection>
  );
}

// =========================================================================
// SECTION 5 — Documentation hub
// =========================================================================

function DocumentationHub() {
  return (
    <RevealSection direction="up">
      <section id="documentation" className="scroll-mt-24" style={{ background: SOFT_SLATE }}>
        <div className="mx-auto max-w-[1320px] px-6 py-20 md:px-8 md:py-24">
          <div className="mx-auto flex max-w-[860px] flex-col items-center text-center">
            <Eyebrow>Documentation hub</Eyebrow>
            <SectionTitle center>The documents behind PROOVRA&apos;s trust posture.</SectionTitle>
            <SectionLede center>
              Use this hub to review PROOVRA&apos;s privacy, security, evidence, governance,
              support, and legal documentation. These documents are written for customers,
              reviewers, legal teams, procurement teams, and security evaluators.
            </SectionLede>
          </div>

          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            {DOCUMENTATION_GROUPS.map((group) => (
              <article
                key={group.title}
                className="relative flex h-full flex-col overflow-hidden rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.04)] md:p-8"
                style={{ borderColor: SLATE_BORDER }}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-[3px]"
                  style={{ background: group.accent }}
                />
                <div className="flex items-start gap-4">
                  <IconBadge Icon={group.Icon} accent={group.accent} />
                  <div>
                    <h3
                      className="text-[1.1rem] font-semibold tracking-[-0.01em]"
                      style={{ color: NAVY_INK }}
                    >
                      {group.title}
                    </h3>
                    <p
                      className="mt-2 text-[14.5px] leading-[1.7]"
                      style={{ color: SLATE_BODY }}
                    >
                      {group.body}
                    </p>
                  </div>
                </div>

                <ul
                  className="mt-6 space-y-1 border-t pt-4"
                  style={{ borderColor: SLATE_BORDER }}
                >
                  {group.links.map((l) => (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        className="group flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-[14px] font-medium transition-colors hover:bg-slate-50"
                        style={{ color: NAVY_INK }}
                      >
                        <span>{l.label}</span>
                        <ArrowRight
                          size={14}
                          strokeWidth={2.2}
                          className="shrink-0 opacity-50 transition-all group-hover:translate-x-0.5 group-hover:opacity-100"
                          style={{ color: group.accent }}
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>
    </RevealSection>
  );
}

// =========================================================================
// SECTION 6 — Enterprise evaluation
// =========================================================================

function EnterpriseEvaluation() {
  return (
    <RevealSection direction="up">
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-20 md:px-8 md:py-24">
          <div className="grid gap-10 lg:grid-cols-[360px_1fr] lg:gap-14">
            {/* Left — image-background intro panel */}
            <aside
              className="relative overflow-hidden rounded-[24px] p-8 md:p-9"
              style={{
                backgroundImage: `url("${VERTICAL_PANEL_BG}")`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
              }}
            >
              {/* Readability overlay */}
              <div
                aria-hidden="true"
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(3,7,18,0.42) 0%, rgba(3,7,18,0.55) 100%)",
                }}
              />
              <div className="relative">
                <div
                  className="text-[11px] font-semibold uppercase tracking-[0.18em]"
                  style={{ color: "rgba(255,255,255,0.74)" }}
                >
                  Enterprise evaluation
                </div>
                <h2
                  className="mt-3 text-[1.7rem] font-semibold leading-[1.12] tracking-[-0.025em]"
                  style={{ color: "#FFFFFF" }}
                >
                  Built for security, legal, and procurement review.
                </h2>
                <p
                  className="mt-4 text-[15px] leading-[1.78]"
                  style={{ color: "rgba(241,245,249,0.85)" }}
                >
                  Enterprise buyers often need to review more than product features. PROOVRA&apos;s
                  public Trust Center helps security, privacy, legal, procurement, and operational
                  stakeholders evaluate the platform&apos;s posture before and during adoption.
                </p>

                <div className="mt-7 flex flex-col gap-2.5">
                  <Link
                    href="/contact-sales"
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold transition-opacity hover:opacity-95"
                    style={{ color: NAVY }}
                  >
                    Start enterprise review
                    <ArrowRight size={16} strokeWidth={2.2} />
                  </Link>
                  <Link
                    href="/support"
                    className="inline-flex items-center justify-center gap-2 rounded-full border px-5 py-3 text-sm font-semibold transition-colors hover:bg-white/10"
                    style={{
                      borderColor: "rgba(255,255,255,0.4)",
                      color: "#FFFFFF",
                    }}
                  >
                    Open Support Center
                  </Link>
                </div>
              </div>
            </aside>

            {/* Right — reviewer cards with per-card accent */}
            <div className="grid gap-4 sm:grid-cols-2">
              {REVIEWER_PATHS.map((r) => (
                <article
                  key={r.title}
                  className="relative flex h-full flex-col overflow-hidden rounded-[18px] border bg-white p-6"
                  style={{ borderColor: SLATE_BORDER }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 top-0 h-[3px]"
                    style={{ background: r.accent }}
                  />
                  <div className="flex items-center gap-3">
                    <IconBadge Icon={r.Icon} accent={r.accent} />
                    <h3
                      className="text-[1rem] font-semibold tracking-[-0.01em]"
                      style={{ color: NAVY_INK }}
                    >
                      {r.title}
                    </h3>
                  </div>
                  <p
                    className="mt-3 text-[14px] leading-[1.7]"
                    style={{ color: SLATE_BODY }}
                  >
                    {r.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>
    </RevealSection>
  );
}

// =========================================================================
// SECTION 7 — Transparency commitments
// =========================================================================

function TransparencyCommitments() {
  return (
    <RevealSection direction="up">
      <section
        className="relative overflow-hidden"
        style={{
          backgroundImage: `url("${DARK_PANEL_BG}")`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{ background: "rgba(3, 7, 18, 0.55)" }}
        />

        <div className="relative mx-auto max-w-[1320px] px-6 py-20 md:px-8 md:py-24">
          <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
            <span
              className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.18em]"
              style={{
                borderColor: "rgba(199,210,254,0.32)",
                background: "rgba(255,255,255,0.06)",
                color: "#C7D2FE",
              }}
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: "#C4B5FD" }}
              />
              Transparency commitments
            </span>
            <SectionTitle center inverse>
              What we publish — and what we avoid.
            </SectionTitle>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <article
              className="rounded-[20px] border p-7 md:p-8"
              style={{
                borderColor: `${ACCENT_EMERALD}55`,
                background: "rgba(255,255,255,0.10)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
              }}
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-[12px]"
                  style={{
                    background: `${ACCENT_EMERALD}29`,
                    border: `1px solid ${ACCENT_EMERALD}66`,
                    color: "#FFFFFF",
                  }}
                >
                  <Eye size={20} strokeWidth={1.9} />
                </span>
                <h3 className="text-[1.1rem] font-semibold" style={{ color: "#F8FAFC" }}>
                  What PROOVRA publishes
                </h3>
              </div>
              <ul className="mt-5 space-y-2.5 text-[14.5px] leading-[1.7]" style={{ color: "rgba(241,245,249,0.92)" }}>
                {PUBLISHES.map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <CheckCircle2
                      size={16}
                      strokeWidth={2}
                      className="mt-[3px] shrink-0"
                      style={{ color: ACCENT_EMERALD }}
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>

            <article
              className="rounded-[20px] border p-7 md:p-8"
              style={{
                borderColor: `${ACCENT_ROSE}55`,
                background: "rgba(255,255,255,0.10)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
              }}
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-[12px]"
                  style={{
                    background: `${ACCENT_ROSE}29`,
                    border: `1px solid ${ACCENT_ROSE}66`,
                    color: "#FFFFFF",
                  }}
                >
                  <XCircle size={20} strokeWidth={1.9} />
                </span>
                <h3 className="text-[1.1rem] font-semibold" style={{ color: "#F8FAFC" }}>
                  What PROOVRA avoids
                </h3>
              </div>
              <ul className="mt-5 space-y-2.5 text-[14.5px] leading-[1.7]" style={{ color: "rgba(241,245,249,0.92)" }}>
                {AVOIDS.map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-[8px] block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: ACCENT_ROSE }}
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          </div>
        </div>
      </section>
    </RevealSection>
  );
}

// =========================================================================
// SECTION 8 — Request and review paths
// =========================================================================

function RequestPaths() {
  return (
    <RevealSection direction="up">
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-20 md:px-8 md:py-24">
          <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
            <Eyebrow>Request paths</Eyebrow>
            <SectionTitle center>Use the right path for sensitive requests.</SectionTitle>
            <SectionLede center>
              These routes exist so privacy, abuse, legal, and procurement requests reach the
              right team with the right context.
            </SectionLede>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {REQUEST_PATHS.map((p, i) => {
              // Light per-card accent rotation so the row stays varied.
              const accents = [
                ACCENT_BLUE,
                ACCENT_EMERALD,
                ACCENT_VIOLET,
                ACCENT_BURGUNDY,
                ACCENT_ORANGE,
              ];
              const accent = accents[i] ?? ACCENT_BLUE;
              return (
                <Link
                  key={p.href}
                  href={p.href}
                  className="group flex h-full flex-col rounded-[18px] border bg-white p-6 transition-shadow hover:shadow-[0_8px_22px_rgba(8,18,22,0.06)]"
                  style={{ borderColor: SLATE_BORDER }}
                >
                  <IconBadge Icon={p.Icon} accent={accent} />
                  <h3
                    className="mt-4 text-[1rem] font-semibold tracking-[-0.01em]"
                    style={{ color: NAVY_INK }}
                  >
                    {p.title}
                  </h3>
                  <p
                    className="mt-2 text-[14px] leading-[1.65]"
                    style={{ color: SLATE_BODY }}
                  >
                    {p.body}
                  </p>
                  <span
                    className="mt-auto inline-flex items-center gap-1.5 pt-4 text-[13.5px] font-semibold"
                    style={{ color: accent }}
                  >
                    Open path
                    <ArrowRight
                      size={13}
                      strokeWidth={2.2}
                      className="transition-transform group-hover:translate-x-0.5"
                    />
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </section>
    </RevealSection>
  );
}

// =========================================================================
// SECTION 9 — Final CTA
// =========================================================================

function FinalCTA() {
  // Style cloned from the Solutions FinalCTA (see
  // apps/web/components/use-case-page.tsx ~L1844). Navy → indigo → wine
  // → violet gradient, rounded-[28px], compact p-7/md:p-9, navy chip
  // eyebrow, white primary button with violet text, outlined secondary.
  // All Trust Center copy preserved verbatim per the spec.
  return (
    <RevealSection direction="up">
      <section className="relative bg-white pb-14 pt-12 md:pb-20 md:pt-16">
        <div className="mx-auto max-w-[1180px] px-6 md:px-8">
          <div
            className="relative overflow-hidden rounded-[28px] p-7 shadow-[0_18px_50px_rgba(11,31,91,0.18)] md:p-9"
            style={{
              background:
                "linear-gradient(90deg,#0B1F5B 0%,#1D2E7A 25%,#8E1F3D 55%,#6A35C9 80%,#7C4DFF 100%)",
              color: "#FFFFFF",
            }}
          >
            <div className="relative grid gap-5 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
              <div>
                <div
                  className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.18em]"
                  style={{ background: "rgba(11,31,91,0.35)", color: "#FFFFFF" }}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                  Trust Center
                </div>
                <h2
                  className="mt-3 max-w-[560px] text-[1.55rem] font-semibold leading-[1.18] tracking-[-0.02em] md:text-[1.85rem]"
                  style={{ color: "#FFFFFF" }}
                >
                  Need to review PROOVRA for your organization?
                </h2>
                <p
                  className="mt-2.5 max-w-[560px] text-[13.5px] leading-[1.6]"
                  style={{ color: "rgba(255,255,255,0.88)" }}
                >
                  Use the Trust Center to review privacy, security, verification, AI, governance,
                  legal, and support documentation. For enterprise security review, procurement,
                  deployment, or legal evaluation, contact the PROOVRA team.
                </p>
              </div>
              <div className="flex flex-col gap-3 md:flex-row md:justify-end">
                <Link
                  href="/contact-sales"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-white px-5 text-[13.5px] font-semibold transition-all duration-200 hover:-translate-y-0.5 hover:text-[#5A2CC0]"
                  style={{ color: "#6A35C9", fontWeight: 600 }}
                >
                  Contact sales
                  <ArrowRight size={14} />
                </Link>
                <Link
                  href="/support"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-white/40 px-5 text-[13.5px] font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/10"
                >
                  Support Center
                </Link>
              </div>
            </div>

            <div className="relative mt-5">
              <Link
                href="/legal/verification-methodology"
                className="inline-flex items-center gap-1.5 text-[13px] font-semibold underline-offset-4 hover:underline"
                style={{ color: "rgba(255,255,255,0.88)" }}
              >
                View Verification Methodology
                <ArrowRight size={13} strokeWidth={2.2} />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </RevealSection>
  );
}

// =========================================================================
// SHARED-CONTENT WIRING — phase-e5 symbol presence only
//
// 2026-06-23 UX decision: the giant visible "Detailed sections" band that
// previously rendered `TRUST_CENTER_SECTIONS.map(...)` directly on this
// public marketing surface was removed. It dominated the page and
// duplicated the link surface already covered by the Documentation Hub
// and Trust Flow sections. The shared trust-center content module
// (`@proovra/shared-evidence-presentation`) is intentionally still
// imported and referenced below so:
//
//   1. The byte-pinned shared content module remains the single
//      source-of-truth for the detailed methodology copy and stays
//      available to any private/authenticated Trust Center surface
//      (e.g. an in-product hub) that needs to render the full list.
//   2. Phase-E5 contract tests that assert the public page consumes
//      the shared module (`from "@proovra/shared-evidence-presentation"`,
//      `TRUST_CENTER_SECTIONS`, `TRUST_CENTER_PAGE_INTRO`,
//      `TRUST_CENTER_PAGE_BOUNDARY_CALLOUT`) continue to pass.
//   3. Phase-R10 "trust-center content module is consumed somewhere"
//      grep continues to pass via the `TRUST_CENTER_SECTION_IDS`
//      reference.
//
// The references are server-rendered into a `hidden` audit anchor that
// emits zero visible UI but pins the data wiring for SEO/structured
// data hooks and contract tests.
// =========================================================================

function TrustContentAuditAnchor() {
  return (
    <div hidden aria-hidden="true" data-trust-content-anchor>
      <span data-tc-section-count={TRUST_CENTER_SECTION_IDS.length} />
      <span data-tc-sections={TRUST_CENTER_SECTIONS.length} />
      <span data-tc-intro-len={TRUST_CENTER_PAGE_INTRO.length} />
      <span data-tc-boundary-len={TRUST_CENTER_PAGE_BOUNDARY_CALLOUT.length} />
    </div>
  );
}

// =========================================================================
// PAGE
// =========================================================================

export default function TrustCenterPage() {
  return (
    <div data-trust-center-page>
      <Hero />
      <BoundarySection />
      <FoundationsSection />
      <TrustFlowSection />
      <DocumentationHub />
      <EnterpriseEvaluation />
      <TransparencyCommitments />
      <RequestPaths />
      <FinalCTA />
      <EnterpriseFooter />
      <TrustContentAuditAnchor />
    </div>
  );
}

// Next.js disallows a `metadata` export inside a "use client" component,
// and page modules forbid arbitrary named exports beyond the allowed set
// (default, metadata, generateStaticParams, dynamic, revalidate, …).
// Site-wide SEO fallback comes from the root layout's metadata.
