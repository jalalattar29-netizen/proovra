"use client";

import "../globals.css";

import { Fragment, useEffect, useMemo } from "react";
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
    // Cookie-banner scope — mark the authenticated app shell so the
    // public cookie consent banner + privacy launcher (rendered once in
    // the ROOT layout for marketing/external pages) are hidden on
    // internal pages. Layout-scoped via the (app) route group — no
    // fragile per-route pathname allowlist. Consent persistence and
    // analytics init are unaffected (the CMP still initialises globally;
    // only the visible banner/launcher are suppressed on internal pages).
    document.body.classList.add("is-internal-app");
    return () => {
      document.body.classList.remove("has-app-decor");
      document.body.classList.remove("is-internal-app");
    };
  }, []);

  const hideAiWidget = useMemo(() => {
    if (!pathname) return false;
    return (
      pathname.startsWith("/admin") ||
      pathname.startsWith("/verify") ||
      pathname.startsWith("/v/") ||
      pathname.startsWith("/share") ||
      pathname.startsWith("/intake") ||
      pathname.startsWith("/portal") ||
      pathname.startsWith("/auth")
    );
  }, [pathname]);

  const handleLogout = async () => {
    // Tell the backend to clear the HttpOnly `proovra_session` cookie.
    try {
      const { apiFetch } = await import("../../lib/api");
      await apiFetch("/v1/auth/logout", { method: "POST" }, { auth: true, retryAuthOnce: false });
    } catch {
      // best-effort — proceed with local clear regardless
    }

    // Defensive cleanup of any legacy localStorage auth token.
    try {
      localStorage.removeItem("proovra-token");
    } catch {
      // ignore
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
        {/* Both slots carry STABLE DOMAIN KEYS, and the route child rides a
            keyed fragment — deliberately, and not decoration:

            `children` here is the server route subtree, which arrives as a
            Flight-deserialized lazy element WITHOUT the `validated` mark the
            jsx runtime stamps on the elements it creates. React 19 validates
            keys in the reconciler off that mark, so this pair — an array by
            the time the shell's <main> renders it — logged a missing-key
            warning on every post-login mount, blamed on whichever component
            owned the slot (`main`, then `AppLayout`). Traced with a fiber
            walk and bisection: the child fiber is the lazy route element,
            and Next's dev segment-explorer was ruled out separately (its
            wrapper is gone from the warning's fiber chain with the flag off,
            and the warning survived).

            The route child is opaque, so the key lives on a fragment AROUND
            it; the fragment holds one child, so nothing under it reconciles
            as an array. The keys are identity, not order: the two slots are
            different kinds of thing, and neither ever swaps position. */}
        <Fragment key="route-content">{children}</Fragment>
        {hasSession && !hideAiWidget ? (
          <ProovraChatWidget key="assistant-widget" />
        ) : null}
      </AppShellV2>
    </PlatformContextProvider>
  );
}
