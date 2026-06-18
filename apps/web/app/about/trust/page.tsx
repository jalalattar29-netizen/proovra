/**
 * Phase E5 — Trust Center.
 *
 * Public enterprise-facing surface that explains, in calm operational
 * language, what PROOVRA records, what its verification subsystems
 * confirm, and — equally important — what it does not claim.
 *
 * IA placement: under the existing `/about/` public route. No new root
 * nav. The 32.8 canonical primaries are unchanged.
 *
 * Content is sourced from
 * `@proovra/shared-evidence-presentation/trust-center-content`, which
 * is the single source of truth shared with the contract tests. The
 * page renders content; it does not invent claims.
 *
 * Hard rules (pinned by `phase-e5-trust-center.test.ts`):
 *
 *   - Every visible string comes from the shared content module — no
 *     hard-coded marketing copy on this page.
 *   - Forbidden phrase regexes from `TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS`
 *     MUST NOT match the rendered page output.
 *   - Required boundary phrases from `TRUST_CENTER_REQUIRED_PHRASES`
 *     MUST appear at least once.
 *   - Every section carries an explicit "Limitations" sub-block — the
 *     boundary is first-class, never an afterthought.
 *   - No fake counters, no fake compliance badges, no marketing hero,
 *     no "99.9999% trust" nonsense.
 */

import type { Metadata } from "next";
import Link from "next/link";

import {
  TRUST_CENTER_PAGE_BOUNDARY_CALLOUT,
  TRUST_CENTER_PAGE_INTRO,
  TRUST_CENTER_SECTIONS,
  type TrustCenterSection,
} from "@proovra/shared-evidence-presentation";

import { MarketingHeader } from "../../../components/marketing/MarketingHeader";
import { EnterpriseFooter } from "../../../components/marketing/EnterpriseFooter";

export const metadata: Metadata = {
  title: "Trust Center · PROOVRA",
  description:
    "How PROOVRA works, what it records, what it verifies, and what it does not claim. A bounded enterprise-readable explanation of the platform's methodology, integrity model, security posture, AI limitations, and operational reliability.",
};

// ---------------------------------------------------------------------------
// Related links — point readers to the existing detailed docs.
// ---------------------------------------------------------------------------

const RELATED_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  {
    href: "/legal/verification-methodology",
    label: "Verification methodology (full doc)",
  },
  { href: "/legal/evidence-handling", label: "Evidence handling policy" },
  { href: "/legal/data-retention", label: "Data retention policy" },
  { href: "/legal/security", label: "Security & responsible disclosure" },
  { href: "/legal/incident-response", label: "Incident response policy" },
  { href: "/legal/transparency", label: "Transparency policy" },
  { href: "/legal/subprocessors", label: "Subprocessors" },
  { href: "/verify/demo", label: "Verification demo (sample evidence)" },
];

// ---------------------------------------------------------------------------
// Section card
// ---------------------------------------------------------------------------

