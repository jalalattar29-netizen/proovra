"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import { AppHeader } from "../../components/header";
import { Icons } from "../../components/icons";
import { Footer } from "../../components/Footer";
import AnalyticsTracker from "../../components/analytics-tracker";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../providers";

const BOTTOM_NAV = [
  { href: "/home", label: "Dashboard", Icon: Icons.Dashboard },
  { href: "/capture", label: "Capture", Icon: Icons.Capture },
  { href: "/cases", label: "Evidence", Icon: Icons.Evidence },
  { href: "/teams", label: "Teams", Icon: Icons.Teams },
  { href: "/reports", label: "Reports", Icon: Icons.Reports },
  { href: "/billing", label: "Billing", Icon: Icons.Billing },
  { href: "/settings", label: "Settings", Icon: Icons.Settings }
];

const MOBILE_PRIMARY_NAV = ["/home", "/capture", "/cases"];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { setToken, authReady, hasSession } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!authReady) return;

    const stored =
      typeof window !== "undefined" ? localStorage.getItem("proovra-token") : null;

    if (!hasSession && !stored) {
      const webBase = process.env.NEXT_PUBLIC_WEB_BASE || "https://www.proovra.com";
      const next = pathname ? encodeURIComponent(pathname) : "";
      const returnUrl = next ? `returnUrl=${next}` : "";
      const separator = returnUrl ? "?" : "";
      window.location.assign(`${webBase}/login${separator}${returnUrl}`);
    }
  }, [authReady, hasSession, pathname]);

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  const handleLogout = async () => {
    try {
      await apiFetch("/v1/auth/logout", { method: "POST" });
    } catch {
      // ignore
    } finally {
      setToken(null);
      router.replace("/");
    }
  };

  const isActive = (href: string) =>
    pathname === href || (href !== "/billing" && pathname?.startsWith(`${href}/`));

  const mobilePrimaryItems = useMemo(
    () => BOTTOM_NAV.filter((item) => MOBILE_PRIMARY_NAV.includes(item.href)),
    []
  );

  const mobileMoreItems = useMemo(
    () => BOTTOM_NAV.filter((item) => !MOBILE_PRIMARY_NAV.includes(item.href)),
    []
  );

  const moreIsActive = mobileMoreItems.some((item) => isActive(item.href));

  if (!authReady) {
    return (
      <div className="page app-page">
        <div className="app-loading">Loading...</div>
      </div>
    );
  }

  if (!hasSession) return null;

  return (
    <div className="page app-page">
      <AnalyticsTracker />

      <div className="blue-shell app-shell-top">
        <AppHeader hasSession={hasSession} onLogout={handleLogout} />
      </div>

      <SilverWatermarkSection as="main" className="app-content">
        {children}
      </SilverWatermarkSection>

      <Footer />

      <nav className="app-bottom-nav">
        <div className="container app-bottom-nav-inner">
          {mobilePrimaryItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`app-bottom-nav-link ${isActive(item.href) ? "active" : ""}`}
            >
              <item.Icon />
              <span>{item.label}</span>
            </Link>
          ))}

          <button
            type="button"
            className={`app-bottom-nav-link app-bottom-nav-more-trigger app-bottom-nav-mobile-only ${
              moreIsActive || moreOpen ? "active" : ""
            }`}
            onClick={() => setMoreOpen((prev) => !prev)}
            aria-expanded={moreOpen}
            aria-label="More navigation items"
          >
            <span className="app-bottom-nav-more-dots" aria-hidden="true">
              •••
            </span>
            <span>More</span>
          </button>
        </div>
      </nav>

      {moreOpen && (
        <>
          <button
            type="button"
            className="app-bottom-nav-more-backdrop"
            aria-label="Close more navigation"
            onClick={() => setMoreOpen(false)}
          />

          <div className="app-bottom-nav-more-sheet" role="dialog" aria-modal="true">
            <div className="app-bottom-nav-more-sheet-header">
              <div className="app-bottom-nav-more-sheet-title">More</div>
              <button
                type="button"
                className="app-bottom-nav-more-close"
                onClick={() => setMoreOpen(false)}
                aria-label="Close more navigation"
              >
                ×
              </button>
            </div>

            <div className="app-bottom-nav-more-list">
              {mobileMoreItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`app-bottom-nav-more-item ${isActive(item.href) ? "active" : ""}`}
                >
                  <item.Icon />
                  <span>{item.label}</span>
                </Link>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}