/**
 * THE SERVER, AS HOME / NOTIFICATIONS / OPERATIONS SEE IT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PROJECT EXISTS
 * ---------------------------------------------------------------------------
 * The Attention Architecture's responsive and accessibility claims were, until
 * this pass, structural: assertions about source text. Source text cannot
 * answer whether a queue row overflows at 390px, whether a severity chip is
 * reachable by keyboard, whether an Arabic layout mirrors correctly, or
 * whether a Free user's Home is actually populated. jsdom answers 0 to every
 * geometry question and resolves no cascade, so a jsdom proof of any of those
 * is a proof of nothing.
 *
 * So: a real Chromium, the real production bundle, the real stylesheet order,
 * the real cascade — with the API intercepted, because none of those
 * properties belong to the database. This is the same shape the repository's
 * existing `search-layout`, `intake-links-layout` and `evidence-detail-layout`
 * projects already use.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES ARE CONTRACT-SHAPED
 * ---------------------------------------------------------------------------
 * Every payload below matches what the route actually projects. Nothing is
 * invented that the server could not send, and no production data is used.
 */

import type { Page } from "@playwright/test";

import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../apps/web/lib/platform-context/types";

const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const SELF_USER_ID = "user-self-0001";

/**
 * The contexts the acceptance matrix requires. Each is defined by the
 * CAPABILITIES the server would resolve for it — never by a plan name, which
 * is the same rule the product itself follows.
 */
export type AttentionContext =
  | "personal-free"
  | "personal-pro"
  | "team-admin"
  | "organization-admin"
  | "viewer";

type ContextShape = {
  capabilities: Record<string, boolean>;
  spaceType: "PERSONAL" | "ORGANIZATION";
  plan: string;
  enterprise: boolean;
};

const CONTEXTS: Record<AttentionContext, ContextShape> = {
  // No condition-producing package, one operator: no workbench at all. Home
  // must still be fully populated — that is the release-blocking property.
  "personal-free": {
    capabilities: { DASHBOARD_VIEW: true, EVIDENCE_VIEW: true },
    spaceType: "PERSONAL",
    plan: "FREE",
    enterprise: false,
  },
  // Package produces conditions, but there is nobody to assign to.
  "personal-pro": {
    capabilities: {
      DASHBOARD_VIEW: true,
      EVIDENCE_VIEW: true,
      OPERATIONS_VIEW: true,
      OPERATIONS_ACKNOWLEDGE: true,
      OPERATIONS_RESOLVE: true,
      OPERATIONS_SUPPRESS: true,
    },
    spaceType: "PERSONAL",
    plan: "PRO",
    enterprise: false,
  },
  "team-admin": {
    capabilities: {
      DASHBOARD_VIEW: true,
      EVIDENCE_VIEW: true,
      OPERATIONS_VIEW: true,
      OPERATIONS_ACKNOWLEDGE: true,
      OPERATIONS_RESOLVE: true,
      OPERATIONS_SUPPRESS: true,
      OPERATIONS_ASSIGN: true,
    },
    spaceType: "ORGANIZATION",
    plan: "TEAM",
    enterprise: false,
  },
  "organization-admin": {
    capabilities: {
      DASHBOARD_VIEW: true,
      EVIDENCE_VIEW: true,
      OPERATIONS_VIEW: true,
      OPERATIONS_ACKNOWLEDGE: true,
      OPERATIONS_RESOLVE: true,
      OPERATIONS_SUPPRESS: true,
      OPERATIONS_ASSIGN: true,
    },
    spaceType: "ORGANIZATION",
    plan: "ENTERPRISE",
    enterprise: true,
  },
  // Sees the work, acts on none of it.
  viewer: {
    capabilities: {
      DASHBOARD_VIEW: true,
      EVIDENCE_VIEW: true,
      OPERATIONS_VIEW: true,
    },
    spaceType: "ORGANIZATION",
    plan: "TEAM",
    enterprise: false,
  },
};

export function envelopeFor(context: AttentionContext): Record<string, unknown> {
  const shape = CONTEXTS[context];
  return {
    // The REAL accepted versions. An envelope carrying anything else is
    // refused by `versionsAreCompatible`, and the shell then renders its
    // unknown-projection state — which looks exactly like a layout bug.
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: shape.capabilities,
    diagnostics: { requestId: `attention-${context}` },
    workspace: {
      id: WORKSPACE_ID,
      name: shape.spaceType === "PERSONAL" ? "Personal Space" : "Meridian Legal",
      status: "active",
      // The envelope's workspace scope is TEAM | PERSONAL — the two-value
      // legacy discriminator, distinct from the structural workspaceKind.
      // A shared workspace is TEAM here whether it is OWNED or ORGANIZATION.
      scope: shape.spaceType === "PERSONAL" ? "PERSONAL" : "TEAM",
      plan: shape.plan,
      membership: { role: context === "viewer" ? "VIEWER" : "OWNER" },
    },
    activeSpace: {
      type: shape.spaceType,
      id: WORKSPACE_ID,
      displayName:
        shape.spaceType === "PERSONAL" ? "Personal Space" : "Meridian Legal",
      roleLabel: context === "viewer" ? "Viewer" : "Owner",
      plan: shape.plan,
    },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: WORKSPACE_ID,
        kind: shape.spaceType,
        organizationId: null,
        displayName: "Meridian Legal",
      },
    },
    account: { accountPlan: shape.plan, accountStatus: "active" },
    flags: { isEnterpriseWorkspace: shape.enterprise },
    platform: { isPlatformAdmin: false },
    planFeatures: {
      intakeIncluded: shape.plan !== "FREE",
      professionalSurfacesIncluded: shape.plan !== "FREE",
    },
    user: { id: SELF_USER_ID, email: "operator@example.invalid", name: "Operator" },
  };
}

