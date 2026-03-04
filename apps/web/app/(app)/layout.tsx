"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";

import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import { AppHeader } from "../../components/header";
import { Icons } from "../../components/icons";
import { apiFetch } from "../../lib/api";
import { LEGAL_LINKS } from "../../lib/legalLinks";
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

function getWebBase(): string {
  return process.env.NEXT_PUBLIC_WEB_BASE || "https://www.proovra.com";
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { setToken, authReady, hasSession } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // prevent repeated hard redirects
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (!authReady) return;
    if (hasSession) {
      redirectedRef.current = false;
      return;
    }

    if (redirectedRef.current) return;
    redirectedRef.current = true;

    const webBase = getWebBase();
    const next = pathname ? encodeURIComponent(pathname) : "";
    const returnUrl = next ? `returnUrl=${next}` : "";
    const separator = returnUrl ? "?" : "";

    // hard redirect (different origin) is required because login lives on WEB host
    window.location.assign(`${webBase}/login${separator}${returnUrl}`);
  }, [authReady, hasSession, pathname]);

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

  const webSupportHref = useMemo(() => `${getWebBase()}/support`, []);

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
      <div className="blue-shell app-shell-top">
        <AppHeader hasSession={hasSession} onLogout={handleLogout} />
      </div>

      <SilverWatermarkSection as="main" className="app-content">
        {children}
      </SilverWatermarkSection>

      <footer className="landing-footer container">
        <div className="footer-left">
          <div className="footer-brand">PROO✓RA</div>
          <a href="mailto:support@proovra.com">support@proovra.com</a>
        </div>

        <div className="footer-links">
          {LEGAL_LINKS.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}

          {/* ✅ open in new tab so user doesn’t “lose session” by switching origin */}
          <a href={webSupportHref} target="_blank" rel="noopener noreferrer">
            Support
          </a>
        </div>
      </footer>

      <nav className="app-bottom-nav">
        <div className="container app-bottom-nav-inner">
          {BOTTOM_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`app-bottom-nav-link ${isActive(item.href) ? "active" : ""}`}
            >
              <item.Icon />
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}