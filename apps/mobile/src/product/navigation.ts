/**
 * CANONICAL NATIVE NAVIGATION MODEL (T-09f / RC-10, SB-4 + SB-5).
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * Native navigation was a hardcoded seven-item array (`useNavItems()` in
 * `src/ui/shell.tsx`) with no icons, no groups and no access decision at all.
 * The web sidebar is DERIVED: `ROUTE_REGISTRY` → `resolveRouteAccess` →
 * `resolveNavigationExposure` → `resolveNavigationDisclosure` →
 * `resolveNavigationGroups` (`AppSidebarV2.tsx:19-44`), each row wearing the
 * glyph from `lib/navigation/routeIcons.ts`.
 *
 * Consequences of the hardcoded array, all observable:
 *   - a member without `ACCOUNT_BILLING_VIEW` was never shown the web's
 *     "Requires permission" state; native simply had no Billing entry at all;
 *   - "Alerts" (native) vs "Notifications" (web) for the same destination;
 *   - Intake links and Collaboration Teams — both real native screens — were
 *     unreachable from navigation even for workspaces whose plan includes them.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The web registry entries for the destinations native actually implements,
 * copied field-for-field, plus the web access decision in the same order. It
 * is PURE (no React, no fetch) so the contract test can execute the web
 * resolver and this one over the same envelope matrix and require identical
 * answers. That test — not a comment — is what keeps the two from drifting:
 * `test/navigation-model.test.mjs`.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not an authorization layer. Every native screen still asks the API,
 * and the API is the authority. Navigation only decides what is OFFERED, the
 * same division the web draws ("a denied-but-visible item still renders …
 * the destination presents the recovery panel", `AppSidebarV2.tsx:48-58`).
 */

/** Feather glyph names — `@expo/vector-icons/Feather`, the ancestor set Lucide forked from. */
export type NavIconName =
  | "home"
  | "inbox"
  | "briefcase"
  | "archive"
  | "camera"
  | "link-2"
  | "search"
  | "users"
  | "file-text"
  | "credit-card"
  | "radio"
  | "activity";

export type RequiredActiveSpace = "NONE" | "PERSONAL_OR_ORG" | "ORGANIZATION_ONLY" | "PLATFORM_ADMIN";
export type FallbackBehavior = "LOAD" | "DEGRADED" | "REQUEST_ACCESS" | "CREATE_ORG" | "HIDDEN_IF_NO_CAPABILITY";
export type NavGroupId = "WORKSPACE" | "GOVERNANCE" | "OUTPUTS" | "SYSTEM";

export interface NativeNavRoute {
  /** Canonical web registry id (`routeRegistry.ts`). */
  readonly id: string;
  /** The web href — kept to prove the pairing, never navigated to. */
  readonly webHref: string;
  /** The expo-router path that renders this destination natively. */
  readonly href: string;
  /** Registry label, verbatim. */
  readonly label: string;
  /** i18n key when the shared dictionary carries this label. */
  readonly labelKey?: "home" | "cases";
  readonly domain: string;
  readonly requiredCapabilities: readonly string[];
  readonly requiredActiveSpace: RequiredActiveSpace;
  readonly fallbackBehavior: FallbackBehavior;
  readonly requiredPlanFeature?: string;
  readonly navPlanFeature?: string;
  /** Member of the web's ENTERPRISE_ONLY_ROUTE_IDS. */
  readonly enterpriseOnly?: boolean;
  readonly group: NavGroupId;
  readonly icon: NavIconName;
}

/**
 * Native destinations, in the web's Phase B order (`phaseBOperationalGroups.ts`
 * — "This array IS the rendered order contract"). Fields other than `href`,
 * `icon` and `labelKey` are the registry's, and the contract test fails on any
 * difference.
 */
