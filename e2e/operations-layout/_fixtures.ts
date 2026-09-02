/**
 * THE SERVER, AS THE OPERATIONS WORKBENCH SEES IT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PROJECT EXISTS SEPARATELY
 * ---------------------------------------------------------------------------
 * The `attention-layout` project proves Home, Notifications and Operations
 * share a coherent shell. This one proves the WORKBENCH: fifteen workspace
 * contexts and fifteen data states, each of which changes what the page is
 * allowed to render, measured in a real engine at eight widths and two
 * directions.
 *
 * It is a separate project rather than more specs in that one because the
 * matrix is combinatorial and the fixture surface is different in kind: this
 * one has to be able to say "the summary source failed", "the list is
 * truncated", "the mutation is still in flight" and "this workspace is
 * suspended" — states the shared fixture has no vocabulary for.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * REAL: the production Next.js bundle, the real stylesheet order, the real
 * cascade, the real PageShell, the real AppListbox and its portal overlay, the
 * real responsive table/card cutover, the real inspector.
 *
 * INTERCEPTED: the API. None of the properties under test belong to the
 * database, and no production system is contacted — the fixture answers on
 * `**\/v1\/**` and nothing else leaves the browser.
 *
 * Every payload matches what the route actually projects. Nothing is invented
 * that the server could not send.
 */

import type { Page } from "@playwright/test";

import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../apps/web/lib/platform-context/types";

export const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
export const OTHER_WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";
export const SELF_USER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const PEER_USER_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

// ===========================================================================
// CONTEXTS
//
// Each is defined by what the SERVER would resolve — capabilities, space
// shape, lifecycle — never by a plan name, which is the rule the product
// itself follows. `operatorCount` is a first-class part of the shape because
// it, and not the caller's own assign capability, is what decides whether
// ownership is a meaningful axis in this workspace.
// ===========================================================================

export type OpsContext =
  | "personal-free"
  | "personal-pro"
  | "owned-workspace"
  | "team-admin"
  | "organization-admin"
  | "enterprise-active"
  | "enterprise-retained"
  | "viewer"
  | "platform-admin-no-membership"
  | "platform-admin-member"
  | "inactive-workspace"
  | "suspended-workspace"
  | "wrong-workspace"
  | "missing-envelope"
  | "withheld-capability"
  | "insufficient-role";

type Shape = {
  capabilities: Record<string, boolean>;
  spaceType: "PERSONAL" | "ORGANIZATION";
  plan: string;
  enterprise: boolean;
  operatorCount: number;
  role: string;
  /** Workspace lifecycle, as the envelope reports it. */
  workspaceStatus?: "active" | "inactive" | "suspended";
  accountStatus?: "active" | "suspended" | "pending";
  isPlatformAdmin?: boolean;
  /** No envelope at all — the shell never resolved authority. */
  noEnvelope?: boolean;
  /**
   * The envelope DISAGREES WITH ITSELF about which workspace is active.
   *
   * `contextOptions.activeContext` names one workspace and the legacy
   * `workspace` block names another. Whichever the shell derives its id from,
   * the capability map it consults may describe the other — so the read would
   * be authorised by the wrong evidence, and is refused.
   */
  wrongWorkspace?: boolean;
};

const VIEW_ONLY = { DASHBOARD_VIEW: true, EVIDENCE_VIEW: true };
const ACTS = {
  ...VIEW_ONLY,
  OPERATIONS_VIEW: true,
  OPERATIONS_ACKNOWLEDGE: true,
  OPERATIONS_RESOLVE: true,
  OPERATIONS_SUPPRESS: true,
};
/**
 * The shared-workspace shape: assignment AND shared-view management.
 *
 * Both are conditioned on the workspace actually being shared, for the same
 * reason — in a single-operator workspace there is nobody to assign to and
 * nobody to share with, so offering either control would be offering a
 * decision that cannot mean anything.
 */
const ACTS_AND_ASSIGNS = {
  ...ACTS,
  OPERATIONS_ASSIGN: true,
  OPERATIONS_SAVED_VIEWS_MANAGE: true,
};

/**
 * What the registry grants a TEAM-shaped workspace beside its operational
 * keys. `ESCALATIONS_VIEW` matters here because it is the authority behind
 * the shell's third runtime source: a personal space has no reviewer
 * escalations and must not ask for them.
 */
const TEAM_SHAPE = { REVIEWER_OPS_VIEW: true, SLA_VIEW: true, ESCALATIONS_VIEW: true };

