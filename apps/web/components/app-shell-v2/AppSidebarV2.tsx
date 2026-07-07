"use client";

import { useState } from "react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Bell,
  BookOpen,
  BriefcaseBusiness,
  Camera,
  CircleHelp,
  ClipboardList,
  CreditCard,
  FileText,
  FolderArchive,
  Gauge,
  GaugeCircle,
  HeartPulse,
  Home,
  Inbox,
  Key,
  Layers,
  LayoutGrid,
  Link2,
  ListTodo,
  Plug,
  Radio,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UsersRound,
  type LucideProps,
} from "lucide-react";

import {
  useGlobalRuntimeState,
  type GlobalRuntimeSeverity,
} from "../../lib/useGlobalRuntimeState";
import {
  usePlatformContext,
  usePersonaProfile,
  workflowFromPersona,
  type WorkflowProfileCode,
} from "../../lib/platform-context";
import { ROUTE_REGISTRY, type RouteDefinition } from "../../lib/navigation/routeRegistry";
// Phase IA-surface-tier — surface visibility filter. The sidebar
// renders ONLY routes the user's plan/role unlocks. ENTERPRISE/
// INTERNAL surfaces disappear from the personal user's nav.
import { canAccessSurface } from "../../lib/surface/access";
import { useSurfaceUserContext } from "../../lib/surface/useSurfaceUserContext";
import {
  resolveRouteAccess,
  type RouteAccessResult,
} from "../../lib/navigation/routeAccessResolver";
import {
  resolveWorkflowExposure,
  type WorkflowExposureItem,
} from "../../lib/navigation/workflowExposureResolver";
import { resolveWorkspaceExperience } from "../../lib/workspace-experience";
// R2 — canonical navigation pipeline. The disclosure resolver folds
// in R1.5B's experience-mode demotion AND adds the bounded primary
// constraint. The grouping resolver is the formal extraction of the
// previously-inline buildSidebarGroups helper.
import { resolveNavigationDisclosure } from "../../lib/navigation/navigationDisclosureResolver";
import { resolveNavigationGroups } from "../../lib/navigation/navigationGroupingResolver";
import { DEGRADATION_CHIP_LABELS } from "../../lib/navigation/canonicalNavigationGroups";
// R5 — disclosure-tier metadata. Pure presentation hint surfaced as
// data attributes; R10 visual work consumes them. Does not change
// what is rendered.
import { getRouteDisclosureTier } from "../../lib/navigation/disclosureModel";
import {
  emit as emitStateEvent,
} from "../../lib/platform-context/state-observability";

/**
 * PHASE 38.9 — Canonical sidebar.
 *
 * Sole source of truth: ROUTE_REGISTRY + resolveRouteAccess +
 * resolveWorkflowExposure. The legacy `envelope.navigation.groups`
 * projection is no longer consumed here — it remains on the envelope
 * for analytics/migration but the sidebar reads exclusively from the
 * canonical registry.
 *
 * Workflow profile changes ORDER / BUCKETING only; capabilities and
 * activeSpace are the only access decision. A denied-but-visible item
 * still renders, linked to its href — the destination PageRouteGate
 * presents the structured recovery panel.
 *
 * Hard rules — pinned by Phase 38.9 source-contract tests:
 *   - imports ROUTE_REGISTRY
 *   - imports resolveRouteAccess
 *   - imports resolveWorkflowExposure
 *   - does NOT consume `envelope.navigation` for rendering
 *   - does NOT call apiFetch
 *   - does NOT derive role/persona/platform-admin locally
 */

type SidebarIcon = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

// =============================================================================
// Static per-registry-id metadata: icon + runtime badge key.
// =============================================================================

