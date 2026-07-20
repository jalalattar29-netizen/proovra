"use client";

/**
 * Phase IA-surface-tier — client-side page-level surface gate.
 *
 * Pages that belong to hidden tiers (ENTERPRISE / INTERNAL / plan-gated)
 * wrap their body in `<SurfaceGate>`. At render time the gate:
 *
 *   1. Reads `usePlatformContext()` to learn plan / role / admin flags.
 *   2. Runs `getDirectAccessDecision(ctx, pathname)`.
 *   3. Applies the bounded outcome:
 *        - allow      → renders children.
 *        - redirect   → next/navigation.useRouter().replace(target).
 *        - notFound   → next/navigation.notFound() (renders not-found.tsx).
 *        - forbidden  → renders a bounded 403 affordance.
 *
 * Why client-side: the middleware only has the path. The full plan /
 * role / `isPlatformAdmin` is established at the PlatformContext layer
 * AFTER the JWT round-trips. We need both layers — middleware catches
 * unauthenticated direct hits to INTERNAL surfaces; this component
 * catches authenticated mis-tier hits.
 *
 * NOTE: never call this from a server component — `usePlatformContext`
 * is a client hook.
 */

import { notFound, usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { getDirectAccessDecision } from "../../lib/surface/access";
import { useSurfaceUserContext } from "../../lib/surface/useSurfaceUserContext";
import { ProovraErrorState } from "../feedback/ProovraErrorState";

export type SurfaceGateProps = {
  children: ReactNode;
  /**
   * Optional explicit override — when set, the gate uses this pathname
   * instead of `usePathname()`. Useful when wrapping a route group
   * whose canonical path differs from the rendered path (e.g. shared
   * `[id]` segment).
   */
  pathnameOverride?: string;
  /**
   * Optional render override for the forbidden case. Defaults to a
   * minimal bounded message.
   */
  forbiddenFallback?: ReactNode;
};

export function SurfaceGate({
  children,
  pathnameOverride,
  forbiddenFallback,
}: SurfaceGateProps) {
  const pathname = usePathname();
  const router = useRouter();
  const userCtx = useSurfaceUserContext();
  const effectivePath = pathnameOverride ?? pathname ?? "/";
  const decision = getDirectAccessDecision(userCtx, effectivePath);

  useEffect(() => {
    if (decision.kind === "redirect") {
      router.replace(decision.to);
    }
  }, [decision, router]);

  if (decision.kind === "allow") {
    return <>{children}</>;
  }
  if (decision.kind === "notFound") {
    notFound();
  }
  if (decision.kind === "forbidden") {
    if (forbiddenFallback) return <>{forbiddenFallback}</>;
    // Branded access-denied — never a bare "Forbidden" heading.
    return (
      <ProovraErrorState
        severity="warning"
        showLogo={false}
        minHeight="60vh"
        title="You don't have access to this area"
        message="This workspace or feature may require additional permissions, or isn't included on your current plan. Ask a workspace admin for access, or head back to the dashboard."
        actions={[
          { label: "Back to dashboard", href: "/home", variant: "primary" },
          { label: "View plans", href: "/billing", variant: "secondary" },
          // /support is a public page; this forbidden state renders inside
          // the authenticated App Shell, so open it in a new tab (external
          // cue) rather than replacing the app in the current tab.
          { label: "Contact support", href: "/support", variant: "secondary", external: true },
        ]}
      />
    );
  }
  // redirect case — render nothing while router.replace runs.
  return null;
}
