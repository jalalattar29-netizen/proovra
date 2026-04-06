"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icons } from "./icons";
import { LanguageSwitcher } from "./language-switcher";

type MarketingNavItem = {
  href: string;
  label: string;
  Icon: () => React.ReactNode;
};

type AppNavItem = {
  href: string;
  label: string;
  Icon: () => React.ReactNode;
};

const MARKETING_NAV: MarketingNavItem[] = [
  { href: "/", label: "Home", Icon: Icons.Home },
  { href: "/#how-it-works", label: "Features", Icon: Icons.Features },
  { href: "/pricing", label: "Pricing", Icon: Icons.Pricing },
  { href: "/legal/security", label: "Security", Icon: Icons.Security },
  { href: "/about", label: "About", Icon: Icons.About }
];

const APP_NAV: AppNavItem[] = [
  { href: "/home", label: "Dashboard", Icon: Icons.Dashboard },
  { href: "/capture", label: "Capture", Icon: Icons.Capture },
  { href: "/cases", label: "Cases", Icon: Icons.Evidence },
  { href: "/teams", label: "Teams", Icon: Icons.Teams },
  { href: "/reports", label: "Reports", Icon: Icons.Reports },
  { href: "/billing", label: "Billing", Icon: Icons.Billing },
  { href: "/settings", label: "Settings", Icon: Icons.Settings }
];

function getWebBase() {
  if (typeof window === "undefined") return "";
  const { hostname } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return window.location.origin;
  return process.env.NEXT_PUBLIC_WEB_BASE ?? process.env.NEXT_PUBLIC_APP_BASE ?? "";
}

export function MarketingHeader() {
  const webBase = getWebBase();
  const appLogin = webBase ? `${webBase}/login` : "/login";
  const appRegister = webBase ? `${webBase}/register` : "/register";

  return (
    <header className="proovra-header">
      <div className="container proovra-header-inner">
        <Link href="/" className="proovra-logo">
<img
  src="/brand/icon-512.png?v=2"
  alt="PROO✓RA"
  width={36}
  height={36}
  className="proovra-logo-mark"
/>          <span>PROO✓RA</span>
        </Link>
        <nav className="proovra-nav proovra-nav-marketing">
          <div className="proovra-nav-center">
            {MARKETING_NAV.map((item) => (
              <Link key={item.href} href={item.href} className="proovra-nav-link">
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
          <div className="proovra-nav-right">
            <div className="lang-button">
              <LanguageSwitcher />
            </div>
            <a href={appLogin} className="proovra-nav-link">
              <span>Login</span>
            </a>
            <a href={appRegister} className="proovra-cta-btn">
              <span>Register</span>
            </a>
          </div>
        </nav>
      </div>
    </header>
  );
}

export function AppHeader({
  hasSession,
  onLogout
}: {
  hasSession: boolean;
  onLogout: () => void;
}) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    pathname === href || (href !== "/billing" && pathname?.startsWith(`${href}/`));

  return (
    <header className="proovra-header">
      <div className="container proovra-header-inner">
        <Link href="/home" className="proovra-logo">
<img
  src="/brand/icon-512.png?v=2"
  alt="PROO✓RA"
  width={36}
  height={36}
  className="proovra-logo-mark"
/>          <span>PROO✓RA</span>
        </Link>
        <nav className="proovra-nav proovra-nav-app proovra-nav-app-desktop">
          {APP_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`proovra-nav-link ${isActive(item.href) ? "active" : ""}`}
            >
              <item.Icon />
              <span>{item.label}</span>
            </Link>
          ))}
<div className="lang-button">
  <LanguageSwitcher />
</div>          {hasSession && (
            <button type="button" className="proovra-nav-link proovra-logout-btn" onClick={onLogout}>
              Sign out
            </button>
          )}
        </nav>
        <div className="proovra-nav-app-mobile">
          {hasSession && (
            <button type="button" className="proovra-nav-link proovra-logout-btn" onClick={onLogout}>
              Sign out
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
