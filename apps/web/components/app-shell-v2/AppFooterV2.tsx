"use client";

import Link from "next/link";

const FOOTER_LINKS = [
  {
    href: "/legal/privacy",
    label: "Privacy",
  },
  {
    href: "/legal/terms",
    label: "Terms",
  },
  {
    href: "/legal/security",
    label: "Security",
  },
  {
    href: "/legal/verification-methodology",
    label: "Methodology",
  },
];

export function AppFooterV2() {
  const year = new Date().getFullYear();

  return (
    <footer className="app-footer-v2">
      <div className="app-footer-v2-bg" />

      <div className="app-footer-v2-inner">
        <div className="app-footer-v2-left">
          <span>© {year} PROOVRA</span>

          <span className="app-footer-v2-dot">•</span>

          <span>
            Verification digital evidence platform.
          </span>
        </div>

        <nav className="app-footer-v2-links">
          {FOOTER_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}