const CONTEXTS: Record<OpsContext, Shape> = {
  // No condition-producing package and one operator: no workbench at all.
  "personal-free": {
    capabilities: VIEW_ONLY,
    spaceType: "PERSONAL",
    plan: "FREE",
    enterprise: false,
    operatorCount: 1,
    role: "OWNER",
  },
  // The package produces conditions; there is nobody to assign to.
  "personal-pro": {
    capabilities: ACTS,
    spaceType: "PERSONAL",
    plan: "PRO",
    enterprise: false,
    operatorCount: 1,
    role: "OWNER",
  },
  // A paid workspace that is shared but not an organization. It must render
  // exactly what a Team does — the distinction is not a product fork.
  "owned-workspace": {
    capabilities: { ...ACTS_AND_ASSIGNS, ...TEAM_SHAPE },
    spaceType: "ORGANIZATION",
    plan: "PRO",
    enterprise: false,
    operatorCount: 2,
    role: "OWNER",
  },
  "team-admin": {
    capabilities: { ...ACTS_AND_ASSIGNS, ...TEAM_SHAPE },
    spaceType: "ORGANIZATION",
    plan: "TEAM",
    enterprise: false,
    operatorCount: 3,
    role: "ADMIN",
  },
  "organization-admin": {
    capabilities: { ...ACTS_AND_ASSIGNS, ...TEAM_SHAPE },
    spaceType: "ORGANIZATION",
    plan: "ENTERPRISE",
    enterprise: true,
    operatorCount: 8,
    role: "ADMIN",
  },
  "enterprise-active": {
    capabilities: { ...ACTS_AND_ASSIGNS, ...TEAM_SHAPE },
    spaceType: "ORGANIZATION",
    plan: "ENTERPRISE",
    enterprise: true,
    operatorCount: 24,
    role: "ADMIN",
  },
  /**
   * An Enterprise customer whose contract has lapsed but whose evidence
   * obligations have not.
   *
   * The workspace is still ACTIVE and the operator still has to be able to see
   * and close conditions on records they remain responsible for. The
   * capability envelope is what changes commercially, and the workbench reads
   * only that — so this context exists to prove the page does not fork on
   * `isEnterpriseWorkspace` or on a contract flag.
   */
  "enterprise-retained": {
    capabilities: { ...ACTS, ...TEAM_SHAPE },
    spaceType: "ORGANIZATION",
    plan: "ENTERPRISE",
    enterprise: true,
    operatorCount: 6,
    role: "ADMIN",
  },
  viewer: {
    capabilities: { ...VIEW_ONLY, OPERATIONS_VIEW: true, ...TEAM_SHAPE },
    spaceType: "ORGANIZATION",
    plan: "TEAM",
    enterprise: false,
    operatorCount: 3,
    role: "VIEWER",
  },
  /**
   * A PROOVRA platform administrator with NO membership of this workspace.
   *
   * Platform-admin status is not tenant authority. The envelope grants no
   * OPERATIONS_* capability here, and the route gate must refuse — being staff
   * does not make somebody an operator of a customer's workspace.
   */
  "platform-admin-no-membership": {
    capabilities: VIEW_ONLY,
    spaceType: "ORGANIZATION",
    plan: "ENTERPRISE",
    enterprise: true,
    operatorCount: 4,
    role: "NONE",
    isPlatformAdmin: true,
  },
  /** The same person WITH a membership: ordinary tenant authority, no more. */
  "platform-admin-member": {
    capabilities: { ...ACTS_AND_ASSIGNS, ...TEAM_SHAPE },
    spaceType: "ORGANIZATION",
    plan: "ENTERPRISE",
    enterprise: true,
    operatorCount: 4,
    role: "ADMIN",
    isPlatformAdmin: true,
  },
  "inactive-workspace": {
    capabilities: ACTS,
    spaceType: "ORGANIZATION",
    plan: "TEAM",
    enterprise: false,
    operatorCount: 3,
    role: "ADMIN",
    workspaceStatus: "inactive",
  },
  "suspended-workspace": {
    capabilities: ACTS,
    spaceType: "ORGANIZATION",
    plan: "TEAM",
    enterprise: false,
    operatorCount: 3,
    role: "ADMIN",
    workspaceStatus: "suspended",
    accountStatus: "suspended",
  },
  "wrong-workspace": {
    capabilities: ACTS_AND_ASSIGNS,
    spaceType: "ORGANIZATION",
    plan: "TEAM",
    enterprise: false,
    operatorCount: 3,
    role: "ADMIN",
    wrongWorkspace: true,
  },
  "missing-envelope": {
    capabilities: {},
    spaceType: "PERSONAL",
    plan: "FREE",
    enterprise: false,
    operatorCount: 0,
    role: "NONE",
    noEnvelope: true,
  },
  /**
   * Entitled-looking, and not granted the capability that opens the route.
   *
   * Deliberately NOT "acknowledge without view": the capability registry
   * cannot emit that envelope, because the acting grants are nested inside the
   * branch that sets OPERATIONS_VIEW first. A fixture that invents an
   * impossible server tests the page against one that does not exist.
   *
   * What IS reachable is this: a paid, shared, multi-operator workspace whose
   * package produces no operational conditions. It has every neighbouring
   * capability and no workbench.
   */
  "withheld-capability": {
    capabilities: { ...VIEW_ONLY, EVIDENCE_MANAGE: true, INTAKE_LINKS_MANAGE: true },
    spaceType: "ORGANIZATION",
    plan: "TEAM",
    enterprise: false,
    operatorCount: 3,
    role: "ADMIN",
  },
  /** In the workspace, may look, may not act. Distinct from `viewer` by role. */
  "insufficient-role": {
    capabilities: { ...VIEW_ONLY, OPERATIONS_VIEW: true, ...TEAM_SHAPE },
    spaceType: "ORGANIZATION",
    plan: "ENTERPRISE",
    enterprise: true,
    operatorCount: 12,
    role: "MEMBER",
  },
};

