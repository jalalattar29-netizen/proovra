/**
 * PRICING PAGE TRUTH — rendered, against a catalogue response built from the
 * real plan catalogue (`@proovra/shared-billing`).
 *
 *   ENT-06     the FREE "AI assistance" comparison cell states the catalogue's
 *              FREE allowance (it once said "Not included" while the catalogue
 *              granted 10 operations a month);
 *   ENT-07     the evidence-credit card tells a credit buyer how storage works:
 *              a Free allowance, raised by paid monthly storage add-ons, and
 *              the comparison row agrees with the server's storage policy;
 *   defect 15  the Team card advertises only what TEAM's capabilities sell —
 *              review queues and review assignments — and no "governance",
 *              which is an Enterprise-only entitlement.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  EVIDENCE_CREDIT_PRODUCT,
  PLAN_CAPABILITIES,
  formatBytesHuman,
  resolveStorageAddonEntitlement,
} from "@proovra/shared-billing";

function plan(p: "FREE" | "PRO" | "TEAM", monthlyPriceCents: number) {
  const c = PLAN_CAPABILITIES[p];
  return {
    plan: p,
    displayName: c.displayName,
    monthlyPriceCents,
    storageBytes: c.includedStorageBytes.toString(),
    storageLabel: formatBytesHuman(c.includedStorageBytes),
    maxEvidenceRecords: c.maxEvidenceRecords,
    maxEvidenceRecordsPerMonth: c.maxEvidenceRecordsPerMonth,
    aiAdvisoryMonthlyOperations: c.aiAdvisoryMonthlyOperations,
    maxCollaborationTeamsPerWorkspace: c.maxCollaborationTeamsPerWorkspace,
    maxAcceptedMembersPerCollaborationTeam: c.maxAcceptedMembersPerCollaborationTeam,
    maxAdditionalWorkspaceMembers: c.maxAdditionalWorkspaceMembers,
  };
}

const CATALOGUE = {
  currency: "USD",
  free: plan("FREE", 0),
  pro: plan("PRO", 1900),
  team: plan("TEAM", 7900),
  payg: {
    productKey: "EVIDENCE_CREDIT",
    displayName: EVIDENCE_CREDIT_PRODUCT.displayName,
    pricingModel: "PER_CREDIT",
    unitPriceCents: EVIDENCE_CREDIT_PRODUCT.unitPriceCents,
    creditsGrantedPerPurchase: EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase,
    creditsRequiredPerCompletion: EVIDENCE_CREDIT_PRODUCT.creditsPerCompletion,
    creditsExpire: false,
    plan: "FREE",
    requiresSubscription: false,
    perFundedRecord: { reportIncluded: true, verificationPackageIncluded: true, publicVerifyIncluded: true },
    storageBytes: PLAN_CAPABILITIES.FREE.includedStorageBytes.toString(),
    storageLabel: formatBytesHuman(PLAN_CAPABILITIES.FREE.includedStorageBytes),
    aiAdvisoryMonthlyOperations: PLAN_CAPABILITIES.FREE.aiAdvisoryMonthlyOperations,
    intakeIncluded: true,
    casesIncluded: false,
    storageAddonsPurchasable: true,
  },
};

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    statusCode = 500;
  }
  return {
    apiFetch: async (path: string) => {
      if (path.startsWith("/v1/billing/pricing")) return CATALOGUE;
      return {};
    },
    readApiToken: () => null,
    apiBaseUrl: () => "https://api.test.invalid",
    ApiError,
  };
});
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../app/providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ hasSession: false }),
}));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));
vi.mock("../../components/marketing/EnterpriseFooter", () => ({ EnterpriseFooter: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/pricing",
}));

import MarketingPricingPage from "../../app/pricing/page";

afterEach(() => {
  cleanup();
});

/** The comparison row's five plan cells: Free, Credits, Pro, Team, Enterprise. */
function rowCells(label: string): string[] {
  const head = screen
    .getAllByRole("cell")
    .find((c) => c.textContent?.trim() === label);
  if (!head) throw new Error(`comparison row "${label}" not rendered`);
  const tr = head.closest("tr")!;
  return within(tr)
    .getAllByRole("cell")
    .slice(1)
    .map((c) => c.textContent?.trim() ?? "");
}

/** The feature list of one plan card. */
function cardFeatures(planId: string): string[] {
  const card = document.getElementById(`plan-${planId}`);
  if (!card) throw new Error(`plan card ${planId} not rendered`);
  return within(card)
    .getAllByRole("listitem")
    .map((li) => li.textContent?.trim() ?? "");
}

async function renderLoaded() {
  render(<MarketingPricingPage />);
  // Prices come from the catalogue; wait until it has been applied.
  await screen.findAllByText(/\$19/);
}

describe("Pricing page — rendered claims match the catalogue", () => {
  it("ENT-06: the FREE AI cell states the catalogue's FREE allowance", async () => {
    await renderLoaded();
    const freeOps = PLAN_CAPABILITIES.FREE.aiAdvisoryMonthlyOperations;
    expect(freeOps).toBeGreaterThan(0);
    const [free, credits, pro, team] = rowCells("AI assistance (advisory)");
    expect(free).toBe(`${freeOps} ops / month`);
    expect(credits).toBe(`${freeOps} ops / month (Free account)`);
    expect(pro).toBe(`${PLAN_CAPABILITIES.PRO.aiAdvisoryMonthlyOperations} ops / month`);
    expect(team).toBe(`${PLAN_CAPABILITIES.TEAM.aiAdvisoryMonthlyOperations} ops / month`);
  });

  it("ENT-07: a credit buyer is told their storage is Free's, raised by monthly add-ons — as the server allows", async () => {
    await renderLoaded();
    expect(resolveStorageAddonEntitlement({ plan: "FREE" }).storageAddonsPurchasable).toBe(true);
    expect(cardFeatures("payg")).toContain(
      "Free storage allowance, with paid monthly storage add-ons when you need more",
    );
    const [, creditsStorage] = rowCells("Storage included");
    expect(creditsStorage).toBe(`${formatBytesHuman(PLAN_CAPABILITIES.FREE.includedStorageBytes)} (Free account)`);
    const [freeAddons, creditAddons] = rowCells("Storage add-ons");
    expect(freeAddons).toBe("Monthly, from +10 GB");
    expect(creditAddons).toBe("Monthly, from +10 GB");
  });

  it("defect 15: the Team card advertises TEAM's real capabilities, and no governance", async () => {
    await renderLoaded();
    // The catalogue flags that distinguish TEAM from PRO.
    expect(PLAN_CAPABILITIES.TEAM.reviewQueuesIncluded).toBe(true);
    expect(PLAN_CAPABILITIES.PRO.reviewQueuesIncluded).toBe(false);
    expect(PLAN_CAPABILITIES.TEAM.reviewerOperationsIncluded).toBe(true);
    expect(PLAN_CAPABILITIES.PRO.reviewerOperationsIncluded).toBe(false);
    // Governance is Enterprise-only in the catalogue.
    expect(Object.values(PLAN_CAPABILITIES.TEAM.enterpriseFeatures).some(Boolean)).toBe(false);

    const team = cardFeatures("team");
    expect(team).toContain(
      "Collaboration Teams, review queues and review assignments — on the workspace you already use",
    );
    for (const line of team) expect(line).not.toMatch(/governance/i);
    expect(rowCells("Governance controls")[3]).toBe("Not included");
  });
});
