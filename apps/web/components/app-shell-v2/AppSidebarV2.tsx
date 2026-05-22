"use client";

import type { ForwardRefExoticComponent, RefAttributes } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Bell,
  BookOpen,
  BriefcaseBusiness,
  Camera,
  ClipboardList,
  CreditCard,
  FileText,
  Gauge,
  GaugeCircle,
  Headphones,
  Key,
  LibraryBig,
  LifeBuoy,
  ListTodo,
  LogOut,
  Plug,
  Radio,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCircle,
  Users,
  type LucideProps,
} from "lucide-react";

import { useActiveWorkspaceId } from "../../lib/useActiveWorkspaceId";
import {
  useGlobalRuntimeState,
  type GlobalRuntimeSeverity,
} from "../../lib/useGlobalRuntimeState";
import type {
  WorkspaceProfile,
  WorkspaceRole,
} from "../../lib/workspace-profile";
import {
  selectNavigationGroups,
  type NavBadgeKey,
  type NavGroup,
  type NavIconKey,
  type NavItem,
} from "../../lib/navigation-config";

type SidebarIcon = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

/**
 * Phase 32.8B — Enterprise sidebar (data-driven).
 *
 * This component is ONLY a renderer. The structure of the sidebar
 * (groups, items, visibility, ordering, deprecated-route metadata)
 * lives in `lib/navigation-config.ts`. Adding or modifying a nav
 * item means editing the config, NOT this file.
 *
 * What this file owns:
 *   - Icon-key → Lucide component mapping (intentionally kept here
 *     so the data layer doesn't import JSX).
 *   - Runtime-badge hydration (escalations count, runtime severity
 *     dots, governance incidents) from `useGlobalRuntimeState`.
 *   - Workspace-role resolution via `useActiveWorkspaceId` (the
 *     parent shell does not know the workspace role).
 *   - Visual rendering of groups + items with role-aware filtering.
 *
 * What this file MUST NOT do:
 *   - Define new sidebar items inline.
 *   - Override the `domain` of an item.
 *   - Skip the `selectNavigationGroups` filter (it is the canonical
 *     filter pipeline).
 */

// =============================================================================
// Icon mapping (the only JSX bridge for the data-driven config)
// =============================================================================

const ICON_BY_KEY: Record<NavIconKey, SidebarIcon> = {
  home: Gauge,
  capture: Camera,
  evidence: LibraryBig,
  cases: BriefcaseBusiness,
  reports: FileText,
  search: Search,
  reviewer_ops: ListTodo,
  sla: GaugeCircle,
  escalations: AlertTriangle,
  governance: ShieldCheck,
  lifecycle: Activity,
  retention: ClipboardList,
  destruction: Trash2,
  policy: ClipboardList,
  ops_center: Radio,
  observability: Activity,
  runbooks: BookOpen,
  security_center: ShieldAlert,
  teams: Users,
  billing: CreditCard,
  settings: Settings,
  admin: Key,
  integrations: Plug,
  intake_links: LifeBuoy,
  profile: UserCircle,
  notifications: Bell,
  logout: LogOut,
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
      return "warning";
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
      {badge.kind === "count" ? badge.value : badge.value}
    </span>
  );
}

// =============================================================================
// Badge hydration
// =============================================================================

/**
 * Project the data-driven `NavItem.badgeKey` to a real, hydrated
 * `SidebarBadge` using current runtime state. Returns `null` when
 * there is no real signal to show (we never fabricate a badge —
 * Phase 28-J / Phase 32.8A rule).
 */
