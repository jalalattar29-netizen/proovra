/**
 * THE Admin control-plane navigation registry.
 *
 * ===========================================================================
 * ONE REGISTRY, FIVE CONSUMERS
 * ===========================================================================
 * The desktop navigation, the mobile drawer, the breadcrumb trail, the
 * active-state resolver and the route-governance tests all read THIS file. The
 * previous list was flat and served two of those; the other three each derived
 * their own answer, so a route could be in the nav and absent from the
 * breadcrumb, or highlighted under the wrong parent, and nothing failed.
 *
 * ===========================================================================
 * WHAT WAS WRONG WITH THE WALL OF PILLS
 * ===========================================================================
 * Twenty entries in three undifferentiated rows, plus "More advanced (24)"
 * hiding the rest behind a disclosure nobody opened twice. Twenty pills is a
 * list to read, not a structure to navigate: an operator looking for queue
 * depth had to know that it lives under a page called "Operations" and not the
 * one called "System health", and there was nothing on screen to tell them.
 *
 * Nine primary sections now, each answering ONE operator question, in the
 * order an operator actually moves: what is happening → who are they → what do
 * they have → who pays → what is broken → is the platform healthy → what did
 * we do. Every surface sits under exactly one of them, and a section's children
 * appear as a second row only when that section is open — so the page shows
 * nine choices, not thirty-seven.
 *
 * ===========================================================================
 * SCOPE IS A FIELD, NOT A FOOTNOTE
 * ===========================================================================
 * Several `/admin/*` surfaces resolve a workspace from the operator's own
 * active workspace and call a tenant API. They sit behind the PLATFORM_ADMIN
 * gate and are titled "Platform" or "Identity operations", so an operator
 * reasonably reads them as cross-tenant. They are not.
 *
 * That used to be recorded as a separate array of path strings that the layout
 * matched against. Two lists of paths drift; one list with a field on each
 * entry cannot. `scope` is REQUIRED on every entry, so adding a surface without
 * deciding what it administers does not typecheck.
 */

export type AdminSurfaceScope =
  /** Reads across every tenant. The platform gate IS the boundary. */
  | "PLATFORM"
  /**
   * Platform-wide DATA, with the operator's active workspace recorded as the
   * AUDIT scope for anything they do here.
   *
   * The distinction from WORKSPACE is not pedantic and it is not cosmetic. Both
   * send `?teamId=` and the two are indistinguishable in a network tab, but
   * they are opposite facts about what is on screen. Queues is the clearest
   * case: its route header states that the queues are global and that failed
   * jobs "may originate from a different workspace than the one the operator is
   * currently active in". Labelling it WORKSPACE told an operator triaging a
   * failure that it belonged to their own tenant. It might belong to any.
   */
  | "PLATFORM_AUDIT"
  /**
   * Resolves a workspace from the operator's own active workspace and calls a
   * tenant API that FILTERS by it. Cross-tenant it is NOT, whatever the page
   * title says.
   */
  | "WORKSPACE";

export type AdminNavChild = {
  /** Route id in the canonical route registry, where one is registered. */
  routeId?: string;
  href: string;
  label: string;
  /** The question this surface answers. The nav tooltip, and the section blurb. */
  purpose: string;
  scope: AdminSurfaceScope;
};

export type AdminNavSection = {
  id: string;
  label: string;
  /** The question the SECTION answers, in the operator's words. */
  purpose: string;
  /** Where the section itself lands. Always one of its own children's hrefs. */
  href: string;
  children: ReadonlyArray<AdminNavChild>;
};

/**
 * Nine sections. The number is deliberate and the ceiling is nine: a primary
 * navigation a reader has to scan rather than recognise is a list again.
 */
