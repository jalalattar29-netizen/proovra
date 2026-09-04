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
  // PERSONAL-FIRST RESCUE fragments come from the centralized
  // platform-context hooks — direct envelope reads for the workspace
  // fragment are forbidden outside lib/platform-context (see
  // phase-g4-tenancy-cleanup.test.ts).
  const workspaceFragment = useWorkspaceFragment();
  const personalSpaceFragment = usePersonalSpaceFragment();
  const [query, setQuery] = useState("");

  const exposure = useMemo(() => {
    // Track 1A (surface-tier removal) — the ONE resolver decides which
    // tools are reachable. Enterprise + commercial gating come from the
    // SERVER-projected flags/planFeatures booleans passed below.
    const routes = ROUTE_REGISTRY.map((route) => ({
      route,
      access: resolveRouteAccess({
        route,
        activeSpaceType: envelope?.activeSpace?.type ?? null,
        isPlatformAdmin: envelope?.platform?.isPlatformAdmin === true,
        capabilities: envelope?.capabilities ?? {},
        accountPlan: envelope?.account?.accountPlan ?? null,
        isEnterpriseWorkspace: envelope?.flags?.isEnterpriseWorkspace === true,
        planFeatures: envelope?.planFeatures ?? null,
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
  }, [envelope, workspaceFragment, personalSpaceFragment]);

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

  /*
   * SPLIT EACH GROUP INTO WHAT YOU CAN OPEN AND WHAT YOU CANNOT.
   *
   * A personal account reaches this page and 116 routes are nav-visible, most
   * of them organization-only. Rendered as one flat list that was 116 cards,
   * each carrying up to three capsules, a red explanation, and its own copy of
   * the same "Create or switch organization" button.
   *
   * The locked ones are not noise — the access resolver keeps them visible on
   * purpose, so an evaluator can see what an organization workspace unlocks
   * rather than finding a silently shorter product. But repeating one
   * requirement dozens of times states it dozens of times; it does not state it
   * better. Locked items collapse into a single line per group with one CTA.
   */
  const visibleGroups = (Object.keys(GROUP_LABEL) as GroupId[])
    .map((groupId) => {
      const matching = groups[groupId].filter((i) =>
        matchesSearch(i.route.label, i.route.description),
      );
      return {
        groupId,
        open: matching.filter((i) => i.access.canLoad),
        locked: matching.filter((i) => !i.access.canLoad),
      };
    })
    .filter((g) => g.open.length + g.locked.length > 0);

  return (
    <PageShell data-all-tools-page>
      <PageHeader
        eyebrow="All Tools"
        title="Browse every product surface"
        subtitle="Everything this workspace can open, grouped by what it is for. Surfaces that need an organization are listed at the end of each group."
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
        visibleGroups.map(({ groupId, open, locked }) => (
          <PageSection
            key={groupId}
            title={GROUP_LABEL[groupId]}
            data-all-tools-group={groupId}
          >
            {open.length > 0 ? (
              <div
                data-all-tools-items
                style={{
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(min(100%, 320px), 1fr))",
                }}
              >
                {open.map((item) => {
                  const isRecommended = recommendedIds.has(item.route.id);
                  return (
                    <Card
                      key={item.route.id}
                      padding="compact"
                      data-all-tools-route-id={item.route.id}
                      data-all-tools-access-state={item.access.accessState}
                      data-all-tools-recommended={isRecommended ? "true" : "false"}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        minInlineSize: 0,
                      }}
                    >
                      <strong style={{ fontSize: 14, fontWeight: 650 }}>
                        {item.route.label}
                      </strong>

                      <div
                        style={{
                          fontSize: 12.5,
                          color: "var(--ink-secondary, #475569)",
                          marginTop: 6,
                          lineHeight: 1.5,
                          // Fills the space between title and action so cards
                          // in a row end up the same height without forcing an
                          // arbitrary one on a two-word description.
                          flex: 1,
                        }}
                      >
                        {item.route.description}
                      </div>

                      {/*
                        METADATA AS WORDS, NOT CAPSULES.

                        Three filled pills per card — Recommended, Advanced,
                        Available — turned a catalogue into a wall of
                        lozenges, and "Available" earned a capsule on every
                        single card that could be opened, which is most of
                        them. Semantic colour on plain text says the same
                        thing and lets the title stay the loudest element.
                      */}
                      <div
                        style={{ marginTop: 10, fontSize: 11.5, minInlineSize: 0 }}
                        data-all-tools-meta
                      >
                        {isRecommended ? (
                          <span
                            style={{ color: "var(--accent-600, #6d28d9)", fontWeight: 600 }}
                            data-all-tools-recommended-label
                          >
                            Recommended
                          </span>
                        ) : null}
                        {isRecommended && item.route.advancedByDefault ? (
                          <span style={{ color: "var(--app-ink-secondary, #667085)" }}> · </span>
                        ) : null}
                        {item.route.advancedByDefault ? (
                          <span
                            style={{ color: "var(--app-ink-secondary, #667085)" }}
                            data-all-tools-advanced-label
                          >
                            Advanced
                          </span>
                        ) : null}
                      </div>

                      <div style={{ marginTop: 10 }}>
                        <Link href={item.route.href} data-all-tools-open>
                          <Button variant="secondary" size="sm">
                            Open
                          </Button>
                        </Link>
                      </div>
                    </Card>
                  );
                })}
              </div>
            ) : null}

            {/*
              THE LOCKED SET, STATED ONCE.

              One line naming what is in it and one CTA, instead of a card per
              surface each repeating the same requirement. The names stay
              visible so the section is still discovery rather than a wall.
            */}
            {locked.length > 0 ? (
              <div
                data-all-tools-locked-group={groupId}
                data-all-tools-locked-count={locked.length}
                style={{
                  marginTop: open.length > 0 ? 14 : 0,
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--border, #e2e8f0)",
                  background: "var(--surface-soft, #f8fafc)",
                  minInlineSize: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--ink-primary, #0f172a)",
                  }}
                >
                  {lockedHeadline(locked)}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--app-ink-secondary, #667085)",
                    marginTop: 4,
                    lineHeight: 1.5,
                  }}
                  data-all-tools-locked-names
                >
                  {locked.map((i) => i.route.label).join(" · ")}
                </div>
                {locked[0]?.access.primaryAction ? (
                  <div style={{ marginTop: 10 }}>
                    <Link
                      href={locked[0].access.primaryAction.href}
                      data-all-tools-primary-action
                    >
                      <Button variant="secondary" size="sm">
                        {locked[0].access.primaryAction.label}
                      </Button>
                    </Link>
                  </div>
                ) : null}
              </div>
            ) : null}
          </PageSection>
        ))
      )}
    </PageShell>
  );
}

/**
 * One sentence for a group's locked set.
 *
 * Deliberately not red and not the word "denied": needing an organization is a
 * normal entitlement boundary, and the previous card rendered the resolver's
 * reason in `--status-risk-fg` (#991b1b), so a personal account saw dozens of
 * enterprise surfaces painted as though something had gone wrong.
 */
function lockedHeadline(
  locked: ReadonlyArray<{ access: { accessState: string } }>,
): string {
  const n = locked.length;
  const noun = n === 1 ? "surface" : "surfaces";
  const state = locked[0]?.access.accessState;
  if (state === "NEEDS_ORGANIZATION") {
    return `${n} ${noun} available in organization-governed workspaces`;
  }
  if (state === "NEEDS_PERSONAL_OR_ORG") {
    return `${n} ${noun} need an active workspace`;
  }
  if (state === "NEEDS_UPGRADE") {
    return `${n} ${noun} included on other plans`;
  }
  return `${n} ${noun} not available in this workspace`;
}

// Closure verification Part C — canonical PageRouteGate wrapper.
export default function AllToolsPage() {
  return (
    <PageRouteGate routeId="workspace.tools">
      <AllToolsPageBody />
    </PageRouteGate>
  );
}
