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

import {
  usePersonaProfile,
  usePersonalSpaceFragment,
  usePlatformContext,
  useWorkspaceFragment,
  workflowFromPersona,
} from "../../../lib/platform-context";
import { ROUTE_REGISTRY } from "../../../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../../../lib/navigation/routeAccessResolver";
import { resolveWorkflowExposure } from "../../../lib/navigation/workflowExposureResolver";
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
  const persona = usePersonaProfile();
  // PERSONAL-FIRST RESCUE fragments come from the centralized
  // platform-context hooks — direct envelope reads for the workspace
  // fragment are forbidden outside lib/platform-context (see
  // phase-g4-tenancy-cleanup.test.ts).
  const workspaceFragment = useWorkspaceFragment();
  const personalSpaceFragment = usePersonalSpaceFragment();
  const [query, setQuery] = useState("");

  const exposure = useMemo(() => {
    const routes = ROUTE_REGISTRY.map((route) => ({
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
    const workflow = workflowFromPersona(persona.primaryProfile).code;
    return resolveWorkflowExposure({
      routes,
      primaryWorkflow: workflow,
      secondaryWorkflows: persona.secondaryUseCases.map(
        (p) => workflowFromPersona(p).code,
      ),
    });
  }, [envelope, persona]);

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

  return (
    <main className="cc-page" data-all-tools-page>
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">All Tools</div>
          <h1 className="cc-title">Browse every product surface</h1>
          <p className="cc-subtitle">
            Workflow profiles personalize layout, defaults, and
            recommendations. They do not change permissions or remove tools.
          </p>
        </div>
        <div className="cc-meta">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools…"
            data-all-tools-search
            aria-label="Search tools"
            style={{
              padding: "6px 10px",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontSize: 13,
              minWidth: 240,
            }}
          />
        </div>
      </header>

      {(Object.keys(GROUP_LABEL) as GroupId[]).map((groupId) => {
        const items = groups[groupId].filter((i) =>
          matchesSearch(i.route.label, i.route.description),
        );
        if (items.length === 0) return null;
        return (
          <section
            key={groupId}
            className="cc-section"
            data-all-tools-group={groupId}
          >
            <header className="cc-section-header">
              <h2 className="cc-section-title">{GROUP_LABEL[groupId]}</h2>
            </header>
            <ul
              className="cases-list"
              data-all-tools-items
              style={{ display: "grid", gap: 8 }}
            >
              {items.map((item) => {
                const isRecommended = recommendedIds.has(item.route.id);
                const isAvailable = item.access.canLoad;
                const badge = badgeForAccess(item.access.accessState);
                return (
                  <li
                    key={item.route.id}
                    className="cases-row"
                    data-all-tools-route-id={item.route.id}
                    data-all-tools-access-state={item.access.accessState}
                    data-all-tools-recommended={
                      isRecommended ? "true" : "false"
                    }
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <strong className="cases-row-title">
                          {item.route.label}
                        </strong>
                        {isRecommended ? (
                          <span
                            data-all-tools-recommended-chip
                            style={{
                              fontSize: 10,
                              padding: "2px 6px",
                              fontWeight: 600,
                              background: "#eef2ff",
                              color: "#3730a3",
                              border: "1px solid #c7d2fe",
                              borderRadius: 999,
                              textTransform: "uppercase",
                              letterSpacing: 0.4,
                            }}
                          >
                            Recommended
                          </span>
                        ) : null}
                        {item.route.advancedByDefault ? (
                          <span
                            data-all-tools-advanced-chip
                            style={{
                              fontSize: 10,
                              padding: "2px 6px",
                              fontWeight: 600,
                              background: "#f1f5f9",
                              color: "#475569",
                              border: "1px solid #cbd5e1",
                              borderRadius: 999,
                              textTransform: "uppercase",
                              letterSpacing: 0.4,
                            }}
                          >
                            Advanced
                          </span>
                        ) : null}
                        <span
                          data-all-tools-status-chip={item.access.accessState}
                          style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            fontWeight: 600,
                            background: badge.background,
                            color: badge.color,
                            border: `1px solid ${badge.border}`,
                            borderRadius: 999,
                          }}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <div
                        className="cases-row-scope"
                        style={{ fontSize: 12, color: "#475569", marginTop: 4 }}
                      >
                        {item.route.description}
                      </div>
                      {!isAvailable && item.access.reason ? (
                        <div
                          style={{
                            fontSize: 11,
                            color: "#7c2d12",
                            marginTop: 4,
                          }}
                          data-all-tools-reason
                        >
                          {item.access.reason}
                        </div>
                      ) : null}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      {isAvailable ? (
                        <Link
                          href={item.route.href}
                          className="cc-quick-action"
                          data-all-tools-open
                        >
                          Open
                        </Link>
                      ) : item.access.primaryAction ? (
                        <Link
                          href={item.access.primaryAction.href}
                          className="cases-filter-chip"
                          data-all-tools-primary-action
                        >
                          {item.access.primaryAction.label}
                        </Link>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </main>
  );
}

function badgeForAccess(state: string): {
  label: string;
  background: string;
  color: string;
  border: string;
} {
  switch (state) {
    case "ALLOWED":
      return {
        label: "Available",
        background: "#ecfdf5",
        color: "#065f46",
        border: "#a7f3d0",
      };
    case "NEEDS_ORGANIZATION":
      return {
        label: "Requires organization",
        background: "#fef3c7",
        color: "#78350f",
        border: "#fde68a",
      };
    case "NEEDS_PERSONAL_OR_ORG":
      return {
        label: "Requires workspace",
        background: "#fef3c7",
        color: "#78350f",
        border: "#fde68a",
      };
    case "DENIED_NO_CAPABILITY":
      return {
        label: "Requires permission",
        background: "#fef2f2",
        color: "#7f1d1d",
        border: "#fecaca",
      };
    case "NEEDS_UPGRADE":
      return {
        label: "Requires upgrade",
        background: "#eef2ff",
        color: "#3730a3",
        border: "#c7d2fe",
      };
    case "RECOVERY_REQUIRED":
      return {
        label: "Recovery required",
        background: "#fef2f2",
        color: "#7f1d1d",
        border: "#fecaca",
      };
    default:
      return {
        label: "Unavailable",
        background: "#f1f5f9",
        color: "#475569",
        border: "#cbd5e1",
      };
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
