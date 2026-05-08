"use client";

import type { ForwardRefExoticComponent, RefAttributes } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BriefcaseBusiness,
  Camera,
  CreditCard,
  FileSearch,
  FileText,
  Gauge,
  Headphones,
  LibraryBig,
  Settings,
  ShieldCheck,
  Users,
  type LucideProps,
} from "lucide-react";

type SidebarIcon = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

type SidebarItem = {
  href: string;
  label: string;
  Icon: SidebarIcon;
};

const WORKSPACE_NAV: SidebarItem[] = [
  { href: "/home", label: "Dashboard", Icon: Gauge },
  { href: "/capture", label: "Capture", Icon: Camera },
  { href: "/reports", label: "Reports", Icon: FileText },
  { href: "/evidence", label: "Evidence", Icon: LibraryBig },
];

const MANAGE_NAV: SidebarItem[] = [
  { href: "/cases", label: "Cases", Icon: BriefcaseBusiness },
  { href: "/teams", label: "Teams", Icon: Users },
  { href: "/billing", label: "Billing", Icon: CreditCard },
];

const ADMIN_NAV: SidebarItem[] = [
  { href: "/settings", label: "Settings", Icon: Settings },
];

function isActiveRoute(pathname: string | null, href: string) {
  if (!pathname) return false;
  return pathname === href || (href !== "/billing" && pathname.startsWith(`${href}/`));
}

function SidebarGroup({
  title,
  items,
}: {
  title: string;
  items: SidebarItem[];
}) {
  const pathname = usePathname();

  return (
    <div className="app-sidebar-v2-group">
      <div className="app-sidebar-v2-group-title">{title}</div>

      <nav className="app-sidebar-v2-nav" aria-label={title}>
        {items.map((item) => {
          const active = isActiveRoute(pathname, item.href);

          return (
            <Link
              key={`${title}-${item.href}-${item.label}`}
              href={item.href}
              className={`app-sidebar-v2-link ${active ? "is-active" : ""}`}
            >
              <span className="app-sidebar-v2-link-icon">
                <item.Icon size={17} strokeWidth={1.9} />
              </span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function AppSidebarV2({
  isPlatformAdmin = false,
}: {
  isPlatformAdmin?: boolean;
}) {
  return (
    <aside className="app-sidebar-v2">
      <div className="app-sidebar-v2-bg" />

      <div className="app-sidebar-v2-inner">
        <div className="app-sidebar-v2-scroll">
          <SidebarGroup title="Workspace" items={WORKSPACE_NAV} />
          <SidebarGroup title="Manage" items={MANAGE_NAV} />
          <SidebarGroup
            title={isPlatformAdmin ? "Admin" : "Account"}
            items={ADMIN_NAV}
          />
        </div>

        <div className="app-sidebar-v2-trust-card">
          <div className="app-sidebar-v2-trust-icon">
            <ShieldCheck size={20} strokeWidth={2} />
          </div>
          <strong>Verification-first</strong>
          <p>We do not store truth. We record integrity. You own the evidence.</p>
          <Link href="/legal/verification-methodology">Learn more →</Link>
        </div>

<Link href="/support" className="app-sidebar-v2-help">
  <Headphones size={18} strokeWidth={1.9} />
  <span>
    <strong>Need help?</strong>
    <small>Contact support</small>
  </span>
</Link>
      </div>
    </aside>
  );
}