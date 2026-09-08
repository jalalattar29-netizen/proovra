/**
 * ADM-P3-010 — THE SUB-LINE OBEYS THE SAME CONTRACT AS THE VALUE ABOVE IT.
 *
 * =============================================================================
 * THE DEFECT
 * =============================================================================
 * `/admin/executive` states its own rule in its header: a figure it was not
 * given renders "Not measured", and it never estimates. `formatCount` returns
 * `null` for a null or NaN input and the tile VALUE honours that.
 *
 * Five supporting sub-lines then wrote `${formatCount(x) ?? 0}`, so the same
 * missing figure that made the value honest printed the character `0`
 * underneath it. On the Failed operations tile that reads
 *
 *     Failed operations
 *     Not measured
 *     0 hash-mismatch · 0 verification FAILED
 *
 * — a fabricated all-clear about evidence integrity, sitting directly beneath
 * an admission that nothing was measured.
 *
 * =============================================================================
 * WHY A RENDER TEST AND NOT A SOURCE GREP
 * =============================================================================
 * The branch is LATENT: `executive.service.ts` types these fields as
 * non-nullable `number`, so no current response reaches it. What reaches it is
 * a field ABSENT from the payload — a web/API deployment skew, which is
 * precisely the condition under which an operator is most likely to be reading
 * this page and least able to check it another way.
 *
 * A grep for `?? 0` would pass the day someone writes `?? "0"`. This mounts the
 * real page against a payload with the fields missing and reads what an
 * operator would see.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

let executiveReply: () => unknown = () => ({});

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    if (path.startsWith("/v1/admin/executive")) return executiveReply();
    throw new Error(`unexpected fetch ${path}`);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  setApiToken: () => {},
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/admin/executive",
  useParams: () => ({}),
}));

vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ToastProvider } from "../../components/ui";
import AdminExecutivePage from "../../app/(app)/admin/executive/page";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A response in the service's real shape, with every figure present.
 *
 * COMPLETE on purpose. Without a control case that renders real numbers, "no
 * fabricated zero on screen" would also pass against a page that rendered
 * nothing at all — which is the failure this file is about, one level up.
 */
function fullPayload() {
  const period = (thisMonth: number, lastMonth: number) => ({
    thisMonth,
    lastMonth,
  });
  const notMeasured = (why: string) => ({ value: null, notMeasured: why });
  const money = (currency: string, amountCents: number, payments: number) => ({
    currency,
    amountCents,
    payments,
  });
  return {
    generatedAtUtc: "2026-09-08T10:00:00.000Z",
    revenue: {
      allTimeByCurrency: [money("EUR", 100_000, 41)],
      thisMonthByCurrency: [money("EUR", 10_000, 4)],
      lastMonthByCurrency: [money("EUR", 8_000, 3)],
      successfulPaymentsAllTime: 41,
      growthRatePct: notMeasured("no prior period"),
    },
    mrrCents: notMeasured("no subscription projection"),
    arrCents: notMeasured("no subscription projection"),
    renewalRiskCents: notMeasured("no renewal model"),
    customers: {
      activeCustomers: 9,
      activeBillingWorkspaces: 7,
      enterpriseContracts: 2,
    },
    leads: {
      demoRequestsByStatus: { NEW: 3 },
      demoRequestsTotal: 3,
      contactSalesByStatus: { NEW: 5 },
      contactSalesTotal: 5,
    },
    usage: {
      evidence: period(12, 8),
      reports: period(4, 2),
      packages: period(1, 0),
    },
    topCustomers: [],
    atRisk: { rule: "PAST_DUE billing", items: [], limit: 5 },
    failedOperations: {
      evidenceHashMismatch: 2,
      evidenceVerificationFailed: 6,
      reportGenerationFailures: notMeasured("no report failure probe"),
    },
  };
}

/**
 * The same response with named FIELDS removed, as a deployment skew produces.
 *
 * FIELDS, not whole sections. `data?.revenue.allTimeByCurrency[0]` reads an
 * array element without a guard, so a response missing that array throws
 * during render rather than reaching any of the sub-lines this file is about.
 * That is a real robustness gap and it is NOT ADM-P3-010 — the finding is
 * about what a sub-line prints when it has no number, and blanking a whole
 * section would test the crash instead. Recorded here so the next reader does
 * not mistake the narrower fixture for carelessness.
 */
function payloadWithout(path: string): Record<string, unknown> {
  const root = fullPayload() as Record<string, unknown>;
  const parts = path.split(".");
  let node = root as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    node = node[part] as Record<string, unknown>;
  }
  delete node[parts[parts.length - 1]!];
  return root;
}