export const ADMIN_NAV_SECTIONS: ReadonlyArray<AdminNavSection> = [
  {
    id: "overview",
    label: "Overview",
    purpose: "What is happening across PROOVRA right now?",
    href: "/admin",
    children: [
      {
        routeId: "platform.admin",
        href: "/admin",
        label: "Platform posture",
        purpose: "One health authority, and what needs attention.",
        scope: "PLATFORM",
      },
    ],
  },
  {
    id: "customers",
    label: "Customers",
    purpose: "Which companies are our customers, and who wants to be?",
    href: "/admin/customers",
    children: [
      {
        routeId: "platform.customers",
        href: "/admin/customers",
        label: "Customer directory",
        purpose: "Every customer organization and its contract state.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.provisioning",
        href: "/admin/provisioning",
        label: "Provisioning",
        purpose: "Activate an enterprise customer.",
        // Platform action; the active workspace is the audit envelope.
        scope: "PLATFORM_AUDIT",
      },
      {
        routeId: "platform.demo_requests",
        href: "/admin/demo-requests",
        label: "Demo requests",
        purpose: "Triage inbound demo requests.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.contact_sales",
        href: "/admin/contact-sales",
        label: "Contact sales",
        purpose: "Triage inbound sales inquiries.",
        scope: "PLATFORM",
      },
    ],
  },
  {
    id: "accounts",
    label: "Accounts & access",
    purpose: "Who are our users, and who can reach what?",
    href: "/admin/users",
    children: [
      {
        routeId: "platform.users",
        href: "/admin/users",
        label: "People",
        purpose: "Every account, its verification and its memberships.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.support_access",
        href: "/admin/support-access",
        label: "Support access",
        purpose: "Support-access and break-glass grants.",
        // The comment below this line already said the true thing — "platform
        // action; the active workspace is the audit envelope" — and then chose
        // WORKSPACE, which is the label for the opposite fact. The console
        // therefore told an operator about to break glass into a CUSTOMER
        // organization that this page "administers your own active workspace
        // — not the platform".
        //
        // It was defensible when written: the grant listing narrowed by the
        // supplied teamId, so the page really did show one workspace's rows.
        // Phase 4 removed that narrowing. `/v1/support-access/grants` is now
        // `requirePlatformStaff` and lists the staff member's own grants
        // across every tenant, so the active workspace filters nothing and
        // selects nothing; it only binds the operator's action, exactly as on
        // /admin/provisioning and /admin/customers/:id.
        //
        // Platform action; the active workspace is the audit envelope.
        scope: "PLATFORM_AUDIT",
      },
      {
        routeId: "admin.identity",
        href: "/admin/identity",
        label: "Identity operations",
        purpose:
          "Providers, SCIM, sessions and the permission matrix — for ONE workspace.",
        scope: "WORKSPACE",
      },
      // ---------------------------------------------------------------------
      // The seven identity children.
      //
      // They rendered, they were gated, and they appeared in no navigation
      // surface — reachable only by typing the URL, or by finding the one link
      // on the hub. A page nobody can find is a page nobody maintains.
      //
      // Every one of them is WORKSPACE scope, and that is not a formality: the
      // handler behind each is `requireIdentityAdmin`, which demands ACTIVE
      // membership of the supplied workspace and narrows the query to it. A
      // platform admin opening "Providers" sees their OWN workspace's SSO
      // configuration. The scope field is what makes the console say so.
      // ---------------------------------------------------------------------
      {
        routeId: "admin.identity_providers",
        href: "/admin/identity/providers",
        label: "Identity providers",
        purpose: "SAML and OIDC configuration and health, for ONE workspace.",
        scope: "WORKSPACE",
      },
      {
        routeId: "admin.identity_scim",
        href: "/admin/identity/scim",
        label: "SCIM operations",
        purpose: "Provisioning drift and reconciliation runs, for ONE workspace.",
        scope: "WORKSPACE",
      },
      {
        routeId: "admin.identity_sessions",
        href: "/admin/identity/sessions",
        label: "Sessions & devices",
        purpose: "Active sessions and devices for ONE workspace's members.",
        scope: "WORKSPACE",
      },
      {
        routeId: "admin.identity_permission_matrix",
        href: "/admin/identity/permission-matrix",
        label: "Permission matrix",
        purpose:
          "Role-to-permission resolution as the runtime computes it, for ONE workspace.",
        scope: "WORKSPACE",
      },
      {
        routeId: "admin.identity_access_reviews",
        href: "/admin/identity/access-reviews",
        label: "Access reviews",
        purpose: "Periodic access-review campaigns and outcomes, for ONE workspace.",
        scope: "WORKSPACE",
      },
      {
        routeId: "admin.identity_runtime",
        href: "/admin/identity/runtime",
        label: "Identity runtime",
        purpose: "Live session, factor and risk signals for ONE workspace.",
        scope: "WORKSPACE",
      },
      {
        routeId: "admin.identity_timeline",
        href: "/admin/identity/timeline",
        label: "Identity audit",
        purpose: "The bounded identity audit trail for ONE workspace.",
        scope: "WORKSPACE",
      },
    ],
  },
  {
    id: "workspaces",
    label: "Workspaces",
    purpose: "What customer spaces exist, and what governs each one?",
    href: "/admin/workspaces",
    children: [
      {
        routeId: "platform.workspaces",
        href: "/admin/workspaces",
        label: "Workspace inventory",
        purpose: "Every live workspace, its owner, plan and health.",
        scope: "PLATFORM",
      },
    ],
  },
  {
    id: "commercial",
    label: "Commercial",
    purpose: "Who pays for what, what is failing, and what are we spending?",
    href: "/admin/billing",
    children: [
      {
        routeId: "platform.billing",
        href: "/admin/billing",
        label: "Billing",
        purpose: "Subscriptions, payments and what is failing.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.costs",
        href: "/admin/costs",
        label: "Costs",
        purpose: "What we are spending with providers.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.executive",
        href: "/admin/executive",
        label: "Executive",
        purpose: "Revenue, leads and usage KPIs.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.adoption",
        href: "/admin/adoption",
        label: "Adoption",
        purpose: "Which capabilities are actually being used.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.dashboard",
        href: "/admin/dashboard",
        label: "Traffic",
        purpose: "Marketing funnel, geography and page analytics.",
        scope: "PLATFORM",
      },
    ],
  },
  {
    id: "evidence",
    label: "Evidence operations",
    purpose: "What evidence is stuck or failed, and for whom?",
    href: "/admin/evidence-ops",
    children: [
      {
        routeId: "platform.evidence_ops",
        href: "/admin/evidence-ops",
        label: "Evidence health",
        purpose: "Timestamping, reports and packages across every tenant.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.evidence_records",
        href: "/admin/evidence-ops/records",
        label: "Affected records",
        purpose: "The individual records behind each evidence-health figure.",
        scope: "PLATFORM",
      },
    ],
  },
  {
    id: "operations",
    label: "Platform operations",
    purpose: "Is the platform healthy, and what is broken?",
    href: "/admin/operations",
    children: [
      {
        routeId: "platform.operations",
        href: "/admin/operations",
        label: "Operations",
        purpose: "Open conditions across every tenant, and whose they are.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.platform_health",
        href: "/admin/platform-health",
        label: "System health",
        purpose: "Dependency and provider status.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.observability",
        href: "/admin/platform/observability",
        label: "Observability",
        purpose: "Process runtime, dependency probes and firing alerts.",
        scope: "PLATFORM",
      },
      {
        routeId: "operations.readiness",
        href: "/admin/platform/readiness",
        label: "Readiness",
        purpose: "Backup/DR, key management and resiliency posture.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.runbooks",
        href: "/admin/platform/runbooks",
        label: "Runbooks",
        purpose: "What to do about each condition.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.queue_ops",
        href: "/admin/platform/queues",
        label: "Queues",
        purpose: "Queue depth, failed jobs and replay.",
        scope: "PLATFORM_AUDIT",
      },
      {
        routeId: "platform.reliability",
        href: "/admin/platform/reliability",
        label: "Reliability",
        purpose: "Reliability posture and reconciliation.",
        scope: "WORKSPACE",
      },
      {
        routeId: "operations.recovery",
        href: "/admin/platform/recovery",
        label: "Recovery",
        purpose: "Backup and restore validation.",
        scope: "WORKSPACE",
      },
      {
        routeId: "operations.signers",
        href: "/admin/platform/signers",
        label: "Signers",
        purpose: "Evidence-signing key custody and signer health.",
        scope: "PLATFORM_AUDIT",
      },
      {
        routeId: "operations.exports",
        href: "/admin/platform/exports",
        label: "Exports",
        purpose: "Export manifests and reproducibility.",
        scope: "WORKSPACE",
      },
      {
        routeId: "platform.automation",
        href: "/admin/platform/automation",
        label: "Automation",
        purpose: "Automation rules and their runs.",
        scope: "WORKSPACE",
      },
      {
        routeId: "platform.analytics",
        href: "/admin/platform/analytics",
        label: "Analytics ops",
        purpose: "Analytics pipeline state.",
        scope: "WORKSPACE",
      },
      {
        routeId: "platform.media_graph",
        href: "/admin/platform/media-graph",
        label: "Media intelligence ops",
        purpose: "Media intelligence and investigation graph metrics.",
        scope: "PLATFORM_AUDIT",
      },
    ],
  },
  {
    id: "security",
    label: "Security & governance",
    purpose: "What security signals are open, and what changed?",
    href: "/admin/security",
    children: [
      {
        routeId: "platform.security",
        href: "/admin/security",
        label: "Security",
        // Corrected. The page's own header calls it "Workspace security
        // posture" and it reads /v1/security/* and /v1/identity/mfa-admin/*
        // for ONE teamId. "Across every tenant" was the claim, not the code.
        purpose: "Security posture and MFA lifecycle, for ONE workspace.",
        scope: "WORKSPACE",
      },
      {
        routeId: "platform.alerts",
        href: "/admin/alerts",
        label: "Alerts",
        purpose: "Every unresolved signal, and which incident backs it.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.timeline",
        href: "/admin/timeline",
        label: "Timeline",
        purpose: "What happened, in order, across the platform.",
        scope: "PLATFORM",
      },
    ],
  },
  {
    id: "audit",
    label: "Audit & operator tools",
    purpose: "What did we do, and how do I find one record?",
    href: "/admin/audit",
    children: [
      {
        routeId: "platform.audit",
        href: "/admin/audit",
        label: "Admin activity",
        purpose: "Every privileged action, and who took it.",
        scope: "PLATFORM",
      },
      {
        routeId: "platform.search",
        href: "/admin/search",
        label: "Search",
        purpose: "Find any customer, workspace, person or record.",
        scope: "PLATFORM",
      },
    ],
  },
] as const;

