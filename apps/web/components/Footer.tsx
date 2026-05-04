"use client";

import Link from "next/link";
import { LEGAL_LINKS, type LegalLink } from "../lib/legalLinks";

const LINK_BY_HREF = new Map<string, LegalLink>(
  LEGAL_LINKS.map((link) => [link.href, link])
);

type FooterLink = {
  href: string;
  label: string;
};

function legalLink(href: string, fallback: string): FooterLink {
  const link = LINK_BY_HREF.get(href);
  return {
    href,
    label: link?.label ?? fallback,
  };
}

const TRUST_LINKS: FooterLink[] = [
  legalLink("/legal/verification-methodology", "Verification Methodology"),
  legalLink("/legal/security", "Security"),
  legalLink("/legal/evidence-handling", "Evidence Handling"),
  legalLink("/legal/data-retention", "Data Retention"),
  legalLink("/legal/incident-response", "Incident Response"),
];

const LEGAL_LINKS_FOOTER: FooterLink[] = [
  legalLink("/legal/terms", "Terms"),
  legalLink("/legal/privacy", "Privacy"),
  legalLink("/legal/cookies", "Cookies"),
  legalLink("/legal/dpa", "DPA"),
  legalLink("/legal/subprocessors", "Subprocessors"),
];

const GOVERNANCE_LINKS: FooterLink[] = [
  legalLink("/legal/transparency", "Transparency"),
  legalLink("/legal/abuse-reporting", "Abuse Reporting"),
  legalLink("/legal/law-enforcement", "Law Enforcement"),
  legalLink("/legal/support", "Support"),
  legalLink("/legal/impressum", "Impressum"),
];

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: FooterLink[];
}) {
  return (
    <div className="min-w-0">
      <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-[#aebbb7]">
        {title}
      </div>

      <nav className="mt-4 grid gap-3" aria-label={`${title} footer links`}>
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="hover-link-bronze w-fit max-w-full text-[0.92rem] text-[#d8e1de] [overflow-wrap:anywhere]"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="relative overflow-hidden text-[#dce4e0]" role="contentinfo">
      <div className="absolute inset-0">
        <img
          src="/images/site-velvet-bg.webp.png"
          alt=""
          className="h-full w-full object-cover object-center"
        />
      </div>

      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.86)_0%,rgba(8,18,22,0.94)_58%,rgba(5,12,15,0.98)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_14%_18%,rgba(158,216,207,0.09),transparent_24%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_86%_18%,rgba(214,184,157,0.07),transparent_20%)]" />
      <div className="absolute inset-0 opacity-[0.045] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.025)_0px,rgba(255,255,255,0.025)_1px,transparent_1px,transparent_4px)]" />

      <div className="relative z-10 mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-14 md:px-8">
        <div className="grid gap-10 lg:grid-cols-[1.08fr_1.35fr] lg:gap-16">
          <div className="min-w-0">
            <Link
              href="/home"
              className="inline-flex max-w-full items-center gap-3 text-[1.45rem] font-semibold tracking-[-0.04em] text-[#edf4f1] sm:text-[1.62rem]"
              aria-label="PROOVRA workspace"
            >
              <img
                src="/brand/icon-512.png?v=2"
                alt=""
                className="h-10 w-10 object-contain drop-shadow-[0_10px_28px_rgba(0,0,0,0.55)]"
              />
              <span className="truncate">PROO✓RA</span>
            </Link>

            <p className="mt-5 max-w-[520px] text-[0.98rem] leading-8 text-[#c7d1ce]">
              Verification-first digital evidence workflows for legal,
              compliance, investigations, claims, journalism, and
              review-sensitive enterprise teams.
            </p>

            <div className="mt-6 grid gap-3 sm:flex sm:flex-wrap">
              <Link
                href="/brand/sample-report.pdf"
                className="hover-chip rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                Sample Report
              </Link>

              <Link
                href="/verify/demo"
                className="hover-chip rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                Verification Demo
              </Link>

              <Link
                href="/legal/verification-methodology"
                className="hover-chip rounded-full border border-white/10 bg-white/[0.055] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                Methodology
              </Link>

              <Link
                href="/request-demo"
                className="hover-chip rounded-full border border-[rgba(214,184,157,0.24)] bg-[rgba(183,157,132,0.10)] px-4 py-2 text-[0.84rem] text-[#ead8c7]"
              >
                Request Demo
              </Link>
            </div>

            <div className="mt-7 rounded-[22px] border border-white/10 bg-white/[0.045] p-4 text-[0.86rem] leading-7 text-[#b8c7c3]">
              PROOVRA records integrity state, custody context, timestamps, and
              verification artifacts. It does not independently prove factual
              truth, authorship, or legal admissibility.
            </div>
          </div>

          <div className="grid gap-9 sm:grid-cols-3">
            <FooterColumn title="Trust" links={TRUST_LINKS} />
            <FooterColumn title="Legal" links={LEGAL_LINKS_FOOTER} />
            <FooterColumn title="Governance" links={GOVERNANCE_LINKS} />
          </div>
        </div>

        <div className="mt-10 h-px w-full bg-[linear-gradient(90deg,transparent,rgba(214,184,157,0.22),rgba(158,216,207,0.12),transparent)]" />

        <div className="mt-6 flex flex-col gap-3 text-[0.86rem] text-[#aebbb7] sm:flex-row sm:items-center sm:justify-between">
          <span>© {currentYear} PROO✓RA. All rights reserved.</span>

          <a
            href="mailto:support@proovra.com"
            className="hover-link-bronze w-fit"
          >
            support@proovra.com
          </a>
        </div>
      </div>
    </footer>
  );
}