/**
 * A workspace with REAL integrity problems.
 *
 * The Personal Free acceptance test requires TSA failures, OTS problems and
 * integrity-review items to be present, so this is the shape every context
 * gets — the point of the matrix is that the same data renders differently by
 * capability, not that some contexts get an empty workspace.
 */
export const TRUST_SUMMARY = {
  totalEvidence: 120,
  tsa: { stamped: 80, pending: 6, failed: 34, none: 0 },
  ots: { anchored: 96, pending: 10, failed: 4, none: 10 },
  signed: 110,
  endToEndReady: 62,
  signedWithoutReport: 8,
  reportedWithoutPackage: 5,
  publicVerify: { published: 40, unpublished: 78, suspended: 2 },
  needingAttention: 14,
  intake: { submissionsAwaitingReview: 3, submissionsNeedingMoreInfo: 1 },
};

const OPS_SUMMARY = {
  workspaceId: WORKSPACE_ID,
  generatedAtUtc: "2026-08-22T12:00:00.000Z",
  open: 7,
  critical: 2,
  high: 3,
  warning: 2,
  info: 0,
  acknowledged: 1,
  assignedToMe: 1,
  // The counterpart to `assignedToMe`, and the field a shared workspace
  // triages from. Counted in the SAME scan as every other field here.
  unassigned: 4,
  overdue: 1,
  complete: true,
  mayAssertAllClear: true,
  incompleteReason: null,
};

/** A deliberately hostile title: nobody would shorten this by hand. */
const LONG_TITLE =
  "Q4-incident-bundle-with-an-extremely-long-operator-supplied-filename-that-nobody-would-shorten-2026-08-20-final-v7-REVIEWED.zip";

function incident(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `55555555-5555-4555-8555-00000000000${i}`,
    category: "EVIDENCE_INTEGRITY",
    severity: i === 1 ? "CRITICAL" : i === 2 ? "HIGH" : "WARNING",
    status: i === 3 ? "ACKNOWLEDGED" : "OPEN",
    title:
      i === 1
        ? `RFC3161 timestamp missing for "${LONG_TITLE}"`
        : `RFC3161 timestamp missing for record ${i}`,
    safeSummary:
      "This record has no RFC3161 timestamp: the timestamping provider was unreachable or timed out. It stays unresolved until the record's own tsaStatus leaves FAILED.",
    fingerprint: `tsa_failure:evidence-0000000${i}`,
    occurrenceCount: i,
    firstSeenAtUtc: "2026-08-18T09:00:00.000Z",
    lastSeenAtUtc: "2026-08-22T09:00:00.000Z",
    requestId: null,
    traceId: null,
    relatedEvidenceId: `66666666-6666-4666-8666-00000000000${i}`,
    relatedJobId: null,
    relatedProvider: "freetsa",
    runbookSlug: "evidence-integrity",
    acknowledgedByUserId: null,
    resolvedByUserId: null,
    assignedOperatorUserId: i === 3 ? SELF_USER_ID : null,
    assignedAtUtc: i === 3 ? "2026-08-22T10:00:00.000Z" : null,
    ...over,
  };
}

const NOTIFICATION_ITEMS = [1, 2, 3, 4, 5].map((i) => ({
  id: `tsa_failure:evidence-0000000${i}`,
  itemKey: `tsa_failure:evidence-0000000${i}`,
  category: "tsa_failure",
  tone: i === 1 ? "critical" : i === 2 ? "high" : "warning",
  priority: "P1",
  title: i === 1 ? `Timestamp failed — ${LONG_TITLE}` : `Timestamp failed for record ${i}`,
  body: "Failed timestamping weakens time-based evidence confidence for this record.",
  href: `/evidence/66666666-6666-4666-8666-00000000000${i}`,
  occurredAt: "2026-08-22T09:00:00.000Z",
  isRead: i > 3,
  readAt: i > 3 ? "2026-08-22T10:00:00.000Z" : null,
  dismissedAt: null,
  snoozedUntil: null,
  attention: {
    readState: i > 3 ? "READ" : "UNREAD",
    lifecycle: "ACTIVE",
    remindAt: null,
    deferred: false,
  },
  classification: {
    channels: ["notification", "operational_condition"],
    conditionAuthority: "evidence",
    scope: "WORKSPACE",
    countsAsWorkload: true,
    sharedConditionFingerprint: `tsa_failure:evidence-0000000${i}`,
  },
  canMarkRead: true,
  canDismiss: true,
  canSnooze: true,
  context: { teamId: WORKSPACE_ID, teamName: "Meridian Legal" },
}));

/**
 * Intercept every route these three surfaces read.
 *
 * A route left unintercepted falls through to a server that does not exist in
 * this project, and the page then renders its error state — which is
 * indistinguishable from a layout failure and would make every assertion here
 * meaningless.
 */