/**
 * CONTEXTUAL DETAIL SURFACES.
 *
 * A detail page is reached FROM a list, never from navigation — putting
 * `/admin/customers/:id` in the nav would be putting "a customer" in the nav.
 * They are recorded here anyway, mapped to the section they belong under, so
 * that arriving on one from the command palette or a deep link still lights up
 * the right parent and still produces a breadcrumb. Without this an operator
 * who lands on a customer from search sees no active section at all, which is
 * how a deep link becomes a dead end.
 */
export const ADMIN_CONTEXTUAL_ROUTES: ReadonlyArray<{
  /** Matched as a path PREFIX. */
  prefix: string;
  sectionId: string;
  /** The list this detail belongs to, for the breadcrumb's parent crumb. */
  parentHref: string;
  parentLabel: string;
  label: string;
}> = [
  {
    prefix: "/admin/customers/",
    sectionId: "customers",
    parentHref: "/admin/customers",
    parentLabel: "Customer directory",
    label: "Customer",
  },
  {
    prefix: "/admin/demo-requests/",
    sectionId: "customers",
    parentHref: "/admin/demo-requests",
    parentLabel: "Demo requests",
    label: "Demo request",
  },
  {
    prefix: "/admin/contact-sales/",
    sectionId: "customers",
    parentHref: "/admin/contact-sales",
    parentLabel: "Contact sales",
    label: "Sales inquiry",
  },
  {
    prefix: "/admin/users/",
    sectionId: "accounts",
    parentHref: "/admin/users",
    parentLabel: "People",
    label: "Account",
  },
  {
    prefix: "/admin/workspaces/",
    sectionId: "workspaces",
    parentHref: "/admin/workspaces",
    parentLabel: "Workspace inventory",
    label: "Workspace",
  },
  {
    prefix: "/admin/identity/",
    sectionId: "accounts",
    parentHref: "/admin/identity",
    parentLabel: "Identity operations",
    label: "Identity",
  },
] as const;

