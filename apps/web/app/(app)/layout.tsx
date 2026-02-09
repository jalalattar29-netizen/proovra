"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { TopBar } from "../../components/ui";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import { translations } from "../../lib/i18n";
import { useAuth, useLocale } from "../providers";
import { apiFetch } from "../../lib/api";

type NavKey = keyof (typeof translations)["en"];
const NAV_ITEMS: Array<{ href: string; label: NavKey }> = [
  { href: "/home", label: "home" },
  { href: "/capture", label: "capture" },
  { href: "/cases", label: "cases" },
  { href: "/teams", label: "teams" },
  { href: "/settings", label: "settings" }
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { setToken, authReady, hasSession } = useAuth();
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const isActive = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);

  useEffect(() => {
    if (!authReady) return;
    if (!hasSession) router.replace("/login");
  }, [authReady, hasSession, router]);

  if (!authReady) {
    return (
      <div className="page app-page">
        <div className="app-loading">Loading...</div>
      </div>
    );
  }

  if (!hasSession) {
    return null;
  }

  return (
    <div className="page app-page">
      <div className="container app-top-bar">
        <TopBar
          title={t("brand")}
          logoHref="/home"
          right={
            <button
              className="btn secondary"
              type="button"
              onClick={async () => {
                try {
                  await apiFetch("/v1/auth/logout", { method: "POST" });
                } catch {
                  // ignore
                } finally {
                  setToken(null);
                }
              }}
            >
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
        <SilverWatermarkSection as="main" className="app-content">
          {children}
        </SilverWatermarkSection>
      </div>
    </div>
  );
}
