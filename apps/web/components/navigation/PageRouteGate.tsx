"use client";

/**
 * PHASE 38.6 — Canonical page-level route gate.
 *
 * Renders one of six structured states based on the canonical
 * `resolveRouteAccess()` decision:
 *
 *   - ALLOWED                → renders children
 *   - NEEDS_ORGANIZATION     → "Create or switch organization" panel
 *   - NEEDS_PERSONAL_OR_ORG  → "Open workspaces" panel (recovery path)
 *   - DENIED_NO_CAPABILITY   → "Request access" panel
 *   - NEEDS_UPGRADE          → "Upgrade" panel
 *   - PLATFORM_ADMIN_ONLY    → renders nothing (matches sidebar hide)
 *
 * Hard rules:
 *
 *   1. NEVER renders a blank page. Every denied state has a structured
 *      panel with primary + (optional) secondary action.
 *   2. NEVER consults workflow / persona. Access is upstream-decided.
 *   3. Reads only the canonical envelope — no fetches, no separate
 *      capability checks. Capability map comes from the envelope.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { usePlatformContext } from "../../lib/platform-context";
import { getRouteDefinition } from "../../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../../lib/navigation/routeAccessResolver";

export function PageRouteGate({
  routeId,
  children,
}: {
  routeId: string;
  children: ReactNode;
}) {
  const { envelope } = usePlatformContext();
  const route = getRouteDefinition(routeId);

  // Unknown route id → render children. Treating an unregistered route
  // as a hard 404 would make the gate too dangerous during incremental
  // migration. Source-contract tests catch unregistered ids separately.
  if (!route) return <>{children}</>;

  const activeSpaceType =
    envelope?.activeSpace?.type ?? null;
  const access = resolveRouteAccess({
    route,
    activeSpaceType,
    isPlatformAdmin: envelope?.platform?.isPlatformAdmin === true,
    capabilities: envelope?.capabilities ?? {},
    accountPlan: envelope?.account?.accountPlan ?? null,
  });

  if (access.canLoad) return <>{children}</>;

  if (access.accessState === "PLATFORM_ADMIN_ONLY") {
    // Hide entirely — matches the sidebar's hide behavior.
    return null;
  }

  // Every other denied state renders a structured panel.
  return (
    <main
      className="cc-page"
      data-page-route-gate
      data-page-route-gate-state={access.accessState}
      data-page-route-gate-route-id={routeId}
      // Phase 2.7Z+ — stable e2e testid. The existing
      // `data-page-route-gate-*` attributes encode runtime state
      // (which is useful for visual debugging but varies per
      // envelope shape). The testid here is route-stable so e2e
      // can wait for "the route gate panel is on screen for this
      // route id" without coupling to access state.
      data-testid={`route-gate-${routeId}`}
      style={{ maxWidth: 640, margin: "0 auto" }}
    >
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">{route.label}</div>
          <h1 className="cc-title">{deniedHeadline(access.accessState)}</h1>
          <p className="cc-subtitle">{access.reason}</p>
        </div>
      </header>

      <section className="cc-section" data-page-route-gate-actions>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {access.primaryAction ? (
            <Link
              href={access.primaryAction.href}
              className="cc-quick-action"
              data-page-route-gate-primary-action
            >
              {access.primaryAction.label}
            </Link>
          ) : null}
          {access.secondaryAction ? (
            <Link
              href={access.secondaryAction.href}
              className="cases-filter-chip"
              data-page-route-gate-secondary-action
            >
              {access.secondaryAction.label}
            </Link>
          ) : null}
          <Link
            href="/tools"
            className="cases-filter-chip"
            data-page-route-gate-all-tools
          >
            Browse all tools
          </Link>
        </div>
      </section>
    </main>
  );
}

function deniedHeadline(state: string): string {
  switch (state) {
    case "NEEDS_ORGANIZATION":
      return "Activate in an organization workspace";
    case "NEEDS_PERSONAL_OR_ORG":
      return "Workspace setup required";
    case "DENIED_NO_CAPABILITY":
      return "Permission required";
    case "NEEDS_UPGRADE":
      return "Plan upgrade required";
    case "RECOVERY_REQUIRED":
      return "Workspace recovery required";
    default:
      return "This surface is not available";
  }
}
