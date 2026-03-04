"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { SilverWatermarkSection } from "../../components/SilverWatermarkSection";
import { AppHeader } from "../../components/header";
import { Icons } from "../../components/icons";
import { useAuth } from "../providers";
import { apiFetch } from "../../lib/api";

const BOTTOM_NAV = [
  { href: "/home", label: "Dashboard", Icon: Icons.Dashboard },
  { href: "/capture", label: "Capture", Icon: Icons.Capture },
  { href: "/cases", label: "Evidence", Icon: Icons.Evidence },
  { href: "/teams", label: "Teams", Icon: Icons.Teams },
  { href: "/reports", label: "Reports", Icon: Icons.Reports },
  { href: "/billing", label: "Billing", Icon: Icons.Billing },
  { href: "/settings", label: "Settings", Icon: Icons.Settings }
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { setToken, authReady, hasSession } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!authReady) return;
    if (!hasSession) {
      const webBase = process.env.NEXT_PUBLIC_WEB_BASE || "https://www.proovra.com";
      const next = pathname ? encodeURIComponent(pathname) : "";
      const returnUrl = next ? `returnUrl=${next}` : "";
      const separator = returnUrl ? "?" : "";
      window.location.href = `${webBase}/login${separator}${returnUrl}`;
    }
  }, [authReady, hasSession, router, pathname]);

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

  const isActive = (href: string) =>
    pathname === href || (href !== "/billing" && pathname?.startsWith(`${href}/`));

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
          <Link href="/legal/privacy">Privacy Policy</Link>
          <Link href="/legal/terms">Terms of Use</Link>
          <Link href="/legal/cookies">Cookies</Link>
          <Link href="/legal/security">Security</Link>
          <Link href="/legal/dpa">DPA</Link>
          <Link href="/legal/law-enforcement">Law Enforcement</Link>
          <Link href="/legal/acceptable-use">Acceptable Use</Link>
          <Link href="/legal/dmca">DMCA</Link>
          <Link href="/legal/transparency">Transparency</Link>
          <Link href="/legal/verification">Verification</Link>
          <Link href="/legal/impressum">Impressum</Link>
          <Link href="/support">Support</Link>
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
