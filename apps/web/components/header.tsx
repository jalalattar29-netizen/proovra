"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LanguageSwitcher } from "./language-switcher";

type MarketingNavItem = {
  href: string;
  label: string;
};

type AppNavItem = {
  href: string;
  label: string;
};

const MARKETING_NAV: MarketingNavItem[] = [
  { href: "/", label: "Home" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/verify", label: "Verify" },
  { href: "/pricing", label: "Pricing" },
  { href: "/legal/security", label: "Security" },
  { href: "/about", label: "About" },
];

const APP_NAV: AppNavItem[] = [
  { href: "/home", label: "Workspace" },
  { href: "/capture", label: "Capture" },
  { href: "/cases", label: "Cases" },
  { href: "/teams", label: "Teams" },
  { href: "/reports", label: "Reports" },
  { href: "/billing", label: "Billing" },
  { href: "/settings", label: "Settings" },
];

function VelvetLinkButton({
  children,
  href,
  dark = false,
}: {
  children: React.ReactNode;
  href: string;
  dark?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group relative inline-flex h-10 items-center justify-center overflow-hidden rounded-[14px] border border-transparent px-5 text-[0.9rem] font-semibold ui-transition active:scale-[0.985] ${
        dark ? "hover-button-secondary" : "hover-button-primary"
      }`}
    >
      <img
        src="/images/site-velvet-bg.webp.png"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-[50%_10%]"
      />

      <div
        className={
          dark
            ? "absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.78)_0%,rgba(5,12,16,0.92)_100%)]"
            : "absolute inset-0 bg-[linear-gradient(180deg,rgba(58,90,94,0.75)_0%,rgba(28,52,56,0.92)_100%)]"
        }
      />

      <div className="absolute inset-0 rounded-[14px] border border-[rgba(183,157,132,0.55)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" />

      <span className="relative z-10 text-[#e6ebea]">{children}</span>
    </Link>
  );
}

function VelvetActionButton({
  children,
  dark = false,
  onClick,
}: {
  children: React.ReactNode;
  dark?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative inline-flex h-10 items-center justify-center overflow-hidden rounded-[14px] border border-transparent px-5 text-[0.9rem] font-semibold ui-transition active:scale-[0.985] ${
        dark ? "hover-button-secondary" : "hover-button-primary"
      }`}
    >
      <img
        src="/images/site-velvet-bg.webp.png"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-[50%_10%]"
      />

      <div
        className={
          dark
            ? "absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,22,0.78)_0%,rgba(5,12,16,0.92)_100%)]"
            : "absolute inset-0 bg-[linear-gradient(180deg,rgba(58,90,94,0.75)_0%,rgba(28,52,56,0.92)_100%)]"
        }
      />

      <div className="absolute inset-0 rounded-[14px] border border-[rgba(183,157,132,0.55)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" />

      <span className="relative z-10 text-[#e6ebea]">{children}</span>
    </button>
  );
}

function HeaderShell({ children }: { children: React.ReactNode }) {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 18);
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  return (
    <header className="sticky top-0 z-50 w-full px-6 pt-5 md:px-8 md:pt-6">
      <div
        className={`mx-auto flex max-w-7xl items-center justify-between rounded-[22px] px-3 py-2 transition-all duration-300 ${
          isScrolled
            ? "bg-[linear-gradient(180deg,rgba(8,18,22,0.30)_0%,rgba(8,18,22,0.18)_100%)] shadow-[0_10px_30px_rgba(0,0,0,0.16),inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-xl"
            : "bg-transparent shadow-none backdrop-blur-0"
        }`}
      >
        {children}
      </div>
    </header>
  );
}

function Brand({ href }: { href: string }) {
  return (
    <Link href={href} className="flex items-center gap-3">
      <div className="flex items-center justify-center">
        <img
          src="/brand/icon-512.png?v=2"
          alt="PROOVRA"
          className="h-[72px] w-[72px] object-contain drop-shadow-[0_10px_28px_rgba(0,0,0,0.65)]"
        />
      </div>

      <span className="text-[1.6rem] font-semibold tracking-[-0.02em] text-[#dce1de]">
        PROO✓RA
      </span>
    </Link>
  );
}

export function MarketingHeader() {
  const appLogin = "/login";
  const appRegister = "/register";

  return (
    <HeaderShell>
      <Brand href="/" />

      <nav className="hidden items-center gap-8 lg:flex">
        {MARKETING_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="hover-link-bronze text-[0.92rem] font-medium"
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-2.5">
<div className="lang-button flex items-center">
  <LanguageSwitcher />
</div>
        <VelvetLinkButton dark href={appLogin}>
          Login
        </VelvetLinkButton>

        <VelvetLinkButton href={appRegister}>Register</VelvetLinkButton>
      </div>
    </HeaderShell>
  );
}

export function AppHeader({
  hasSession,
  onLogout,
  isPlatformAdmin = false,
}: {
  hasSession: boolean;
  onLogout: () => void;
  isPlatformAdmin?: boolean;
}) {
  const pathname = usePathname();

  const navItems = useMemo<AppNavItem[]>(() => {
    if (!isPlatformAdmin) return APP_NAV;
    return [...APP_NAV, { href: "/admin", label: "Admin" }];
  }, [isPlatformAdmin]);

  const isActive = (href: string) =>
    pathname === href || (href !== "/billing" && pathname?.startsWith(`${href}/`));

  return (
    <HeaderShell>
      <Brand href="/home" />

      <nav className="hidden items-center gap-4 lg:flex">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`text-[0.92rem] font-medium ${
              isActive(item.href)
                ? "text-[#d6b89d]"
                : "hover-link-bronze text-[#dce1de]"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-2.5">
<div className="lang-button flex items-center">
  <LanguageSwitcher />
</div>
        {hasSession && (
          <VelvetActionButton dark onClick={onLogout}>
            Sign out
          </VelvetActionButton>
        )}
      </div>
    </HeaderShell>
  );
}