export function operatorCountFor(context: OpsContext): number {
  return CONTEXTS[context].operatorCount;
}

/** True when the route gate is expected to refuse before the page mounts. */
export function isRefusedContext(context: OpsContext): boolean {
  const shape = CONTEXTS[context];
  return shape.noEnvelope || shape.capabilities.OPERATIONS_VIEW !== true;
}

export function envelopeFor(context: OpsContext): Record<string, unknown> {
  const shape = CONTEXTS[context];
  // The legacy `workspace` block, which is where the sidebar derives its id.
  const workspaceId = WORKSPACE_ID;
  // The canonical active context. For `wrong-workspace` these deliberately
  // disagree, which is the whole point of that fixture.
  const activeContextId = shape.wrongWorkspace ? OTHER_WORKSPACE_ID : WORKSPACE_ID;
  const name =
    shape.spaceType === "PERSONAL" ? "Personal Space" : "Meridian Legal";
  return {
    // The REAL accepted versions. An envelope carrying anything else is
    // refused by `versionsAreCompatible` and the shell renders its
    // unknown-projection state, which looks exactly like a layout bug.
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: shape.capabilities,
    diagnostics: { requestId: `ops-${context}` },
    workspace: {
      id: workspaceId,
      name,
      status: shape.workspaceStatus ?? "active",
      scope: shape.spaceType === "PERSONAL" ? "PERSONAL" : "TEAM",
      plan: shape.plan,
      membership: { role: shape.role },
    },
    activeSpace: {
      type: shape.spaceType,
      id: activeContextId,
      displayName: name,
      roleLabel: shape.role,
      plan: shape.plan,
      status: shape.workspaceStatus ?? "active",
    },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: {
        workspaceId: activeContextId,
        kind: shape.spaceType,
        organizationId: null,
        displayName: name,
      },
    },
    account: {
      userId: SELF_USER_ID,
      accountPlan: shape.plan,
      accountStatus: shape.accountStatus ?? "active",
      email: "operator@example.invalid",
      displayName: "Operator",
    },
    flags: { isEnterpriseWorkspace: shape.enterprise },
    platform: { isPlatformAdmin: shape.isPlatformAdmin === true },
    planFeatures: {
      intakeIncluded: shape.plan !== "FREE",
      professionalSurfacesIncluded: shape.plan !== "FREE",
    },
    user: {
      id: SELF_USER_ID,
      email: "operator@example.invalid",
      name: "Operator",
    },
  };
}

// ===========================================================================
// DATA STATES
// ===========================================================================

export type OpsScenario =
  | "default"
  | "clear-empty"
  | "filtered-empty"
  | "one-incident"
  | "mixed-severity"
  | "long-title"
  | "long-identifiers"
  | "overdue"
  | "degraded-summary"
  | "unavailable-incidents"
  | "truncated"
  | "hundred-plus"
  | "mutation-pending"
  | "mutation-error"
  | "mutation-success"
  /** The incident source answers 403. The route must LATCH it off, not retry. */
  | "source-403"
  /** The incident source answers 404. Same latch, different cause. */
  | "source-404"
  /** The work queue is down. Remediation must say so, never claim completion. */
  | "queue-unavailable";

/** A title nobody would shorten by hand, in a language that does not wrap. */
const LONG_TITLE =
  "RFC3161 timestamp missing for Q4-incident-bundle-with-an-extremely-long-operator-supplied-filename-that-nobody-would-shorten-2026-08-20-final-v7-REVIEWED.zip";

/**
 * German-length operator copy.
 *
 * German compounds are the standard stress test for a control whose width was
 * chosen against English: it is not a translation, it is a LENGTH, and the
 * layout has to survive it.
 */
export const LONG_GERMAN_TITLE =
  "Zeitstempelbeglaubigungsdienstleistungsunterbrechung bei der Beweismittelintegritätsüberprüfung";

const LONG_REQUEST_ID =
  "req-01J9ZQ8F7K3M2N5P8R1T4V7X0Z-c8f2a91e-4d7b-4f1a-9c3e-2b6d8a0f5e13";

