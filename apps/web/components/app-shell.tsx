"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "../app/providers";
import { TopBar } from "./ui";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useLocale();
  const navItems = [
    { href: "/home", label: t("home") },
    { href: "/capture", label: t("capture") },
    { href: "/cases", label: t("cases") },
    { href: "/teams", label: t("teams") },
    { href: "/settings", label: t("settings") }
  ];
  return (
    <div className="page">
      <TopBar title={t("brand")} />
      <div className="app-shell">
        <nav className="app-nav">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? "nav-link active" : "nav-link"}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