const ICON_BY_ROUTE_ID: Record<string, SidebarIcon> = {
  // Semantic distinctness — each visible sidebar entry maps to a
  // distinct Lucide glyph. Route IDs are the canonical values from
  // routeRegistry.ts (verified against the rendered DOM
  // `data-sidebar-nav-id`). The workspace-scoped Teams and Trust routes
  // use `workspace.collaboration_teams` and `workspace.trust` — the
  // sidebar renders those; `admin.teams` / `governance.hub` are separate
  // registry entries that aren't currently sidebar-eligible.
  "workspace.home": Home,
  "workspace.capture": Camera,
  "workspace.evidence": FolderArchive,
  "workspace.cases": BriefcaseBusiness,
  "workspace.reports": FileText,
  "workspace.search": Search,
  "workspace.notifications": Bell,
  "workspace.integrations": Plug,
  "workspace.collaboration_teams": UsersRound,
  "workspace.trust": ShieldCheck,
  "review.queue": ListTodo,
  "review.sla": GaugeCircle,
  "governance.hub": ShieldCheck,
  "governance.retention": ClipboardList,
  "platform.ops_center": Radio,
  "platform.observability": Activity,
  "platform.runbooks": BookOpen,
  "platform.security_center": ShieldAlert,
  "admin.teams": UsersRound,
  "account.billing": CreditCard,
  "account.settings": Settings,
  "account.persona": Settings,
  "platform.admin": Key,
  "workspace.tools": LayoutGrid,
  "workspace.intake_links": Link2,
  "workspace.destruction": Trash2,
  // Final Closure Remediation Parts A + E — newly sidebar-eligible
  // routes get explicit icons so they don't fall back to the generic
  // Gauge default.
  "workspace.evidence_requests": Inbox,
  "platform.queue_ops": Layers,
  "platform.reliability": HeartPulse,
};

const BADGE_KEY_BY_ROUTE_ID: Record<string, string> = {
  "review.queue": "escalations_open",
  "platform.ops_center": "ops_center_runtime",
  "platform.observability": "observability_runtime",
  "governance.hub": "governance_incidents",
};

// =============================================================================
// Badge view
// =============================================================================

type SidebarBadgeTone = "neutral" | "warning" | "high" | "critical";

type SidebarBadge =
  | { kind: "count"; value: number; tone: SidebarBadgeTone }
  | { kind: "dot"; tone: SidebarBadgeTone; ariaLabel: string }
  | { kind: "label"; value: string; tone: SidebarBadgeTone };

function severityToTone(
  severity: GlobalRuntimeSeverity,
): SidebarBadgeTone | null {
  switch (severity) {
    case "CRITICAL":
      return "critical";
    case "INCIDENT_ACTIVE":
      return "high";
    case "DEGRADED":
    case "UNKNOWN":
      return "warning";
    default:
      return null;
  }
}

const BADGE_PALETTE: Record<
  SidebarBadgeTone,
  { bg: string; ink: string; border: string; dot: string }
> = {
  neutral: {
    bg: "rgba(255, 255, 255, 0.08)",
    ink: "rgba(244, 247, 245, 0.85)",
    border: "rgba(255, 255, 255, 0.16)",
    dot: "#94a3b8",
  },
  warning: {
    bg: "rgba(245, 158, 11, 0.18)",
    ink: "#fde68a",
    border: "rgba(245, 158, 11, 0.4)",
    dot: "#f59e0b",
  },
  high: {
    bg: "rgba(239, 68, 68, 0.18)",
    ink: "#fecaca",
    border: "rgba(239, 68, 68, 0.45)",
    dot: "#ef4444",
  },
  critical: {
    bg: "rgba(239, 68, 68, 0.32)",
    ink: "#fee2e2",
    border: "rgba(239, 68, 68, 0.65)",
    dot: "#b91c1c",
  },
};

