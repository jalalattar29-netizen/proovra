"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { TopBar } from "../../components/ui";
import { translations } from "../../lib/i18n";
import { useAuth, useLocale } from "../providers";

type NavKey = keyof (typeof translations)["en"];
const NAV_ITEMS: Array<{ href: string; label: NavKey }> = [
  { href: "/home", label: "home" },
  { href: "/capture", label: "capture" },
  { href: "/cases", label: "cases" },
  { href: "/teams", label: "teams" },
  { href: "/settings", label: "settings" }
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { token, setToken, authReady } = useAuth();
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const isActive = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);

  useEffect(() => {
    if (!authReady) return;
    if (!token) router.replace("/login");
  }, [authReady, token, router]);

  if (!authReady) {
    return (
      <div className="page app-page">
        <div className="app-loading">Loading...</div>
      </div>
    );
  }

  if (!token) {
    return null;
  }

  return (
    <div className="page app-page">
      <div className="container">
        <TopBar
          title={t("brand")}
          right={
            <button className="btn secondary" type="button" onClick={() => setToken(null)}>
              {t("logout")}
            </button>
          }
        />
      </div>
      <div className="app-shell container">
        <nav className="app-nav">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-link ${isActive(item.href) ? "active" : ""}`}
            >
              {t(item.label)}
            </Link>
          ))}
          <Link href="/pricing" className="nav-link">
            Pricing
          </Link>
        </nav>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