export const NATIVE_NAV_ROUTES: readonly NativeNavRoute[] = [
  {
    id: "workspace.home", webHref: "/home", href: "/", label: "Home", labelKey: "home",
    domain: "PERSONAL_WORKSPACE", requiredCapabilities: ["DASHBOARD_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG", fallbackBehavior: "DEGRADED", group: "WORKSPACE", icon: "home",
  },
  {
    id: "account.notifications", webHref: "/notifications", href: "/notifications", label: "Notifications",
    domain: "ACCOUNT", requiredCapabilities: [],
    requiredActiveSpace: "NONE", fallbackBehavior: "LOAD", group: "WORKSPACE", icon: "inbox",
  },
  {
    id: "workspace.cases", webHref: "/cases", href: "/cases", label: "Cases", labelKey: "cases",
    domain: "PERSONAL_WORKSPACE", requiredCapabilities: ["CASES_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG", fallbackBehavior: "DEGRADED", group: "WORKSPACE", icon: "briefcase",
  },
  {
    id: "workspace.evidence", webHref: "/evidence", href: "/evidence", label: "Evidence",
    domain: "PERSONAL_WORKSPACE", requiredCapabilities: ["EVIDENCE_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG", fallbackBehavior: "DEGRADED", group: "WORKSPACE", icon: "archive",
  },
  {
    id: "workspace.capture", webHref: "/capture", href: "/capture", label: "Capture",
    domain: "PERSONAL_WORKSPACE", requiredCapabilities: ["EVIDENCE_CAPTURE"],
    requiredActiveSpace: "PERSONAL_OR_ORG", fallbackBehavior: "DEGRADED", group: "WORKSPACE", icon: "camera",
  },
  {
    id: "workspace.intake_links", webHref: "/intake-links", href: "/intake-links", label: "Intake links",
    domain: "PERSONAL_WORKSPACE", requiredCapabilities: ["INTAKE_LINKS_MANAGE"],
    requiredActiveSpace: "PERSONAL_OR_ORG", fallbackBehavior: "REQUEST_ACCESS",
    requiredPlanFeature: "intakeIncluded", group: "WORKSPACE", icon: "link-2",
  },
  {
    id: "workspace.search", webHref: "/search", href: "/search", label: "Search",
    domain: "PERSONAL_WORKSPACE", requiredCapabilities: ["SEARCH_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG", fallbackBehavior: "DEGRADED", group: "WORKSPACE", icon: "search",
  },
  {
    id: "workspace.collaboration_teams", webHref: "/collaboration-teams", href: "/teams", label: "Collaboration Teams",
    domain: "PERSONAL_WORKSPACE", requiredCapabilities: [], navPlanFeature: "teamCollaborationIncluded",
    requiredActiveSpace: "PERSONAL_OR_ORG", fallbackBehavior: "DEGRADED", group: "WORKSPACE", icon: "users",
  },
  {
    id: "workspace.reports", webHref: "/reports", href: "/reports", label: "Reports",
    domain: "PERSONAL_WORKSPACE", requiredCapabilities: ["REPORTS_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG", fallbackBehavior: "DEGRADED", group: "OUTPUTS", icon: "file-text",
  },
  {
    // routeIcons.ts has no explicit glyph for this id, so the web renders its
    // FAMILY fallback (`workspace` → FolderArchive). Mirrored, not improved on:
    // a better glyph belongs in the web map first, then here.
    id: "workspace.people", webHref: "/people", href: "/workspace-people", label: "Members & Access",
    domain: "ACCOUNT", requiredCapabilities: ["TEAM_VIEW"], navPlanFeature: "teamCollaborationIncluded",
    requiredActiveSpace: "NONE", fallbackBehavior: "LOAD", group: "GOVERNANCE", icon: "archive",
  },
  {
    id: "account.billing", webHref: "/billing", href: "/billing", label: "Billing & plan",
    domain: "ACCOUNT", requiredCapabilities: ["ACCOUNT_BILLING_VIEW"],
    requiredActiveSpace: "NONE", fallbackBehavior: "LOAD", group: "SYSTEM", icon: "credit-card",
  },
  {
    // T-11 / RC-12 — was the first entry of WEB_SIDEBAR_ROUTES_WITHOUT_NATIVE_SCREEN.
    id: "workspace.operations", webHref: "/operations", href: "/operations", label: "Operations",
    domain: "OPS", requiredCapabilities: ["OPERATIONS_VIEW"],
    requiredActiveSpace: "PERSONAL_OR_ORG", fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY", group: "SYSTEM", icon: "radio",
  },
];

/**
 * Web sidebar destinations native does NOT offer, each with the reason. The
 * contract test computes the web sidebar across its envelope matrix and fails
 * if a destination appears that is neither implemented above nor listed here —
 * so a new web sidebar entry cannot silently go missing on native.
 */
export const WEB_SIDEBAR_ROUTES_WITHOUT_NATIVE_SCREEN: Readonly<Record<string, string>> = {
  "workspace.review": "Reviewer console has no native screen (RC-15 / T-13 scope).",
  "workspace.review_workspace": "Reviewer workspace has no native screen (RC-15 / T-13 scope).",
  "workspace.review_queues": "Reviewer queues have no native screen (RC-15 / T-13 scope).",
  "governance.hub": "Governance is an Enterprise surface with no native screen.",
};

export type AccessState =
  | "ALLOWED"
  | "NEEDS_ORGANIZATION"
  | "NEEDS_PERSONAL_OR_ORG"
  | "DENIED_NO_CAPABILITY"
  | "NEEDS_UPGRADE"
  | "PLATFORM_ADMIN_ONLY";

export interface NavAccess {
  readonly canLoad: boolean;
  readonly canSeeNav: boolean;
  readonly accessState: AccessState;
}

export interface NavigationInput {
  readonly activeSpaceType: "PERSONAL" | "ORGANIZATION" | null;
  readonly isPlatformAdmin: boolean;
  readonly isEnterpriseWorkspace: boolean;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly planFeatures: Readonly<Record<string, boolean | null>> | null;
  readonly workspace: { readonly id: string | null; readonly status: string | null } | null;
  readonly personalSpace: { readonly id: string | null; readonly status: string | null } | null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function boolMap(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(obj(v))) if (typeof val === "boolean") out[k] = val;
  return out;
}

/**
 * Read the navigation inputs from the canonical `/v1/platform/context`
 * envelope — the same fields `AppSidebarV2` passes to `resolveRouteAccess`.
 * Nothing is derived: absent reads as absent, which denies rather than offers.
 */
export function navigationInputFromEnvelope(envelope: unknown): NavigationInput {
  const env = obj(envelope);
  const typeRaw = strOrNull(obj(env["activeSpace"])["type"]);
  const ws = env["workspace"] && typeof env["workspace"] === "object" ? obj(env["workspace"]) : null;
  const ps = env["personalSpace"] && typeof env["personalSpace"] === "object" ? obj(env["personalSpace"]) : null;
  const pf = env["planFeatures"] && typeof env["planFeatures"] === "object" ? obj(env["planFeatures"]) : null;
  const planFeatures: Record<string, boolean | null> | null = pf
    ? Object.fromEntries(Object.entries(pf).filter(([, v]) => typeof v === "boolean" || v === null)) as Record<string, boolean | null>
    : null;
  return {
    activeSpaceType: typeRaw === "PERSONAL" || typeRaw === "ORGANIZATION" ? typeRaw : null,
    isPlatformAdmin: obj(env["platform"])["isPlatformAdmin"] === true,
    isEnterpriseWorkspace: obj(env["flags"])["isEnterpriseWorkspace"] === true,
    capabilities: boolMap(env["capabilities"]),
    planFeatures,
    workspace: ws ? { id: strOrNull(ws["id"]), status: strOrNull(ws["status"]) } : null,
    personalSpace: ps ? { id: strOrNull(ps["id"]), status: strOrNull(ps["status"]) } : null,
  };
}

/** `hasUsablePersonalOrOrgEvidence` — routeAccessResolver.ts, verbatim in effect. */
function hasUsablePersonalOrOrgEvidence(input: NavigationInput): boolean {
  const ws = input.workspace;
  if (ws && ws.id) {
    if ((ws.status ?? "active").toLowerCase() !== "no-workspace") return true;
  }
  const ps = input.personalSpace;
  if (ps && ps.id) {
    if ((ps.status ?? "active").toLowerCase() === "active") return true;
  }
  return false;
}

const ALLOWED: NavAccess = { canLoad: true, canSeeNav: true, accessState: "ALLOWED" };

/**
 * The web's `resolveRouteAccess`, same decision order:
 *   1. platform-admin routes · 2. active-space requirement ·
 *   3. Enterprise-only · 4. navPlanFeature (hide, still loads) ·
 *   5. requiredPlanFeature (hide, refuse) · 6. capabilities.
 */
export function resolveNativeRouteAccess(route: NativeNavRoute, input: NavigationInput): NavAccess {
  const admin = input.isPlatformAdmin;

  if (route.requiredActiveSpace === "PLATFORM_ADMIN" || route.domain === "PLATFORM_ADMIN") {
    return admin ? ALLOWED : { canLoad: false, canSeeNav: false, accessState: "PLATFORM_ADMIN_ONLY" };
  }

  if (route.requiredActiveSpace === "ORGANIZATION_ONLY") {
    if (input.activeSpaceType !== "ORGANIZATION") {
      return { canLoad: false, canSeeNav: true, accessState: "NEEDS_ORGANIZATION" };
    }
  } else if (route.requiredActiveSpace === "PERSONAL_OR_ORG") {
    if (input.activeSpaceType !== "PERSONAL" && input.activeSpaceType !== "ORGANIZATION") {
      if (!hasUsablePersonalOrOrgEvidence(input)) {
        return { canLoad: false, canSeeNav: true, accessState: "NEEDS_PERSONAL_OR_ORG" };
      }
    }
  }

  if (!admin && route.enterpriseOnly && !input.isEnterpriseWorkspace) {
    return { canLoad: false, canSeeNav: false, accessState: "NEEDS_UPGRADE" };
  }
  if (!admin && route.navPlanFeature && input.planFeatures?.[route.navPlanFeature] !== true) {
    return { canLoad: true, canSeeNav: false, accessState: "NEEDS_UPGRADE" };
  }
  if (!admin && route.requiredPlanFeature && input.planFeatures?.[route.requiredPlanFeature] !== true) {
    return { canLoad: false, canSeeNav: false, accessState: "NEEDS_UPGRADE" };
  }

  for (const cap of route.requiredCapabilities) {
    if (input.capabilities[cap] !== true) {
      return {
        canLoad: false,
        canSeeNav: route.fallbackBehavior !== "HIDDEN_IF_NO_CAPABILITY",
        accessState: "DENIED_NO_CAPABILITY",
      };
    }
  }
  return ALLOWED;
}

/** `DEGRADATION_CHIP_LABELS` (canonicalNavigationGroups.ts), verbatim. */
export const DEGRADATION_CHIP_LABELS = {
  NEEDS_ORGANIZATION: "Requires organization",
  NEEDS_PERSONAL_OR_ORG: "Setup needed",
  DENIED_NO_CAPABILITY: "Requires permission",
  NEEDS_UPGRADE: "Upgrade required",
} as const;

export function degradationChip(access: NavAccess): string | null {
  if (access.canLoad) return null;
  switch (access.accessState) {
    case "NEEDS_ORGANIZATION":
    case "NEEDS_PERSONAL_OR_ORG":
    case "DENIED_NO_CAPABILITY":
    case "NEEDS_UPGRADE":
      return DEGRADATION_CHIP_LABELS[access.accessState];
    default:
      return null;
  }
}

export interface NavItem {
  readonly route: NativeNavRoute;
  readonly access: NavAccess;
  /** "Requires permission" etc. — null for a loadable destination. */
  readonly chip: string | null;
}

export interface NavGroup {
  readonly id: NavGroupId;
  /** Web group title (`canonicalNavigationGroups.ts`). */
  readonly title: string;
  readonly items: readonly NavItem[];
}

const GROUP_TITLES: Readonly<Record<NavGroupId, string>> = {
  WORKSPACE: "Workspace",
  GOVERNANCE: "Governance",
  OUTPUTS: "Outputs",
  SYSTEM: "System",
};
const GROUP_ORDER: readonly NavGroupId[] = ["WORKSPACE", "GOVERNANCE", "OUTPUTS", "SYSTEM"];

/**
 * The grouped navigation for an envelope. Empty groups are dropped, as the web
 * drops them.
 *
 * The one sidebar-local rule the web applies before exposure is kept too
 * (`AppSidebarV2.tsx`, PHASE 4): outside an organization, an
 * organization-only destination is HIDDEN rather than shown as "Requires
 * organization" — "hidden is better than showing 'Requires Permission' for
 * irrelevant enterprise features".
 */
export function resolveNativeNavigation(
  input: NavigationInput,
  routes: readonly NativeNavRoute[] = NATIVE_NAV_ROUTES,
): readonly NavGroup[] {
  const buckets = new Map<NavGroupId, NavItem[]>();
  for (const route of routes) {
    const access = resolveNativeRouteAccess(route, input);
    const suppressed =
      access.accessState === "NEEDS_ORGANIZATION" &&
      input.activeSpaceType !== "ORGANIZATION" &&
      !input.isPlatformAdmin;
    if (!access.canSeeNav || suppressed) continue;
    const list = buckets.get(route.group) ?? [];
    list.push({ route, access, chip: degradationChip(access) });
    buckets.set(route.group, list);
  }
  return GROUP_ORDER.filter((g) => (buckets.get(g)?.length ?? 0) > 0).map((g) => ({
    id: g,
    title: GROUP_TITLES[g],
    items: buckets.get(g)!,
  }));
}

/**
 * Navigation while the envelope has not arrived, or could not be read.
 *
 * The web never renders its sidebar without an envelope. Native must still let
 * someone move around, so it offers the destinations that require NO plan
 * feature and NO organization, WITHOUT any chip: before the envelope exists we
 * do not know the access state, and a chip would be a claim we cannot back.
 * Each destination still enforces its own access against the API.
 */
export function provisionalNavigation(): readonly NavGroup[] {
  const provisional = NATIVE_NAV_ROUTES.filter(
    (r) => !r.requiredPlanFeature && !r.navPlanFeature && !r.enterpriseOnly &&
      r.requiredActiveSpace !== "ORGANIZATION_ONLY" && r.requiredActiveSpace !== "PLATFORM_ADMIN" &&
      r.id !== "account.billing" &&
      // Hidden-if-no-capability destinations must not be offered before the
      // capability is known — that is exactly what the fallback forbids.
      r.fallbackBehavior !== "HIDDEN_IF_NO_CAPABILITY",
  );
  return GROUP_ORDER.map((g) => ({
    id: g,
    title: GROUP_TITLES[g],
    items: provisional.filter((r) => r.group === g).map((route) => ({ route, access: ALLOWED, chip: null })),
  })).filter((g) => g.items.length > 0);
}

/**
 * The phone bottom bar is a bounded subset — five slots — of the Workspace
 * group, in the same order. Search is omitted because the header already
 * carries it on every screen (T-09a). Everything else is one tap away in the
 * navigation drawer, which renders the full grouped list exactly as the web's
 * mobile drawer renders the whole sidebar (`AppShellV2.tsx:276`).
 */
export const BOTTOM_BAR_LIMIT = 5;
export function bottomBarItems(groups: readonly NavGroup[]): readonly NavItem[] {
  const workspace = groups.find((g) => g.id === "WORKSPACE")?.items ?? [];
  return workspace.filter((i) => i.route.id !== "workspace.search").slice(0, BOTTOM_BAR_LIMIT);
}

/** Active-route match — `isActiveRoute` on the web, with native's `/` home. */
export function isActiveHref(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname === "/index";
  return pathname === href || pathname.startsWith(`${href}/`);
}
