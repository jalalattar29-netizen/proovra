/**
 * THE REVIEWED DISPOSITION FOR EVERY ADMIN SCOPE FINDING.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * `apps/web/scripts/admin-inventory.mjs` reports, for every `/admin/*` page,
 * what the page's own API handlers actually do with `teamId`. Some of those
 * answers are uncomfortable. A count of them in a report is not a resolution —
 * it is a number somebody will quote next quarter without knowing whether it
 * was ever looked at.
 *
 * So every non-PLATFORM finding is listed here with a decision and the reason
 * for it, and `admin-scope-dispositions.test.ts` fails if the tree grows a
 * finding this file does not cover, or covers one the tree no longer has.
 *
 * ===========================================================================
 * WHAT THE INVENTORY'S SCOPE VALUES MEAN
 * ===========================================================================
 * They come from following the request, not from the folder or the hook name:
 *
 *   WORKSPACE_FILTERED     the handler NARROWS its query by teamId. The page
 *                          shows one tenant, whatever its title says.
 *   WORKSPACE_AUTHZ        the handler AUTHORIZES on teamId but does not
 *                          filter by it. Who may call is workspace-derived;
 *                          what comes back may be platform-wide.
 *   PLATFORM_AUDIT_SCOPED  teamId is recorded and nothing else. The data is
 *                          platform-wide and the workspace names where the
 *                          operator was standing.
 *   WORKSPACE_UNCLASSIFIED the page resolves the active workspace but the
 *                          inventory could not resolve its handlers.
 *
 * The distinction that matters most is FILTER versus AUDIT. Both look
 * identical in the URL — `?teamId=…` — and they are opposite facts about what
 * the operator is looking at.
 */

export type AdminScopeDecision =
  /**
   * Platform-wide data. The `teamId` is the audit scope — where the operator
   * was standing when they acted — and never a filter. Correct as it is; the
   * page must SAY so, because the query string looks identical to a filter.
   */
  | "PLATFORM_AUDIT_CONTEXT"
  /**
   * Genuinely one tenant's data. The page is workspace-scoped in fact, and the
   * remedy is to say which workspace unmistakably — not to move the route,
   * because the platform gate is currently STRICTER than the API and moving it
   * would widen the audience.
   */
  | "WORKSPACE_SURFACE_LABELLED"
  /**
   * The workspace comes from an explicit filter control the operator chose,
   * not from their own active workspace. This is what a platform surface with
   * a tenant filter is supposed to look like.
   */
  | "PLATFORM_WITH_TENANT_FILTER";

export type AdminScopeDisposition = {
  route: string;
  /** What the inventory reports. Asserted against the live scan. */
  observed:
    | "WORKSPACE_FILTERED"
    /**
     * The handler passes teamId to something, and static analysis cannot tell
     * a workspace-scoping service from an audit-recording one — they are the
     * same shape. A candidate is a request for a human to read the handler,
     * not a finding.
     */
    | "WORKSPACE_CANDIDATE"
    | "WORKSPACE_AUTHZ"
    | "PLATFORM_AUDIT_SCOPED"
    | "WORKSPACE_UNCLASSIFIED";
  decision: AdminScopeDecision;
  /** Why this is correct. Not a restatement of the observation. */
  why: string;
};

