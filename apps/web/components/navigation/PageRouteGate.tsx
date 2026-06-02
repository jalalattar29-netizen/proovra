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
import {
  accessStateToDenialReason,
  denialReasonHeadline,
  denialReasonGuidance,
} from "@proovra/shared";

import {
  usePersonalSpaceFragment,
  usePlatformContext,
  useWorkspaceFragment,
} from "../../lib/platform-context";
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
  // PERSONAL-FIRST RESCUE fragments come from the centralized
  // platform-context hooks — direct envelope reads for the workspace
  // fragment are forbidden outside lib/platform-context (see
  // phase-g4-tenancy-cleanup.test.ts).
  const workspaceFragment = useWorkspaceFragment();
  const personalSpaceFragment = usePersonalSpaceFragment();
  const route = getRouteDefinition(routeId);

  // Unknown route id → render children. Treating an unregistered route
  // as a hard 404 would make the gate too dangerous during incremental
  // migration. Source-contract tests catch unregistered ids separately.
  if (!route) {
    // Development-only warning so an unregistered routeId surfaces
    // immediately in the browser console instead of silently rendering
    // children unprotected. Production keeps the silent fallback to
    // avoid bricking the app on a typo.
    if (
      process.env.NODE_ENV !== "production" &&
      typeof console !== "undefined"
    ) {
      console.warn(
        `[PageRouteGate] Unknown routeId "${routeId}" — no entry in routeRegistry. Children will render unprotected. Register this id in lib/navigation/routeRegistry to enable access gating.`,
      );
    }
    return <>{children}</>;
  }

  const activeSpaceType =
    envelope?.activeSpace?.type ?? null;
  const access = resolveRouteAccess({
    route,
    activeSpaceType,
    isPlatformAdmin: envelope?.platform?.isPlatformAdmin === true,
    capabilities: envelope?.capabilities ?? {},
    accountPlan: envelope?.account?.accountPlan ?? null,
    // PERSONAL-FIRST RESCUE — pass envelope fragments so the gate
    // can fall back to workspace.id / personalSpace.id when
    // activeSpace.type is missing from the backend projection.
    // Required so personal-only users are NEVER blocked from core
    // product routes (capture / evidence / reports / verify / etc.)
    // even when the backend returns a partial envelope.
    workspace: workspaceFragment,
    personalSpace: personalSpaceFragment,
  });

  if (access.canLoad) return <>{children}</>;

  if (access.accessState === "PLATFORM_ADMIN_ONLY") {
    // PRODUCTION FIX: previously this branch returned `null`, leaving
    // non-platform-admin users on a blank URL whenever they typed a
    // platform-admin route directly (e.g. `/operations/observability`).
    // That violates this component's own header rule: "NEVER renders a
    // blank page. Every denied state has a structured panel with primary
    // + (optional) secondary action."
    //
    // The sidebar / cmd-K / All Tools still correctly hide these routes
    // from non-admins via `canSeeNav: false`. This panel only renders
    // when a non-admin reaches the URL by direct navigation (typed URL,
    // bookmark, stale email link, copy-pasted from a peer).
    const canonicalReason = accessStateToDenialReason(access.accessState);
    const headline = canonicalReason
      ? denialReasonHeadline(canonicalReason)
      : "Platform administration only";
    const subtitle =
      access.reason && access.reason.length > 0
        ? access.reason
        : canonicalReason
          ? denialReasonGuidance(canonicalReason)
          : "This surface is restricted to platform administrators.";
    return (
      <main
        className="cc-page"
        data-page-route-gate
        data-page-route-gate-state={access.accessState}
        data-page-route-gate-route-id={routeId}
        data-page-route-gate-denial-reason={canonicalReason ?? ""}
        data-testid={`route-gate-${routeId}`}
        style={{ maxWidth: 640, margin: "0 auto" }}
      >
        <header className="cc-page-header">
          <div>
            <div className="cc-kicker">{route.label}</div>
            <h1 className="cc-title">{headline}</h1>
            <p className="cc-subtitle">{subtitle}</p>
          </div>
        </header>
        <section className="cc-section" data-page-route-gate-actions>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link
              href="/home"
              className="cc-quick-action"
              data-page-route-gate-primary-action
            >
              Back to home
            </Link>
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

  // Every other denied state renders a structured panel.
  // PHASE 4 — denial copy flows through the Phase 3 canonical
  // `DenialReason` vocabulary in `@proovra/shared`. The route resolver
  // still provides a route-specific `access.reason` (with the
  // workspace-id-of-the-day phrasing, etc.) which we preserve as the
  // subtitle; the headline + fallback guidance come from the canonical
  // helpers so copy stays consistent across every gate surface
  // (PageRouteGate, AccessGate, tools page, command palette).
  const canonicalReason = accessStateToDenialReason(access.accessState);
  const headline = canonicalReason
    ? denialReasonHeadline(canonicalReason)
    : "This surface is not available";
  const subtitle =
    access.reason && access.reason.length > 0
      ? access.reason
      : canonicalReason
        ? denialReasonGuidance(canonicalReason)
        : "";
  return (
    <main
      className="cc-page"
      data-page-route-gate
      data-page-route-gate-state={access.accessState}
      data-page-route-gate-route-id={routeId}
      data-page-route-gate-denial-reason={canonicalReason ?? ""}
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
          <h1 className="cc-title">{headline}</h1>
          <p className="cc-subtitle">{subtitle}</p>
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

// PHASE 4 — `deniedHeadline` removed in favour of the canonical
// `denialReasonHeadline` from `@proovra/shared`. The headline used to
// be a local function with one `switch` per denial state; that copy
// was duplicated by `AccessGate.tsx` and the Tools page. The Phase 3
// `denial-vocabulary` module is now the single source of truth.