function hydrateBadge(
  badgeKey: NavBadgeKey,
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

// =============================================================================
// Active-route predicate
// =============================================================================

function isActiveRoute(pathname: string | null, href: string) {
  if (!pathname) return false;
  const route = href.split("#")[0]!.split("?")[0]!;
  // /billing is excluded from prefix-match so /billing/invoices doesn't
  // light up the Billing nav item incorrectly when on a sibling
  // route. Same intent as the prior implementation.
  return (
    pathname === route ||
    (route !== "/billing" && route !== "/" && pathname.startsWith(`${route}/`))
  );
}

// =============================================================================
// Group renderer
// =============================================================================

function SidebarGroupView({
  group,
  hydratedBadges,
}: {
  group: NavGroup;
  hydratedBadges: Map<string, SidebarBadge>;
}) {
  const pathname = usePathname();

  return (
    <div
      className="app-sidebar-v2-group"
      data-sidebar-group={group.title}
      data-sidebar-group-id={group.id}
      data-sidebar-group-domain={group.domain}
    >
      <div className="app-sidebar-v2-group-title">{group.title}</div>

      <nav className="app-sidebar-v2-nav" aria-label={group.title}>
        {group.items.map((item) => {
          const active = isActiveRoute(pathname, item.href);
          const Icon = ICON_BY_KEY[item.iconKey];
          const badge = hydratedBadges.get(item.id);

          return (
            <Link
              key={item.id}
              href={item.href}
              className={`app-sidebar-v2-link ${active ? "is-active" : ""}`}
              data-sidebar-link-key={item.badgeKey ?? item.href}
              data-sidebar-nav-id={item.id}
              data-sidebar-nav-domain={item.domain}
            >
              <span className="app-sidebar-v2-link-icon">
                <Icon size={17} strokeWidth={1.9} />
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {badge ? <BadgeView badge={badge} /> : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

// =============================================================================
// Public sidebar
// =============================================================================

export function AppSidebarV2({
  isPlatformAdmin = false,
  role: explicitRole = null,
  workspaceProfile: explicitProfile = null,
}: {
  isPlatformAdmin?: boolean;
  /** Phase 32.5 — bounded workspace role for sidebar visibility
   *  filtering. Defaults to null which renders the "everyone"
   *  default. Backend permissions remain authoritative. */
  role?: WorkspaceRole | null;
  /** Phase 32.5 — bounded workspace profile. */
  workspaceProfile?: WorkspaceProfile | null;
}) {
  // Phase 32.6.4 — sidebar resolves role from the workspace hook so
  // role-gated items are visible to admins even when the parent
  // shell does not pass a role prop.
  const workspace = useActiveWorkspaceId();
  const teamId =
    workspace.status === "ready" ? workspace.workspaceId : null;
  const runtime = useGlobalRuntimeState(teamId);

  const resolvedRole: WorkspaceRole | null =
    explicitRole ??
    (workspace.status === "ready"
      ? (workspace.role as WorkspaceRole | null)
      : null);

  const runtimeTone = severityToTone(runtime.severity);
  const governanceIncidents = runtime.incidents.filter(
    (i) => i.category && i.category.toLowerCase().includes("governance"),
  ).length;

  // 1) Filter the canonical config by role / profile / platform-admin.
  const visibleGroups = selectNavigationGroups({
    isPlatformAdmin,
    role: resolvedRole,
    profile: explicitProfile,
  });

  // 2) Hydrate runtime badges for items that declared a badgeKey.
  const hydratedBadges = new Map<string, SidebarBadge>();
  for (const group of visibleGroups) {
    for (const item of group.items as NavItem[]) {
      if (item.badgeKey) {
        const badge = hydrateBadge(
          item.badgeKey,
          runtime,
          runtimeTone,
          governanceIncidents,
        );
        if (badge) hydratedBadges.set(item.id, badge);
      }
    }
  }

  return (
    <aside className="app-sidebar-v2">
      <div className="app-sidebar-v2-bg" />

      <div className="app-sidebar-v2-inner">
        <div className="app-sidebar-v2-scroll">
          {visibleGroups.map((group) => (
            <SidebarGroupView
              key={group.id}
              group={group}
              hydratedBadges={hydratedBadges}
            />
          ))}
        </div>

        <div className="app-sidebar-v2-trust-card">
          <div className="app-sidebar-v2-trust-icon">
            <ShieldCheck size={20} strokeWidth={2} />
          </div>
          <strong>Verification-first</strong>
          <p>We do not store truth. We record integrity. You own the evidence.</p>
          <Link href="/legal/verification-methodology">Learn more →</Link>
        </div>

        <Link href="/support" className="app-sidebar-v2-help">
          <Headphones size={18} strokeWidth={1.9} />
          <span>
            <strong>Need help?</strong>
            <small>Contact support</small>
          </span>
        </Link>
      </div>
    </aside>
  );
}