export const ADMIN_SCOPE_DISPOSITIONS: readonly AdminScopeDisposition[] = [
  {
    route: "/admin/platform/queues",
    observed: "WORKSPACE_CANDIDATE",
    decision: "PLATFORM_AUDIT_CONTEXT",
    why:
      "VERIFIED by reading the route: its header states 'The queues themselves are global (not per-workspace) … We do NOT filter jobs by team in the listing because failed jobs may originate from a different workspace than the one the operator is currently active in.' The teamId is what a retry, replay or cancel is recorded against. Authority is requirePlatformOpsActor, which evaluates platform authority BEFORE workspace membership.",
  },
  {
    route: "/admin/platform/signers",
    observed: "WORKSPACE_CANDIDATE",
    decision: "PLATFORM_AUDIT_CONTEXT",
    why:
      "VERIFIED by reading the service: listAllSigners begins with getCurrentActiveSigners(), which takes no teamId at all and returns the platform's live signing identities. Only STAGED signers are workspace-attributed. Requiring platform authority here was the fix in c07c3ef2, after an ordinary member was proven able to read kmsKeyArn.",
  },
  {
    route: "/admin/platform/media-graph",
    observed: "WORKSPACE_CANDIDATE",
    decision: "PLATFORM_AUDIT_CONTEXT",
    why:
      "VERIFIED: /v1/admin/platform/metrics is registered with requirePlatformAdmin and returns snapshotMetrics(), which takes no teamId. The active workspace is read for the audit envelope only.",
  },
  {
    route: "/admin/platform/exports",
    observed: "WORKSPACE_CANDIDATE",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "CORRECTED. Previously labelled platform-wide on the strength of Object Lock being a platform property. Reading the service settles it: listExports queries `where: { evidence: { teamId: input.teamId } }`. The export LIST is one workspace's; only the Object Lock panel is platform state. Labelled workspace-scoped, because the list is what fills the page.",
  },
  {
    route: "/admin/platform/recovery",
    observed: "WORKSPACE_CANDIDATE",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "CORRECTED. listRecoveryReports queries `where: { teamId: input.teamId }`, so the readiness history shown is one workspace's. The validate-backup and validate-restore actions are platform work, but what the page DISPLAYS is scoped, and the banner describes what is displayed.",
  },
  {
    route: "/admin/platform/reliability",
    observed: "WORKSPACE_CANDIDATE",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "CORRECTED, and this one reached the browser before it was caught. countUploadSessionsByTeam({ teamId }) narrows to one workspace, and the page's own subtitle already said 'for this workspace'. It was briefly labelled platform-wide because the inventory saw no Prisma `where` in the handler — the narrowing happens inside the service. The inventory now reports that shape as a CANDIDATE rather than as proof of anything.",
  },
  {
    route: "/admin/support-access",
    // RECLASSIFIED IN PHASE 4, because the code moved under the judgement.
    //
    // The previous entry was right about the tree it was written against: the
    // grant listing narrowed by the supplied teamId, so the page showed one
    // workspace's rows and WORKSPACE was the honest label.
    //
    // Phase 4 changed that tree. `GET /v1/support-access/grants` is now gated
    // by `requirePlatformStaff` and returns the staff member's own grants
    // across every tenant — the narrowing is gone. Revocation was moved to
    // platform authority in the same change, because a customer must be able
    // to have a support grant destroyed and the old caller-supplied teamId
    // refused the very staff whose job that is.
    //
    // What remains of teamId is the audit envelope: /start and /enter still
    // demand `identity.org_policy.manage` on the workspace the operator is
    // standing in, on TOP of platform staff. It filters nothing and selects
    // nothing. That is PLATFORM_AUDIT_CONTEXT, the same shape already recorded
    // for /admin/provisioning and /admin/customers/:id.
    //
    // Keeping the old label would have been the worst of the three states: the
    // console reassuring an operator about to break glass into a CUSTOMER
    // organization that the page administers their own workspace.
    // `observed` stays WORKSPACE_FILTERED because that is what the tracer
    // still reports, and it is not wrong: /v1/support-access/enter compares
    // `grant.teamId` against the supplied teamId and refuses a mismatch. That
    // is a real narrowing — of ONE action, to the workspace its grant already
    // names. The decision differs from the observation on purpose; that is
    // what these two fields are for.
    observed: "WORKSPACE_FILTERED",
    decision: "PLATFORM_AUDIT_CONTEXT",
    why:
      "RECLASSIFIED. The banner describes what the page DISPLAYS, and both listings are now platform-wide: GET /v1/support-access/grants and GET /v1/break-glass/grants are requirePlatformStaff and neither narrows by teamId — the support listing returns the staff actor's grants across every tenant. The teamId the page still sends binds authority and audit on /start, /enter and the grant it enters, and filters nothing that is shown. Same shape as /admin/provisioning.",
  },
  {
    route: "/admin/provisioning",
    observed: "PLATFORM_AUDIT_SCOPED",
    decision: "PLATFORM_AUDIT_CONTEXT",
    why:
      "VERIFIED: /v1/admin/enterprise/provision is registered with requirePlatformAdmin and acts across tenants. The active workspace is the audit envelope for the operator's action, not a filter on anything shown.",
  },
  {
    route: "/admin/customers/:id",
    observed: "PLATFORM_AUDIT_SCOPED",
    decision: "PLATFORM_AUDIT_CONTEXT",
    why:
      "VERIFIED: POST /v1/admin/orgs/:id/suspend and /resume are requirePlatformAdmin + step-up, and the organization they act on is named by the PATH. The teamId the page now sends in the body (it previously sent {} and every click was a 400) exists so requireStepUpForSensitiveAction can bind the challenge and the audit row to the workspace the operator was standing in — it filters nothing and selects nothing. Same shape as /admin/provisioning's plan grant.",
  },
  {
    route: "/admin/identity",
    observed: "WORKSPACE_UNCLASSIFIED",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "The identity hub and every child call /v1/admin/identity/*, whose guard is requireIdentityAdmin — ACTIVE membership of the supplied teamId plus identity.org_policy.read. It is not a platform gate, and listSsoConnections({ teamId }) filters. A platform admin sees THEIR OWN workspace's identity configuration. NOT moved to a tenant URL: the page gate (PLATFORM_ADMIN) is currently stricter than the API, and moving it would widen the audience from platform operators to every workspace admin. That is a product decision, not a refactor.",
  },
  {
    route: "/admin/identity/providers",
    observed: "WORKSPACE_FILTERED",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "listSsoConnections({ teamId }) narrows to one workspace and requireIdentityAdmin demands ACTIVE membership of it, so a platform admin sees the SSO configuration of the workspace they are standing in and no other. Labelled rather than moved, for the audience reason recorded on /admin/identity.",
  },
  {
    route: "/admin/identity/timeline",
    observed: "WORKSPACE_FILTERED",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "The identity audit timeline is narrowed by teamId in the handler, so this is one workspace's identity history presented under a Platform heading. Labelled rather than moved, for the audience reason recorded on /admin/identity.",
  },
  {
    route: "/admin/identity/runtime",
    observed: "WORKSPACE_FILTERED",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "Runtime identity signals — sessions, factors, risk — are computed for the active workspace, not across tenants. Grouped and labelled with the rest of the identity family so the section does not mix scopes without saying so.",
  },
  {
    route: "/admin/identity/access-reviews",
    // WORKSPACE_FILTERED, upgraded from WORKSPACE_CANDIDATE.
    //
    // The old note said the inventory could only report a CANDIDATE "because
    // the narrowing happens inside the service". That was half right: the
    // narrowing does happen there, but the reason the tracer could not see it
    // was that this page's list URL is built as
    // `/v1/identity/access-reviews${qs.toString() ? `?${qs}` : ""}` and the
    // extractor truncated the template, so the endpoint matched no
    // registration at all. With that fixed the filter is proven.
    observed: "WORKSPACE_FILTERED",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "Access-review campaigns belong to a workspace, and the listing now resolves to a registration whose handler narrows by the supplied teamId. The family's shared guard, requireIdentityAdmin, demands ACTIVE membership of that same workspace, so the label and the authority agree.",
  },
  {
    route: "/admin/identity/permission-matrix",
    observed: "WORKSPACE_CANDIDATE",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "The permission matrix is resolved against one workspace's roles and memberships, so two workspaces legitimately produce different matrices. Presenting it under a Platform heading implies a single platform-wide answer that does not exist.",
  },
  {
    route: "/admin/identity/scim",
    observed: "WORKSPACE_CANDIDATE",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "SCIM provisioning, its drift and its reconciliation runs are configured and evaluated per workspace; there is no platform-wide SCIM state to show. Labelled with its family rather than moved, for the audience reason on /admin/identity.",
  },
  {
    route: "/admin/security",
    observed: "WORKSPACE_UNCLASSIFIED",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "The page's own header calls it 'Workspace security posture' and it reads /v1/security/* and /v1/identity/mfa-admin/* for one teamId. It is a workspace surface sitting behind the platform gate; labelled, not moved, for the same reason as the identity family.",
  },
  {
    route: "/admin/platform/analytics",
    observed: "WORKSPACE_FILTERED",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "/v1/analytics/* authorizes through authorizeOrFail with intelligence.read and scopes by teamId. Tenant analytics presented under a Platform heading. Labelled; moving it would widen who can reach the UI.",
  },
  {
    route: "/admin/platform/automation",
    observed: "WORKSPACE_FILTERED",
    decision: "WORKSPACE_SURFACE_LABELLED",
    why:
      "/v1/automation/rules and /v1/automation/runs both take teamId as a query filter and the page supplies its own active workspace, so this is one tenant's automation shown under a Platform heading. Labelled rather than moved: the page gate is stricter than the API.",
  },
  {
    route: "/admin/operations",
    observed: "WORKSPACE_FILTERED",
    decision: "PLATFORM_WITH_TENANT_FILTER",
    why:
      "Reads /v1/admin/incidents behind requirePlatformAdmin. The teamId in the query string comes from a filter control the operator chose, NOT from their own active workspace — the page resolves no active-workspace hook at all. This is the shape a platform surface with a tenant filter is supposed to have, and it is listed so the inventory's FILTER reading is not mistaken for the defect it is elsewhere.",
  },
];

/** The routes this file says are genuinely one tenant's data. */
export const WORKSPACE_LABELLED_ROUTES: readonly string[] =
  ADMIN_SCOPE_DISPOSITIONS.filter(
    (d) => d.decision === "WORKSPACE_SURFACE_LABELLED",
  ).map((d) => d.route);

/** The routes where `?teamId=` is an audit envelope, not a filter. */
export const AUDIT_CONTEXT_ROUTES: readonly string[] =
  ADMIN_SCOPE_DISPOSITIONS.filter(
    (d) => d.decision === "PLATFORM_AUDIT_CONTEXT",
  ).map((d) => d.route);

export function dispositionFor(route: string): AdminScopeDisposition | null {
  return ADMIN_SCOPE_DISPOSITIONS.find((d) => d.route === route) ?? null;
}