async function mountExecutive() {
  cleanup();
  const utils = render(
    <ToastProvider>
      <AdminExecutivePage />
    </ToastProvider>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

const DASH = "—";

afterEach(cleanup);

describe("executive sub-lines never invent a zero (ADM-P3-010)", () => {
  beforeEach(() => {
    executiveReply = () => fullPayload();
  });

  it("renders the real figures when it has them", async () => {
    // The control. Without it, every "no fabricated zero" assertion below
    // would also pass against a page that rendered nothing at all.
    await mountExecutive();
    const tile = screen.getByTestId("admin-executive-failed-ops");
    expect(tile.textContent).toContain("2 hash-mismatch");
    expect(tile.textContent).toContain("6 verification FAILED");
    expect(
      screen.getByTestId("admin-executive-revenue-all-time").textContent,
    ).toContain("41 successful payments");
  });

  // ==========================================================================
  // The instances a skew can actually reach.
  //
  // A tile whose VALUE is unmeasured never renders its `sub` at all — the
  // renderer substitutes the not-measured reason. So the fabricated zero can
  // only appear where the sub-line reads a DIFFERENT field from the value
  // above it, and those are the three below. (The audit named the Failed
  // operations tile as the worst instance; it is asserted separately, and it
  // turns out to be unreachable for that reason. The `?? 0` was still wrong,
  // and would have become visible the moment the renderer changed.)
  // ==========================================================================

  it("shows an em dash for a payments count the response did not carry", async () => {
    executiveReply = () => payloadWithout("revenue.successfulPaymentsAllTime");
    await mountExecutive();
    const tile = screen.getByTestId("admin-executive-revenue-all-time");
    expect(tile.textContent).toContain(`${DASH} successful payments`);
    expect(
      tile.textContent,
      "an unmeasured payment count rendered as a literal zero",
    ).not.toContain("0 successful payments");
  });

  it("shows an em dash for an absent billing-workspace count", async () => {
    executiveReply = () => payloadWithout("customers.activeBillingWorkspaces");
    await mountExecutive();
    const tile = screen.getByTestId("admin-executive-active-customers");
    expect(tile.textContent).toContain(`${DASH} live workspaces billing ACTIVE`);
    expect(tile.textContent).not.toContain("0 live workspaces");
  });

  it("shows an em dash on the half of a month-over-month line that is missing", async () => {
    // The partial case, which is the realistic one: a skew drops a field, not
    // a whole object, so this tile keeps a measured value and a half-known
    // sub-line. "12 this month · 0 last month" states a fall to zero that
    // nothing measured.
    executiveReply = () => payloadWithout("usage.evidence.lastMonth");
    await mountExecutive();
    const tile = screen.getByTestId("admin-executive-usage-evidence");
    expect(tile.textContent).toContain("12 this month");
    expect(tile.textContent).toContain(`${DASH} last month`);
    expect(tile.textContent).not.toContain("0 last month");
  });

  // ==========================================================================
  // The instances the renderer already protects — asserted so the protection
  // is a fact of the suite rather than a thing someone once noticed.
  // ==========================================================================

  it("a summed tile goes to Not measured rather than printing a fabricated all-clear", async () => {
    // "0 hash-mismatch · 0 verification FAILED" would be an all-clear about
    // evidence integrity that nothing measured. It cannot appear, because the
    // tile's VALUE is the sum of the same two fields — one absent addend makes
    // the sum unmeasured and the renderer drops the sub-line entirely. Pinned
    // here so a future change to either the tile or the renderer has to face
    // it.
    for (const field of [
      "failedOperations.evidenceHashMismatch",
      "failedOperations.evidenceVerificationFailed",
    ]) {
      executiveReply = () => payloadWithout(field);
      await mountExecutive();
      const tile = screen.getByTestId("admin-executive-failed-ops");
      expect(tile.textContent).toContain("Not measured");
      expect(
        tile.textContent,
        `${field}: the integrity tile printed a zero it did not measure`,
      ).not.toMatch(/0 hash-mismatch|0 verification FAILED/);
    }
  });

  it("the same holds for the Leads tile, whose value is also a sum", async () => {
    executiveReply = () => payloadWithout("leads.demoRequestsTotal");
    await mountExecutive();
    const tile = screen.getByTestId("admin-executive-leads");
    expect(tile.textContent).toContain("Not measured");
    expect(tile.textContent).not.toMatch(/0 demo|0 contact-sales/);
  });

  // ==========================================================================
  // The distinction the finding is about.
  // ==========================================================================

  it("still prints a MEASURED zero as a zero", async () => {
    // Zero is a fact when it was measured, and this page must not start
    // hedging real zeroes — that would trade one dishonest reading for
    // another.
    const p = fullPayload();
    p.failedOperations = {
      evidenceHashMismatch: 0,
      evidenceVerificationFailed: 0,
      reportGenerationFailures: { value: null, notMeasured: "no probe" },
    };
    executiveReply = () => p;
    await mountExecutive();
    const tile = screen.getByTestId("admin-executive-failed-ops");
    expect(tile.textContent).toContain("0 hash-mismatch");
    expect(tile.textContent).toContain("0 verification FAILED");
    expect(tile.textContent).not.toContain(`${DASH} hash-mismatch`);
  });
});
