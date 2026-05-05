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

const TRUST_VERIFICATION_LINKS: FooterLink[] = [
  legalLink("/legal/verification-methodology", "Verification Methodology"),
  legalLink("/legal/security", "Security & Responsible Disclosure"),
  legalLink("/legal/evidence-handling", "Evidence Handling Policy"),
  legalLink("/legal/data-retention", "Data Retention Policy"),
  legalLink("/legal/incident-response", "Incident Response Policy"),
];

const LEGAL_PRIVACY_LINKS: FooterLink[] = [
  legalLink("/legal/terms", "Terms of Service"),
  legalLink("/legal/privacy", "Privacy Policy"),
  legalLink("/legal/cookies", "Cookie Policy"),
  legalLink("/legal/dpa", "Data Processing Agreement"),
  legalLink("/legal/subprocessors", "Subprocessors"),
  legalLink("/legal/privacy-matrix", "Privacy Matrix"),
];

const GOVERNANCE_SUPPORT_LINKS: FooterLink[] = [
  legalLink("/legal/transparency", "Transparency Policy"),
  legalLink("/legal/abuse-reporting", "Abuse Reporting"),
  legalLink("/legal/law-enforcement", "Law Enforcement"),
  legalLink("/legal/support", "Support Policy"),
  legalLink("/legal/impressum", "Impressum"),
  legalLink("/legal/legal-changelog", "Legal Changelog"),
];

type FooterColumnProps = {
  title: string;
  links: FooterLink[];
};

function FooterColumn({ title, links }: FooterColumnProps) {
  if (links.length === 0) return null;

  return (
    <div className="min-w-0">
      <p className="text-[0.76rem] font-semibold uppercase tracking-[0.24em] text-[#b9c8c4]">
        {title}
      </p>

      <nav
        className="mt-4 flex flex-col gap-3"
        aria-label={`${title} footer links`}
      >
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="hover-link-bronze w-fit max-w-full text-[0.94rem] [overflow-wrap:anywhere]"
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
  const sampleReportUrl = "/brand/sample-report.pdf";
  const requestDemoUrl = "/request-demo";
  const verificationDemoUrl = "/verify/demo";

  return (
    <footer
      className="relative -mt-2 overflow-hidden text-[#dce4e0]"
      role="contentinfo"
    >
      <div className="absolute inset-0">
        <img
          src="/images/site-velvet-bg.webp.png"
          alt=""
          className="h-full w-full object-cover object-center"
        />
      </div>

      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(16,32,36,0.82)_0%,rgba(10,21,25,0.92)_58%,rgba(7,15,18,0.98)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_18%,rgba(130,176,170,0.10),transparent_22%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_84%_24%,rgba(255,255,255,0.04),transparent_18%)]" />
      <div className="absolute inset-0 opacity-[0.045] [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.022)_0px,rgba(255,255,255,0.022)_1px,transparent_1px,transparent_4px)]" />

      <div className="relative z-10 mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-14 md:px-8 md:py-16">
        <div className="grid gap-10 sm:gap-12 lg:grid-cols-[1.05fr_1.4fr] lg:gap-16">
          <div className="min-w-0">
            <Link
              href="/"
              className="inline-flex max-w-full items-center text-[1.42rem] font-semibold tracking-[-0.04em] text-[#e7ecea] sm:text-[1.58rem] md:text-[1.72rem]"
              aria-label="PROOVRA home"
            >
              <span className="truncate">PROO✓RA</span>
            </Link>

            <p className="mt-5 max-w-[460px] text-[0.98rem] leading-7 text-[#c7d1ce] [overflow-wrap:anywhere] sm:text-[1rem] sm:leading-8">
              Verification-first digital evidence workflows for legal, compliance,
              investigations, claims, and review-sensitive enterprise use.
            </p>

            <a
              className="hover-link-bronze mt-5 inline-block max-w-full text-[0.96rem] underline underline-offset-4 [overflow-wrap:anywhere]"
              href="mailto:support@proovra.com"
            >
              support@proovra.com
            </a>

            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href={sampleReportUrl}
                className="hover-chip rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                View Sample Report
              </Link>

              <Link
                href={verificationDemoUrl}
                className="hover-chip rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                Verification Demo
              </Link>

              <Link
                href="/legal/verification-methodology"
                className="hover-chip rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                Verification Methodology
              </Link>

              <Link
                href={requestDemoUrl}
                className="hover-chip rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                Request Demo
              </Link>
            </div>
          </div>

          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
            <FooterColumn title="Trust & Verification" links={TRUST_VERIFICATION_LINKS} />
            <FooterColumn title="Legal & Privacy" links={LEGAL_PRIVACY_LINKS} />
            <FooterColumn title="Governance & Support" links={GOVERNANCE_SUPPORT_LINKS} />
          </div>
        </div>

        <div className="mt-10 h-px w-full bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.14),transparent)] sm:mt-12" />

        <div className="mt-6 flex flex-col gap-2 text-[0.88rem] text-[#aebbb7] sm:flex-row sm:items-center sm:justify-between">
          <span>© {currentYear} PROO✓RA</span>
          <span>Verification-first digital evidence platform.</span>
        </div>
      </div>
    </footer>
  );
}