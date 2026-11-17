"use client";

/**
 * B2A-F-12 — the Support page reads the reader's language (`useT()`, the
 * shared dictionary `SUPPORT_LEADS_COPY`). A client page cannot export
 * metadata, so the segment's metadata is in ./layout.tsx.
 */
import { scrollRegionProps } from "../../lib/ui/scrollRegion";
import type { ReactNode } from "react";
import Link from "next/link";
import { fillCopy } from "@proovra/shared/i18n";
import { useT, type TranslationKey } from "../providers";
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
import { MARKETING_BTN } from "../../lib/marketing-buttons";

const HERO_BG = "/assets/hero/support-hero.png";
const SUPPORT_EMAIL = "support@proovra.com";
const BILLING_EMAIL = "billing@proovra.com";
const SECURITY_EMAIL = "security@proovra.com";

// ---------------------------------------------------------------------------
// Section 2 — Support paths
// ---------------------------------------------------------------------------

const SUPPORT_PATHS: ReadonlyArray<{
  label: TranslationKey;
  title: TranslationKey;
  body: TranslationKey;
  href: string;
  /** A translated CTA, or "Email <address>" when `email` is set. */
  cta: TranslationKey;
  email?: string;
  external?: boolean;
}> = [
  {
    label: "supportPathProductLabel",
    title: "supportPathProductTitle",
    body: "supportPathProductBody",
    href: `mailto:${SUPPORT_EMAIL}`,
    cta: "supportPathEmailCta",
    email: SUPPORT_EMAIL,
    external: true,
  },
  {
    label: "supportPathBillingLabel",
    title: "supportPathBillingTitle",
    body: "supportPathBillingBody",
    href: `mailto:${BILLING_EMAIL}`,
    cta: "supportPathEmailCta",
    email: BILLING_EMAIL,
    external: true,
  },
  {
    label: "supportPathSecurityLabel",
    title: "supportPathSecurityTitle",
    body: "supportPathSecurityBody",
    href: "/legal/security",
    cta: "supportPathSecurityCta",
  },
  {
    label: "supportPathLegalLabel",
    title: "supportPathLegalTitle",
    body: "supportPathLegalBody",
    href: "/trust",
    cta: "supportPathLegalCta",
  },
];

// ---------------------------------------------------------------------------
// Section 4 — Support scope
// ---------------------------------------------------------------------------

const SUPPORT_CAN_HELP: ReadonlyArray<TranslationKey> = [
  "supportCanHelp1",
  "supportCanHelp2",
  "supportCanHelp3",
  "supportCanHelp4",
  "supportCanHelp5",
  "supportCanHelp6",
];

const SUPPORT_CANNOT_DO: ReadonlyArray<TranslationKey> = [
  "supportCannot1",
  "supportCannot2",
  "supportCannot3",
  "supportCannot4",
  "supportCannot5",
  "supportCannot6",
  "supportCannot7",
];

// ---------------------------------------------------------------------------
// Section 5 — Response expectations
// ---------------------------------------------------------------------------

const RESPONSE_EXPECTATIONS: ReadonlyArray<{
  type: TranslationKey;
  path: TranslationKey;
  expectation: TranslationKey;
}> = [
  { type: "supportPathProductTitle", path: "supportRespProductPath", expectation: "supportRespProductExpect" },
  { type: "supportRespBillingType", path: "supportDestBilling", expectation: "supportRespBillingExpect" },
  { type: "supportChipSecurity", path: "supportDestSecurity", expectation: "supportRespSecurityExpect" },
  { type: "supportRespPrivacyType", path: "supportRespPrivacyPath", expectation: "supportRespPrivacyExpect" },
  { type: "supportSensitiveLawTitle", path: "supportRespLawPath", expectation: "supportRespLawExpect" },
  { type: "supportRespEnterpriseType", path: "supportDestSales", expectation: "supportRespEnterpriseExpect" },
];

// ---------------------------------------------------------------------------
// Section 6 — Enterprise evaluation
// ---------------------------------------------------------------------------

