"use client";

import Link from "next/link";

const APP_FOOTER_LINKS = [
  { href: "/legal/support", label: "Support" },
  { href: "/legal/privacy", label: "Privacy" },
  { href: "/legal/terms", label: "Terms" },
  { href: "/legal/verification-methodology", label: "Methodology" },
];

export function AppFooter() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="proovra-app-footer" role="contentinfo">
      <div className="proovra-app-footer-inner">
        <div className="proovra-app-footer-brand">
          <span>© {currentYear} PROO✓RA</span>
          <span className="proovra-app-footer-dot">•</span>
          <span>Verification digital evidence platform.</span>
        </div>

        <nav className="proovra-app-footer-links" aria-label="App footer links">
          {APP_FOOTER_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}