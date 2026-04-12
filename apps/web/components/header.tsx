"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
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
  className = "",
  fullWidth = false,
}: {
  children: React.ReactNode;
  href: string;
  dark?: boolean;
  className?: string;
  fullWidth?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group relative inline-flex h-10 items-center justify-center overflow-hidden rounded-[14px] border border-transparent px-4 sm:px-5 text-[0.9rem] font-semibold ui-transition active:scale-[0.985] ${
        fullWidth ? "w-full" : "w-auto"
      } ${
        dark ? "hover-button-secondary" : "hover-button-primary"
      } ${className}`.trim()}
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
  className = "",
  fullWidth = false,
}: {
  children: React.ReactNode;
  dark?: boolean;
  onClick: () => void;
  className?: string;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative inline-flex h-10 items-center justify-center overflow-hidden rounded-[14px] border border-transparent px-4 sm:px-5 text-[0.9rem] font-semibold ui-transition active:scale-[0.985] ${
        fullWidth ? "w-full" : "w-auto"
      } ${
        dark ? "hover-button-secondary" : "hover-button-primary"
      } ${className}`.trim()}
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

function HeaderShell({
  children,
  mobilePanel,
}: {
  children: React.ReactNode;
  mobilePanel?: React.ReactNode;
}) {
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
    <header className="sticky top-0 z-50 w-full px-4 pt-4 sm:px-6 sm:pt-5 md:px-8 md:pt-6">
      <div
        className={`mx-auto max-w-7xl rounded-[22px] px-3 py-2 transition-all duration-300 ${
          isScrolled
            ? "bg-[linear-gradient(180deg,rgba(8,18,22,0.30)_0%,rgba(8,18,22,0.18)_100%)] shadow-[0_10px_30px_rgba(0,0,0,0.16),inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-xl"
            : "bg-transparent shadow-none backdrop-blur-0"
        }`}
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          {children}
        </div>

        {mobilePanel ? <div className="mt-3 lg:hidden">{mobilePanel}</div> : null}
      </div>
    </header>
  );
}

function Brand({ href }: { href: string }) {
  return (
    <Link href={href} className="flex min-w-0 items-center gap-2.5 sm:gap-3">
      <div className="flex shrink-0 items-center justify-center">
        <img
          src="/brand/icon-512.png?v=2"
          alt="PROOVRA"
          className="h-11 w-11 object-contain drop-shadow-[0_10px_28px_rgba(0,0,0,0.65)] sm:h-14 sm:w-14 lg:h-[72px] lg:w-[72px]"
        />
      </div>

      <span className="truncate text-[1.02rem] font-semibold tracking-[-0.02em] text-[#dce1de] sm:text-[1.16rem] lg:text-[1.6rem]">
        PROO✓RA
      </span>
    </Link>
  );
}