export type InstallApiOptions = {
  /**
   * Serve an inbox with no items and zero counts.
   *
   * The empty state is a real product state with its own copy and its own
   * (absent) call to action, and Personal Free is the account most likely to
   * see it. Driving it from the fixture keeps that path measurable instead of
   * only reachable in theory.
   */
  emptyInbox?: boolean;
  /**
   * Serve the ARCHIVE SCENARIO: three active notifications and two archived
   * ones, with the mock honouring `filter`, `tone` and `sort` the way the real
   * route does.
   *
   * This exists because the Archived defect was user-visible: the filter
   * returned archived AND active rows. The server half of that is proven
   * against a real database in
   * `services/api/test/inbox-archived-and-sort.integration.test.ts`; what
   * cannot be proven there is that the PAGE asks for the right thing and
   * renders exactly what came back. So the fixture below is a faithful
   * implementation of the contract that suite pins — same predicate, same
   * orderings, same pagination shape — and the browser tests read the DOM.
   *
   * A mock that ignored the query string would pass no matter what the page
   * sent, which is how a filter bug survives a browser suite.
   */
  archiveScenario?: boolean;
  /**
   * Serve the METRIC-EXCLUSIVITY population: Unread 0, High 26, Info 2,
   * All 28.
   *
   * Shaped precisely to reproduce the defect this pass fixes. `Unread` at
   * ZERO is the trap: the six cards used to write two independent pieces of
   * state, so selecting Unread and then High left both applied, the request
   * asked for unread-AND-high, and the answer was empty — with no way out
   * except clicking the old card a second time to clear it. A zero-count
   * Unread makes the first click land on an empty view, which is exactly the
   * position a reader could not escape from.
   */
  metricScenario?: boolean;
  /**
   * Serve POPULATED Home collections: intake links, reports and evidence.
   *
   * Home's Operations tab — Public verification links, Report production and
   * Intake status — reads four collection endpoints, and this project served
   * `{ items: [], data: null }` for every one of them. Every row-level
   * property of those cards was therefore invisible to the browser suite: the
   * status treatments, the action colours, and how many intake rows render.
   *
   * Seven ACTIVE intake links, deliberately more than the five the card shows,
   * so the cap and its "View intake" footer are both observable.
   */
  homeCollections?: boolean;
};

/** 26 High + 2 Info, none unread. See `metricScenario`. */
const METRIC_SCENARIO_ITEMS = [
  ...Array.from({ length: 26 }, (_, i) => ({ tone: "high", i })),
  ...Array.from({ length: 2 }, (_, i) => ({ tone: "info", i: 100 + i })),
].map((s) => ({
  id: `tsa_failure:metric-${s.tone}-${s.i}`,
  itemKey: `tsa_failure:metric-${s.tone}-${s.i}`,
  category: "tsa_failure",
  tone: s.tone,
  priority: "P1",
  title: `Timestamp failed — ${s.tone} ${s.i}`,
  body: "Failed timestamping weakens time-based evidence confidence.",
  href: "/evidence/66666666-6666-4666-8666-000000000001",
  // Descending minute stamps so every ordering is deterministic.
  occurredAt: new Date(Date.UTC(2026, 7, 22, 12, 0, 0) - s.i * 60_000).toISOString(),
  // NONE unread — that is the whole point of the fixture.
  isRead: true,
  readAt: "2026-08-22T12:30:00.000Z",
  dismissedAt: null,
  snoozedUntil: null,
  attention: {
    readState: "READ",
    lifecycle: "ACTIVE",
    remindAt: null,
    deferred: false,
  },
  classification: {
    channels: ["notification", "operational_condition"],
    conditionAuthority: "evidence",
    scope: "WORKSPACE",
    countsAsWorkload: true,
    sharedConditionFingerprint: `tsa_failure:metric-${s.tone}-${s.i}`,
  },
  canMarkRead: true,
  canDismiss: true,
  canSnooze: true,
  context: { teamId: WORKSPACE_ID, teamName: "Meridian Legal" },
}));

/** The same four axes, over the metric-exclusivity population. */
function projectMetricScenario(url: URL) {
  const readState = url.searchParams.get("readState") ?? "any";
  const tone = url.searchParams.get("tone");
  const sort = url.searchParams.get("sort") ?? "newest";

  let items = METRIC_SCENARIO_ITEMS.filter((i) => i.dismissedAt == null);
  if (readState === "unread") items = items.filter((i) => !i.isRead);
  if (tone) items = items.filter((i) => i.tone === tone);

  const sorted = [...items].sort((a, b) =>
    sort === "oldest"
      ? a.occurredAt.localeCompare(b.occurredAt) ||
        a.itemKey.localeCompare(b.itemKey)
      : b.occurredAt.localeCompare(a.occurredAt) ||
        a.itemKey.localeCompare(b.itemKey),
  );

  const all = METRIC_SCENARIO_ITEMS;
  // Same rule: the cards' own axes are excluded from their own basis.
  const metricSummary = {
    total: all.length,
    unread: all.filter((i) => !i.isRead).length,
    byTone: {
      critical: 0,
      high: all.filter((i) => i.tone === "high").length,
      warning: 0,
      info: all.filter((i) => i.tone === "info").length,
    },
  };
  return {
    items: sorted,
    metricSummary,
    scopeSummary: {
      total: all.length,
      unread: all.filter((i) => !i.isRead).length,
      workload: all.length,
      guidance: 0,
      byTone: {
        critical: 0,
        high: all.filter((i) => i.tone === "high").length,
        warning: 0,
        info: all.filter((i) => i.tone === "info").length,
      },
      byCategory: { tsa_failure: all.length },
      deadlines: { dueSoon: 0, overdue: 0 },
    },
  };
}

/**
 * The archive-scenario population. Deliberately mixed: the three active items
 * include one already-read row, because "read" was the state the old predicate
 * wrongly treated as "archived" — if the page or the mock regressed to it,
 * `active-read` would appear under Archived and the test would catch it.
 */