function BadgeView({ badge }: { badge: SidebarBadge }) {
  const palette = BADGE_PALETTE[badge.tone];
  if (badge.kind === "dot") {
    return (
      <span
        data-sidebar-badge="dot"
        data-tone={badge.tone}
        aria-label={badge.ariaLabel}
        title={badge.ariaLabel}
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 8,
          background: palette.dot,
          marginLeft: "auto",
        }}
      />
    );
  }
  return (
    <span
      data-sidebar-badge={badge.kind}
      data-tone={badge.tone}
      style={{
        marginLeft: "auto",
        minWidth: 22,
        padding: "0 7px",
        borderRadius: 999,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.ink,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        textAlign: "center",
        lineHeight: "16px",
      }}
    >
      {badge.value}
    </span>
  );
}

function hydrateBadge(
  badgeKey: string,
  runtime: ReturnType<typeof useGlobalRuntimeState>,
  runtimeTone: SidebarBadgeTone | null,
  governanceIncidents: number,
): SidebarBadge | null {
  if (badgeKey === "escalations_open" && runtime.counts.escalations > 0) {
    const tone: SidebarBadgeTone = runtime.escalations.some(
      (e) => e.severity === "CRITICAL",
    )
      ? "critical"
      : runtime.escalations.some((e) => e.severity === "HIGH")
        ? "high"
        : "warning";
    return { kind: "count", value: runtime.counts.escalations, tone };
  }
  if (
    (badgeKey === "ops_center_runtime" ||
      badgeKey === "observability_runtime") &&
    runtimeTone
  ) {
    return {
      kind: "dot",
      tone: runtimeTone,
      ariaLabel: `Runtime ${runtime.severity.toLowerCase()}`,
    };
  }
  if (badgeKey === "governance_incidents" && governanceIncidents > 0) {
    const tone: SidebarBadgeTone = runtime.incidents.some(
      (i) =>
        i.severity === "CRITICAL" &&
        i.category.toLowerCase().includes("governance"),
    )
      ? "critical"
      : "high";
    return { kind: "count", value: governanceIncidents, tone };
  }
  return null;
}

function isActiveRoute(pathname: string | null, href: string) {
  if (!pathname) return false;
  const route = href.split("#")[0]!.split("?")[0]!;
  return (
    pathname === route ||
    (route !== "/billing" && route !== "/" && pathname.startsWith(`${route}/`))
  );
}

// =============================================================================
// Group construction from resolver output.
// =============================================================================

// R2 — the previously-inline buildSidebarGroups helper has been
// extracted to `lib/navigation/navigationGroupingResolver.ts` as the
// canonical pipeline step. `SidebarGroup` is the consumer-facing
// type re-exported from that resolver.
import type { SidebarGroup } from "../../lib/navigation/navigationGroupingResolver";

// =============================================================================
// Per-item link with degradation badge for denied-but-visible routes.
// =============================================================================

function SidebarLink({
  item,
  badge,
  active,
  inMore,
  disclosureTier,
}: {
  item: WorkflowExposureItem;
  badge: SidebarBadge | null;
  active: boolean;
  inMore?: boolean;
  /** R5 — disclosure-tier hint (beginner / advanced / contextual / all-tools-only). */
  disclosureTier?: string;
}) {
  const route = item.route;
  const access = item.access;
  const Icon = ICON_BY_ROUTE_ID[route.id] ?? Gauge;

  // Denied-but-visible items render with a structured degradation
  // chip. The link still points at the route — the destination
  // PageRouteGate renders the recovery panel canonically.
  const degraded = !access.canLoad;
  const degradationLabel = degraded ? degradationChip(access) : null;

  return (
    <Link
      href={route.href}
      className={`app-sidebar-v2-link ${active ? "is-active" : ""}`}
      data-sidebar-link-key={BADGE_KEY_BY_ROUTE_ID[route.id] ?? route.href}
      data-sidebar-nav-id={route.id}
      data-sidebar-nav-domain={route.domain}
      data-sidebar-nav-more={inMore ? "true" : undefined}
      data-sidebar-degraded={degraded ? "true" : undefined}
      data-sidebar-access-state={access.accessState}
      data-disclosure-tier={disclosureTier}
      aria-disabled={degraded ? "false" : undefined}
    >
      <span className="app-sidebar-v2-link-icon">
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <span style={{ flex: 1 }}>{route.label}</span>
      {badge ? <BadgeView badge={badge} /> : null}
      {degradationLabel ? (
        <span
          data-sidebar-degradation-chip
          data-tone="neutral"
          style={{
            marginLeft: "auto",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            padding: "1px 6px",
            borderRadius: 999,
            background: "rgba(148, 163, 184, 0.18)",
            border: "1px solid rgba(148, 163, 184, 0.4)",
            color: "rgba(244, 247, 245, 0.7)",
          }}
        >
          {degradationLabel}
        </span>
      ) : null}
    </Link>
  );
}

