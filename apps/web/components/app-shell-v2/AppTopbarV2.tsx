"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  Globe2,
  LogOut,
  Settings,
  ShieldCheck,
  UserCircle,
  CreditCard,
  LifeBuoy,
} from "lucide-react";
import { LanguageSwitcher } from "../language-switcher";

export type AppShellUserV2 = {
  email?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  platformRole?: string | null;
};

const TOP_NAV = [
  { href: "/home", label: "Workspace" },
  { href: "/capture", label: "Capture" },
  { href: "/cases", label: "Cases" },
  { href: "/teams", label: "Teams" },
  { href: "/reports", label: "Reports" },
  { href: "/billing", label: "Billing" },
  { href: "/settings", label: "Settings" },
];

function isActiveRoute(pathname: string | null, href: string) {
  if (!pathname) return false;
  return pathname === href || (href !== "/billing" && pathname.startsWith(`${href}/`));
}

function getUserDisplayName(user: AppShellUserV2 | null) {
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  return fullName || user?.displayName || user?.email || "Account";
}

function getInitials(user: AppShellUserV2 | null) {
  const name = getUserDisplayName(user);
  const parts = name.split(/[.\s@_-]+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "P"
  );
}

export function AppTopbarV2({
  user,
  onLogout,
  isPlatformAdmin = false,
}: {
  user: AppShellUserV2 | null;
  onLogout: () => void;
  isPlatformAdmin?: boolean;
}) {
  const pathname = usePathname();
  const [accountOpen, setAccountOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const navItems = isPlatformAdmin
    ? [...TOP_NAV, { href: "/admin", label: "Admin" }]
    : TOP_NAV;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    setAccountOpen(false);
  }, [pathname]);

  return (
    <header className="app-topbar-v2">
      <div className="app-topbar-v2-bg" />

      <div className="app-topbar-v2-inner">
        <Link href="/home" className="app-topbar-v2-brand">
          <img
            src="/brand/icon-512.png?v=2"
            alt="PROOVRA"
            className="app-topbar-v2-brand-icon"
          />
          <span className="app-topbar-v2-brand-text">
            <strong>PROOVRA</strong>
            <small>VERIFICATION-FIRST</small>
          </span>
        </Link>

        <nav className="app-topbar-v2-nav" aria-label="Primary app navigation">
          {navItems.map((item) => {
            const active = isActiveRoute(pathname, item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`app-topbar-v2-nav-link ${active ? "is-active" : ""}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="app-topbar-v2-actions">
          <div className="app-topbar-v2-language">
            <Globe2 size={16} strokeWidth={1.9} />
            <LanguageSwitcher />
          </div>

          <div ref={menuRef} className="app-topbar-v2-account">
            <button
              type="button"
              className={`app-topbar-v2-user ${accountOpen ? "is-open" : ""}`}
              onClick={() => setAccountOpen((prev) => !prev)}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
            >
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="app-topbar-v2-avatar" />
              ) : (
                <span className="app-topbar-v2-avatar-fallback">
                  {getInitials(user)}
                </span>
              )}

              <span className="app-topbar-v2-user-copy">
                <strong>{getUserDisplayName(user)}</strong>
                <span>
                  {isPlatformAdmin ? (
                    <>
                      <ShieldCheck size={12} strokeWidth={2} />
                      Admin
                    </>
                  ) : (
                    "Workspace"
                  )}
                </span>
              </span>

              <ChevronDown size={16} strokeWidth={1.9} />
            </button>

            {accountOpen ? (
              <div className="app-topbar-v2-account-menu" role="menu">
                <div className="app-topbar-v2-account-menu-header">
                  <strong>{getUserDisplayName(user)}</strong>
                  <span>{user?.email ?? "Signed in"}</span>
                </div>

                <Link href="/settings" role="menuitem">
                  <UserCircle size={16} strokeWidth={1.9} />
                  Profile
                </Link>

                <Link href="/settings" role="menuitem">
                  <Settings size={16} strokeWidth={1.9} />
                  Account settings
                </Link>

                <Link href="/billing" role="menuitem">
                  <CreditCard size={16} strokeWidth={1.9} />
                  Billing
                </Link>

                <Link href="/legal/support" role="menuitem">
                  <LifeBuoy size={16} strokeWidth={1.9} />
                  Support
                </Link>

                <button type="button" onClick={onLogout} role="menuitem">
                  <LogOut size={16} strokeWidth={1.9} />
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}