const ARCHIVE_SCENARIO_ITEMS = [
  {
    key: "active-unread-critical",
    tone: "critical",
    isRead: false,
    archived: false,
    occurredAt: "2026-08-22T11:00:00.000Z",
  },
  {
    key: "active-unread-warning",
    tone: "warning",
    isRead: false,
    archived: false,
    occurredAt: "2026-08-22T09:00:00.000Z",
  },
  {
    key: "active-read-high",
    tone: "high",
    isRead: true,
    archived: false,
    occurredAt: "2026-08-22T10:00:00.000Z",
  },
  {
    key: "archived-info",
    tone: "info",
    isRead: true,
    archived: true,
    occurredAt: "2026-08-22T08:00:00.000Z",
  },
  {
    key: "archived-critical",
    tone: "critical",
    isRead: true,
    archived: true,
    occurredAt: "2026-08-22T07:00:00.000Z",
  },
].map((s) => ({
  id: `tsa_failure:${s.key}`,
  itemKey: `tsa_failure:${s.key}`,
  category: "tsa_failure",
  tone: s.tone,
  priority: "P1",
  title: `Timestamp failed — ${s.key}`,
  body: "Failed timestamping weakens time-based evidence confidence.",
  href: "/evidence/66666666-6666-4666-8666-000000000001",
  occurredAt: s.occurredAt,
  isRead: s.isRead,
  readAt: s.isRead ? "2026-08-22T12:00:00.000Z" : null,
  // ARCHIVED IMPLIES READ — the real archive action writes both stamps in one
  // mutation, so the fixture cannot express an archived-but-unread item either.
  dismissedAt: s.archived ? "2026-08-22T12:30:00.000Z" : null,
  snoozedUntil: null,
  attention: {
    readState: s.isRead ? "READ" : "UNREAD",
    lifecycle: s.archived ? "ARCHIVED" : "ACTIVE",
    remindAt: null,
    deferred: false,
  },
  classification: {
    channels: ["notification", "operational_condition"],
    conditionAuthority: "evidence",
    scope: "WORKSPACE",
    countsAsWorkload: true,
    sharedConditionFingerprint: `tsa_failure:${s.key}`,
  },
  canMarkRead: true,
  canDismiss: true,
  canSnooze: true,
  context: { teamId: WORKSPACE_ID, teamName: "Meridian Legal" },
}));

/**
 * The category members the route's own `FILTER_CATEGORY_MEMBERS` declares, for
 * the categories these fixtures can produce. A mock that ignored the category
 * axis would answer every category filter with the full list, and a page that
 * sent the wrong one would still look right.
 */
const FIXTURE_CATEGORY_MEMBERS: Record<string, string[]> = {
  integrity: ["ots_failure"],
  reports: ["report_failure"],
  packages: ["verification_package_failure"],
  intake: [
    "intake_submission_pending_review",
    "intake_required_items_missing",
    "intake_link_expiring",
  ],
  failures: ["communication_failure", "report_failure", "tsa_failure"],
  security: ["security_event_high", "mfa_recovery_pending"],
};

function matchesFixtureCategory(category: string, itemCategory: string): boolean {
  const members = FIXTURE_CATEGORY_MEMBERS[category];
  return !members || members.includes(itemCategory);
}

const TONE_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  warning: 2,
  info: 1,
};

/** The same predicate and orderings the API applies, over the fixture set. */
function projectArchiveScenario(url: URL) {
  // THE FOUR AXES, exactly as the route resolves them — including the legacy
  // single-slot spellings, so a fixture cannot pass a request the real server
  // would answer differently.
  const rawFilter = url.searchParams.get("filter") ?? "all";
  const legacy = rawFilter === "history" ? "archived" : rawFilter;

  let lifecycle = url.searchParams.get("lifecycle") ?? "active";
  let readState = url.searchParams.get("readState") ?? "any";
  let category = legacy;
  if (legacy === "archived") {
    if (!url.searchParams.get("lifecycle")) lifecycle = "archived";
    category = "all";
  } else if (legacy === "unread") {
    if (!url.searchParams.get("readState")) readState = "unread";
    category = "all";
  }

  const tone = url.searchParams.get("tone");
  const sort = url.searchParams.get("sort") ?? "newest";
  const canonicalFilter = lifecycle === "archived" ? "archived" : category;

  let items = ARCHIVE_SCENARIO_ITEMS.filter((i) =>
    lifecycle === "archived" ? i.dismissedAt != null : i.dismissedAt == null,
  );
  if (readState === "unread") items = items.filter((i) => !i.isRead);
  if (tone) items = items.filter((i) => i.tone === tone);
  if (category !== "all") {
    items = items.filter((i) => matchesFixtureCategory(category, i.category));
  }

  const byRecency = (a: typeof items[number], b: typeof items[number]) =>
    b.occurredAt.localeCompare(a.occurredAt) ||
    a.itemKey.localeCompare(b.itemKey);
  const sorted = [...items];
  if (sort === "oldest") {
    sorted.sort(
      (a, b) =>
        a.occurredAt.localeCompare(b.occurredAt) ||
        a.itemKey.localeCompare(b.itemKey),
    );
  } else if (sort === "unread_first") {
    sorted.sort(
      (a, b) => Number(a.isRead) - Number(b.isRead) || byRecency(a, b),
    );
  } else if (sort === "severity") {
    sorted.sort(
      (a, b) => TONE_RANK[b.tone]! - TONE_RANK[a.tone]! || byRecency(a, b),
    );
  } else {
    sorted.sort(byRecency);
  }

  const active = ARCHIVE_SCENARIO_ITEMS.filter((i) => i.dismissedAt == null);
  const zero = { critical: 0, high: 0, warning: 0, info: 0 };
  const byTone = active.reduce<Record<string, number>>(
    (acc, i) => ({ ...acc, [i.tone]: (acc[i.tone] ?? 0) + 1 }),
    { ...zero },
  );

  // THE METRIC BASIS — the same rule the route applies: narrowed by the
  // ADVANCED axes (lifecycle, category) and NOT by the two the cards
  // themselves set (tone, read-state). A fixture that ignored this would let
  // the page read global numbers and still pass.
  const metricBasis = ARCHIVE_SCENARIO_ITEMS.filter(
    (i) =>
      (lifecycle === "archived" ? i.dismissedAt != null : i.dismissedAt == null) &&
      (category === "all" || matchesFixtureCategory(category, i.category)),
  );
  const metricSummary = {
    total: metricBasis.length,
    unread: metricBasis.filter((i) => !i.isRead).length,
    byTone: metricBasis.reduce<Record<string, number>>(
      (acc, i) => ({ ...acc, [i.tone]: (acc[i.tone] ?? 0) + 1 }),
      { ...zero },
    ),
  };

  return {
    items: sorted,
    canonicalFilter,
    metricSummary,
    // The SCOPE summary is filter-independent by contract — it describes the
    // active population, which is what the metric cards count.
    scopeSummary: {
      total: active.length,
      unread: active.filter((i) => !i.isRead).length,
      workload: active.length,
      guidance: 0,
      byTone,
      byCategory: { tsa_failure: active.length },
      deadlines: { dueSoon: 0, overdue: 0 },
    },
  };
}

