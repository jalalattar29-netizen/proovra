"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  Globe2,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
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
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "P";
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

  const navItems = isPlatformAdmin
    ? [...TOP_NAV, { href: "/admin", label: "Admin" }]
    : TOP_NAV;

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
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`app-topbar-v2-nav-link ${
                isActiveRoute(pathname, item.href) ? "is-active" : ""
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="app-topbar-v2-actions">
          <div className="app-topbar-v2-language">
            <Globe2 size={16} strokeWidth={1.9} />
            <LanguageSwitcher />
          </div>

          <div className="app-topbar-v2-account">
            <button
              type="button"
              className="app-topbar-v2-user"
              onClick={() => setAccountOpen((prev) => !prev)}
              aria-expanded={accountOpen}
            >
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="app-topbar-v2-avatar" />
              ) : (
                <div className="app-topbar-v2-avatar-fallback">{getInitials(user)}</div>
              )}

              <div className="app-topbar-v2-user-copy">
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
              </div>

              <ChevronDown size={16} strokeWidth={1.9} />
            </button>

            {accountOpen ? (
              <div className="app-topbar-v2-account-menu">
                <Link href="/settings" onClick={() => setAccountOpen(false)}>
                  <Settings size={16} strokeWidth={1.9} />
                  Settings
                </Link>

                <Link href="/home" onClick={() => setAccountOpen(false)}>
                  <UserRound size={16} strokeWidth={1.9} />
                  Workspace
                </Link>

                <button type="button" onClick={onLogout}>
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