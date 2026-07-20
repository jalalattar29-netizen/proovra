"use client";

/**
 * PHASE 38.6 — All Tools surface.
 *
 * The universal place to find every product surface the actor can reach
 * or request. Consumes the canonical route registry + the access
 * resolver + the workflow exposure resolver.
 *
 * Hard rules:
 *
 *   1. EVERY `allToolsVisible: true` route the actor can see in nav
 *      appears here. Workflow can change the "Recommended" badge but
 *      never removes a tool.
 *   2. Denied tools (capability-missing) appear with a human-readable
 *      "Permission required" badge and a "Request access" CTA — never
 *      silently hidden (except PLATFORM_ADMIN_ONLY routes which the
 *      access resolver returns `canSeeNav: false` for).
 *   3. The page never makes a fetch — it reads everything from the
 *      canonical envelope.
 *   4. No raw capability codes shown to operators. Reasons come from
 *      the access resolver's bounded `reason` field.
 */

import { useMemo, useState } from "react";
import Link from "next/link";

import { PageShell, PageHeader, PageSection } from "../../../components/ui/PageShell";
import { Card } from "../../../components/ui/Card";
import { Badge, type BadgeTone } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { FilterBar } from "../../../components/ui/FilterBar";
import { EmptyState } from "../../../components/ui/EmptyState";
import {
  usePersonalSpaceFragment,
  usePlatformContext,
  useWorkspaceFragment,
} from "../../../lib/platform-context";
import { ROUTE_REGISTRY } from "../../../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../../../lib/navigation/routeAccessResolver";
import { resolveNavigationExposure } from "../../../lib/navigation/navigationExposureResolver";
// Phase IA-surface-tier — All Tools catalog applies the surface-tier
// visibility filter before the navigation exposure resolver runs. A FREE
// personal user sees only CORE tools; ENTERPRISE / INTERNAL surfaces
// disappear entirely (NO "Permission required" badge for tools the
// user's plan cannot unlock — keeps the surface focused).
import { canAccessSurface } from "../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../lib/surface/useSurfaceUserContext";
// Closure verification Part C — All Tools is an ACCOUNT-domain route
// (capability ACCOUNT_SETTINGS_VIEW). The canonical PageRouteGate
// enforces UX-layer access for parity with the other gated /app pages.
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";

type GroupId =
  | "capture-records"
  | "cases-review"
  | "reports-verification"
  | "governance-compliance"
  | "review-operations"
  | "operations"
  | "organization-settings"
  | "account-billing";

const GROUP_LABEL: Record<GroupId, string> = {
  "capture-records": "Capture & Records",
  "cases-review": "Cases & Review",
  "reports-verification": "Reports & Verification",
  "governance-compliance": "Governance & Compliance",
  "review-operations": "Review Operations",
  operations: "Operations",
  "organization-settings": "Organization & Settings",
  "account-billing": "Account & Billing",
};

function groupForRoute(domain: string): GroupId {
  switch (domain) {
    case "PERSONAL_WORKSPACE":
      return "capture-records";
    case "ORGANIZATION_WORKSPACE":
    case "TEAM_ONLY":
      return "cases-review";
    case "GOVERNANCE":
      return "governance-compliance";
    case "REVIEW_OPERATIONS":
      return "review-operations";
    case "OPS":
      return "operations";
    case "ACCOUNT":
      return "account-billing";
    default:
      return "account-billing";
  }
}