function degradationChip(access: RouteAccessResult): string | null {
  // R2 Part 7 — replaced raw architecture chips with operational
  // language. Old chips ("Org", "Access") were architecture leakage;
  // the canonical labels come from `canonicalNavigationGroups.ts`
  // so a future copy update touches one place.
  switch (access.accessState) {
    case "NEEDS_ORGANIZATION":
      return DEGRADATION_CHIP_LABELS.NEEDS_ORGANIZATION;
    case "NEEDS_PERSONAL_OR_ORG":
      return DEGRADATION_CHIP_LABELS.NEEDS_PERSONAL_OR_ORG;
    case "DENIED_NO_CAPABILITY":
      return DEGRADATION_CHIP_LABELS.DENIED_NO_CAPABILITY;
    case "NEEDS_UPGRADE":
      return DEGRADATION_CHIP_LABELS.NEEDS_UPGRADE;
    default:
      return null;
  }
}

// =============================================================================
// Group view
// =============================================================================

function SidebarGroupView({
  group,
  pathname,
  hydratedBadges,
  disclosureTierByRouteId,
  toolingTier,
}: {
  group: SidebarGroup;
  pathname: string | null;
  hydratedBadges: Map<string, SidebarBadge>;
  /** R5 — disclosure-tier per route id, pre-computed by the parent. */
  disclosureTierByRouteId: Map<string, string>;
  /** R5 — tooling tier for the entire group (CSS / R10 hook). */
  toolingTier: string;
}) {
  return (
    <div
      className="app-sidebar-v2-group"
      data-sidebar-group={group.title}
      data-sidebar-group-id={group.id}
      data-sidebar-group-domain={group.domain}
      data-tooling-tier={toolingTier}
    >
      <div className="app-sidebar-v2-group-title">{group.title}</div>
      <nav className="app-sidebar-v2-nav" aria-label={group.title}>
        {group.items.map((item) => (
          <SidebarLink
            key={item.route.id}
            item={item}
            badge={hydratedBadges.get(item.route.id) ?? null}
            active={isActiveRoute(pathname, item.route.href)}
            disclosureTier={disclosureTierByRouteId.get(item.route.id)}
          />
        ))}
      </nav>
    </div>
  );
}

function SidebarMoreView({
  items,
  pathname,
  hydratedBadges,
  disclosureTierByRouteId,
}: {
  items: ReadonlyArray<WorkflowExposureItem>;
  pathname: string | null;
  hydratedBadges: Map<string, SidebarBadge>;
  disclosureTierByRouteId: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div
      className="app-sidebar-v2-group"
      data-sidebar-group="More / Advanced"
      data-sidebar-group-id="sidebar.more-advanced"
      data-sidebar-group-domain="MORE"
      data-tooling-tier="advanced"
    >
      <div
        className="app-sidebar-v2-more"
        data-sidebar-more-open={open ? "true" : "false"}
        data-sidebar-more-count={items.length}
      >
        <button
          type="button"
          className="app-sidebar-v2-link"
          data-sidebar-more-toggle
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          style={{
            width: "100%",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            fontSize: 11,
            fontWeight: 600,
            color: "#64748b",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            padding: "8px 12px",
          }}
        >
          {open ? "− Hide advanced" : `+ More / Advanced (${items.length})`}
        </button>
        {open
          ? items.map((item) => (
              <SidebarLink
                key={item.route.id}
                item={item}
                badge={hydratedBadges.get(item.route.id) ?? null}
                active={isActiveRoute(pathname, item.route.href)}
                disclosureTier={
                  disclosureTierByRouteId.get(item.route.id) ?? "advanced"
                }
                inMore
              />
            ))
          : null}
      </div>
    </div>
  );
}