function SectionCard({ section }: { section: TrustCenterSection }): JSX.Element {
  return (
    <article
      id={section.id}
      data-trust-section={section.id}
      className="scroll-mt-24 rounded-2xl border border-[rgba(79,112,107,0.18)] bg-white/[0.92] p-6 shadow-[0_18px_42px_rgba(8,18,22,0.06)] md:p-8"
    >
      <header>
        <h2
          className="text-[1.22rem] font-semibold leading-tight tracking-[-0.02em] text-[#2a3a3c] md:text-[1.36rem]"
          data-trust-section-title={section.id}
        >
          {section.title}
        </h2>
        <p
          className="mt-3 text-[0.96rem] leading-[1.72] text-[#4a5b5e]"
          data-trust-section-summary={section.id}
        >
          {section.summary}
        </p>
      </header>

      {section.bullets.length > 0 ? (
        <div className="mt-5">
          <div className="text-[0.74rem] font-semibold uppercase tracking-[0.18em] text-[#5e7068]">
            What is recorded
          </div>
          <ul
            className="mt-2 space-y-2 text-[0.94rem] leading-[1.7] text-[#384b4d]"
            data-trust-section-bullets={section.id}
          >
            {section.bullets.map((b, i) => (
              <li key={`${section.id}-bullet-${i}`} className="flex gap-2">
                <span aria-hidden="true" className="mt-[0.55em] block h-[5px] w-[5px] shrink-0 rounded-full bg-[#86a097]" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {section.limitations.length > 0 ? (
        <div className="mt-6 rounded-xl border border-[rgba(214,184,157,0.32)] bg-[rgba(252,247,239,0.6)] p-4">
          <div
            className="text-[0.74rem] font-semibold uppercase tracking-[0.18em] text-[#8e7863]"
            data-trust-section-limitations-title={section.id}
          >
            Limitations
          </div>
          <ul
            className="mt-2 space-y-2 text-[0.92rem] leading-[1.7] text-[#4d4030]"
            data-trust-section-limitations={section.id}
          >
            {section.limitations.map((l, i) => (
              <li key={`${section.id}-limit-${i}`} className="flex gap-2">
                <span aria-hidden="true" className="mt-[0.55em] block h-[5px] w-[5px] shrink-0 rounded-full bg-[#b89977]" />
                <span>{l}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TrustCenterPage(): JSX.Element {
  return (
    <div className="page trust-center-page" data-trust-center-page>
      {/* Calm enterprise header strip (no marketing hero, no fake counters) */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <img
            src="/images/site-velvet-bg.webp.png"
            alt=""
            className="h-full w-full object-cover object-center"
          />
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.86)_0%,rgba(8,18,22,0.76)_38%,rgba(8,18,22,0.66)_100%)]" />

        <div className="relative z-10">
          <MarketingHeader />

          <section className="mx-auto max-w-5xl px-6 pb-12 pt-10 md:px-8 md:pb-14 md:pt-14">
            <div className="inline-flex items-center gap-[0.72rem] rounded-full border border-white/10 bg-white/[0.055] px-5 py-2 text-[0.74rem] font-medium uppercase tracking-[0.2em] text-[#dce3e0] shadow-[0_10px_24px_rgba(0,0,0,0.10)] backdrop-blur-md">
              <span className="block h-[6px] w-[6px] shrink-0 rounded-full bg-[#b79d84] opacity-95" />
              Trust Center
            </div>

            <h1 className="mt-5 max-w-[760px] text-[1.62rem] font-medium leading-[1.05] tracking-[-0.03em] text-[#edf1ef] md:text-[2.02rem] lg:text-[2.34rem]">
              How PROOVRA actually works
            </h1>

            <p
              className="mt-5 max-w-[820px] text-[0.94rem] font-normal leading-[1.78] tracking-[-0.006em] text-[#c7cfcc] md:text-[0.98rem]"
              data-trust-page-intro
            >
              {TRUST_CENTER_PAGE_INTRO}
            </p>

            <div
              className="mt-6 max-w-[820px] rounded-xl border border-[rgba(214,184,157,0.30)] bg-[rgba(255,255,255,0.04)] px-5 py-4 text-[0.92rem] leading-[1.7] text-[#d6dcd9] backdrop-blur-md"
              data-trust-page-boundary
            >
              <span className="mr-1 inline-block rounded-full border border-[rgba(214,184,157,0.4)] bg-[rgba(214,184,157,0.16)] px-2.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.18em] text-[#e6c9aa]">
                Boundary
              </span>{" "}
              {TRUST_CENTER_PAGE_BOUNDARY_CALLOUT}
            </div>
          </section>
        </div>
      </div>

      {/* Section index — deep-link nav */}
      <section
        className="mx-auto max-w-5xl px-6 pt-10 md:px-8"
        aria-label="Trust Center sections"
      >
        <nav
          className="rounded-2xl border border-[rgba(79,112,107,0.18)] bg-white/[0.92] p-5 shadow-[0_8px_22px_rgba(8,18,22,0.04)]"
          data-trust-section-index
        >
          <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-[#5e7068]">
            On this page
          </div>
          <ul className="mt-3 grid gap-2 text-[0.94rem] leading-[1.6] text-[#33464a] md:grid-cols-2">
            {TRUST_CENTER_SECTIONS.map((s) => (
              <li key={`index-${s.id}`}>
                <Link
                  href={`#${s.id}`}
                  className="inline-flex items-center gap-2 underline-offset-4 hover:underline"
                  data-trust-section-link={s.id}
                >
                  <span aria-hidden="true" className="block h-[5px] w-[5px] rounded-full bg-[#86a097]" />
                  <span>{s.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </section>

      {/* Sections */}
      <section className="mx-auto mt-8 max-w-5xl space-y-6 px-6 pb-12 md:px-8 md:pb-14">
        {TRUST_CENTER_SECTIONS.map((s) => (
          <SectionCard key={s.id} section={s} />
        ))}
      </section>

      {/* Related links */}
      <section
        className="mx-auto max-w-5xl px-6 pb-16 md:px-8 md:pb-20"
        aria-label="Related documentation"
      >
        <div className="rounded-2xl border border-[rgba(79,112,107,0.18)] bg-white/[0.92] p-6 shadow-[0_8px_22px_rgba(8,18,22,0.04)] md:p-8">
          <h2 className="text-[1.04rem] font-semibold tracking-[-0.01em] text-[#2a3a3c]">
            Related documentation
          </h2>
          <p className="mt-3 text-[0.92rem] leading-[1.7] text-[#4a5b5e]">
            This page summarizes the trust posture. Full legal and policy
            documents live alongside.
          </p>
          <ul
            className="mt-4 grid gap-2 text-[0.94rem] leading-[1.7] text-[#33464a] md:grid-cols-2"
            data-trust-related-links
          >
            {RELATED_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="inline-flex items-center gap-2 underline-offset-4 hover:underline"
                >
                  <span aria-hidden="true" className="block h-[5px] w-[5px] rounded-full bg-[#b79d84]" />
                  <span>{link.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <EnterpriseFooter />
    </div>
  );
}