const ENTERPRISE_CHECKLIST: ReadonlyArray<TranslationKey> = [
  "supportChecklist1",
  "supportChecklist2",
  "supportChecklist3",
  "supportChecklist4",
  "supportChecklist5",
  "supportChecklist6",
  "supportChecklist7",
  "supportChecklist8",
  "supportChecklist9",
  "supportChecklist10",
];

const REVIEW_PACKET: ReadonlyArray<{
  label: TranslationKey;
  href: string;
  Icon: LucideIcon;
}> = [
  { label: "supportDocTrustCenter", href: "/trust", Icon: BadgeCheck },
  { label: "supportDocDpa", href: "/legal/dpa", Icon: ClipboardCheck },
  { label: "supportDocSecurityOverview", href: "/legal/security", Icon: LockKeyhole },
  { label: "supportDocSubprocessors", href: "/legal/subprocessors", Icon: Network },
  { label: "supportDocVerificationMethodology", href: "/legal/verification-methodology", Icon: Fingerprint },
];

// ---------------------------------------------------------------------------
// Section 7 — Security review resources
// ---------------------------------------------------------------------------

const SECURITY_REVIEW: ReadonlyArray<{
  title: TranslationKey;
  body: TranslationKey;
  href: string;
  /** The document named in the "Open …" call to action. */
  ctaDoc: TranslationKey;
}> = [
  {
    title: "supportDocSecurityOverview",
    body: "supportSecReviewSecurityBody",
    href: "/legal/security",
    ctaDoc: "supportDocSecurityOverview",
  },
  {
    title: "supportDocToms",
    body: "supportSecReviewTomsBody",
    href: "/legal/toms",
    ctaDoc: "supportDocTomsShort",
  },
  {
    title: "supportDocIncidentResponse",
    body: "supportSecReviewIncidentBody",
    href: "/legal/incident-response",
    ctaDoc: "supportDocIncidentResponse",
  },
  {
    title: "supportDocSubprocessors",
    body: "supportSecReviewSubprocessorsBody",
    href: "/legal/subprocessors",
    ctaDoc: "supportDocSubprocessors",
  },
];

// ---------------------------------------------------------------------------
// Section 8 — Sensitive / legal request paths
// ---------------------------------------------------------------------------

const SENSITIVE_REQUESTS: ReadonlyArray<{
  title: TranslationKey;
  body: TranslationKey;
  href: string;
  label: TranslationKey;
  Icon: typeof Gavel;
}> = [
  {
    title: "supportSensitiveLawTitle",
    body: "supportSensitiveLawBody",
    href: "/legal/law-enforcement",
    label: "supportDocLawEnforcement",
    Icon: Gavel,
  },
  {
    title: "supportSensitiveAbuseTitle",
    body: "supportSensitiveAbuseBody",
    href: "/legal/abuse-reporting",
    label: "supportDocAbuseReporting",
    Icon: ShieldAlert,
  },
  {
    title: "supportSensitivePrivacyTitle",
    body: "supportSensitivePrivacyBody",
    href: "/legal/privacy-requests",
    label: "supportDocPrivacyRequests",
    Icon: Scale,
  },
  {
    title: "supportSensitiveSecurityTitle",
    body: "supportSensitiveSecurityBody",
    href: "/legal/security",
    label: "supportDocSecurityOverview",
    Icon: Shield,
  },
];

// ---------------------------------------------------------------------------
// Section 10 — Helpful resources grouped
// ---------------------------------------------------------------------------