// =============================================================================
// Main sidebar
// =============================================================================

export function AppSidebarV2() {
  const { envelope } = usePlatformContext();
  const persona = usePersonaProfile();
  const pathname = usePathname();

  const activeSpaceType = envelope?.activeSpace?.type ?? null;
  const isPlatformAdmin = envelope?.platform?.isPlatformAdmin === true;
  const capabilities = envelope?.capabilities ?? {};
  const accountPlan = envelope?.account?.accountPlan ?? null;

const teamId =
  envelope?.workspace?.status === "active" && envelope.workspace.scope === "TEAM"
    ? envelope.workspace.id
    : null;
      const runtime = useGlobalRuntimeState(teamId);
  const runtimeTone = severityToTone(runtime.severity);
  const governanceIncidents = runtime.incidents.filter(
    (i) => i.category && i.category.toLowerCase().includes("governance"),
  ).length;

  // Phase IA-surface-tier — pre-filter the registry by the user's
  // surface tier before running the legacy access resolver. This is the
  // ONE central enforcement point for sidebar visibility:
  // ENTERPRISE/INTERNAL surfaces never even enter the access resolver
  // pipeline for a non-eligible user, so they cannot appear in the
  // sidebar / disclosure / fallback tiers.
  const surfaceUserCtx = useSurfaceUserContext();
  const tierFilteredRegistry = ROUTE_REGISTRY.filter((route) =>
    canAccessSurface(surfaceUserCtx, route.href),
  );

  // Resolve canonical access per registered route.
  const resolved = tierFilteredRegistry.map((route: RouteDefinition) => {
    const access = resolveRouteAccess({
      route,
      activeSpaceType,
      isPlatformAdmin,
      capabilities,
      accountPlan,
      // PERSONAL-FIRST RESCUE — pass envelope fragments so the gate
      // can fall back to `workspace.id` / `personalSpace.id` when
      // `activeSpace.type` is missing from the backend projection.
      // Required so personal-only users are NEVER blocked from core
      // product routes (capture / evidence / reports / verify / etc.)
      // even when the backend returns a partial envelope.
      workspace: envelope?.workspace
        ? {
            id: envelope.workspace.id ?? null,
            status: envelope.workspace.status ?? null,
          }
        : null,
      personalSpace: envelope?.personalSpace
        ? {
            id: envelope.personalSpace.id ?? null,
            status: envelope.personalSpace.status ?? null,
          }
        : null,
    });

    // PHASE 4 — Sidebar-only suppression of org-only routes for
    // personal users. The constitutional rule (rule 13 in the Phase 4
    // brief) is: "Hidden is better than showing 'Requires Permission'
    // for irrelevant enterprise features." When a user's active space
    // is PERSONAL (and they're not a platform admin), org-only routes
    // like Governance / Reviewer Ops should NOT clutter their sidebar
    // with "Activate in an organization" CTAs.
    //
    // The routes remain reachable from the Tools page and Command
    // Palette (those surfaces compute their own resolved[] array — this
    // mutation here is sidebar-local and does NOT affect them). When a
    // personal user does navigate to an org-only URL directly, the
    // PageRouteGate still renders the canonical NEEDS_ORGANIZATION
    // panel with a "Create or switch organization" CTA.
    //
    // canLoad is left untouched — only the sidebar-visibility hint
    // (canSeeNav) is suppressed.
    if (
      access.canSeeNav &&
      access.accessState === "NEEDS_ORGANIZATION" &&
      activeSpaceType !== "ORGANIZATION" &&
      !isPlatformAdmin
    ) {
      return {
        route,
        access: { ...access, canSeeNav: false },
      };
    }

    return { route, access };
  });

  // Bucket by workflow priority. Workflow only re-orders; capabilities
  // already decided canSeeNav/canLoad above.
  const primaryWorkflow: WorkflowProfileCode = workflowFromPersona(
    persona.primaryProfile,
  ).code;
  const secondaryWorkflows: WorkflowProfileCode[] = persona.secondaryUseCases.map(
    (p) => workflowFromPersona(p).code,
  );
  const exposure = resolveWorkflowExposure({
    routes: resolved,
    primaryWorkflow,
    secondaryWorkflows,
  });

  // R1.5B — workspace experience segmentation. Read the canonical
  // mode for the current context.
  const experience = resolveWorkspaceExperience({
    activeSpaceType,
    capabilities,
    primaryWorkflow,
  });

  // R2 — canonical navigation pipeline. The disclosure resolver
  // applies BOTH the bounded primary constraint (R2 Part 1) AND the
  // experience-mode demotion (R1.5B). The grouping resolver then
  // builds the bounded sidebar groups from the refined exposure.
  // Authorization is upstream; All Tools / Cmd+K / direct links are
  // unaffected.
  const disclosure = resolveNavigationDisclosure({
    exposure,
    demotionRouteIds: experience.demotionRouteIds,
  });
  emitStateEvent("workspace-experience:resolved", "AppSidebarV2", {
    mode: experience.mode,
    demotedCount: disclosure.stats.experienceDemotedCount,
  });
  emitStateEvent("navigation-mode:resolved", "AppSidebarV2", {
    mode: experience.mode,
    primaryCount: disclosure.primaryItems.length,
    secondaryCount: disclosure.secondaryItems.length,
    moreAdvancedCount: disclosure.moreAdvancedItems.length,
    primaryOverflow: disclosure.stats.primaryOverflowCount,
  });
  if (
    disclosure.stats.experienceDemotedCount > 0 ||
    disclosure.stats.primaryOverflowCount > 0
  ) {
    emitStateEvent("advanced-tooling:disclosed", "AppSidebarV2", {
      mode: experience.mode,
      demotedCount: disclosure.stats.experienceDemotedCount,
      primaryOverflow: disclosure.stats.primaryOverflowCount,
    });
  }

  // Phase 1 (frontend consolidation) — wire the persona-visibility
  // overlay. Previously this call omitted `persona`, leaving the
  // `PERSONA_PILLAR_VISIBILITY` overlay dormant: saving a persona changed
  // ordering but never sidebar composition, so "Save persona" appeared to
  // do nothing. Passing the active persona lets the resolver declutter the
  // sidebar to the persona's pillar set.
  //
  // This is SAFE BY CONSTRUCTION and is NOT a capability gate:
  //   * The surface-tier gate (`tierFilteredRegistry`, above) and the
  //     capability/active-space resolver have already run, so the persona
  //     filter can only SUBTRACT from what plan + role + workspace already
  //     permit — it can never expose an enterprise/internal surface.
  //   * CORE self-serve pillars are pinned universal (see
  //     `UNIVERSAL_PILLARS` in pillarRegistry.ts), so no core product
  //     surface can be hidden for any persona.
  //   * Persona-hidden pillars remain reachable via Command Palette /
  //     All Tools when capabilities permit (presentation-only).
  const { groups } = resolveNavigationGroups(
    {
      primaryItems: disclosure.primaryItems,
      secondaryItems: disclosure.secondaryItems,
    },
    { persona: persona.primaryProfile },
  );

  // R5 — compute the disclosure tier per visible route. Pure
  // presentation hint; drives `data-disclosure-tier` so CSS / R10
  // visual work can target. No access decisions taken here.
  const disclosureTierByRouteId = new Map<string, string>();
  for (const item of [
    ...disclosure.primaryItems,
    ...disclosure.secondaryItems,
    ...disclosure.moreAdvancedItems,
  ]) {
    disclosureTierByRouteId.set(
      item.route.id,
      getRouteDisclosureTier({
        route: item.route,
        mode: experience.mode,
        capabilities,
      }),
    );
  }

  // R5 — map group id → bounded tooling-tier label.
  function toolingTierFor(groupId: string): string {
    if (groupId === "sidebar.primary-workflows") return "beginner";
    if (groupId === "sidebar.governance") return "advanced";
    if (groupId === "sidebar.operations") return "advanced";
    return "beginner";
  }

  // Hydrate runtime badges per route id.
  const hydratedBadges = new Map<string, SidebarBadge>();
  for (const item of [
    ...disclosure.primaryItems,
    ...disclosure.secondaryItems,
    ...disclosure.moreAdvancedItems,
  ]) {
    const badgeKey = BADGE_KEY_BY_ROUTE_ID[item.route.id];
    if (!badgeKey) continue;
    const badge = hydrateBadge(
      badgeKey,
      runtime,
      runtimeTone,
      governanceIncidents,
    );
    if (badge) hydratedBadges.set(item.route.id, badge);
  }

  return (
<aside
  className="app-sidebar-v2"
  data-workspace-experience-mode={experience.mode}
>
  <div className="app-sidebar-v2-bg" />

  <div className="app-sidebar-v2-inner">
    <div className="app-sidebar-v2-brand">
      <img
        src="/assets/branding/proovra-mark.png"
        alt="PROOVRA"
        className="app-sidebar-v2-brand-mark"
      />
      <img
        src="/assets/branding/footer-logo.png"
        alt=""
        aria-hidden="true"
        className="app-sidebar-v2-brand-logo"
      />
    </div>
            <div className="app-sidebar-v2-scroll">
          {groups.map((group) => (
            <SidebarGroupView
              key={group.id}
              group={group}
              pathname={pathname}
              hydratedBadges={hydratedBadges}
              disclosureTierByRouteId={disclosureTierByRouteId}
              toolingTier={toolingTierFor(group.id)}
            />
          ))}

          <SidebarMoreView
            items={disclosure.moreAdvancedItems}
            pathname={pathname}
            hydratedBadges={hydratedBadges}
            disclosureTierByRouteId={disclosureTierByRouteId}
          />

          {/* Phase IA-self-serve-regression-fix — `/tools` is INTERNAL
              (tier rule: `directAccessPolicy: "notFound"`). The
              All Tools group must NEVER appear in the sidebar for a
              non-platform-admin user. Direct URL navigation is already
              blocked by middleware; this hides the affordance so a
              FREE / PAYG / PRO / TEAM user doesn't even see the link.
              The platform-admin signal is taken from the canonical
              envelope (`envelope.platform.isPlatformAdmin`) — never
              re-derived. */}
          {isPlatformAdmin ? (
            <div
              className="app-sidebar-v2-group"
              data-sidebar-group="All Tools"
              data-sidebar-group-id="sidebar.all-tools"
              data-sidebar-group-domain="ALL_TOOLS"
            >
              <nav className="app-sidebar-v2-nav" aria-label="All Tools">
                <Link
                  href="/tools"
                  className={`app-sidebar-v2-link ${isActiveRoute(pathname, "/tools") ? "is-active" : ""}`}
                  data-sidebar-link-key="all-tools"
                  data-sidebar-nav-id="workspace.tools"
                >
                  <span className="app-sidebar-v2-link-icon">
                    <LayoutGrid size={20} strokeWidth={1.75} />
                  </span>
                  <span style={{ flex: 1 }}>All Tools</span>
                </Link>
              </nav>
            </div>
          ) : null}
        </div>

        <Link href="/support" className="app-sidebar-v2-help">
          <CircleHelp size={20} strokeWidth={1.75} />
          <span>
            <strong>Need help?</strong>
            <small>Contact support</small>
          </span>
        </Link>
      </div>
    </aside>
  );
}
