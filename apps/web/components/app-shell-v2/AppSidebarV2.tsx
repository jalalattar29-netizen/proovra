"use client";

import type { ForwardRefExoticComponent, RefAttributes } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  BriefcaseBusiness,
  Camera,
  ClipboardList,
  CreditCard,
  FileText,
  Gauge,
  GaugeCircle,
  Headphones,
  LibraryBig,
  ListTodo,
  Radio,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
  type LucideProps,
} from "lucide-react";

import { useActiveWorkspaceId } from "../../lib/useActiveWorkspaceId";
import {
  useGlobalRuntimeState,
  type GlobalRuntimeSeverity,
} from "../../lib/useGlobalRuntimeState";
// Phase 32.5 — workspace profile + role-aware navigation foundation.
import {
  filterByVisibility,
  type SidebarVisibility,
  type WorkspaceProfile,
  type WorkspaceRole,
} from "../../lib/workspace-profile";

type SidebarIcon = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

/**
 * Phase 28-J — Enterprise sidebar IA.
 *
 * Four semantic groups (Primary / Operations / Governance / Admin) with
 * real-runtime operational badges. Badges are derived from
 * `useGlobalRuntimeState` so every count / dot reflects the same source
 * of truth as the topbar runtime indicator. No fake counters.
 */

type SidebarBadgeTone = "neutral" | "warning" | "high" | "critical";

type SidebarBadge =
  | { kind: "count"; value: number; tone: SidebarBadgeTone }
  | { kind: "dot"; tone: SidebarBadgeTone; ariaLabel: string }
  | { kind: "label"; value: string; tone: SidebarBadgeTone };

type SidebarItem = {
  href: string;
  label: string;
  Icon: SidebarIcon;
  /** Optional bounded badge — only real runtime values, never fake. */
  badge?: SidebarBadge;
  /** Bounded ID used by tests / telemetry. */
  badgeKey?:
    | "escalations_open"
    | "ops_center_runtime"
    | "observability_runtime"
    | "governance_incidents";
  /** Phase 32.5 — bounded role / profile / platform-admin predicate.
   *  When omitted the item is visible to all authenticated users. */
  visibility?: SidebarVisibility;
};

type SidebarGroupDef = {
  title: string;
  items: SidebarItem[];
};

const PRIMARY_NAV: SidebarItem[] = [
  { href: "/home", label: "Dashboard", Icon: Gauge },
  { href: "/capture", label: "Capture", Icon: Camera },
  { href: "/evidence", label: "Evidence", Icon: LibraryBig },
  { href: "/cases", label: "Cases", Icon: BriefcaseBusiness },
  { href: "/reports", label: "Reports", Icon: FileText },
];

const OPERATIONS_NAV_BASE: SidebarItem[] = [
  { href: "/reviewer-ops", label: "Reviewer Ops", Icon: ListTodo },
  { href: "/reviewer-ops/sla", label: "SLA", Icon: GaugeCircle },
  {
    href: "/reviewer-ops/escalations",
    label: "Escalations",
    Icon: AlertTriangle,
    badgeKey: "escalations_open",
  },
  {
    href: "/ops",
    label: "Operations Center",
    Icon: Radio,
    badgeKey: "ops_center_runtime",
  },
  {
    href: "/ops/observability",
    label: "Observability",
    Icon: Activity,
    badgeKey: "observability_runtime",
  },
  { href: "/ops/runbooks", label: "Runbooks", Icon: BookOpen },
];

// Phase 32.5 — Governance nav cleanup.
//
// Previously this exposed 4 items where 2 were anchor links to the
// same /governance hub page (#retention, #legal-holds). That created
// the illusion of fragmented duplicate shells. The cleaner pattern:
// link directly to the real sub-pages that already exist
// (/governance/retention, /governance/destruction, /governance/lifecycle).
// Anchor deep-links are still available via the hub's section TOC.
const GOVERNANCE_NAV_BASE: SidebarItem[] = [
  {
    href: "/governance",
    label: "Governance",
    Icon: ShieldCheck,
    badgeKey: "governance_incidents",
  },
  {
    href: "/governance/lifecycle",
    label: "Lifecycle",
    Icon: Activity,
  },
  {
    href: "/governance/retention",
    label: "Retention",
    Icon: ScrollText,
    // Retention policy management requires admin permission.
    visibility: { roles: ["OWNER", "ADMIN"] },
  },
  {
    href: "/governance/destruction",
    label: "Destruction",
    Icon: AlertTriangle,
    visibility: { roles: ["OWNER", "ADMIN"] },
  },
  {
    href: "/reviewer-ops/policy",
    label: "Policy",
    Icon: ClipboardList,
    visibility: { roles: ["OWNER", "ADMIN"] },
  },
];

