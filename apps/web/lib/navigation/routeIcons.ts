/**
 * ONE ROUTE → ICON AUTHORITY.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 * The sidebar already knew what every destination looks like: `AppSidebarV2`
 * carried a private `ICON_BY_ROUTE_ID` map keyed by the canonical registry id.
 * The command palette — the header's global search — knew nothing, so its
 * results were twenty rows of text with no visual anchor at all.
 *
 * The fix is NOT a second map. This module is the sidebar's map, moved out of
 * the component so both surfaces read the same one: the sidebar imports it and
 * the palette imports it, and a destination therefore wears the same glyph
 * wherever it is shown. Adding a route to the registry means adding it here
 * once, not in two components that drift apart.
 *
 * =============================================================================
 * COVERAGE, AND WHAT HAPPENS WITHOUT AN ENTRY
 * =============================================================================
 * The sidebar shows a couple of dozen routes; the palette indexes the whole
 * registry, which is an order of magnitude larger. Hand-writing a distinct
 * glyph for every one of those would be a hundred and fifty judgement calls
 * that nobody could keep true.
 *
 * So there are two layers:
 *
 *   1. EXPLICIT — a specific glyph for a specific destination. Every route the
 *      sidebar renders is here (moved verbatim, same glyphs as before), plus
 *      the destinations a search is most likely to land on.
 *   2. FAMILY — a fallback per registry namespace. `platform.*` is operator
 *      tooling, `review.*` is the reviewer workspace, and so on. A row without
 *      an explicit entry still gets an icon that says what KIND of destination
 *      it is rather than a generic dial.
 *
 * `DEFAULT_ROUTE_ICON` is the last resort and should stay rare.
 *
 * This file maps ids to glyphs and nothing else. It makes no statement about
 * whether a route is visible, permitted, or reachable — that is
 * `resolveRouteAccess`'s job, and an icon here for a route the caller cannot
 * open is expected and harmless.
 */

import type { ForwardRefExoticComponent, RefAttributes } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  BriefcaseBusiness,
  Building2,
  Camera,
  ClipboardList,
  Clock,
  CreditCard,
  Database,
  Eye,
  FileText,
  Fingerprint,
  FolderArchive,
  Gauge,
  GaugeCircle,
  Globe,
  HeartPulse,
  Home,
  Inbox,
  Key,
  KeyRound,
  Layers,
  LayoutGrid,
  LifeBuoy,
  Link2,
  ListTodo,
  Lock,
  Mail,
  Network,
  Package,
  Plug,
  Radio,
  Scale,
  ScrollText,
  Search,
  Send,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  TrendingUp,
  UserCircle,
  Users,
  UsersRound,
  Workflow,
  Wrench,
  type LucideProps,
} from "lucide-react";

export type RouteIcon = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

/** Last resort. A route reaching this has no explicit and no family entry. */
export const DEFAULT_ROUTE_ICON: RouteIcon = Gauge;

/**
 * Explicit per-registry-id icons.
 *
 * Semantic distinctness — each visible sidebar entry maps to a distinct Lucide
 * glyph. Route IDs are the canonical values from `routeRegistry.ts` (verified
 * against the rendered DOM `data-sidebar-nav-id`). The workspace-scoped Teams
 * route uses `workspace.collaboration_teams` — the sidebar renders it;
 * `admin.teams` / `governance.hub` are separate registry entries that aren't
 * currently sidebar-eligible. (The former `workspace.trust` Trust Hub sidebar
 * entry was removed 2026-07-15 when the authenticated Trust Hub was deleted.)
 */
