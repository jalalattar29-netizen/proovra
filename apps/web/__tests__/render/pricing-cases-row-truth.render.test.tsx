/**
 * SECOND RE-AUDIT ENT-11 — the Pricing page's "Cases & matters" row, rendered
 * against a catalogue built from the real plan catalogue.
 *
 * The page sold "Personal cases" on PRO and "Team cases" on TEAM, while the
 * catalogue grants PRO and TEAM the same case capability (`casesIncluded`,
 * collaboration included) and the server opens case assignment on both, to a
 * member placed in an ACTIVE Collaboration Team. The row now states one
 * capability for both, derived here from the catalogue: if the catalogue ever
 * separates the two plans' case capability, this test fails and the copy must
 * follow it. FREE and evidence credits (no cases) are the positive control.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  EVIDENCE_CREDIT_PRODUCT,
  PLAN_CAPABILITIES,
  formatBytesHuman,
  planIncludesCollaboration,
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

async function renderLoaded() {
  render(<MarketingPricingPage />);
  // Prices come from the catalogue; wait until it has been applied.
  await screen.findAllByText(/\$19/);
}

describe("ENT-11 — Pricing sells the case capability the catalogue grants", () => {
  it("PRO and TEAM state the same case capability; no 'Personal' / 'Team' cases distinction", async () => {
    // The catalogue truth the row reports.
    expect(PLAN_CAPABILITIES.PRO.casesIncluded).toBe(true);
    expect(PLAN_CAPABILITIES.TEAM.casesIncluded).toBe(true);
    expect(planIncludesCollaboration("PRO")).toBe(true);
    expect(planIncludesCollaboration("TEAM")).toBe(true);

    await renderLoaded();
    const [free, credits, pro, team, enterprise] = rowCells("Cases & matters");
    expect(pro).toBe("Cases, assignable to Collaboration Team members");
    expect(team).toBe(pro);
    for (const cell of [pro, team]) {
      expect(cell).not.toMatch(/personal cases/i);
      expect(cell).not.toMatch(/team cases/i);
    }
    // Positive control: the plans without cases say so, from the same catalogue.
    expect(PLAN_CAPABILITIES.FREE.casesIncluded).toBe(false);
    expect(free).toBe("Not included");
    expect(credits).toBe("Not included");
    expect(enterprise).toBe("Organization-wide matters");
  });
});
