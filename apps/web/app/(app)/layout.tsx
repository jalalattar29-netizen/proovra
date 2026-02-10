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
      const next = pathname ? `?next=${encodeURIComponent(pathname)}` : "";
      router.replace(`/login${next}`);
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
      <div className="blue-shell">
        <AppHeader hasSession={hasSession} onLogout={handleLogout} />
      </div>
      <SilverWatermarkSection as="main" className="app-content">
        {children}
      </SilverWatermarkSection>
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
