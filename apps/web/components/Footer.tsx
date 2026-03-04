import Link from "next/link";
import { LEGAL_LINKS, type LegalLink } from "../lib/legalLinks";

const LINK_BY_HREF = new Map(LEGAL_LINKS.map((link) => [link.href, link]));

function pickLinks(hrefs: string[]): LegalLink[] {
  return hrefs
    .map((href) => LINK_BY_HREF.get(href))
    .filter((link): link is LegalLink => Boolean(link));
}

const PRODUCT_LINKS = pickLinks([
  "/legal/security",
  "/legal/verification-methodology",
  "/legal/evidence-handling"
]);

const LEGAL_CORE_LINKS = pickLinks([
  "/legal/privacy",
  "/legal/terms",
  "/legal/cookies",
  "/legal/aup",
  "/legal/dpa",
  "/legal/dmca"
]);

const COMPANY_SUPPORT_LINKS = pickLinks([
  "/legal/law-enforcement",
  "/legal/transparency",
  "/legal/impressum",
  "/legal/support"
]);

export function Footer() {
  return (
    <footer className="landing-footer container">
      <div className="footer-layout">
        <div className="footer-left">
          <div className="footer-brand">PROO✓RA</div>
          <p className="footer-tagline">Verifiable digital evidence for legal, compliance, and investigations.</p>
          <a href="mailto:support@proovra.com">support@proovra.com</a>
        </div>

        <div className="footer-columns">
          <div className="footer-column">
            <p className="footer-heading">Product</p>
            <div className="footer-links">
              {PRODUCT_LINKS.map((link) => (
                <Link key={link.href} href={link.href}>
                  {link.label}
                </Link>
              ))}
            </div>
          </div>

          <div className="footer-column">
            <p className="footer-heading">Legal</p>
            <div className="footer-links">
              {LEGAL_CORE_LINKS.map((link) => (
                <Link key={link.href} href={link.href}>
                  {link.label}
                </Link>
              ))}
            </div>
          </div>

          <div className="footer-column">
            <p className="footer-heading">Company & Support</p>
            <div className="footer-links">
              {COMPANY_SUPPORT_LINKS.map((link) => (
                <Link key={link.href} href={link.href}>
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} PROO✓RA</span>
        <span>All rights reserved.</span>
      </div>
    </footer>
  );
}
