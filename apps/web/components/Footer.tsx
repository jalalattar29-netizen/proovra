import Link from "next/link";
import { LEGAL_LINKS } from "../lib/legalLinks";

export function Footer() {
  return (
    <footer className="landing-footer container">
      <div className="footer-left">
        <div className="footer-brand">PROO✓RA</div>
        <a href="mailto:support@proovra.com">support@proovra.com</a>
      </div>

      <div className="footer-links">
        {LEGAL_LINKS.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
      </div>
    </footer>
  );
}
