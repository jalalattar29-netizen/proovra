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

  const isActive = (href: string) =>
    pathname === href || (href !== "/pricing" && pathname?.startsWith(`${href}/`));
  const isPricingActive = pathname === "/pricing";

  useEffect(() => {
    if (!authReady) return;
    if (!hasSession && pathname !== "/pricing") router.replace("/login");
  }, [authReady, hasSession, router, pathname]);

  if (!authReady) {
    return (
      <div className="page app-page">
        <div className="app-loading">Loading...</div>
      </div>
    );
  }

  if (!hasSession && pathname !== "/pricing") {
    return null;
  }

  return (
    <div className="page app-page">
      <div className="app-top-bar">
        <div className="container app-top-bar-inner">
          <TopBar
            title={t("brand")}
            logoHref="/"
            logoSrc="/brand/logo-white.svg"
            center={
              <nav className="app-header-nav">
                {NAV_ITEMS.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`app-header-nav-link ${isActive(item.href) ? "active" : ""}`}
                  >
                    {t(item.label)}
                  </Link>
                ))}
                <Link
                  href="/pricing"
                  className={`app-header-nav-link ${isPricingActive ? "active" : ""}`}
                >
                  Pricing
                </Link>
              </nav>
            }
            right={
              hasSession ? (
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
              ) : (
                <div className="app-header-auth-links">
                  <Link href="/login" className="app-header-nav-link">
                    {t("login")}
                  </Link>
                  <Link href="/register" className="btn secondary">
                    {t("register")}
                  </Link>
                </div>
              )
            }
          />
        </div>
      </div>
      <SilverWatermarkSection as="main" className="app-content">
        {children}
      </SilverWatermarkSection>
      <footer className="app-footer">
        <div className="container app-footer-container">
          <div className="app-footer-inner">
            <div className="app-footer-brand">PROO✓RA</div>
            <a href="mailto:support@proovra.com">support@proovra.com</a>
          </div>
          <div className="app-footer-links">
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/legal/cookies">Cookies</Link>
            <Link href="/legal/security">Security</Link>
            <Link href="/support">Support</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