/**
 * Platform-runtime requests observed since the last `resetPlatformCalls()`.
 *
 * A tenant surface reading platform runtime is a boundary defect, and the only
 * honest way to prove it is absent is to watch for it rather than to grep for
 * it — a request built from a variable would pass a grep and still fire.
 */
const platformCalls: string[] = [];

export function resetPlatformCalls(): void {
  platformCalls.length = 0;
}

export function observedPlatformCalls(): readonly string[] {
  return [...platformCalls];
}

/**
 * Home's collection endpoints, shaped as the routes project them.
 *
 * Nothing here is invented beyond what the view-model reads: an intake link
 * needs id/status/recipientLabel/usedCount/maxUses, a report needs
 * evidenceId/title/report.available/package.available, and a record needs
 * id/title/status plus its verification state.
 */
const HOME_INTAKE_LINKS = {
  links: Array.from({ length: 7 }, (_, i) => ({
    id: `link-${i + 1}`,
    status: "ACTIVE",
    recipientLabel: `Witness ${i + 1}`,
    recipientPhone: null,
    workflowTemplateSlug: "witness-statement",
    usedCount: i % 3,
    maxUses: 3,
    expiresAtUtc: new Date(Date.now() + 86_400_000 * (i + 2)).toISOString(),
    createdAtUtc: new Date(Date.now() - 3_600_000 * (i + 1)).toISOString(),
  })),
};

const HOME_REPORTS = {
  items: Array.from({ length: 6 }, (_, i) => ({
    evidenceId: `ev-${i + 1}`,
    title: `Joint Scene Examination by Fire Investigators ${i + 1}.jpg`,
    status: "SIGNED",
    createdAt: new Date(Date.now() - 3_600_000 * (i + 1)).toISOString(),
    report: {
      available: true,
      version: i + 1,
      generatedAtUtc: new Date(Date.now() - 3_600_000 * (i + 1)).toISOString(),
    },
    package: { available: i % 2 === 0 },
  })),
};

const HOME_EVIDENCE = {
  items: Array.from({ length: 6 }, (_, i) => ({
    id: `ev-${i + 1}`,
    title: `Joint Scene Examination by Fire Investigators ${i + 1}.jpg`,
    type: "PHOTO",
    status: "SIGNED",
    verificationStatus: "VERIFIED",
    tsaStatus: "SUCCESS",
    latestReportVersion: 1,
    createdAt: new Date(Date.now() - 3_600_000 * (i + 1)).toISOString(),
    caseId: i === 0 ? "case-1" : null,
    publicVerificationEnabled: true,
    verificationToken: `tok-${i + 1}`,
  })),
};

/**
 * The command centre, as `/v1/dashboard/command-center` projects it.
 *
 * Two things on Home could not be observed without it: the Active matters card
 * (a case NAME is a record title and must stay navy, whatever the matter's
 * health says) and the Report production tiles for PENDING and FAILED, which
 * are neutral at zero and therefore proved nothing about their tones.
 *
 * The counts are deliberately non-zero on both sides — 5 ready, 3 packages,
 * 4 pending, 2 failed — so "ready is green, pending is attention, failed is an
 * error" is a statement the browser can actually check.
 */
