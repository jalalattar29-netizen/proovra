/**
 * THE WORKSPACE / CAPABILITY REQUEST-COUNT MATRIX.
 *
 * Every context the product supports, measured against the REAL route and the
 * REAL shell, counting requests PER SOURCE rather than in aggregate.
 *
 * ---------------------------------------------------------------------------
 * WHY PER SOURCE, AND WHY MUTATIONS ARE SEPARATE
 * ---------------------------------------------------------------------------
 * "The refused workspace made no calls" and "no calls except the saved-view
 * read" look identical in a total. The second is a boundary an earlier pass
 * closed being quietly reopened by a new surface, and only a per-source count
 * can see it.
 *
 * Mutation columns are measured on a SEPARATE pass with nothing clicked, so
 * they must be zero on page load for every context including the fully
 * authorized ones. A mutation count that is non-zero before anybody pressed
 * anything is a surface acting on its own.
 *
 * The AUTHORITY column is classified apart from Operations data. Resolving
 * whether a caller may enter is not an Operations read, and folding it in
 * would make every row look like a leak while hiding the real ones.
 *
 * The table this produces IS the deliverable. A test that merely passed would
 * establish that today's numbers are acceptable without saying what they are.
 */

import { expect, test, type Page } from "@playwright/test";

import { openOperations, type OpsContext, type OpsScenario } from "./_fixtures";

/** The fourteen sources, in the order the report prints them. */
const SOURCES = [
  "authority",
  "incidents",
  "summary",
  "detail",
  "slaPolicy",
  "savedViews",
  "operators",
  "remediationRead",
  "remediationWrite",
  "bulkWrite",
  "escalations",
  "shellPoll",
  "platform",
  "ai",
] as const;

type Source = (typeof SOURCES)[number];
type Counts = Record<Source, number>;

/**
 * One request -> one source.
 *
 * The shell's own incident poll is separated from the ROUTE's list read by the
 * presence of a `sort` parameter, which the workbench always sends and the
 * poller never does.
 * Without that split one assertion could not say "the route asked" and another
 * "the shell asked", and the shell's pre-existing behaviour would be blamed on
 * this route.
 */
function classify(url: URL, method: string): Source | null {
  const path = url.pathname;

  if (path.endsWith("/v1/platform/context")) return "authority";
  if (
    path.endsWith("/v1/ops/health") ||
    path.endsWith("/v1/ops/metrics") ||
    path.endsWith("/v1/ops/alerts") ||
    path.includes("/admin/platform/")
  ) {
    return "platform";
  }
  if (/\/v1\/(ai|copilot|intelligence)\b/.test(path)) return "ai";
  if (path.includes("/v1/reviewer-ops/escalations")) return "escalations";
  if (!path.includes("/v1/ops/")) return null;

  if (path.endsWith("/v1/ops/summary")) return "summary";
  if (path.includes("/remediate")) {
    return method === "GET" ? "remediationRead" : "remediationWrite";
  }
  if (path.endsWith("/v1/ops/bulk-actions")) return "bulkWrite";
  if (path.includes("/v1/ops/saved-views")) return "savedViews";
  if (path.endsWith("/v1/ops/assignable-operators")) return "operators";
  if (path.includes("/sla-policy") || path.includes("/governance/policy")) {
    return "slaPolicy";
  }
  if (/\/v1\/ops\/incidents\/[^/]+$/.test(path)) {
    // The detail read carries the remediation projection with it — one round
    // trip, so it is counted once and named for what it is.
    return "detail";
  }
  if (path.endsWith("/v1/ops/incidents")) {
    // The SHELL polls `teamId&status=OPEN&limit=50` and never sends a sort.
    // The ROUTE always sends one (`incidentsQuery` sets it unconditionally).
    // `status` and `limit` no longer discriminate — the workbench default
    // view sends the same pair — so keying on them would silently attribute
    // every route read to the shell and understate this route to zero.
    return url.searchParams.has("sort") ? "incidents" : "shellPoll";
  }
  return null;
}

async function measure(
  page: Page,
  context: OpsContext,
  scenario?: OpsScenario,
): Promise<Counts> {
  const counts = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Counts;
  page.on("request", (r) => {
    const source = classify(new URL(r.url()), r.method());
    if (source) counts[source] += 1;
  });
  await openOperations(page, context, scenario ? { scenario } : {});
  // Long enough for a timer-driven poll to fire and for route effects to
  // settle. A boundary that holds for 50ms and leaks at 500ms is not one.
  await page.waitForTimeout(1500);
  return counts;
}

type Row = {
  label: string;
  context: OpsContext;
  scenario?: OpsScenario;
  /** The route gate declines: zero of everything the ROUTE owns. */
  refused: boolean;
  /** No operator to assign to, so the picker must not be fetched. */
  soloOperator?: boolean;
  /** May read, may not write. */
  readOnly?: boolean;
};