const ADMIN_NAV: SidebarItem[] = [
  {
    href: "/teams",
    label: "Teams",
    Icon: Users,
    // Team management is admin-only at the workspace level. The
    // platform-admin gate is intentionally NOT applied here so a
    // workspace OWNER can still manage their own team.
    visibility: { roles: ["OWNER", "ADMIN"] },
  },
  {
    href: "/billing",
    label: "Billing",
    Icon: CreditCard,
    visibility: { roles: ["OWNER", "ADMIN"] },
  },
  {
    href: "/settings",
    label: "Settings",
    Icon: Settings,
  },
];

function isActiveRoute(pathname: string | null, href: string) {
  if (!pathname) return false;
  // Strip URL hash before active-check.
  const route = href.split("#")[0]!;
  return pathname === route || (route !== "/billing" && pathname.startsWith(`${route}/`));
}

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

function SidebarGroup({
  title,
  items,
}: SidebarGroupDef) {
  const pathname = usePathname();

  return (
    <div className="app-sidebar-v2-group" data-sidebar-group={title}>
      <div className="app-sidebar-v2-group-title">{title}</div>

      <nav className="app-sidebar-v2-nav" aria-label={title}>
        {items.map((item) => {
          const active = isActiveRoute(pathname, item.href);

          return (
            <Link
              key={`${title}-${item.href}-${item.label}`}
              href={item.href}
              className={`app-sidebar-v2-link ${active ? "is-active" : ""}`}
              data-sidebar-link-key={item.badgeKey ?? item.href}
            >
              <span className="app-sidebar-v2-link-icon">
                <item.Icon size={17} strokeWidth={1.9} />
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge ? <BadgeView badge={item.badge} /> : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function AppSidebarV2({
  isPlatformAdmin = false,
  role = null,
  workspaceProfile = null,
}: {
  isPlatformAdmin?: boolean;
  /** Phase 32.5 — bounded workspace role for sidebar visibility
   *  filtering. Defaults to null which renders the "everyone"
   *  default. Backend permissions remain authoritative. */
  role?: WorkspaceRole | null;
  /** Phase 32.5 — bounded workspace profile. */
  workspaceProfile?: WorkspaceProfile | null;
}) {
  // Phase 28-J — sidebar consumes the same runtime state as the topbar
  // pill. Counts and dots reflect real values, polled every 45s.
  const workspace = useActiveWorkspaceId();
  const teamId =
    workspace.status === "ready" ? workspace.workspaceId : null;
  const runtime = useGlobalRuntimeState(teamId);
  // Phase 32.5 — visibility context shared by every group.
  const visibilityContext = {
    isPlatformAdmin,
    role,
    profile: workspaceProfile,
  };

  const runtimeTone = severityToTone(runtime.severity);
  const governanceIncidents = runtime.incidents.filter(
    (i) => i.category && i.category.toLowerCase().includes("governance"),
  ).length;

  // Build the badges. Only attach a badge if we have a real signal.
  const operationsNav: SidebarItem[] = OPERATIONS_NAV_BASE.map((item) => {
    if (item.badgeKey === "escalations_open" && runtime.counts.escalations > 0) {
      return {
        ...item,
        badge: {
          kind: "count",
          value: runtime.counts.escalations,
          tone:
            runtime.escalations.some((e) => e.severity === "CRITICAL")
              ? "critical"
              : runtime.escalations.some((e) => e.severity === "HIGH")
                ? "high"
                : "warning",
        },
      };
    }
    if (
      (item.badgeKey === "ops_center_runtime" ||
        item.badgeKey === "observability_runtime") &&
      runtimeTone
    ) {
      return {
        ...item,
        badge: {
          kind: "dot",
          tone: runtimeTone,
          ariaLabel: `Runtime ${runtime.severity.toLowerCase()}`,
        },
      };
    }
    return item;
  });

  const governanceNav: SidebarItem[] = GOVERNANCE_NAV_BASE.map((item) => {
    if (
      item.badgeKey === "governance_incidents" &&
      governanceIncidents > 0
    ) {
      return {
        ...item,
        badge: {
          kind: "count",
          value: governanceIncidents,
          tone:
            runtime.incidents.some(
              (i) =>
                i.severity === "CRITICAL" &&
                i.category.toLowerCase().includes("governance"),
            )
              ? "critical"
              : "high",
        },
      };
    }
    return item;
  });

  return (
    <aside className="app-sidebar-v2">
      <div className="app-sidebar-v2-bg" />

      <div className="app-sidebar-v2-inner">
        <div className="app-sidebar-v2-scroll">
          {/* Phase 32.5 — every group filters through the bounded
              role / profile / platform-admin predicate. Items without
              a `visibility` block stay visible to everyone (current
              behavior). Admin-only items hide for non-admin roles. */}
          <SidebarGroup
            title="Primary"
            items={filterByVisibility(PRIMARY_NAV, visibilityContext)}
          />
          <SidebarGroup
            title="Operations"
            items={filterByVisibility(operationsNav, visibilityContext)}
          />
          <SidebarGroup
            title="Governance"
            items={filterByVisibility(governanceNav, visibilityContext)}
          />
          <SidebarGroup
            title="Admin"
            items={filterByVisibility(ADMIN_NAV, visibilityContext)}
          />
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