const HOME_COMMAND_CENTER = {
  sections: {
    /* THE ACTIVITY FEED reads the timeline. A spread of kinds, because the
       whole point of the row treatment is that a report, a package and a hold
       are distinguishable before the label is read. */
    timeline: {
      status: "ok",
      items: [
        { kind: "evidence_finalized", title: "Joint Scene Examination by Fire Investigators.jpg", occurredAt: new Date(Date.now() - 12 * 60_000).toISOString(), href: "/evidence/ev-1" },
        { kind: "report_generated", title: "Joint Scene Examination by Fire Investigators.jpg", occurredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), href: "/evidence/ev-1" },
        { kind: "package_generated", title: "Joint Scene Examination by Fire Investigators.jpg", occurredAt: new Date(Date.now() - 26 * 3_600_000).toISOString(), href: "/evidence/ev-2" },
        { kind: "verification_published", title: "landing-network-bg.png", occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), href: "/evidence/ev-3" },
        { kind: "hold_placed", title: "20260704_014724.mp4", occurredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), href: "/evidence/ev-4" },
        { kind: "lifecycle_transition", title: "Scene overview.jpg", occurredAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), href: "/evidence/ev-5" },
        { kind: "destruction_review", title: "Archived interview.zip", occurredAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), href: "/evidence/ev-6" },
      ],
    },
    recentEvidence: {
      status: "ok",
      items: Array.from({ length: 6 }, (_, i) => ({
        id: `ev-${i + 1}`,
        title: `Joint Scene Examination by Fire Investigators ${i + 1}.jpg`,
        status: "SIGNED",
        verificationStatus: "VERIFIED",
        createdAt: new Date(Date.now() - 3_600_000 * (i + 1)).toISOString(),
        caseId: i === 0 ? "case-1" : null,
      })),
    },
    caseOperations: {
      status: "ok",
      data: {
        activeCasesCount: 1,
        casesWithEvidenceGapsCount: 0,
        unreviewedEvidenceCount: 0,
        unlinkedEvidenceCount: 0,
        topCases: [
          {
            caseId: "case-1",
            caseName: "Bilal",
            evidenceCount: 6,
            unreviewedCount: 0,
            overdueReviewCount: 0,
            openEscalationsCount: 0,
            hasActiveLegalHold: false,
            lastActivityAtUtc: new Date(Date.now() - 3_600_000).toISOString(),
            reportsReadyCount: 5,
            packagesReadyCount: 3,
            verifyLiveCount: 3,
          },
        ],
      },
    },
    pipelineDetail: {
      status: "ok",
      data: {
        evidence: {
          created: 0,
          uploading: 0,
          uploaded: 0,
          signed: 6,
          reported: 5,
          stuckUploading: 0,
        },
        reports: { ready: 5, queued: 4, failed: 2, missingFromSigned: 1 },
        packages: { ready: 3, queued: 0, failed: 2 },
      },
    },
  },
};

