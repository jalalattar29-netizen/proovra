"use client";

import Link from "next/link";
import { LEGAL_LINKS, type LegalLink } from "../lib/legalLinks";

const LINK_BY_HREF = new Map<string, LegalLink>(
  LEGAL_LINKS.map((link) => [link.href, link])
);

function pickLinks(hrefs: string[]): LegalLink[] {
  return hrefs
    .map((href) => LINK_BY_HREF.get(href))
    .filter((link): link is LegalLink => Boolean(link));
}

function linkLabel(href: string, fallback: string): string {
  return LINK_BY_HREF.get(href)?.label ?? fallback;
}

const PRODUCT_LINKS = pickLinks([
  "/legal/security",
  "/legal/verification-methodology",
  "/legal/evidence-handling",
  "/legal/data-retention",
  "/legal/subprocessors",
]);

const LEGAL_CORE_LINKS = pickLinks([
  "/legal/terms",
  "/legal/privacy",
  "/legal/cookies",
  "/legal/aup",
  "/legal/dpa",
  "/legal/dmca",
]);

const COMPANY_SUPPORT_LINKS = pickLinks([
  "/legal/support",
  "/legal/transparency",
  "/legal/impressum",
  "/legal/abuse-reporting",
  "/legal/incident-response",
  "/legal/law-enforcement",
]);

type FooterColumnProps = {
  title: string;
  links: LegalLink[];
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

  return (
    <footer className="relative -mt-2 overflow-hidden text-[#dce4e0]" role="contentinfo">
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
              className="inline-flex max-w-full items-center text-[1.42rem] sm:text-[1.58rem] md:text-[1.72rem] font-semibold tracking-[-0.04em] text-[#e7ecea]"
              aria-label="PROOVRA home"
            >
              <span className="truncate">PROO✓RA</span>
            </Link>

            <p className="mt-5 max-w-[430px] text-[0.98rem] sm:text-[1rem] leading-7 sm:leading-8 text-[#c7d1ce] [overflow-wrap:anywhere]">
              Verifiable digital evidence for legal, compliance, and investigations.
            </p>

            <a
              className="hover-link-bronze mt-5 inline-block max-w-full text-[0.96rem] underline underline-offset-4 [overflow-wrap:anywhere]"
              href="mailto:support@proovra.com"
            >
              support@proovra.com
            </a>

            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/legal/terms"
                className="hover-chip rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                {linkLabel("/legal/terms", "Terms of Service")}
              </Link>

              <Link
                href="/legal/privacy"
                className="hover-chip rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                {linkLabel("/legal/privacy", "Privacy Policy")}
              </Link>

              <Link
                href="/legal/cookies"
                className="hover-chip rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-[0.84rem] text-[#d7dfdc]"
              >
                {linkLabel("/legal/cookies", "Cookie Policy")}
              </Link>
            </div>
          </div>

          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
            <FooterColumn title="Product" links={PRODUCT_LINKS} />
            <FooterColumn title="Legal" links={LEGAL_CORE_LINKS} />
            <FooterColumn title="Company & Support" links={COMPANY_SUPPORT_LINKS} />
          </div>
        </div>

        <div className="mt-10 sm:mt-12 h-px w-full bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.14),transparent)]" />

        <div className="mt-6 flex flex-col gap-2 text-[0.88rem] text-[#aebbb7] sm:flex-row sm:items-center sm:justify-between">
          <span>© {currentYear} PROO✓RA</span>
          <span>All rights reserved.</span>
        </div>
      </div>
    </footer>
  );
}