// ---------------------------------------------------------------------------
// Resolution. One implementation, so nav and breadcrumb cannot disagree.
// ---------------------------------------------------------------------------

export type AdminLocation = {
  section: AdminNavSection;
  /**
   * The listed surface this path belongs to.
   *
   * On a DETAIL page this is the LIST it came from, not the detail — the
   * detail is not a listed surface. The navigation highlights it, which is
   * right: an operator reading one customer is inside Customer directory.
   */
  child: AdminNavChild | null;
  /** Present when the path is a contextual detail under a listed surface. */
  contextual: (typeof ADMIN_CONTEXTUAL_ROUTES)[number] | null;
  /**
   * TRUE when the path is a detail BENEATH `child`, rather than `child` itself.
   *
   * The one decision both consumers read, and the reason it is a field rather
   * than each of them re-deriving it. The breadcrumb re-derived it as
   * `contextual && !child` and got it wrong: `/admin/customers/<id>` matches
   * the `/admin/customers` child by prefix, so `child` was set, the branch
   * never fired, and the detail rendered a breadcrumb identical to the list's —
   * no crumb naming the record, and no crumb back to the list. Which is the
   * deep-link dead end this phase exists to close, reintroduced one level down.
   */
  isDetail: boolean;
  /** What the CURRENT page administers. Drives the scope chip and the notice. */
  scope: AdminSurfaceScope;
};