function AllToolsPageBody() {
  const { envelope } = usePlatformContext();
  // Phase IA-surface-tier — tier-filter the registry before the All
  // Tools navigation exposure resolver runs.
  const surfaceUserCtx = useSurfaceUserContext();
  // PERSONAL-FIRST RESCUE fragments come from the centralized
  // platform-context hooks — direct envelope reads for the workspace
  // fragment are forbidden outside lib/platform-context (see
  // phase-g4-tenancy-cleanup.test.ts).
  const workspaceFragment = useWorkspaceFragment();
  const personalSpaceFragment = usePersonalSpaceFragment();
  const [query, setQuery] = useState("");

  const exposure = useMemo(() => {
    const tierFiltered = ROUTE_REGISTRY.filter((route) =>
      canAccessSurface(surfaceUserCtx, route.href),
    );
    const routes = tierFiltered.map((route) => ({
      route,
      access: resolveRouteAccess({
        route,
        activeSpaceType: envelope?.activeSpace?.type ?? null,
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
      }),
    }));
    return resolveNavigationExposure({ routes });
  }, [envelope, surfaceUserCtx]);

  // Build grouped items from the canonical exposure list. Each bucket
  // is a mutable array; `allToolsItems` itself is read-only by contract.
  type ToolItem = (typeof exposure.allToolsItems)[number];
  const groups: Record<GroupId, ToolItem[]> = {
    "capture-records": [],
    "cases-review": [],
    "reports-verification": [],
    "governance-compliance": [],
    "review-operations": [],
    operations: [],
    "organization-settings": [],
    "account-billing": [],
  };
  for (const item of exposure.allToolsItems) {
    const g = groupForRoute(item.route.domain);
    // Special placement for the reports/verification group.
    if (
      item.route.id === "workspace.reports" ||
      item.route.id.startsWith("verification.")
    ) {
      groups["reports-verification"].push(item);
    } else {
      groups[g].push(item);
    }
  }

  // Recommended-by-workflow ids for the badge.
  const recommendedIds = new Set(exposure.primaryItems.map((i) => i.route.id));

  const q = query.trim().toLowerCase();
  function matchesSearch(label: string, description: string): boolean {
    if (q.length === 0) return true;
    return (
      label.toLowerCase().includes(q) ||
      description.toLowerCase().includes(q)
    );
  }

  const visibleGroups = (Object.keys(GROUP_LABEL) as GroupId[])
    .map((groupId) => ({
      groupId,
      items: groups[groupId].filter((i) =>
        matchesSearch(i.route.label, i.route.description),
      ),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <PageShell data-all-tools-page>
      <PageHeader
        eyebrow="All Tools"
        title="Browse every product surface"
        subtitle="Workflow profiles personalize layout, defaults, and recommendations. They do not change permissions or remove tools."
      />

      <FilterBar>
        <FilterBar.Search
          value={query}
          onChange={setQuery}
          label="Search tools"
          placeholder="Search tools…"
          data-all-tools-search
        />
      </FilterBar>

      {visibleGroups.length === 0 ? (
        <EmptyState
          framed
          title="No tools match your search"
          purpose="Try a different term, or clear the search to see every surface available to you."
        />
      ) : (
        visibleGroups.map(({ groupId, items }) => (
          <PageSection
            key={groupId}
            title={GROUP_LABEL[groupId]}
            data-all-tools-group={groupId}
          >
            <div
              data-all-tools-items
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(min(100%, 340px), 1fr))",
              }}
            >
              {items.map((item) => {
                const isRecommended = recommendedIds.has(item.route.id);
                const isAvailable = item.access.canLoad;
                const badge = badgeForAccess(item.access.accessState);
                return (
                  <Card
                    key={item.route.id}
                    padding="compact"
                    data-all-tools-route-id={item.route.id}
                    data-all-tools-access-state={item.access.accessState}
                    data-all-tools-recommended={
                      isRecommended ? "true" : "false"
                    }
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <strong style={{ fontSize: 14, fontWeight: 650 }}>
                        {item.route.label}
                      </strong>
                      {isRecommended ? (
                        <Badge
                          tone="governance"
                          subtle
                          data-all-tools-recommended-chip
                        >
                          Recommended
                        </Badge>
                      ) : null}
                      {item.route.advancedByDefault ? (
                        <Badge
                          tone="neutral"
                          subtle
                          data-all-tools-advanced-chip
                        >
                          Advanced
                        </Badge>
                      ) : null}
                      <Badge
                        tone={badge.tone}
                        subtle
                        data-all-tools-status-chip={item.access.accessState}
                      >
                        {badge.label}
                      </Badge>
                    </div>

                    <div
                      style={{
                        fontSize: 12.5,
                        color: "var(--ink-secondary, #475569)",
                        marginTop: 6,
                        lineHeight: 1.5,
                      }}
                    >
                      {item.route.description}
                    </div>

                    {!isAvailable && item.access.reason ? (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--status-risk-fg, #991b1b)",
                          marginTop: 6,
                        }}
                        data-all-tools-reason
                      >
                        {item.access.reason}
                      </div>
                    ) : null}

                    <div style={{ marginTop: 12 }}>
                      {isAvailable ? (
                        <Link href={item.route.href} data-all-tools-open>
                          <Button variant="secondary" size="sm">
                            Open
                          </Button>
                        </Link>
                      ) : item.access.primaryAction ? (
                        <Link
                          href={item.access.primaryAction.href}
                          data-all-tools-primary-action
                        >
                          <Button variant="secondary" size="sm">
                            {item.access.primaryAction.label}
                          </Button>
                        </Link>
                      ) : null}
                    </div>
                  </Card>
                );
              })}
            </div>
          </PageSection>
        ))
      )}
    </PageShell>
  );
}

function badgeForAccess(state: string): { label: string; tone: BadgeTone } {
  switch (state) {
    case "ALLOWED":
      return { label: "Available", tone: "verified" };
    case "NEEDS_ORGANIZATION":
      return { label: "Requires organization", tone: "pending" };
    case "NEEDS_PERSONAL_OR_ORG":
      return { label: "Requires workspace", tone: "pending" };
    case "DENIED_NO_CAPABILITY":
      return { label: "Requires permission", tone: "risk" };
    case "NEEDS_UPGRADE":
      return { label: "Requires upgrade", tone: "governance" };
    case "RECOVERY_REQUIRED":
      return { label: "Recovery required", tone: "risk" };
    default:
      return { label: "Unavailable", tone: "neutral" };
  }
}

// Closure verification Part C — canonical PageRouteGate wrapper.
export default function AllToolsPage() {
  return (
    <PageRouteGate routeId="workspace.tools">
      <AllToolsPageBody />
    </PageRouteGate>
  );
}
