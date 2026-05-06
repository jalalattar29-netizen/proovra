"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  ChevronDown,
  Globe2,
  LogOut,
  ShieldCheck,
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
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "P";
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
          <button
            type="button"
            className="app-topbar-v2-icon-button"
            aria-label="Notifications"
          >
            <Bell size={18} strokeWidth={1.9} />
            <span className="app-topbar-v2-notification-dot">3</span>
          </button>

          <div className="app-topbar-v2-language">
            <Globe2 size={16} strokeWidth={1.9} />
            <LanguageSwitcher />
          </div>

          <div className="app-topbar-v2-user">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                className="app-topbar-v2-avatar"
              />
            ) : (
              <div className="app-topbar-v2-avatar-fallback">
                {getInitials(user)}
              </div>
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
          </div>

          <button
            type="button"
            className="app-topbar-v2-logout"
            onClick={onLogout}
          >
            <LogOut size={16} strokeWidth={1.9} />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
}