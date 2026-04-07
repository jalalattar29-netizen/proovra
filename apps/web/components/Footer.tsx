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
    <div className="footer-column">
      <p className="footer-heading">{title}</p>
      <nav className="footer-links" aria-label={`${title} footer links`}>
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="footer-link">
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
    <footer className="landing-footer container" role="contentinfo">
      <div className="footer-layout">
        <div className="footer-left">
          <Link href="/" className="footer-brand" aria-label="PROOVRA home">
            PROO✓RA
          </Link>

          <p className="footer-tagline">
            Verifiable digital evidence for legal, compliance, and investigations.
          </p>

          <a className="footer-contact" href="mailto:support@proovra.com">
            support@proovra.com
          </a>

          <div className="footer-primary-legal">
            <Link href="/legal/terms" className="footer-pill-link">
              {linkLabel("/legal/terms", "Terms of Service")}
            </Link>
            <Link href="/legal/privacy" className="footer-pill-link">
              {linkLabel("/legal/privacy", "Privacy Policy")}
            </Link>
            <Link href="/legal/cookies" className="footer-pill-link">
              {linkLabel("/legal/cookies", "Cookie Policy")}
            </Link>
          </div>
        </div>

        <div className="footer-columns">
          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Legal" links={LEGAL_CORE_LINKS} />
          <FooterColumn title="Company & Support" links={COMPANY_SUPPORT_LINKS} />
        </div>
      </div>

      <div className="footer-bottom">
        <span>© {currentYear} PROO✓RA</span>
        <span>All rights reserved.</span>
      </div>
    </footer>
  );
}