/**
 * THE WORKSPACE / CAPABILITY REQUEST-COUNT MATRIX.
 *
 * Every context in the product, measured against the REAL route and the REAL
 * shell, counting requests PER SOURCE rather than in aggregate.
 *
 * Why per source: "the refused workspace made no calls" and "the refused
 * workspace made no calls except the saved-view read" look identical in a
 * total. The second is a hole — a new surface that quietly reopened a boundary
 * an earlier pass closed — and only a per-source count can see it.
 *
 * The table this produces is the deliverable. A test that merely passed would
 * establish that today's numbers are acceptable without saying what they are.
 */

import { expect, test, type Page } from "@playwright/test";

import { openOperations, type OpsContext } from "./_fixtures";

/** The sources a request can belong to, in the order the report prints them. */
const SOURCES = [
  "summary",
  "incidents",
  "detail",
  "saved-views",
  "remediation",
  "bulk",
  "operators",
  "escalations",
  "other-ops",
  "platform",
] as const;

type Source = (typeof SOURCES)[number];
type Counts = Record<Source, number>;

function classify(pathname: string, method: string): Source | null {
  // PLATFORM RUNTIME, which a tenant page must never read. Deliberately NOT
  // `/v1/platform/context`: that is the authority envelope every
  // authenticated page resolves, and counting it here would make every row
  // look like a boundary violation while hiding the real one.
  if (
    pathname.endsWith("/v1/ops/health") ||
    pathname.endsWith("/v1/ops/metrics") ||
    pathname.endsWith("/v1/ops/alerts")
  ) {
    return "platform";
  }
  if (pathname.includes("/v1/reviewer-ops/escalations")) return "escalations";
  if (!pathname.includes("/v1/ops/")) return null;

  if (pathname.endsWith("/v1/ops/summary")) return "summary";
  if (pathname.includes("/remediate")) return "remediation";
  if (pathname.endsWith("/v1/ops/bulk-actions")) return "bulk";
  if (pathname.includes("/v1/ops/saved-views")) return "saved-views";
  if (pathname.endsWith("/v1/ops/assignable-operators")) return "operators";
  // A detail read has an id segment; the list does not.
  if (/\/v1\/ops\/incidents\/[^/]+$/.test(pathname)) return "detail";
  if (pathname.endsWith("/v1/ops/incidents")) return "incidents";
  return method === "GET" ? "other-ops" : "other-ops";
}

async function measure(page: Page, context: OpsContext): Promise<Counts> {
  const counts = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Counts;
  page.on("request", (r) => {
    const u = new URL(r.url());
    const source = classify(u.pathname, r.method());
    if (source) counts[source] += 1;
  });
  await openOperations(page, context);
  // Long enough for the shell's own 45s poller to have had a chance on its
  // first tick, and for any route-level effect to settle. A boundary that
  // holds for 50ms and leaks at 500ms is not a boundary.
  await page.waitForTimeout(1500);
  return counts;
}

/**
 * Every context the brief enumerates, with what each one is FOR.
 *
 * `refused` means the route gate declined: those must issue zero of
 * everything the ROUTE owns. The shell's own incident poller is recorded
 * separately and asserted in `operations-shell-boundary.spec.ts`.
 */
const MATRIX: ReadonlyArray<{
  context: OpsContext;
  label: string;
  refused: boolean;
}> = [
  { context: "personal-free", label: "Personal Free", refused: true },
  { context: "personal-pro", label: "Personal Pro owner", refused: false },
  { context: "owned-workspace", label: "Paid owned multi-member", refused: false },
  { context: "viewer", label: "Team viewer", refused: false },
  { context: "insufficient-role", label: "Insufficient role", refused: false },
  { context: "team-admin", label: "Team admin", refused: false },
  { context: "organization-admin", label: "Organization admin", refused: false },
  { context: "enterprise-active", label: "Enterprise active", refused: false },
  {
    context: "enterprise-retained",
    label: "Enterprise expired, retained obligations",
    refused: false,
  },
  {
    context: "platform-admin-no-membership",
    label: "Platform admin without membership",
    refused: true,
  },
  {
    context: "platform-admin-member",
    label: "Platform admin with membership",
    refused: false,
  },
  { context: "missing-envelope", label: "Missing capability envelope", refused: true },
  { context: "withheld-capability", label: "Capability withheld", refused: true },
  { context: "wrong-workspace", label: "Wrong workspace context", refused: true },
  { context: "inactive-workspace", label: "Inactive workspace", refused: false },
  { context: "suspended-workspace", label: "Suspended workspace", refused: true },
];

const measured: Array<{ label: string; counts: Counts; refused: boolean }> = [];

for (const row of MATRIX) {
  test(`request counts — ${row.label}`, async ({ page }) => {
    const counts = await measure(page, row.context);
    measured.push({ label: row.label, counts, refused: row.refused });

    // A tenant page NEVER reads platform runtime, in any context.
    expect(counts.platform, `${row.label}: platform runtime`).toBe(0);

    if (row.refused) {
      // Zero of everything the ROUTE owns. `incidents` is excluded and
      // asserted separately because the app SHELL polls it on every
      // authenticated page — folding it in would either hide that finding or
      // blame this route for a read it does not make.
      for (const source of [
        "summary",
        "detail",
        "saved-views",
        "remediation",
        "bulk",
        "operators",
        "other-ops",
      ] as const) {
        expect(counts[source], `${row.label}: ${source}`).toBe(0);
      }
    }

    // A READER never issues a mutation, whatever else it reads.
    if (row.context === "viewer" || row.context === "insufficient-role") {
      expect(counts.remediation, `${row.label}: remediation`).toBe(0);
      expect(counts.bulk, `${row.label}: bulk`).toBe(0);
    }

    // A sole operator is never asked who to assign to: there is nobody.
    if (row.context === "personal-pro") {
      expect(counts.operators, "Personal Pro must not enumerate operators").toBe(0);
    }
  });
}

test("print the matrix", async () => {
  const header = ["context", ...SOURCES].join(" | ");
  const lines = [
    `| ${header} |`,
    `|${new Array(SOURCES.length + 1).fill("---").join("|")}|`,
    ...measured.map(
      (m) => `| ${m.label} | ${SOURCES.map((s) => m.counts[s]).join(" | ")} |`,
    ),
  ];
  // eslint-disable-next-line no-console
  console.log("\n===== OPERATIONS REQUEST-COUNT MATRIX =====\n" + lines.join("\n") + "\n");
  expect(measured.length).toBe(MATRIX.length);
});
