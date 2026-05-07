"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  Globe2,
  LogOut,
  Menu,
  X,
  Settings,
  ShieldCheck,
  UserCircle,
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
  mobileSidebarOpen = false,
  onToggleMobileSidebar,
}: {
  user: AppShellUserV2 | null;
  onLogout: () => void;
  isPlatformAdmin?: boolean;
  mobileSidebarOpen?: boolean;
  onToggleMobileSidebar?: () => void;
}) {
  const pathname = usePathname();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const navItems = isPlatformAdmin
    ? [...TOP_NAV, { href: "/admin", label: "Admin" }]
    : TOP_NAV;

  return (
    <header className="app-topbar-v2">
      <div className="app-topbar-v2-bg" />

      <div className="app-topbar-v2-inner">
        <button
  type="button"
  className="app-topbar-v2-mobile-menu"
  onClick={onToggleMobileSidebar}
  aria-label={mobileSidebarOpen ? "Close navigation" : "Open navigation"}
>
  {mobileSidebarOpen ? <X size={22} /> : <Menu size={22} />}
</button>
<Link href="/home" className="app-topbar-v2-brand" aria-label="PROOVRA home">
  <span className="app-topbar-v2-brand-icon-wrap">
    <img
      src="/brand/icon-512.png?v=2"
      alt=""
      className="app-topbar-v2-brand-icon"
    />
  </span>

  <span className="app-topbar-v2-brand-name">PROO✓RA</span>
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

          <div className="app-topbar-v2-account" ref={accountRef}>
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
              <div className="app-topbar-v2-account-menu" role="menu">
                <div className="app-topbar-v2-account-menu-header">
                  <strong>{getUserDisplayName(user)}</strong>
                  <span>{user?.email ?? "Signed in account"}</span>
                </div>

                <Link href="/settings" role="menuitem" onClick={() => setAccountOpen(false)}>
                  <Settings size={16} strokeWidth={1.9} />
                  Settings
                </Link>

                <Link href="/home" role="menuitem" onClick={() => setAccountOpen(false)}>
                  <UserCircle size={16} strokeWidth={1.9} />
                  Workspace
                </Link>

<button
  type="button"
  role="menuitem"
  onClick={onLogout}
  className="app-user-menu-signout"
>
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