export async function installApi(
  page: Page,
  context: AttentionContext,
  options: InstallApiOptions = {},
): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith("/v1/platform/context")) {
      return route.fulfill(json(envelopeFor(context)));
    }
    if (path.endsWith("/v1/dashboard/trust-summary")) {
      return route.fulfill(json(TRUST_SUMMARY));
    }
    if (path.endsWith("/v1/ops/summary")) {
      // EVERY context reads this, including Personal Free: the endpoint is
      // gated on the role-based `operations.view` permission, not on the
      // OPERATIONS_VIEW capability that gates the workbench.
      //
      // `workspace.operatorCount` is what tells the workbench whether
      // OWNERSHIP is a meaningful axis here. A sole operator gets no owner
      // column, no owner filter and no assigned/unassigned cards — and that
      // falls out of this COUNT rather than the caller's own assign
      // capability, so a read-only viewer in a shared workspace keeps the
      // axis they need in order to ask who is on something.
      return route.fulfill(
        json({
          summary: OPS_SUMMARY,
          workspace: { operatorCount: context === "personal-pro" || context === "personal-free" ? 1 : 3 },
        }),
      );
    }
    if (/\/v1\/ops\/incidents\/[^/]+$/.test(path)) {
      // ONE condition plus its bounded history — the first read of
      // OperationalIncidentEvent the product has. Six code paths write that
      // history; until the workbench there was nothing that could show it.
      const id = path.slice(path.lastIndexOf("/") + 1);
      const index = Number(id.slice(-1)) || 1;
      return route.fulfill(
        json({
          incident: {
            ...incident(index),
            timeline: [
              {
                id: "evt-2",
                eventType: "occurrence",
                safeMessage: "The condition was observed again.",
                occurredAtUtc: "2026-08-22T09:00:00.000Z",
              },
              {
                id: "evt-1",
                eventType: "opened",
                safeMessage: "The condition was opened by the integrity scan.",
                occurredAtUtc: "2026-08-18T09:00:00.000Z",
              },
            ],
            timelineComplete: true,
          },
        }),
      );
    }
    if (path.endsWith("/v1/ops/incidents")) {
      return route.fulfill(
        json({
          incidents: [1, 2, 3, 4].map((i) => incident(i)),
          pagination: { nextCursor: null, returned: 4 },
          completeness: { complete: true, mayAssertAllClear: true },
        }),
      );
    }
    if (path.endsWith("/v1/ops/assignable-operators")) {
      return route.fulfill(
        json({
          operators: [
            { userId: SELF_USER_ID, displayName: "Operator", email: "operator@example.invalid", role: "ADMIN" },
            { userId: "user-peer-0002", displayName: "Dana Reviewer", email: "dana@example.invalid", role: "REVIEWER" },
          ],
          selfUserId: SELF_USER_ID,
        }),
      );
    }
    // PLATFORM RUNTIME — deliberately NOT served.
    //
    // These describe the API process: database status, Sentry status, process
    // uptime, in-process counters, gauge counts. They are identical for every
    // tenant on the instance, they reset on deploy, and no tenant can act on
    // any of them. The tenant workbench stopped reading them, and answering
    // here would let that regress silently. Every request is recorded so a
    // spec can assert the count is zero, and refused with a 410 so a
    // regression fails loudly rather than rendering stale platform chrome.
    if (
      path.endsWith("/v1/ops/health") ||
      path.endsWith("/v1/ops/metrics") ||
      path.endsWith("/v1/ops/alerts")
    ) {
      platformCalls.push(path);
      return route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "platform_runtime_not_for_tenants" } }),
      });
    }
    if (path.includes("/v1/me/inbox/summary")) {
      if (options.metricScenario) {
        const m = projectMetricScenario(new URL("http://x/"));
        return route.fulfill(
          json({
            unread: m.scopeSummary.unread,
            critical: 0,
            high: m.scopeSummary.byTone.high,
            assignedToMe: 0,
            overdue: 0,
            total: m.scopeSummary.total,
            hasTruncatedSources: false,
            degraded: false,
            degradedSources: [],
            completeness: {
              anyIncomplete: false,
              incompleteSources: [],
              mayAssertAllClear: true,
            },
            generatedAtUtc: "2026-08-22T12:00:00.000Z",
            workspaceId: WORKSPACE_ID,
          }),
        );
      }
      if (options.archiveScenario) {
        const p = projectArchiveScenario(new URL("http://x/?filter=all"));
        return route.fulfill(
          json({
            unread: p.scopeSummary.unread,
            critical: p.scopeSummary.byTone.critical ?? 0,
            high: p.scopeSummary.byTone.high ?? 0,
            assignedToMe: 0,
            overdue: 0,
            total: p.scopeSummary.total,
            hasTruncatedSources: false,
            degraded: false,
            degradedSources: [],
            completeness: {
              anyIncomplete: false,
              incompleteSources: [],
              mayAssertAllClear: true,
            },
            generatedAtUtc: "2026-08-22T12:00:00.000Z",
            workspaceId: WORKSPACE_ID,
          }),
        );
      }
      if (options.emptyInbox) {
        return route.fulfill(
          json({
            unread: 0,
            critical: 0,
            high: 0,
            assignedToMe: 0,
            overdue: 0,
            total: 0,
            hasTruncatedSources: false,
            degraded: false,
            degradedSources: [],
            completeness: {
              anyIncomplete: false,
              incompleteSources: [],
              mayAssertAllClear: true,
            },
            generatedAtUtc: "2026-08-22T12:00:00.000Z",
            workspaceId: WORKSPACE_ID,
          }),
        );
      }
      return route.fulfill(
        json({
          unread: 3,
          critical: 1,
          high: 1,
          assignedToMe: 0,
          overdue: 0,
          total: 5,
          hasTruncatedSources: false,
          degraded: false,
          degradedSources: [],
          completeness: {
            anyIncomplete: false,
            incompleteSources: [],
            mayAssertAllClear: true,
          },
          generatedAtUtc: "2026-08-22T12:00:00.000Z",
          workspaceId: WORKSPACE_ID,
        }),
      );
    }
    if (path.includes("/v1/me/inbox")) {
      if (options.metricScenario) {
        const m = projectMetricScenario(url);
        const zero = { critical: 0, high: 0, warning: 0, info: 0 };
        const byTone = m.items.reduce<Record<string, number>>(
          (acc, i) => ({ ...acc, [i.tone]: (acc[i.tone] ?? 0) + 1 }),
          { ...zero },
        );
        return route.fulfill(
          json({
            generatedAt: "2026-08-22T12:00:00.000Z",
            caller: {
              userId: SELF_USER_ID,
              email: "operator@example.invalid",
              displayName: "Operator",
            },
            summary: {
              total: m.items.length,
              byTone,
              byCategory: {},
              byPriority: { P1: m.items.length, P2: 0, P3: 0, P4: 0, P5: 0 },
            },
            scopeSummary: m.scopeSummary,
            metricSummary: m.metricSummary,
            truncated: {},
            anyTruncated: false,
            completeness: {
              bySource: {},
              anyIncomplete: false,
              incompleteSources: [],
              mayAssertAllClear: true,
            },
            pagination: {
              offset: 0,
              pageSize: 50,
              returned: m.items.length,
              nextCursor: null,
              totalEstimate: m.items.length,
              totalIsExact: true,
              appliedFilter: "all",
              appliedTone: url.searchParams.get("tone"),
            },
            items: m.items,
            historyAvailable: true,
          }),
        );
      }
      if (options.archiveScenario) {
        const projected = projectArchiveScenario(url);
        const zero = { critical: 0, high: 0, warning: 0, info: 0 };
        const byTone = projected.items.reduce<Record<string, number>>(
          (acc, i) => ({ ...acc, [i.tone]: (acc[i.tone] ?? 0) + 1 }),
          { ...zero },
        );
        return route.fulfill(
          json({
            generatedAt: "2026-08-22T12:00:00.000Z",
            caller: {
              userId: SELF_USER_ID,
              email: "operator@example.invalid",
              displayName: "Operator",
            },
            summary: {
              total: projected.items.length,
              byTone,
              byCategory: {},
              byPriority: {
                P1: projected.items.length,
                P2: 0,
                P3: 0,
                P4: 0,
                P5: 0,
              },
            },
            scopeSummary: projected.scopeSummary,
            metricSummary: projected.metricSummary,
            truncated: {},
            anyTruncated: false,
            completeness: {
              bySource: {},
              anyIncomplete: false,
              incompleteSources: [],
              mayAssertAllClear: true,
            },
            pagination: {
              offset: 0,
              pageSize: 25,
              returned: projected.items.length,
              nextCursor: null,
              totalEstimate: projected.items.length,
              totalIsExact: true,
              appliedFilter: projected.canonicalFilter,
              appliedTone: url.searchParams.get("tone"),
            },
            items: projected.items,
            historyAvailable: true,
          }),
        );
      }
      if (options.emptyInbox) {
        const zeroTones = { critical: 0, high: 0, warning: 0, info: 0 };
        return route.fulfill(
          json({
            generatedAt: "2026-08-22T12:00:00.000Z",
            caller: {
              userId: SELF_USER_ID,
              email: "operator@example.invalid",
              displayName: "Operator",
            },
            summary: {
              total: 0,
              byTone: zeroTones,
              byCategory: {},
              byPriority: { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 },
            },
            scopeSummary: {
              total: 0,
              unread: 0,
              workload: 0,
              guidance: 0,
              byTone: zeroTones,
              byCategory: {},
              deadlines: { dueSoon: 0, overdue: 0 },
            },
            truncated: {},
            anyTruncated: false,
            completeness: {
              anyIncomplete: false,
              incompleteSources: [],
              mayAssertAllClear: true,
            },
            items: [],
            pagination: {
              offset: 0,
              pageSize: 25,
              returned: 0,
              nextCursor: null,
              totalEstimate: 0,
              totalIsExact: true,
              appliedFilter: "all",
              appliedTone: null,
            },
            historyAvailable: true,
          }),
        );
      }
      return route.fulfill(
        json({
          generatedAt: "2026-08-22T12:00:00.000Z",
          caller: { userId: SELF_USER_ID, email: "operator@example.invalid", displayName: "Operator" },
          summary: {
            total: NOTIFICATION_ITEMS.length,
            byTone: { critical: 1, high: 1, warning: 3, info: 0 },
            byCategory: {},
            byPriority: { P1: 5, P2: 0, P3: 0, P4: 0, P5: 0 },
          },
          scopeSummary: {
            total: NOTIFICATION_ITEMS.length,
            unread: 3,
            workload: 5,
            guidance: 0,
            byTone: { critical: 1, high: 1, warning: 3, info: 0 },
            byCategory: { tsa_failure: 5 },
            deadlines: { dueSoon: 0, overdue: 0 },
          },
          truncated: {},
          anyTruncated: false,
          completeness: {
            bySource: {},
            anyIncomplete: false,
            incompleteSources: [],
            mayAssertAllClear: true,
          },
          pagination: {
            offset: 0,
            pageSize: 25,
            returned: NOTIFICATION_ITEMS.length,
            nextCursor: null,
            totalEstimate: NOTIFICATION_ITEMS.length,
            totalIsExact: true,
            appliedFilter: "all",
            appliedTone: null,
          },
          items: NOTIFICATION_ITEMS,
        }),
      );
    }
    if (options.homeCollections) {
      if (path.endsWith("/v1/workflow/intake-links")) {
        return route.fulfill(json(HOME_INTAKE_LINKS));
      }
      if (path.endsWith("/v1/reports")) {
        return route.fulfill(json(HOME_REPORTS));
      }
      if (path.endsWith("/v1/evidence")) {
        return route.fulfill(json(HOME_EVIDENCE));
      }
      /*
        A DISTRIBUTION WITH MORE THAN ONE CATEGORY IN IT.
        The evidence fixture is six PHOTO records, which draws a single 100%
        arc - a donut that cannot show whether segments separate, whether five
        colours stay distinct, or whether a 1% slice is still findable. These
        are the shapes the chart exists to render.
      */
      if (path.endsWith("/v1/dashboard/records-by-type")) {
        return route.fulfill(
          json({
            records: {
              total: 181,
              // The canonical category LABELS the projection reads.
              byCategory: {
                Images: 123,
                Documents: 30,
                Videos: 16,
                Audio: 2,
                Archives: 1,
              },
            },
            files: {
              total: 212,
              byCategory: {
                Images: 140,
                Documents: 41,
                Videos: 22,
                Audio: 6,
                Archives: 3,
              },
            },
          }),
        );
      }
      if (path.endsWith("/v1/dashboard/command-center")) {
        return route.fulfill(json(HOME_COMMAND_CENTER));
      }
    }

    // Everything else Home fans out to: an empty-but-valid envelope keeps the
    // page in its ready state instead of its error state.
    return route.fulfill(json({ items: [], data: null }));
  });

  // The session probe the app shell makes before anything renders.
  await page.route("**/auth/**", (route) =>
    route.fulfill(json({ user: { id: SELF_USER_ID, email: "operator@example.invalid" } })),
  );
}

