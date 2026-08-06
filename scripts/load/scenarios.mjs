// scripts/load/scenarios.mjs
//
// Scenario catalogue for the Enterprise load-test baseline runner.
//
// SAFETY CONTRACT (read scripts/load/README.md before running):
//   * Every scenario here is READ-ONLY or DRY-RUN. Nothing mutates real state.
//   * The only "writes" are the bulk-invite VALIDATE and CSV ?dryRun=1
//     endpoints, which the API explicitly documents as creating nothing.
//   * All synthetic data uses `loadtest+{i}@example.com` addresses — never
//     real user data, never real uploads.
//   * NO evidence-upload scenario is included on purpose: a safe upload would
//     require a non-prod fixture + finalize gate + storage writes, which is
//     neither read-only nor dry-run. Omitted deliberately (documented in
//     README.md). Add it only behind a dedicated, non-prod, fixture-only flag.
//
// Path templates use `:orgId` / `:teamId` placeholders, filled from config
// (LOAD_TEST_ORG_ID / LOAD_TEST_TEAM_ID). Endpoints whose exact route was
// uncertain are marked `configurable: true` and can be overridden via the
// JSON config file's `endpointOverrides` map (see README.md).

/**
 * @typedef {Object} Scenario
 * @property {string}  name           Stable identifier for the report.
 * @property {"GET"|"POST"} method
 * @property {string}  pathTemplate   e.g. "/v1/orgs/:orgId/audit-events".
 * @property {boolean} auth           Requires a bearer token.
 * @property {boolean} [needsOrg]     Requires LOAD_TEST_ORG_ID.
 * @property {boolean} [needsTeam]    Requires LOAD_TEST_TEAM_ID.
 * @property {(cfg: any) => (undefined | Record<string, unknown> | string)} [body]
 *           Optional request-body factory (dry-run/validate only).
 * @property {Record<string,string>} [headers]  Extra headers (merged w/ auth).
 * @property {boolean} [dryRun]       True if this scenario exercises a dry-run.
 * @property {boolean} [configurable] Route was uncertain; overridable.
 * @property {string}  [note]         Human note for the README / report.
 */

/**
 * Build a small synthetic bulk-invite body. Emails are synthetic and routed to
 * the reserved example.com domain, so nothing can ever reach a real inbox.
 * @param {number} rows
 */
function syntheticInviteBody(rows) {
  const n = Math.max(1, Math.min(rows | 0 || 5, 25));
  return {
    defaultRole: "ORG_MEMBER",
    rows: Array.from({ length: n }, (_v, i) => ({
      email: `loadtest+${i + 1}@example.com`,
    })),
  };
}

/**
 * Build a synthetic CSV payload for the dry-run CSV endpoint.
 * @param {number} rows
 */
function syntheticCsvBody(rows) {
  const n = Math.max(1, Math.min(rows | 0 || 5, 25));
  const lines = ["email,role"];
  for (let i = 1; i <= n; i++) lines.push(`loadtest+${i}@example.com,ORG_MEMBER`);
  return { csv: lines.join("\n"), defaultRole: "ORG_MEMBER" };
}

/** @type {Scenario[]} */
export const SCENARIOS = [
  // ---- Public health probes (no auth) ------------------------------------
  {
    name: "healthz",
    method: "GET",
    pathTemplate: "/healthz",
    auth: false,
    note: "Liveness probe. Public, minimal.",
  },
  {
    name: "readyz",
    method: "GET",
    pathTemplate: "/readyz",
    auth: false,
    note: "Readiness probe (DB reachable). Public, minimal.",
  },

  // ---- Authenticated health / readiness ----------------------------------
  {
    name: "ops_health",
    method: "GET",
    pathTemplate: "/v1/ops/health",
    auth: true,
    note: "Authenticated detailed health for the operator UI.",
  },
  {
    name: "operations_readiness",
    method: "GET",
    pathTemplate: "/v1/operations/readiness",
    auth: true,
    note: "PLATFORM-ADMIN readiness posture read-model.",
  },

  // ---- Core read surfaces (cursor / list reads) --------------------------
  {
    name: "evidence_list",
    method: "GET",
    pathTemplate: "/v1/evidence?limit=25",
    auth: true,
    note: "Evidence list (cursor pagination). Read-only.",
  },
  {
    name: "cases_list",
    method: "GET",
    pathTemplate: "/v1/cases?limit=25",
    auth: true,
    note: "Case list. Read-only.",
  },
  {
    name: "search_evidence",
    method: "GET",
    // PHASE 12 — the legacy /v1/search/evidence route was deleted; the unified
    // /v1/search endpoint requires a teamId scope.
    pathTemplate: "/v1/search?q=loadtest&teamId=:teamId",
    auth: true,
    note: "Unified search (query + workspace scope). Read-only.",
  },
  {
    name: "audit_events",
    method: "GET",
    pathTemplate: "/v1/orgs/:orgId/audit-events?limit=25",
    auth: true,
    needsOrg: true,
    note: "Org audit log. Read-only. Requires ORG_AUDITOR+.",
  },

  // ---- Reviewer ops (team-scoped reads) ----------------------------------
  {
    name: "reviewer_ops_queue",
    method: "GET",
    pathTemplate: "/v1/reviewer-ops/queue?teamId=:teamId&limit=25",
    auth: true,
    needsTeam: true,
    note: "Reviewer queue. Read-only.",
  },
  {
    name: "reviewer_ops_dashboard",
    method: "GET",
    pathTemplate: "/v1/reviewer-ops/dashboard?teamId=:teamId",
    auth: true,
    needsTeam: true,
    note: "Reviewer dashboard projection. Read-only.",
  },

  // ---- Bulk-invite DRY-RUN scenarios (create nothing) --------------------
  {
    name: "bulk_invite_validate",
    method: "POST",
    pathTemplate: "/v1/orgs/:orgId/invites/bulk/validate",
    auth: true,
    needsOrg: true,
    dryRun: true,
    headers: { "content-type": "application/json" },
    body: (cfg) => syntheticInviteBody(cfg?.bulkInviteRows),
    note: "DRY RUN. Validates synthetic invites; creates nothing.",
  },
  {
    name: "bulk_invite_csv_dryrun",
    method: "POST",
    pathTemplate: "/v1/orgs/:orgId/invites/csv?dryRun=1",
    auth: true,
    needsOrg: true,
    dryRun: true,
    headers: { "content-type": "application/json" },
    body: (cfg) => syntheticCsvBody(cfg?.bulkInviteRows),
    note: "DRY RUN (?dryRun=1). Parses synthetic CSV; creates nothing.",
  },

  // ---- Report / package status polling (route uncertain → configurable) --
  {
    name: "report_status_poll",
    method: "GET",
    // Uncertain exact path — override via endpointOverrides.report_status_poll.
    pathTemplate: "/v1/reports?limit=10",
    auth: true,
    configurable: true,
    note:
      "Report/package status polling. Exact route uncertain — set " +
      "endpointOverrides.report_status_poll in the JSON config to the real " +
      "polling path for your build.",
  },
];

export { syntheticInviteBody, syntheticCsvBody };