const NOW = "2026-08-23T12:00:00.000Z";
const hoursAgo = (h: number) =>
  new Date(Date.parse(NOW) - h * 3600_000).toISOString();

type IncidentOver = {
  id?: string;
  title?: string;
  severity?: string;
  status?: string;
  category?: string;
  owner?: string | null;
  firstSeenHoursAgo?: number;
  occurrences?: number;
  requestId?: string | null;
};

export function incident(i: number, over: IncidentOver = {}) {
  return {
    id: over.id ?? `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
    category: over.category ?? "EVIDENCE_INTEGRITY",
    severity: over.severity ?? "HIGH",
    status: over.status ?? "OPEN",
    title: over.title ?? `RFC3161 timestamp missing for record ${i}`,
    safeSummary:
      "This record has no RFC3161 timestamp: the timestamping provider was unreachable or timed out. It stays unresolved until the record's own tsaStatus leaves FAILED.",
    fingerprint: `tsa_failure:evidence-${i}`,
    occurrenceCount: over.occurrences ?? 1,
    firstSeenAtUtc: hoursAgo(over.firstSeenHoursAgo ?? 5),
    lastSeenAtUtc: hoursAgo(1),
    requestId: over.requestId === undefined ? null : over.requestId,
    traceId: null,
    relatedEvidenceId: `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`,
    relatedJobId: null,
    relatedProvider: "freetsa",
    runbookSlug: "evidence-integrity",
    acknowledgedByUserId: null,
    resolvedByUserId: null,
    assignedOperatorUserId: over.owner ?? null,
    assignedAtUtc: over.owner ? hoursAgo(1) : null,
    // The lifecycle instants the SLA posture is measured from.
    acknowledgedAtUtc: over.status === "ACKNOWLEDGED" ? hoursAgo(1) : null,
    resolvedAtUtc: over.status === "RESOLVED" ? hoursAgo(1) : null,
    /**
     * SLA POSTURE, exactly as the server resolves it.
     *
     * Derived here from the SAME inputs the real projection uses — the age
     * of the row against a 4h response window — rather than pinned to a
     * constant, so a fixture row that is old reads as BREACHED for the
     * reason a real one would.
     *
     * A SUPPRESSED row carries NOT_APPLICABLE and no deadline, which is the
     * refusal the surface has to render correctly.
     */
    sla: slaFor(over.status ?? "OPEN", over.firstSeenHoursAgo ?? 5),
  };
}

const SLA_ACK_HOURS = 4;
const SLA_RESOLUTION_HOURS = 24;
const SLA_DUE_SOON_HOURS = 2;

/**
 * The SLA projection as the server produces it FROM A PERSISTED CYCLE.
 *
 * Mirrors `projectIncidentSla` rather than pinning constants, so a fixture
 * row that is old reads BREACHED for the reason a real one would. The closed
 * seven-value vocabulary is used verbatim — a fixture speaking a different
 * dialect would let the surface pass while rendering something the server
 * never sends.
 */
function slaFor(status: string, ageHours: number) {
  const latched = { policyVersionId: "version-fixture", cycleNumber: 1 };

  if (status === "SUPPRESSED") {
    return {
      posture: "NOT_APPLICABLE",
      obligation: "NONE",
      dueAtUtc: null,
      targetHours: null,
      ...latched,
      acknowledgementBreached: ageHours > SLA_ACK_HOURS,
      resolutionBreached: false,
    };
  }

  if (status === "RESOLVED") {
    return {
      posture: "RESOLVED",
      obligation: "NONE",
      dueAtUtc: hoursAgo(ageHours - SLA_RESOLUTION_HOURS),
      targetHours: SLA_RESOLUTION_HOURS,
      ...latched,
      acknowledgementBreached: false,
      resolutionBreached: false,
    };
  }

  const acknowledged = status === "ACKNOWLEDGED";
  const target = acknowledged ? SLA_RESOLUTION_HOURS : SLA_ACK_HOURS;
  const remaining = target - ageHours;
  return {
    posture:
      remaining < 0
        ? "BREACHED"
        : remaining <= SLA_DUE_SOON_HOURS
          ? "AT_RISK"
          : acknowledged
            ? "ACKNOWLEDGED"
            : "ON_TRACK",
    obligation: acknowledged ? "RESOLUTION" : "ACKNOWLEDGEMENT",
    dueAtUtc: hoursAgo(ageHours - target),
    targetHours: target,
    ...latched,
    acknowledgementBreached: !acknowledged && remaining < 0,
    resolutionBreached: false,
  };
}

const MIXED = [
  incident(1, { severity: "CRITICAL", category: "REPORT", title: "Report generation failed" }),
  incident(2, { severity: "HIGH" }),
  incident(3, { severity: "WARNING", status: "ACKNOWLEDGED", owner: SELF_USER_ID }),
  incident(4, { severity: "INFO", category: "PACKAGE", title: "Verification package queued behind a long backlog" }),
  incident(5, { severity: "CRITICAL", firstSeenHoursAgo: 200, occurrences: 12 }),
];

function incidentsFor(scenario: OpsScenario, longGerman: boolean) {
  const german = (rows: ReturnType<typeof incident>[]) =>
    longGerman
      ? rows.map((r, i) =>
          i === 0 ? { ...r, title: LONG_GERMAN_TITLE } : r,
        )
      : rows;

  switch (scenario) {
    case "clear-empty":
    case "filtered-empty":
      return [];
    case "one-incident":
      return german([incident(1, { severity: "CRITICAL" })]);
    case "long-title":
      return german([incident(1, { title: LONG_TITLE }), ...MIXED.slice(1)]);
    case "long-identifiers":
      return german([
        incident(1, { requestId: LONG_REQUEST_ID }),
        ...MIXED.slice(1),
      ]);
    case "overdue":
      return german(
        MIXED.map((r) => ({ ...r, firstSeenAtUtc: hoursAgo(300), status: "OPEN" })),
      );
    case "hundred-plus":
      return german(
        Array.from({ length: 50 }, (_, i) =>
          incident(i + 1, {
            severity: ["CRITICAL", "HIGH", "WARNING", "INFO"][i % 4],
            owner: i % 3 === 0 ? SELF_USER_ID : i % 3 === 1 ? PEER_USER_ID : null,
            occurrences: (i % 7) + 1,
          }),
        ),
      );
    default:
      return german(MIXED);
  }
}

function summaryFor(scenario: OpsScenario, operatorCount: number) {
  const base = {
    workspaceId: WORKSPACE_ID,
    generatedAtUtc: NOW,
    open: 5,
    critical: 2,
    high: 1,
    warning: 1,
    info: 1,
    acknowledged: 1,
    assignedToMe: 1,
    unassigned: 3,
    resolved: 12,
    slaBreached: 1,
    slaAtRisk: 0,
    slaOnTrack: 3,
    slaUntracked: 0,
    complete: true,
    mayAssertAllClear: true,
    incompleteReason: null,
  };
  if (scenario === "clear-empty" || scenario === "filtered-empty") {
    return {
      ...base,
      open: 0,
      critical: 0,
      high: 0,
      warning: 0,
      info: 0,
      acknowledged: 0,
      assignedToMe: 0,
      unassigned: 0,
      resolved: 0,
      slaBreached: 0,
      slaAtRisk: 0,
      slaOnTrack: 0,
      slaUntracked: 0,
    };
  }
  if (scenario === "one-incident") {
    return { ...base, open: 1, critical: 1, high: 0, warning: 0, info: 0, unassigned: 1, assignedToMe: 0, acknowledged: 0, slaBreached: 0, slaAtRisk: 0, slaOnTrack: 1, slaUntracked: 0, resolved: 0 };
  }
  if (scenario === "hundred-plus") {
    return { ...base, open: 137, critical: 35, high: 34, warning: 34, info: 34, unassigned: 46, assignedToMe: 46, overdue: 22 };
  }
  if (scenario === "overdue") {
    return { ...base, overdue: 5 };
  }
  void operatorCount;
  return base;
}

export type InstallOptions = {
  scenario?: OpsScenario;
  /** Render the first condition's title at German compound length. */
  longGerman?: boolean;
};

/** Requests to platform-runtime endpoints, which a tenant must never make. */
const platformCalls: string[] = [];
export function resetPlatformCalls(): void {
  platformCalls.length = 0;
}
export function observedPlatformCalls(): readonly string[] {
  return [...platformCalls];
}

/** Every `/v1/ops/*` path the page asked for, in order. */
const opsCalls: Array<{ method: string; path: string; query: string }> = [];

/**
 * Every SHELL runtime source, in order.
 *
 * `useGlobalRuntimeState` reads three endpoints and only one of them lives
 * under `/v1/ops/`. Counting that one alone would let the other two keep
 * firing from a refused context while the test reported zero.
 */
const shellRuntimeCalls: Array<{ source: string; path: string }> = [];
export function resetShellRuntimeCalls(): void {
  shellRuntimeCalls.length = 0;
}
export function observedShellRuntimeCalls(): ReadonlyArray<{
  source: string;
  path: string;
}> {
  return [...shellRuntimeCalls];
}
export function resetOpsCalls(): void {
  opsCalls.length = 0;
}
export function observedOpsCalls(): ReadonlyArray<{
  method: string;
  path: string;
  query: string;
}> {
  return [...opsCalls];
}

export async function installApi(
  page: Page,
  context: OpsContext,
  options: InstallOptions = {},
): Promise<void> {
  const scenario = options.scenario ?? "default";
  const shape = CONTEXTS[context];
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  const rows = incidentsFor(scenario, options.longGerman === true);
  const summary = summaryFor(scenario, shape.operatorCount);

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    // ---- platform runtime: recorded, never served -----------------------
    if (
      path.endsWith("/v1/ops/health") ||
      path.endsWith("/v1/ops/metrics") ||
      path.endsWith("/v1/ops/alerts")
    ) {
      platformCalls.push(path);
      return route.fulfill(
        json({ error: { code: "platform_runtime_not_for_tenants" } }, 410),
      );
    }

    if (path.includes("/v1/ops/")) {
      opsCalls.push({ method, path, query: url.search });
    }
    /*
      THE GROUPED SURFACE — the view the page OPENS in.

      Built from the SAME scenario rows the flat list uses, collapsed by
      source, so the two renderings of one dataset cannot drift apart in this
      project the way they did in the product. Not stubbing it meant
      `/operations` rendered its empty state in every spec here while a real
      operator saw six rows.
    */
    if (path.includes("/v1/ops/incident-groups") && method === "GET") {
      if (path.includes("/affected")) {
        return route.fulfill(
          json({
            records: rows.slice(0, 3).map((r) => ({
              conditionId: r.id,
              evidenceId: r.relatedEvidenceId ?? null,
              title: r.title,
              severity: r.severity,
              status: r.status,
              lastSeenAtUtc: r.lastSeenAtUtc,
            })),
            pagination: { nextCursor: null, returned: Math.min(3, rows.length) },
            completeness: { complete: true },
          }),
        );
      }
      const bySource = new Map();
      for (const r of rows) {
        // These rows all carry the same `tsa_failure:` fingerprint prefix, so
        // the CATEGORY is the dimension that actually separates them here —
        // REPORT, EVIDENCE_INTEGRITY, PACKAGE. Grouping on the prefix collapsed
        // the whole fixture to one row, which is a fixture that cannot show
        // whether two rows agree on where their status sits.
        const key = String(r.category ?? "unknown");
        const g = bySource.get(key);
        if (!g) {
          bySource.set(key, { rows: [r] });
        } else {
          g.rows.push(r);
        }
      }
      const RANK = { CRITICAL: 4, HIGH: 3, WARNING: 2, INFO: 1 };
      const groups = [...bySource.entries()].map(([key, g]) => {
        const worst = g.rows.reduce(
          (a, r) => ((RANK[r.severity] ?? 0) > (RANK[a.severity] ?? 0) ? r : a),
          g.rows[0],
        );
        // OPEN if any member is open — the posture the type documents.
        const posture = g.rows.some((r) => r.status === "OPEN")
          ? "OPEN"
          : g.rows[0].status;
        return {
          groupKey: key,
          sourceId: key,
          category: worst.category,
          title: worst.title,
          conditionCount: g.rows.length,
          affectedRecordCount: g.rows.length,
          affectedUnit: "records",
          observations: g.rows.length,
          durationSeconds: null,
          lastObservedAtUtc: worst.lastSeenAtUtc,
          severity: worst.severity,
          statusPosture: posture,
          firstSeenAtUtc: worst.firstSeenAtUtc,
          lastSeenAtUtc: worst.lastSeenAtUtc,
          latestActivityAtUtc: worst.lastSeenAtUtc,
          assignedCount: g.rows.filter((r) => r.assignedOperatorUserId).length,
          failureGroups: [],
          affectedSample: [],
          hasMoreAffected: false,
          availableActions: [],
          metric: null,
        };
      });
      return route.fulfill(
        json({
          groups,
          totals: { groups: groups.length, conditions: rows.length },
          conservation: { conditions: rows.length, grouped: rows.length },
          completeness: { complete: true, mayAssertAllClear: true },
        }),
      );
    }

    if (path.endsWith("/v1/ops/incidents") && method === "GET") {
      // The shell polls this with `status=OPEN&limit=50`; the workbench never
      // sends that exact pair. Distinguishing them is what lets one assertion
      // say "the route asked" and another say "the shell asked".
      const q = url.searchParams;
      if (q.get("status") === "OPEN" && q.get("limit") === "50") {
        shellRuntimeCalls.push({ source: "incidents", path });
      }
    }
    if (path.endsWith("/v1/reviewer-ops/escalations")) {
      shellRuntimeCalls.push({ source: "escalations", path });
      return route.fulfill(json({ escalations: [] }));
    }

    // ---- authority -------------------------------------------------------
    if (path.endsWith("/v1/platform/context")) {
      if (shape.noEnvelope) {
        return route.fulfill(json({ error: { code: "unauthorized" } }, 401));
      }
      return route.fulfill(json(envelopeFor(context)));
    }

    // ---- saved views ------------------------------------------------------
    //
    // Handled BEFORE the generic `/v1/ops/` mutation branch: a save is a
    // POST, and letting the mutation branch swallow it would make the strip
    // untestable in exactly the scenarios that exist to test mutations.
    if (path.endsWith("/v1/ops/saved-views") && method === "GET") {
      return route.fulfill(
        json({
          views: [
            {
              id: "view-mine",
              name: "Unassigned critical",
              description: null,
              visibility: "PRIVATE",
              pinned: false,
              createdByUserId: "user-self",
              ownedByViewer: true,
              createdAt: hoursAgo(48),
              updatedAt: hoursAgo(2),
              filter: { teamId: WORKSPACE_ID, severity: "CRITICAL", owner: "unassigned" },
            },
            {
              id: "view-shared",
              name: "Evidence integrity",
              description: null,
              visibility: "TEAM",
              pinned: false,
              // Somebody ELSE's shared view, so the matrix covers the case
              // where the reader may see a view and may not delete it.
              createdByUserId: "user-other",
              ownedByViewer: false,
              createdAt: hoursAgo(72),
              updatedAt: hoursAgo(6),
              filter: { teamId: WORKSPACE_ID, category: "EVIDENCE_INTEGRITY" },
            },
          ],
        }),
      );
    }
    if (path.includes("/v1/ops/saved-views")) {
      return route.fulfill(json({ ok: true }, method === "DELETE" ? 204 : 201));
    }

    // ---- mutations -------------------------------------------------------
    if (method === "POST" && path.includes("/v1/ops/")) {
      if (scenario === "queue-unavailable" && path.includes("/remediate")) {
        // Durable but unscheduled. The operator must be told THAT, and must
        // never be told the work completed.
        return route.fulfill(
          json(
            {
              remediation: {
                result: "QUEUE_UNAVAILABLE",
                message:
                  "The work was recorded but could not be scheduled yet. It will be picked up automatically.",
              },
            },
            503,
          ),
        );
      }
      if (scenario === "mutation-pending") {
        // Never settles. The page must show a pending state and refuse a
        // second press rather than firing the same transition twice.
        return new Promise(() => {});
      }
      if (scenario === "mutation-error") {
        return route.fulfill(
          json({ error: { code: "forbidden" } }, 403),
        );
      }
      return route.fulfill(json({ ok: true }));
    }

    // ---- reads -----------------------------------------------------------
    if (path.endsWith("/v1/ops/summary")) {
      if (scenario === "degraded-summary") {
        return route.fulfill(json({ error: { code: "unavailable" } }, 503));
      }
      return route.fulfill(
        json({ summary, workspace: { operatorCount: shape.operatorCount } }),
      );
    }

    if (/\/v1\/ops\/incidents\/[^/]+$/.test(path)) {
      const target = rows[0] ?? incident(1);
      return route.fulfill(
        json({
          incident: {
            ...target,
            timeline: [
              {
                id: "evt-2",
                eventType: "occurrence",
                safeMessage: "The condition was observed again.",
                occurredAtUtc: hoursAgo(1),
              },
              {
                id: "evt-1",
                eventType: "opened",
                safeMessage:
                  "The condition was opened by the evidence-integrity scan.",
                occurredAtUtc: hoursAgo(5),
              },
            ],
            timelineComplete: true,
          },
          // The server decides what this caller may DO. A viewer's fixture
          // offers nothing, so the matrix proves the panel is withheld rather
          // than merely disabled.
          remediation: shape.capabilities.OPERATIONS_ACKNOWLEDGE === true
            ? {
                disposition: "DIRECT_REMEDIATION",
                actions: [
                  {
                    actionId: "ots.resume_anchoring",
                    label: "Resume anchoring",
                    description:
                      "Queues the anchoring step again for this record.",
                    confirm: true,
                    async: true,
                  },
                ],
                deepLink: null,
                guidance: null,
                unsafeReason: null,
              }
            : {
                disposition: "READ_ONLY_GUIDANCE",
                actions: [],
                deepLink: null,
                guidance: null,
                unsafeReason: null,
              },
        }),
      );
    }

    if (path.endsWith("/v1/ops/incidents")) {
      if (scenario === "source-403") {
        // A refusal, not an outage. The route must stop asking: a poller that
        // retries a 403 forever produces a request storm the operator cannot
        // see and cannot stop.
        return route.fulfill(json({ error: { code: "forbidden" } }, 403));
      }
      if (scenario === "source-404") {
        return route.fulfill(json({ error: { code: "not_found" } }, 404));
      }
      if (scenario === "unavailable-incidents") {
        return route.fulfill(json({ error: { code: "unavailable" } }, 503));
      }
      const truncated = scenario === "truncated" || scenario === "hundred-plus";
      return route.fulfill(
        json({
          incidents: rows,
          pagination: {
            nextCursor: truncated
              ? "55555555-5555-4555-8555-000000000050"
              : null,
            returned: rows.length,
          },
          completeness: {
            complete: !truncated,
            mayAssertAllClear: !truncated,
          },
          // The VOCABULARY this page speaks. Deliberately no hours: those
          // belong to an individual condition's recorded promise, and a
          // page-level number would invite the browser to recompute a
          // deadline from it.
          sla: {
            postures: [
              "UNTRACKED_LEGACY",
              "NOT_APPLICABLE",
              "ON_TRACK",
              "AT_RISK",
              "BREACHED",
              "ACKNOWLEDGED",
              "RESOLVED",
            ],
            attentionPostures: ["BREACHED", "AT_RISK"],
          },
        }),
      );
    }

    if (path.endsWith("/v1/ops/assignable-operators")) {
      return route.fulfill(
        json({
          operators: [
            {
              userId: SELF_USER_ID,
              displayName: "Operator",
              email: "operator@example.invalid",
              role: "ADMIN",
            },
            {
              userId: PEER_USER_ID,
              displayName: "Dana Reviewer",
              email: "dana@example.invalid",
              role: "REVIEWER",
            },
          ],
          selfUserId: SELF_USER_ID,
        }),
      );
    }

    // Anything else the shell asks for: an empty, well-formed answer.
    return route.fulfill(json({}));
  });

  // `/admin/runtime/readiness` is the shell's third runtime source and does
  // not match the `**/v1/**` pattern above.
  await page.route("**/admin/runtime/**", async (route) => {
    shellRuntimeCalls.push({
      source: "readiness",
      path: new URL(route.request().url()).pathname,
    });
    return route.fulfill(
      json({
        status: "HEALTHY",
        ranAtUtc: NOW,
        subsystems: [],
      }),
    );
  });

  await page.route("**/auth/**", (route) =>
    route.fulfill(
      json({ user: { id: SELF_USER_ID, email: "operator@example.invalid" } }),
    ),
  );
}