const MATRIX: ReadonlyArray<Row> = [
  { label: "1 Personal Free", context: "personal-free", refused: true },
  { label: "2 Personal Pro owner", context: "personal-pro", refused: false, soloOperator: true },
  { label: "3 Paid owned multi-member", context: "owned-workspace", refused: false },
  { label: "4 Team viewer", context: "viewer", refused: false, readOnly: true },
  { label: "5 Team member/operator", context: "team-admin", refused: false },
  { label: "6 Team admin", context: "team-admin", refused: false },
  { label: "7 Organization admin", context: "organization-admin", refused: false },
  { label: "8 Enterprise active", context: "enterprise-active", refused: false },
  { label: "9 Enterprise expired, retained", context: "enterprise-retained", refused: false },
  { label: "10 Platform admin, no membership", context: "platform-admin-no-membership", refused: true },
  { label: "11 Platform admin, with membership", context: "platform-admin-member", refused: false },
  { label: "12 Missing capability envelope", context: "missing-envelope", refused: true },
  { label: "13 Capability withheld", context: "withheld-capability", refused: true },
  { label: "14 Wrong workspace context", context: "wrong-workspace", refused: true },
  { label: "15 Inactive workspace", context: "inactive-workspace", refused: false },
  { label: "16 Suspended workspace", context: "suspended-workspace", refused: true },
  { label: "17 Insufficient role", context: "insufficient-role", refused: false, readOnly: true },
  { label: "18 Provider unavailable", context: "team-admin", scenario: "unavailable-incidents", refused: false },
  { label: "19 Queue unavailable", context: "team-admin", scenario: "queue-unavailable", refused: false },
  { label: "20 Degraded source", context: "team-admin", scenario: "degraded-summary", refused: false },
  { label: "21 Truncated source", context: "team-admin", scenario: "truncated", refused: false },
  { label: "22 No incidents", context: "team-admin", scenario: "clear-empty", refused: false },
  { label: "23 Source refusal 403", context: "team-admin", scenario: "source-403", refused: false },
  { label: "24 Source refusal 404", context: "team-admin", scenario: "source-404", refused: false },
];

/** Everything the ROUTE owns. The shell's own poll is asserted separately. */
const ROUTE_OWNED: ReadonlyArray<Source> = [
  "incidents",
  "summary",
  "detail",
  "slaPolicy",
  "savedViews",
  "operators",
  "remediationRead",
  "remediationWrite",
  "bulkWrite",
];

const MUTATIONS: ReadonlyArray<Source> = [
  "remediationWrite",
  "bulkWrite",
];

const measured: Array<{ label: string; counts: Counts }> = [];

for (const row of MATRIX) {
  test(`request counts — ${row.label}`, async ({ page }) => {
    const counts = await measure(page, row.context, row.scenario);
    measured.push({ label: row.label, counts });

    // NEVER, in any context: a tenant page reading platform runtime, or any
    // Operations-Intelligence/AI endpoint. The AI panel was removed; this is
    // what keeps it removed.
    expect(counts.platform, `${row.label}: platform runtime`).toBe(0);
    expect(counts.ai, `${row.label}: AI endpoint`).toBe(0);

    // NOTHING is mutated by loading a page, however authorized the caller.
    for (const m of MUTATIONS) {
      expect(counts[m], `${row.label}: ${m} on page load`).toBe(0);
    }

    if (row.refused) {
      for (const source of ROUTE_OWNED) {
        expect(counts[source], `${row.label}: ${source}`).toBe(0);
      }
      // The shell must not read on this context's behalf either.
      expect(counts.shellPoll, `${row.label}: shell poll`).toBe(0);
    }

    if (row.soloOperator) {
      // A picker over an empty set is a control that cannot succeed.
      expect(counts.operators, `${row.label}: assignee list`).toBe(0);
    }

    if (row.readOnly) {
      for (const m of MUTATIONS) {
        expect(counts[m], `${row.label}: ${m}`).toBe(0);
      }
    }

    // A refused SOURCE must LATCH OFF rather than retry forever. One request
    // is the attempt; anything beyond it is a storm the operator cannot see.
    if (row.scenario === "source-403" || row.scenario === "source-404") {
      expect(
        counts.incidents,
        `${row.label}: a refused source must not be retried`,
      ).toBeLessThanOrEqual(1);
    }
  });
}

test("print the matrix", async () => {
  const lines = [
    `| context | ${SOURCES.join(" | ")} |`,
    `|${new Array(SOURCES.length + 1).fill("---").join("|")}|`,
    ...measured.map(
      (m) => `| ${m.label} | ${SOURCES.map((s) => m.counts[s]).join(" | ")} |`,
    ),
  ];
  // eslint-disable-next-line no-console
  console.log(
    "\n===== OPERATIONS REQUEST-COUNT MATRIX =====\n" + lines.join("\n") + "\n",
  );
  expect(measured.length).toBe(MATRIX.length);
});

// ===========================================================================
// AUTHORIZED MUTATIONS — measured on their own, after a deliberate action
// ===========================================================================

test("an authorized remediation issues EXACTLY one mutation", async ({ page }) => {
  const counts = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Counts;
  page.on("request", (r) => {
    const source = classify(new URL(r.url()), r.method());
    if (source) counts[source] += 1;
  });
  await openOperations(page, "team-admin");
  await page.locator("[data-ops-open]").first().click();
  await page.locator("[data-ops-remediate]").first().click();
  await page
    .locator('[data-confirm-action-modal="ops-remediate-confirm"] button')
    .last()
    .click();
  await page.waitForTimeout(800);

  // Exactly one. A double-fire would spend real work twice, and the operator
  // asked for it once.
  expect(counts.remediationWrite).toBe(1);
  expect(counts.bulkWrite).toBe(0);
});

test("a queue outage is reported truthfully and never as completion", async ({
  page,
}) => {
  await openOperations(page, "team-admin", { scenario: "queue-unavailable" });
  await page.locator("[data-ops-open]").first().click();
  await page.locator("[data-ops-remediate]").first().click();
  await page
    .locator('[data-confirm-action-modal="ops-remediate-confirm"] button')
    .last()
    .click();

  const panel = page.locator("[data-ops-remediation]");
  await expect(panel).toBeVisible();
  const text = await panel.innerText();
  // The operator is told the work is recorded but unscheduled. "Done",
  // "Completed" or "Fixed" over a dead queue is the single most damaging
  // sentence this surface could produce.
  for (const forbidden of ["Completed", "Done", "Fixed", "Resolved"]) {
    expect(text, `a queue outage must not report ${forbidden}`).not.toContain(
      forbidden,
    );
  }
});