/** Flip the document direction and wait for the reflow the assertions read. */
export async function setDirection(page: Page, dir: "ltr" | "rtl"): Promise<void> {
  await page.evaluate((d) => {
    document.documentElement.setAttribute("dir", d);
    document.documentElement.setAttribute("lang", d === "rtl" ? "ar" : "en");
  }, dir);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r(null))),
  );
}

/**
 * The required viewport matrix.
 *
 * `reflow-200` is the accessibility 200%-zoom requirement expressed the way
 * WCAG 1.4.10 actually defines it: content must reflow into a 320 CSS-pixel
 * wide viewport without a second scroll direction. A 1280px viewport at 200%
 * zoom IS a 640px CSS viewport; 320px is the stricter end of the same rule and
 * is what a 640px-wide window at 200% produces. Chromium's `deviceScaleFactor`
 * does not change CSS pixel width, so shrinking the viewport is the correct
 * emulation — and it is the method WCAG describes.
 */
export const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "tablet-landscape-1024", width: 1024, height: 768 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "mobile-375", width: 375, height: 812 },
  { name: "reflow-200", width: 320, height: 800 },
] as const;

/** Does the PAGE scroll horizontally? The one thing that must never happen. */
export async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // 1px of tolerance for sub-pixel rounding in the layout engine.
    return doc.scrollWidth - doc.clientWidth > 1;
  });
}