// ===========================================================================
// Navigation + measurement helpers
// ===========================================================================

export async function openOperations(
  page: Page,
  context: OpsContext,
  options: InstallOptions & { query?: string } = {},
): Promise<void> {
  resetPlatformCalls();
  resetOpsCalls();
  resetShellRuntimeCalls();
  await installApi(page, context, options);
  await page.goto(`/operations${options.query ?? ""}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

export async function setDirection(
  page: Page,
  dir: "ltr" | "rtl",
): Promise<void> {
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
 * `reflow-200` is WCAG 1.4.10 expressed the way the criterion defines it:
 * content must reflow into a 320 CSS-pixel viewport without a second scroll
 * direction. Chromium's `deviceScaleFactor` does not change CSS pixel width,
 * so shrinking the viewport is the correct emulation of 200% zoom.
 */
export const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "tablet-landscape-1024", width: 1024, height: 768 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "mobile-430", width: 430, height: 932 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "mobile-375", width: 375, height: 812 },
  { name: "reflow-200", width: 320, height: 800 },
] as const;

/** Does the PAGE scroll horizontally? The one thing that must never happen. */
export async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth > 1;
  });
}

/**
 * Elements that paint OUTSIDE their own box.
 *
 * "scrollWidth > clientWidth" is not that question. Two of the three overflow
 * modes bound their content perfectly well:
 *
 *   auto / scroll   the content scrolls INSIDE the box. That is the table
 *                   surface's whole job — it is what stops one wide table
 *                   teaching the page to scroll sideways.
 *   hidden          the content is CLIPPED. A monospace request id under
 *                   `overflow: hidden; text-overflow: ellipsis` reports a
 *                   scrollWidth larger than its box by construction, and is
 *                   nonetheless bounded: nothing paints outside, nothing
 *                   scrolls, and the full value is still reachable through
 *                   the row's Copy control.
 *
 * Only `visible` overflow escapes the box, and only that can push a sibling
 * or lengthen the page. Flagging the other two makes this helper report
 * correct, deliberate clipping as a defect — which it did on first run.
 */
export async function overflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll<HTMLElement>("[class*='opsw-']").forEach((el) => {
      const o = getComputedStyle(el);
      const bounded =
        o.overflowX !== "visible" || o.overflowY !== "visible";
      if (bounded) return;
      if (el.scrollWidth - el.clientWidth > 1) {
        out.push(`${el.className}: ${el.scrollWidth} > ${el.clientWidth}`);
      }
    });
    return out;
  });
}

/** Is the element fully inside the viewport horizontally? */
export async function isWithinViewport(
  page: Page,
  selector: string,
): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return true;
    const r = el.getBoundingClientRect();
    return r.left >= -1 && r.right <= window.innerWidth + 1;
  }, selector);
}

/**
 * The capabilities a context holds, for tests that must assert a behaviour
 * against its PERMISSION rather than against a hand-kept list of allowed
 * behaviours. A list drifts silently when a shape changes; a capability
 * lookup fails the moment the two disagree.
 */
export function capabilitiesFor(context: OpsContext): Record<string, boolean> {
  return CONTEXTS[context].capabilities;
}
