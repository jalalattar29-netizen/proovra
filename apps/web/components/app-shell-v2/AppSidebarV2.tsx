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

import {
  useGlobalRuntimeState,
  type GlobalRuntimeSeverity,
} from "../../lib/useGlobalRuntimeState";
import {
  usePlatformContext,
  type PlatformContextNavGroup,
  type PlatformContextNavItem,
} from "../../lib/platform-context";

/**
 * Phase 32.8 Foundation — Canonical sidebar.
 *
 * Reads the pre-filtered navigation tree from
 * `usePlatformContext().envelope.navigation.groups`. NO local
 * filtering, NO `selectNavigationGroups`, NO `useActiveWorkspaceId`,
 * NO role/profile coercion. The server has already decided what this
 * user sees.
 *
 * Responsibilities retained here (rendering-only):
 *   1. Icon-key → Lucide component mapping
 *   2. Runtime-badge hydration from `useGlobalRuntimeState` (escalations
 *      count, runtime severity dots, governance incidents)
 *   3. Active-route highlighting
 *
 * Hard rules — enforced by F-6 grep tests:
 *   - NO `apiFetch(...)` in this file.
 *   - NO `useActiveWorkspaceId` import.
 *   - NO role/scope/persona/capability/platform-admin derivation here.
 */

type SidebarIcon = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

// =============================================================================
// Icon mapping
// =============================================================================

const ICON_BY_KEY: Record<string, SidebarIcon> = {
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

function SidebarGroupView({
  group,
  hydratedBadges,
}: {
  group: PlatformContextNavGroup;
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
          const Icon = ICON_BY_KEY[item.iconKey] ?? Gauge;
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

export function AppSidebarV2() {
  const { envelope } = usePlatformContext();
  const teamId =
    envelope?.workspace.status === "active" && envelope.workspace.scope === "TEAM"
      ? envelope.workspace.id
      : null;
  const runtime = useGlobalRuntimeState(teamId);

  const runtimeTone = severityToTone(runtime.severity);
  const governanceIncidents = runtime.incidents.filter(
    (i) => i.category && i.category.toLowerCase().includes("governance"),
  ).length;

  const groups = envelope?.navigation.groups ?? [];

  // Hydrate runtime badges for items that declared a badgeKey.
  const hydratedBadges = new Map<string, SidebarBadge>();
  for (const group of groups) {
    for (const item of group.items as ReadonlyArray<PlatformContextNavItem>) {
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
          {groups.map((group) => (
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
          <p>
            We do not store truth. We record integrity. You own the evidence.
          </p>
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