const RESOURCE_GROUPS: ReadonlyArray<{
  title: TranslationKey;
  subtitle: TranslationKey;
  links: ReadonlyArray<{ href: string; label: TranslationKey }>;
}> = [
  {
    title: "supportGroupTrustTitle",
    subtitle: "supportGroupTrustSubtitle",
    links: [
      { href: "/trust", label: "supportDocTrustCenter" },
      { href: "/legal/privacy-requests", label: "supportDocPrivacyRequests" },
      { href: "/legal/security", label: "supportDocSecurityOverview" },
      { href: "/legal/support", label: "supportDocSupportPolicy" },
    ],
  },
  {
    title: "supportGroupEvidenceTitle",
    subtitle: "supportGroupEvidenceSubtitle",
    links: [
      { href: "/legal/evidence-handling", label: "supportDocEvidenceHandling" },
      { href: "/legal/toms", label: "supportDocToms" },
      { href: "/legal/verification-disclaimer", label: "supportDocVerificationDisclaimer" },
      { href: "/legal/verification-methodology", label: "supportDocVerificationMethodology" },
    ],
  },
  {
    title: "supportGroupLegalTitle",
    subtitle: "supportGroupLegalSubtitle",
    links: [
      { href: "/legal/abuse-reporting", label: "supportDocAbuseReporting" },
      { href: "/legal/refund-policy", label: "supportDocRefund" },
      { href: "/legal/dmca", label: "supportDocDmca" },
      { href: "/legal/law-enforcement", label: "supportDocLawEnforcement" },
    ],
  },
  {
    title: "supportGroupEnterpriseTitle",
    subtitle: "supportGroupEnterpriseSubtitle",
    links: [
      { href: "/legal/ai-use-policy", label: "supportDocAiUse" },
      { href: "/contact-sales", label: "supportDocContactSales" },
      { href: "/legal/dpa", label: "supportDocDpa" },
      { href: "/legal/subprocessors", label: "supportDocSubprocessors" },
    ],
  },
];

const HERO_CHIPS: ReadonlyArray<TranslationKey> = [
  "supportChipProduct",
  "supportChipBilling",
  "supportChipSecurity",
  "supportChipLegal",
];
const REQUEST_TYPES: ReadonlyArray<TranslationKey> = [
  "supportPathProductLabel",
  "supportPathBillingLabel",
  "supportPathSecurityLabel",
  "supportTypeLegal",
  "supportTypeEnterprise",
];
const DESTINATIONS: ReadonlyArray<TranslationKey> = [
  "supportDestSupportTeam",
  "supportDestBilling",
  "supportDestSecurity",
  "supportDestLegal",
  "supportDestSales",
];

/**
 * A dictionary sentence with one `{slot}` replaced by an element (a link, a
 * highlighted phrase), so each language keeps its own word order.
 */