export const ROUTE_ICONS: Readonly<Record<string, RouteIcon>> = {
  // ---- Workspace ---------------------------------------------------------
  "workspace.home": Home,
  "workspace.capture": Camera,
  "workspace.evidence": FolderArchive,
  "workspace.cases": BriefcaseBusiness,
  "workspace.reports": FileText,
  "workspace.search": Search,
  "workspace.tools": LayoutGrid,
  "workspace.intake_links": Link2,
  "workspace.destruction": Trash2,
  "workspace.evidence_requests": Inbox,
  "workspace.evidence_lifecycle": Clock,
  "workspace.integrations": Plug,
  "workspace.collaboration_teams": UsersRound,
  "workspace.collaboration_team_hub": UsersRound,
  "workspace.collaboration_team_detail": UsersRound,
  "workspace.notification_deliveries": Bell,
  "workspace.communications": Mail,
  "workspace.operations": Radio,
  "workspace.operations_health": HeartPulse,
  "workspace.workflows": Workflow,
  "workspace.packaging": Package,
  "workspace.exchange": Send,
  "workspace.executive": TrendingUp,
  "workspace.intelligence": Sparkles,
  "workspace.intelligence_quality": Sparkles,
  "workspace.ai_settings": Sparkles,
  "workspace.security_center": ShieldAlert,
  "workspace.trust_center": ShieldCheck,
  "workspace.audit_transparency": ScrollText,
  "workspace.governance_platform": Scale,
  "workspace.budget_center": CreditCard,
  "workspace.coding_schemas": ClipboardList,
  "workspace.reviewer_criteria": ClipboardList,

  // ---- Review ------------------------------------------------------------
  "review.queue": ListTodo,
  "review.queue_detail": ListTodo,
  "review.sla": GaugeCircle,
  "review.escalations": ShieldAlert,
  "review.operations": Activity,
  "workspace.review": Eye,
  "workspace.review_workspace": Eye,
  "workspace.review_queues": ListTodo,
  "workspace.review_metrics": BarChart3,
  "workspace.review_qc": ClipboardList,
  "workspace.review_external": Globe,
  "workspace.review_redaction": Eye,
  "workspace.review_disagreements": Scale,

  // ---- Investigation -----------------------------------------------------
  "investigation.hub": BriefcaseBusiness,
  "investigation.graph": Network,
  "investigation.relationships": Network,
  "investigation.timeline": Clock,
  "investigation.duplicates": Layers,
  "investigation.reviewers": UsersRound,

  // ---- Governance --------------------------------------------------------
  "governance.hub": ShieldCheck,
  "governance.retention": ClipboardList,
  "governance.destruction": Trash2,
  "governance.policy": Scale,
  "governance.lifecycle": Clock,
  "governance.analytics": BarChart3,
  "governance.notifications": Bell,

  // ---- Operations --------------------------------------------------------
  "operations.exports": Package,
  "operations.readiness": HeartPulse,
  "operations.recovery": LifeBuoy,
  "operations.signers": KeyRound,

  // ---- Account / settings ------------------------------------------------
  "account.settings": Settings,
  "account.profile": UserCircle,
  "account.security": Lock,
  "account.privacy": Lock,
  "account.preferences": Settings,
  "account.billing": CreditCard,
  "account.notifications": Inbox,
  "account.notification_settings": Bell,
  "account.organizations": Building2,
  "account.organization-detail": Building2,
  "account.organization-setup": Building2,
  "account.legal_document": ScrollText,

  // ---- Identity / admin --------------------------------------------------
  "admin.teams": UsersRound,
  "admin.identity": Fingerprint,
  "admin.identity_providers": Fingerprint,
  "admin.identity_sessions": Fingerprint,
  "admin.identity_scim": Users,
  "admin.identity_access_reviews": ClipboardList,
  "admin.identity_permission_matrix": Key,
  "admin.identity_runtime": Activity,
  "admin.identity_timeline": Clock,
  "security_center.sso": KeyRound,
  "security_center.mfa_recovery": LifeBuoy,

  // ---- Platform operator tooling ----------------------------------------
  "platform.admin": Key,
  "platform.observability": Activity,
  "platform.runbooks": BookOpen,
  "platform.security_center": ShieldAlert,
  "platform.queue_ops": Layers,
  "platform.reliability": HeartPulse,
  "platform.workspaces": Boxes,
  "platform.users": Users,
  "platform.customers": Building2,
  "platform.billing": CreditCard,
  "platform.costs": CreditCard,
  "platform.audit": ScrollText,
  "platform.search": Search,
  "platform.support_access": LifeBuoy,
  "platform.evidence_records": Database,
  "platform.provisioning": Server,
};

/**
 * Family fallbacks, applied when there is no explicit entry.
 *
 * Keyed by the registry id's namespace (the part before the first dot). These
 * say what KIND of destination a row is rather than exactly which one, which
 * is still far more use to a reader than a bare list of titles.
 */
const ICON_BY_FAMILY: Readonly<Record<string, RouteIcon>> = {
  workspace: FolderArchive,
  review: Eye,
  investigation: BriefcaseBusiness,
  governance: ShieldCheck,
  operations: Radio,
  account: Settings,
  admin: Key,
  security_center: ShieldCheck,
  platform: Wrench,
  dashboard: BarChart3,
};

/**
 * The icon for a canonical route id: explicit entry, then family, then the
 * default. Never throws and never returns null — a caller can render the
 * result directly.
 */
export function routeIconFor(routeId: string): RouteIcon {
  const explicit = ROUTE_ICONS[routeId];
  if (explicit) return explicit;

  const family = routeId.slice(0, routeId.indexOf("."));
  return ICON_BY_FAMILY[family] ?? DEFAULT_ROUTE_ICON;
}