function MobileMenuButton({
  open,
  onClick,
  label,
}: {
  open: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={label}
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] border border-white/10 bg-white/[0.04] text-[#e6ebea] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ui-transition hover:border-[rgba(183,157,132,0.28)] hover:bg-white/[0.06]"
    >
      {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
    </button>
  );
}

function MobilePanel({
  navItems,
  extraActions,
  onNavigate,
  activeHref,
}: {
  navItems: Array<{ href: string; label: string }>;
  extraActions?: React.ReactNode;
  onNavigate: () => void;
  activeHref?: string;
}) {
  return (
    <div className="overflow-hidden rounded-[20px] border border-white/10 bg-[linear-gradient(180deg,rgba(8,18,22,0.90)_0%,rgba(6,14,18,0.95)_100%)] shadow-[0_16px_36px_rgba(0,0,0,0.22)] backdrop-blur-xl">
      <nav className="flex flex-col p-2.5" aria-label="Mobile navigation">
        {navItems.map((item) => {
          const active =
            activeHref === item.href ||
            (item.href !== "/billing" && activeHref?.startsWith(`${item.href}/`));

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`flex min-h-[46px] items-center rounded-[14px] px-4 text-[0.95rem] font-medium ui-transition ${
                active
                  ? "bg-[linear-gradient(180deg,rgba(183,157,132,0.16)_0%,rgba(255,255,255,0.04)_100%)] text-[#f1decb]"
                  : "text-[#dce1de] hover:bg-white/[0.05] hover:text-[#f0f4f2]"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-white/10 p-3">{extraActions}</div>
    </div>
  );
}

export function MarketingHeader() {
  const appLogin = "/login";
  const appRegister = "/register";
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <HeaderShell
      mobilePanel={
        mobileOpen ? (
          <MobilePanel
            navItems={MARKETING_NAV}
            activeHref={pathname ?? undefined}
            onNavigate={() => setMobileOpen(false)}
            extraActions={
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#b8c7c3]">
                    Language
                  </span>
                  <div className="lang-button flex items-center">
                    <LanguageSwitcher />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <VelvetLinkButton dark href={appLogin} fullWidth className="w-full">
                    Login
                  </VelvetLinkButton>
                  <VelvetLinkButton href={appRegister} fullWidth className="w-full">
                    Register
                  </VelvetLinkButton>
                </div>
              </div>
            }
          />
        ) : null
      }
    >
<div className="hidden lg:grid lg:w-full lg:grid-cols-[auto_1fr_auto] lg:items-center lg:gap-8">
  <div className="min-w-0">
    <Brand href="/" />
  </div>

  <nav className="flex items-center justify-center gap-8">
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

  <div className="flex items-center justify-end gap-2.5">
    <div className="lang-button flex items-center">
      <LanguageSwitcher />
    </div>

    <VelvetLinkButton dark href={appLogin}>
      Login
    </VelvetLinkButton>

    <VelvetLinkButton href={appRegister}>Register</VelvetLinkButton>
  </div>
</div>

<div className="min-w-0 flex-1 lg:hidden">
  <Brand href="/" />
</div>

      <div className="flex shrink-0 items-center gap-2 lg:hidden">
        <div className="lang-button flex items-center">
          <LanguageSwitcher />
        </div>

        <MobileMenuButton
          open={mobileOpen}
          onClick={() => setMobileOpen((prev) => !prev)}
          label="Toggle navigation menu"
        />
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
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = useMemo<AppNavItem[]>(() => {
    if (!isPlatformAdmin) return APP_NAV;
    return [...APP_NAV, { href: "/admin", label: "Admin" }];
  }, [isPlatformAdmin]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const isActive = (href: string) =>
    pathname === href || (href !== "/billing" && pathname?.startsWith(`${href}/`));

  return (
    <HeaderShell
      mobilePanel={
        mobileOpen ? (
          <MobilePanel
            navItems={navItems}
            activeHref={pathname ?? undefined}
            onNavigate={() => setMobileOpen(false)}
            extraActions={
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-[#b8c7c3]">
                    Language
                  </span>
                  <div className="lang-button flex items-center">
                    <LanguageSwitcher />
                  </div>
                </div>

                {hasSession ? (
                  <VelvetActionButton dark onClick={onLogout} fullWidth className="w-full">
                    Sign out
                  </VelvetActionButton>
                ) : null}
              </div>
            }
          />
        ) : null
      }
    >
<div className="hidden lg:grid lg:w-full lg:grid-cols-[auto_1fr_auto] lg:items-center lg:gap-8">
  <div className="min-w-0">
    <Brand href="/home" />
  </div>

  <nav className="flex items-center justify-center gap-4">
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

  <div className="flex items-center justify-end gap-2.5">
    <div className="lang-button flex items-center">
      <LanguageSwitcher />
    </div>

    {hasSession && (
      <VelvetActionButton dark onClick={onLogout}>
        Sign out
      </VelvetActionButton>
    )}
  </div>
</div>

<div className="min-w-0 flex-1 lg:hidden">
  <Brand href="/home" />
</div>

      <div className="flex shrink-0 items-center gap-2 lg:hidden">
        <div className="lang-button flex items-center">
          <LanguageSwitcher />
        </div>

        <MobileMenuButton
          open={mobileOpen}
          onClick={() => setMobileOpen((prev) => !prev)}
          label="Toggle app navigation menu"
        />
      </div>
    </HeaderShell>
  );
}