function withSlot(template: string, slot: string, node: ReactNode): ReactNode {
  const marker = `{${slot}}`;
  const at = template.indexOf(marker);
  if (at < 0) return template;
  return (
    <>
      {template.slice(0, at)}
      {node}
      {template.slice(at + marker.length)}
    </>
  );
}

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
  const t = useT();
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
                {t("supportEyebrow")}
              </span>

              <h1 className="mt-4 text-[2rem] font-semibold leading-[1.06] tracking-[-0.025em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
                {withSlot(
                  t("supportHeroTitle"),
                  "highlight",
                  <span
                    className="bg-clip-text text-transparent"
                    style={{
                      backgroundImage:
                        "linear-gradient(90deg, #2563EB 0%, #7C3AED 50%, #C026D3 100%)",
                    }}
                    >
                    {t("supportHeroHighlight")}
                  </span>,
                )}
              </h1>

              <p className="mt-4 max-w-[560px] text-[15px] leading-[1.65] text-[#475569]">
                {t("supportHeroLead")}
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-[#071B4D] px-5 text-[13.5px] font-semibold text-white shadow-[0_10px_24px_rgba(7,27,77,0.22)] transition hover:-translate-y-0.5"
                >
                  {t("supportEmailSupport")}
                </a>
                <Link
                  href="/contact-sales"
                  className={MARKETING_BTN.heroSecondary}
                >
                  {t("supportTalkToSales")}
                </Link>
              </div>

              {/* Hero chips — quick route hints */}
              <div className="mt-6 flex flex-wrap gap-2">
                {HERO_CHIPS.map((chip) => (
                  <span
                    key={chip}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white/85 px-3 py-1 text-[12px] font-medium text-[#0F172A]"
                  >
                    <span
                      aria-hidden="true"
                      className="block h-1.5 w-1.5 rounded-full bg-[#2563EB]"
                    />
                    {t(chip)}
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
            <SectionEyebrow tone="blue">{t("supportPathsEyebrow")}</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              {t("supportPathsTitle")}
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              {t("supportPathsLead")}
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
                    className="absolute start-0 top-6 h-7 w-[3px] rounded-e"
                    style={{ background: accent }}
                  />
                  <div
                    className="text-[11.5px] font-bold uppercase tracking-[0.14em]"
                    style={{ color: accent }}
                  >
                    {t(p.label)}
                  </div>
                  <h3 className="mt-2 text-[1.1rem] font-semibold tracking-[-0.01em] text-[#081426]">
                    {t(p.title)}
                  </h3>
                  <p className="mt-2 flex-1 text-[14px] leading-[1.65] text-[#475569]">
                    {t(p.body)}
                  </p>
                  <LinkComp
                    {...linkProps}
                    className="mt-4 inline-flex items-center gap-1 text-[13.5px] font-semibold text-[#2563EB] hover:gap-2"
                  >
                    {p.email ? fillCopy(t(p.cta), { email: p.email }) : t(p.cta)}{" "}
                    <ArrowRight size={14} aria-hidden="true" className="rtl:-scale-x-100" />
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
            <SectionEyebrow tone="violet">{t("supportRoutingEyebrow")}</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              {t("supportRoutingTitle")}
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              {t("supportRoutingLead")}
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
                    {fillCopy(t("supportStep"), { n: 1 })}
                  </div>
                  <div className="mt-2 text-[15px] font-semibold text-white">
                    {t("supportStep1Title")}
                  </div>
                  <p className="mt-2 text-[13px] leading-[1.55] text-[#CBD5F5]">
                    {t("supportStep1Body")}
                  </p>
                </div>
              </div>

              {/* Connector arrow */}
              <div
                aria-hidden="true"
                className="hidden lg:flex items-center justify-center text-[#A78BFA]"
              >
                <ArrowRight size={22} className="rtl:-scale-x-100" />
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
                    {fillCopy(t("supportStep"), { n: 2 })}
                  </div>
                  <div className="mt-2 text-[15px] font-semibold">
                    {t("supportStep2Title")}
                  </div>
                  <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {REQUEST_TYPES.map((label) => (
                      <li
                        key={label}
                        className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[12px] font-medium"
                      >
                        <span
                          aria-hidden="true"
                          className="block h-1.5 w-1.5 rounded-full bg-[#A78BFA]"
                        />
                        {t(label)}
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
                <ArrowRight size={22} className="rtl:-scale-x-100" />
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
                    {fillCopy(t("supportStep"), { n: 3 })}
                  </div>
                  <div className="mt-2 text-[15px] font-semibold text-white">
                    {t("supportStep3Title")}
                  </div>
                  <ul className="mt-3 grid gap-1.5 text-[13px] text-[#CBD5F5]">
                    {DESTINATIONS.map((label) => (
                      <li key={label} className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="block h-[5px] w-[5px] rounded-full bg-[#A78BFA]"
                        />
                        {t(label)}
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
            <SectionEyebrow tone="blue">{t("supportScopeEyebrow")}</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              {t("supportScopeTitle")}
            </h2>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div
              className="rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{ borderColor: "#DDE6F2", borderInlineStart: "4px solid #2563EB" }}
            >
              <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#2563EB]">
                <FileCheck2 size={15} aria-hidden="true" />
                {t("supportCanHelpTitle")}
              </div>
              <ul className="mt-5 grid gap-3">
                {SUPPORT_CAN_HELP.map((item) => (
                  <li
                    key={item}
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
                    <span>{t(item)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div
              className="rounded-[20px] border p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{
                borderColor: "#F1D5C3",
                borderInlineStart: "4px solid #B45309",
                background: "#FEF9F2",
              }}
            >
              <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#B45309]">
                <ShieldAlert size={15} aria-hidden="true" />
                {t("supportCannotTitle")}
              </div>
              <ul className="mt-5 grid gap-3">
                {SUPPORT_CANNOT_DO.map((item) => (
                  <li
                    key={item}
                    className="flex gap-3 text-[14.5px] leading-[1.65] text-[#0F172A]"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[0.55em] block h-[5px] w-[5px] shrink-0 rounded-full bg-[#B45309]"
                    />
                    <span>{t(item)}</span>
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
            <SectionEyebrow tone="violet">{t("supportResponseEyebrow")}</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              {t("supportResponseTitle")}
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              {t("supportResponseLead")}
            </p>
          </div>

          {/* AUD-0061 — scrolls sideways at phone width; focusable + named so a keyboard can scroll it (lib/ui/scrollRegion). */}
          <div
            {...scrollRegionProps(t("supportResponseEyebrow"))}
            className="overflow-x-auto rounded-[20px] border bg-white shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
            style={{ borderColor: "#E2E8F0" }}
          >
            <table className="min-w-[760px] w-full border-collapse text-start">
              <thead style={{ background: "#F8FAFC" }}>
                <tr>
                  <th className="px-5 py-3 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#0F172A]">
                    {t("supportColType")}
                  </th>
                  <th className="px-5 py-3 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#0F172A]">
                    {t("supportColPath")}
                  </th>
                  <th className="px-5 py-3 text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#0F172A]">
                    {t("supportColExpectation")}
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
                      {t(row.type)}
                    </td>
                    <td className="px-5 py-4 align-top text-[14px] text-[#475569]">
                      {t(row.path)}
                    </td>
                    <td className="px-5 py-4 align-top text-[14px] text-[#475569]">
                      {t(row.expectation)}
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
                  {t("supportEnterpriseEyebrow")}
                </SectionEyebrow>
                <h2 className="mt-3 text-[1.85rem] font-semibold tracking-[-0.02em] text-white md:text-[2.2rem]">
                  {t("supportEnterpriseTitle")}
                </h2>
                <p className="mt-4 max-w-[560px] text-[15px] leading-[1.7] text-white/80">
                  {t("supportEnterpriseLead")}
                </p>

                <div className="mt-7">
                  <div className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-white/65">
                    {t("supportEnterpriseAskFor")}
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
                        <span>{t(item)}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-8 flex flex-wrap gap-3">
                  <Link
                    href="/trust"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-white px-5 text-[13.5px] font-semibold text-[#071B4D] transition hover:-translate-y-0.5"
                  >
                    {t("supportDocTrustCenter")}
                  </Link>
                  <Link
                    href="/contact-sales"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-white/30 bg-white/5 px-5 text-[13.5px] font-semibold text-white transition hover:bg-white/15"
                  >
                    {t("supportTalkToSales")}
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
                    {t("supportReviewPacket")}
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
                            {t(item.label)}
                          </span>
                        </div>
                        <ArrowRight
                          size={14}
                          aria-hidden="true"
                          className="text-white/55 transition group-hover:translate-x-0.5 group-hover:text-white rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
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
            <SectionEyebrow tone="blue">{t("supportSecurityEyebrow")}</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              {t("supportSecurityTitle")}
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              {t("supportSecurityLead")}
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
                  {t(r.title)}
                </h3>
                <p className="mt-2 flex-1 text-[13.5px] leading-[1.6] text-[#475569]">
                  {t(r.body)}
                </p>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-[#2563EB] transition group-hover:gap-2">
                  {fillCopy(t("supportOpenDoc"), { doc: t(r.ctaDoc) })}{" "}
                  <ArrowRight size={13} aria-hidden="true" className="rtl:-scale-x-100" />
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
                  {t("supportReportVuln")}
                </div>
                <p className="mt-1 text-[13px] leading-[1.55] text-[#475569]">
                  {withSlot(
                    t("supportReportVulnBody"),
                    "email",
                    <a
                      href={`mailto:${SECURITY_EMAIL}`}
                      className="font-medium text-[#2563EB] underline-offset-2 hover:underline"
                    >
                      {SECURITY_EMAIL}
                    </a>,
                  )}
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
                  {t("supportQuestionnaireTitle")}
                </div>
                <p className="mt-1 text-[13px] leading-[1.55] text-[#475569]">
                  {withSlot(
                    t("supportQuestionnaireBody"),
                    "link",
                    <Link
                      href="/contact-sales"
                      className="font-medium text-[#2563EB] underline-offset-2 hover:underline"
                    >
                      /contact-sales
                    </Link>,
                  )}
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
              {t("supportSensitiveEyebrow")}
            </SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              {t("supportSensitiveTitle")}
            </h2>
            <p className="mt-3 text-[14.5px] leading-[1.65] text-[#475569]">
              {t("supportSensitiveLead")}
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
                  {t(s.title)}
                </h3>
                <p className="mt-2 flex-1 text-[13.5px] leading-[1.6] text-[#475569]">
                  {t(s.body)}
                </p>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-[#2563EB] transition group-hover:gap-2">
                  {t(s.label)} <ArrowRight size={13} aria-hidden="true" className="rtl:-scale-x-100" />
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
            <SectionEyebrow tone="slate">{t("supportVsEyebrow")}</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              {t("supportVsTitle")}
            </h2>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            {/* You are here */}
            <div
              className="relative flex flex-col rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{
                borderColor: "#DDE6F2",
                borderInlineStart: "4px solid #2563EB",
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
                {t("supportPublicTitle")}
              </h3>
              <p className="mt-2 flex-1 text-[14px] leading-[1.65] text-[#475569]">
                {t("supportPublicBody")}
              </p>
              <span className="mt-5 inline-flex w-fit items-center gap-1.5 rounded-full border border-[#2563EB] bg-white px-3 py-1 text-[12px] font-bold uppercase tracking-[0.12em] text-[#2563EB]">
                {t("supportYouAreHere")}
              </span>
            </div>

            {/* Support Policy */}
            <div
              className="relative flex flex-col rounded-[20px] border bg-white p-7 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{
                borderColor: "#DDE6F2",
                borderInlineStart: "4px solid #7C3AED",
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
                {t("supportDocSupportPolicy")}
              </h3>
              <p className="mt-2 flex-1 text-[14px] leading-[1.65] text-[#475569]">
                {t("supportPolicyBody")}
              </p>
              <Link
                href="/legal/support"
                className="mt-5 inline-flex w-fit items-center gap-1.5 rounded-full bg-[#7C3AED] px-4 py-1.5 text-[12px] font-bold uppercase tracking-[0.12em] text-white transition hover:-translate-y-0.5"
              >
                {t("supportOpenPolicy")}
                <ArrowRight size={12} aria-hidden="true" className="rtl:-scale-x-100" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────── Section 10 — Helpful resources ───────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-[1320px] px-6 py-16 md:px-8 md:py-20">
          <div className="mb-8 max-w-[820px]">
            <SectionEyebrow tone="blue">{t("supportResourcesEyebrow")}</SectionEyebrow>
            <h2 className="mt-2 text-[1.7rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[2rem]">
              {t("supportResourcesTitle")}
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
                    {t(group.title)}
                  </div>
                  <p className="mt-2 text-[13px] leading-[1.6] text-[#475569]">
                    {t(group.subtitle)}
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
                          <span>{t(link.label)}</span>
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
                  {t("supportCtaEyebrow")}
                </div>
                <h2 className="mt-4 text-[1.75rem] font-semibold tracking-[-0.02em] text-white md:text-[2.1rem]">
                  {t("supportCtaTitle")}
                </h2>
                <p className="mt-3 max-w-[540px] text-[15px] leading-[1.7] text-white/80">
                  {t("supportCtaLead")}
                </p>
              </div>
              <div className="flex flex-wrap gap-3 md:justify-end">
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] bg-white px-5 text-[13.5px] font-semibold text-[#071B4D] shadow-[0_10px_24px_rgba(15,23,42,0.18)] transition hover:-translate-y-0.5"
                >
                  {t("supportEmailSupport")}
                </a>
                <Link
                  href="/contact-sales"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-white/30 bg-white/5 px-5 text-[13.5px] font-semibold text-white transition hover:bg-white/15"
                >
                  {t("supportTalkToSales")}
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
