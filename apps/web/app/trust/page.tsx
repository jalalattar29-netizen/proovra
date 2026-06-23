/**
 * Trust Center — canonical top-level destination at `/trust`.
 *
 * Public enterprise-facing surface that explains, in calm operational
 * language, what PROOVRA records, what its verification subsystems
 * confirm, and — equally important — what it does not claim.
 *
 * IA placement: top-level `/trust`. Trust Center is a primary trust/legal
 * destination, not a sub-page of /about.
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

import { EnterpriseFooter } from "../../components/marketing/EnterpriseFooter";
import { LegalHero } from "../../components/legal/LegalHero";
import { legalHeroFor } from "../legal/legal-hero-meta";

const ENTERPRISE_READINESS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Privacy & data governance",
    body: "Privacy Policy, DPA, retention, subprocessors, and TOMs surfaced together as one enterprise-ready set.",
  },
  {
    title: "Security & reliability",
    body: "Security posture, responsible disclosure, incident response, and operational transparency.",
  },
  {
    title: "Evidence & verification",
    body: "Methodology, evidence handling, verification disclaimer, and AI use rules in one place.",
  },
  {
    title: "Platform governance",
    body: "Acceptable use, abuse reporting, law-enforcement request handling, and support policy.",
  },
];

const CONTACT_CTAS: ReadonlyArray<{ title: string; body: string; href: string }> = [
  { title: "Contact PROOVRA", body: "Reach the sales and account team.", href: "/contact-sales" },
  { title: "Privacy Requests", body: "Submit a privacy or data subject request.", href: "/legal/privacy-requests" },
  { title: "Law Enforcement Requests", body: "Guidance for government and legal requests.", href: "/legal/law-enforcement" },
  { title: "Abuse Reporting", body: "Report misuse or unlawful content.", href: "/legal/abuse-reporting" },
];

export const metadata: Metadata = {
  title: "Trust Center · PROOVRA",
  description:
    "How PROOVRA works, what it records, what it verifies, and what it does not claim. A bounded enterprise-readable explanation of the platform's methodology, integrity model, security posture, AI limitations, and operational reliability.",
  alternates: {
    canonical: "/trust",
  },
};

// ---------------------------------------------------------------------------
// Related documentation — categorized hub for every legal & policy doc.
// Trust Center is the single discovery surface; the footer no longer
// surfaces these individually.
// ---------------------------------------------------------------------------

type RelatedLink = { href: string; label: string };
type RelatedCategory = { title: string; links: RelatedLink[] };

const RELATED_CATEGORIES: ReadonlyArray<RelatedCategory> = [
  {
    title: "Privacy & Data Governance",
    links: [
      { href: "/legal/privacy", label: "Privacy Policy" },
      { href: "/legal/cookies", label: "Cookie Policy" },
      { href: "/legal/dpa", label: "Data Processing Addendum (DPA)" },
      { href: "/legal/privacy-requests", label: "Privacy Requests" },
      { href: "/legal/data-retention", label: "Data Retention Policy" },
      { href: "/legal/subprocessors", label: "Subprocessors" },
      { href: "/legal/toms", label: "Technical & Organizational Measures (TOMs)" },
    ],
  },
  {
    title: "Security & Reliability",
    links: [
      { href: "/security-overview", label: "Security Overview" },
      { href: "/legal/security", label: "Security & Responsible Disclosure" },
      { href: "/legal/incident-response", label: "Incident Response" },
      { href: "/legal/transparency", label: "Transparency Policy" },
    ],
  },
  {
    title: "Evidence & Verification",
    links: [
      { href: "/legal/verification-methodology", label: "Verification Methodology" },
      { href: "/legal/evidence-handling", label: "Evidence Handling Policy" },
      { href: "/legal/verification-disclaimer", label: "Verification Disclaimer" },
      { href: "/legal/ai-use-policy", label: "AI Use Policy" },
    ],
  },
  {
    title: "Platform Governance",
    links: [
      { href: "/legal/aup", label: "Acceptable Use Policy" },
      { href: "/legal/abuse-reporting", label: "Abuse Reporting" },
      { href: "/legal/law-enforcement", label: "Law Enforcement Requests" },
      { href: "/legal/support", label: "Support Policy" },
      // Public-facing Support is operational, not a policy doc. Linking
      // it under Platform Governance keeps Trust Center reachable as the
      // canonical hub even for non-policy support paths.
      { href: "/support", label: "Public Support" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/legal/terms", label: "Terms of Service" },
      { href: "/legal/refund-policy", label: "Consumer Cancellation & Refund Policy" },
      { href: "/legal/dmca", label: "Copyright & DMCA Policy" },
      { href: "/legal/impressum", label: "Impressum" },
      { href: "/legal/accessibility", label: "Accessibility Statement" },
      { href: "/legal/legal-changelog", label: "Legal Changelog" },
    ],
  },
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
  const hero = legalHeroFor("trust", "Trust Center");
  return (
    <div className="page trust-center-page" style={{ background: "#F6F9FC" }} data-trust-center-page>
      <LegalHero
        label={hero.label}
        title={hero.title}
        summary={TRUST_CENTER_PAGE_INTRO}
        meta={hero.meta}
        highlight={hero.highlight}
      >
        <div
          className="rounded-xl border bg-white/[0.95] px-5 py-4 text-[0.95rem] leading-[1.7] text-[#0F172A] shadow-[0_2px_10px_rgba(8,18,22,0.04)]"
          style={{ borderColor: "#DDE6F2" }}
          data-trust-page-boundary
        >
          <span
            className="mr-1 inline-block rounded-full border px-2.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.18em] text-[#0B1F4D]"
            style={{ borderColor: "#DDE6F2", backgroundColor: "#F1F5F9" }}
          >
            Boundary
          </span>{" "}
          {TRUST_CENTER_PAGE_BOUNDARY_CALLOUT}
        </div>
      </LegalHero>

      {/* Important Clarification — explicit boundary block. Sits between
          the hero and the section index so reviewers see it before
          drilling into individual surfaces. The same wording is
          surfaced verbatim on Verification reports and on the linked
          [Verification Disclaimer](/legal/verification-disclaimer). */}
      <section
        className="mx-auto max-w-6xl px-6 pt-12 md:px-8"
        aria-label="Important clarification"
      >
        <div
          className="rounded-2xl border bg-white p-6 shadow-[0_8px_22px_rgba(8,18,22,0.04)] md:p-7"
          style={{ borderColor: "#DDE6F2", borderLeft: "4px solid #8A1538" }}
          data-trust-important-clarification
        >
          <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-[#8A1538]">
            Important clarification
          </div>
          <p className="mt-3 text-[0.98rem] leading-[1.72] text-[#0F172A]">
            PROOVRA is not a court, law-enforcement authority, or legal
            service provider. Verification confirms recorded integrity
            signals, timestamp-related context, custody metadata, and
            preservation-related details for an evidence record. It
            does not by itself establish factual truth, authorship,
            identity, liability, or legal admissibility in a specific
            jurisdiction.
          </p>
        </div>
      </section>

      {/* Section index — deep-link nav */}
      <section
        className="mx-auto max-w-6xl px-6 pt-10 md:px-8"
        aria-label="Trust Center sections"
      >
        <nav
          className="rounded-2xl border bg-white p-5 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
          style={{ borderColor: "#DDE6F2" }}
          data-trust-section-index
        >
          <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-[#64748B]">
            On this page
          </div>
          <ul className="mt-3 grid gap-2 text-[0.94rem] leading-[1.6] text-[#0F172A] md:grid-cols-2">
            {TRUST_CENTER_SECTIONS.map((s) => (
              <li key={`index-${s.id}`}>
                <Link
                  href={`#${s.id}`}
                  className="inline-flex items-center gap-2 text-[#0B1F4D] underline-offset-4 hover:text-[#2563EB] hover:underline"
                  data-trust-section-link={s.id}
                >
                  <span aria-hidden="true" className="block h-[5px] w-[5px] rounded-full bg-[#2563EB]" />
                  <span>{s.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </section>

      {/* Sections */}
      <section className="mx-auto mt-8 max-w-6xl space-y-6 px-6 pb-12 md:px-8 md:pb-14">
        {TRUST_CENTER_SECTIONS.map((s) => (
          <SectionCard key={s.id} section={s} />
        ))}
      </section>

      {/* Enterprise Readiness strip — four-card summary that mirrors the
          Related Documentation taxonomy so visitors see "what's covered"
          before drilling into individual docs. */}
      <section
        className="mx-auto max-w-6xl px-6 pb-12 md:px-8 md:pb-14"
        aria-label="Enterprise readiness"
      >
        <div className="mb-6">
          <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-[#64748B]">
            Enterprise readiness
          </div>
          <h2 className="mt-2 text-[1.4rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[1.65rem]">
            What enterprise buyers find here.
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-trust-readiness-grid>
          {ENTERPRISE_READINESS.map((c) => (
            <div
              key={c.title}
              className="rounded-2xl border bg-white p-5 shadow-[0_2px_10px_rgba(8,18,22,0.03)]"
              style={{ borderColor: "#DDE6F2" }}
            >
              <div className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#0F766E]">
                Covered
              </div>
              <h3 className="mt-2 text-[1rem] font-semibold tracking-[-0.01em] text-[#081426]">
                {c.title}
              </h3>
              <p className="mt-2 text-[0.92rem] leading-[1.65] text-[#475569]">
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Related documentation — categorized hub rendered as a white-card
          grid (rounded-20, soft border, category label + title + arrow).
          Trust Center is the single discovery surface for every legal &
          policy document; the public footer enumerates the most-used
          subset. */}
      <section
        className="mx-auto max-w-6xl px-6 pb-12 md:px-8 md:pb-14"
        aria-label="Related documentation"
        data-trust-related-section
      >
        <div className="mb-6">
          <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-[#64748B]">
            Related documentation
          </div>
          <h2 className="mt-2 text-[1.4rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[1.65rem]">
            The underlying legal, privacy, security, and governance documents.
          </h2>
        </div>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3" data-trust-related-categories>
          {RELATED_CATEGORIES.map((cat) => (
            <div
              key={cat.title}
              className="rounded-[20px] border bg-white p-6 shadow-[0_2px_10px_rgba(8,18,22,0.03)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(8,18,22,0.05)]"
              style={{ borderColor: "#DDE6F2" }}
              data-trust-related-category={cat.title}
            >
              <div className="text-[0.7rem] font-bold uppercase tracking-[0.16em] text-[#2563EB]">
                {cat.title}
              </div>
              <ul className="mt-4 grid gap-2 text-[0.94rem] leading-[1.65]">
                {cat.links.map((link) => (
                  <li key={`${cat.title}-${link.label}`}>
                    <Link
                      href={link.href}
                      className="inline-flex items-center gap-2 text-[#0B1F4D] underline-offset-4 hover:text-[#2563EB] hover:underline"
                    >
                      <span aria-hidden="true" className="block h-[5px] w-[5px] rounded-full bg-[#2563EB]" />
                      <span>{link.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-6 text-[0.92rem] leading-[1.7] text-[#475569]">
          See also:{" "}
          <Link
            href="/verify/demo"
            className="font-medium text-[#2563EB] underline underline-offset-4 hover:text-[#1E40AF]"
          >
            Verification demo (sample evidence)
          </Link>
          .
        </div>
      </section>

      {/* Contact / Legal Request CTA — the four most common direct
          paths for a reader who arrives at Trust Center with a real
          request to make. */}
      <section
        className="mx-auto max-w-6xl px-6 pb-16 md:px-8 md:pb-20"
        aria-label="Contact and legal requests"
      >
        <div className="mb-6">
          <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-[#64748B]">
            Make a request
          </div>
          <h2 className="mt-2 text-[1.4rem] font-semibold tracking-[-0.02em] text-[#081426] md:text-[1.65rem]">
            Contact, privacy, law-enforcement, and abuse paths.
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-trust-contact-grid>
          {CONTACT_CTAS.map((c) => (
            <Link
              key={c.href + c.title}
              href={c.href}
              className="group rounded-[20px] border bg-white p-5 shadow-[0_2px_10px_rgba(8,18,22,0.03)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(8,18,22,0.05)]"
              style={{ borderColor: "#DDE6F2" }}
            >
              <div className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#7C3AED]">
                Request path
              </div>
              <h3 className="mt-2 text-[1rem] font-semibold tracking-[-0.01em] text-[#081426]">
                {c.title}
              </h3>
              <p className="mt-2 text-[0.92rem] leading-[1.65] text-[#475569]">
                {c.body}
              </p>
              <span
                aria-hidden="true"
                className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-[#2563EB] transition group-hover:gap-2"
              >
                Open <span>→</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <EnterpriseFooter />
    </div>
  );
}