const ALL_CHILDREN: ReadonlyArray<{ section: AdminNavSection; child: AdminNavChild }> =
  ADMIN_NAV_SECTIONS.flatMap((section) =>
    section.children.map((child) => ({ section, child })),
  );

/**
 * Where am I?
 *
 * LONGEST HREF WINS. `/admin/evidence-ops/records` and `/admin/evidence-ops`
 * are both prefixes of the first, and a shortest-first match would light up the
 * parent while the child is open — the "stale active navigation" an operator
 * reads as "I did not go anywhere".
 *
 * `/admin` matches only exactly, for the same reason inverted: as a prefix it
 * would light up on every page in the console.
 */
export function resolveAdminLocation(
  pathname: string | null | undefined,
): AdminLocation | null {
  if (!pathname || !pathname.startsWith("/admin")) return null;

  let best: { section: AdminNavSection; child: AdminNavChild } | null = null;
  for (const entry of ALL_CHILDREN) {
    const { href } = entry.child;
    const matches =
      href === "/admin"
        ? pathname === "/admin"
        : pathname === href || pathname.startsWith(`${href}/`);
    if (!matches) continue;
    if (!best || href.length > best.child.href.length) best = entry;
  }

  const contextual =
    ADM_CONTEXTUAL_SORTED.find((c) => pathname.startsWith(c.prefix)) ?? null;

  if (best) {
    return {
      section: best.section,
      child: best.child,
      contextual,
      // Strictly deeper than the listed surface, and a contextual rule claims
      // it. Both halves are load-bearing: without the depth test the list
      // itself would read as a detail of itself, and without the contextual
      // rule an unregistered deep path would claim a parent it has no crumb
      // for.
      isDetail: Boolean(contextual) && pathname !== best.child.href,
      scope: best.child.scope,
    };
  }

  if (contextual) {
    const section = ADMIN_NAV_SECTIONS.find((s) => s.id === contextual.sectionId);
    if (section) {
      const parent = section.children.find((c) => c.href === contextual.parentHref);
      return {
        section,
        child: parent ?? null,
        contextual,
        isDetail: true,
        // A detail inherits the scope of the list it came from. A workspace-
        // scoped list cannot produce a platform-scoped detail.
        scope: parent?.scope ?? "PLATFORM",
      };
    }
  }

  return null;
}

/** Longest prefix first, so `/admin/identity/scim` does not match `/admin/`. */
const ADM_CONTEXTUAL_SORTED = [...ADMIN_CONTEXTUAL_ROUTES].sort(
  (a, b) => b.prefix.length - a.prefix.length,
);

/** Every href the registry knows, listed and contextual alike. */
export function adminNavigationHrefs(): string[] {
  return ALL_CHILDREN.map((e) => e.child.href);
}

/**
 * Is this a surface that administers ONE workspace rather than the platform?
 *
 * Read from the registry rather than from a second list of paths. The two-list
 * arrangement it replaces could disagree, and did: a page could be promoted in
 * the nav and left in the tenant-scope list, or the reverse.
 */
export function isWorkspaceScopedAdminPath(
  pathname: string | null | undefined,
): boolean {
  // PLATFORM_AUDIT is deliberately NOT workspace-scoped. It is platform data
  // with a workspace-shaped audit envelope, and it gets its own notice.
  return resolveAdminLocation(pathname)?.scope === "WORKSPACE";
}

/**
 * True when a surface shows PLATFORM data but records the operator's action
 * against their active workspace.
 *
 * Separate from `isWorkspaceScopedAdminPath` because the two need different
 * sentences: one warns that the page is NOT cross-tenant, the other explains
 * that it IS and says where the audit lands.
 */
export function isPlatformAuditScopedAdminPath(
  pathname: string | null | undefined,
): boolean {
  return resolveAdminLocation(pathname)?.scope === "PLATFORM_AUDIT";
}
