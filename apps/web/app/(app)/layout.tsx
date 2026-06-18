"use client";

import "../globals.css";

import { useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AppShellV2 } from "../../components/app-shell-v2/AppShellV2";
import { ProovraChatWidget } from "../../components/ai/ProovraChatWidget";
import { useAuth } from "../providers";
import { PlatformContextProvider } from "../../lib/platform-context";

/**
 * Phase 32.8 Foundation — (app)/layout wraps every operator surface
 * with the canonical PlatformContextProvider. Every nested page reads
 * user, workspace, role, persona, capabilities, and navigation
 * exclusively from `usePlatformContext()`.
 *
 * IMPORTANT: This layout NO LONGER derives `isPlatformAdmin` from
 * `user.platformRole`. The canonical envelope's
 * `envelope.platform.isPlatformAdmin` is the single source of truth.
 * Components that previously received `isPlatformAdmin` as a prop now
 * read it from context.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const { authReady, hasSession, setToken, updateUser } = useAuth();

  // Phase scroll-perf — the body decorative effects (fixed gradient,
  // soft-light noise overlay, fixed radial overlays) live in globals.css
  // under `body.has-app-decor`. They cause scroll-jank when applied to
  // marketing routes because they trigger full-viewport repaints on
  // every scroll frame. Apply the class only while the (app) layout is
  // mounted so the dashboard keeps its texture but the marketing site
  // (which uses only the root layout) stays clean.
  useEffect(() => {
    document.body.classList.add("has-app-decor");
    return () => {
      document.body.classList.remove("has-app-decor");
    };
  }, []);

  const hideAiWidget = useMemo(() => {
    if (!pathname) return false;
    return pathname.startsWith("/admin") || pathname.startsWith("/verify");
  }, [pathname]);

  const handleLogout = () => {
    try {
      localStorage.removeItem("proovra-token");
    } catch {
      //
    }

    setToken(null);
    updateUser(null);

    router.push("/login");
  };

  if (!authReady) {
    return <div className="min-h-screen bg-[#f3f5f7]" />;
  }

  return (
    <PlatformContextProvider>
      <AppShellV2 onLogout={handleLogout}>
        {children}
        {hasSession && !hideAiWidget ? <ProovraChatWidget /> : null}
      </AppShellV2>
    </PlatformContextProvider>
  );
}
