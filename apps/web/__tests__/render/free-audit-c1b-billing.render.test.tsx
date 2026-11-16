/**
 * Free-user audit 0ea0 — WEB-C1B-BILLING-AI-UI, web Billing.
 *
 *   B6-F-60  the stuck-cancellation "Contact support" reaches /support (new tab), not /settings/support
 *   B6-F-61  an ending storage add-on says "Ends <date> — not renewing" and offers no Cancel
 *   B6-F-62  a managed payer holding BILLING_CANCEL is offered add-on Cancel
 *   B6-F-66  Free's storage panel says the first issued outputs do not count
 *   B6-F-67  PayPal cancel copy says "immediately"; "no subscription found" promises nothing
 *   B6-F-68  admission copy names storage when it is full, and offers Add storage beside Buy credits
 *   B6-F-69  an organization-active session opens Billing on the organization; ?workspace=personal still wins
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: vi.fn() }));

let search = "";
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/billing",
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
let activeOrganizationId: string | null = null;
vi.mock("../../lib/platform-context", () => {
  const stamp = () => 0;
  const isStale = () => false;
  return {
    useTenantGuard: () => ({ stamp, isStale }),
    useActiveCustomerOrganizationId: () => activeOrganizationId,
  };
});

import BillingPage from "../../app/(app)/billing/page";
import { ActionRequiredBanner } from "../../app/(app)/billing/_sections/PlanAndUsage";
import { StorageAddonsSection } from "../../app/(app)/billing/_sections/StorageAndHistory";
import { ManagePlanDrawer } from "../../app/(app)/billing/_sections/ManagePlanDrawer";
import { EvidenceDetailCard } from "../../app/(app)/billing/_sections/BillingOverview";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { ToastProvider } from "../../components/ui-legacy";
import type { ActiveStorageAddon, BillingAccountProjection } from "../../lib/api/billing-accounts";

const noop = () => {};
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);

function addon(over: Partial<ActiveStorageAddon> = {}): ActiveStorageAddon {
  return {
    id: "addon-1",
    addonKey: "PERSONAL_50_GB",
    label: "+50 GB",
    storageLabel: "50 GB",
    status: "ACTIVE",
    billingCycle: "MONTHLY",
    legacyOneTime: false,
    endsWithPlan: false,
    canCancel: true,
    canRecheck: false,
    canAbandon: false,
    attemptReference: "a",
    paymentProvider: "STRIPE",
    providerReference: null,
    createdAtUtc: "2026-10-01T00:00:00.000Z",
    activatedAtUtc: "2026-10-01T00:00:00.000Z",
    currentPeriodEndUtc: "2026-12-01T12:00:00.000Z",
    priceCents: 900,
    currency: "USD",
    ...over,
  };
}

function projection(over: Partial<BillingAccountProjection> = {}): BillingAccountProjection {
  return {
    account: {
      type: "PERSONAL",
      id: "user-1",
      displayName: "Jamie",
      capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_HISTORY_VIEW", "BILLING_MANAGE", "BILLING_CANCEL", "BILLING_ADDON_PURCHASE"],
      billingOwnerMissing: false,
    },
    plan: {
      planKey: "FREE",
      accessKind: "FREE",
      displayName: "Free",
      model: "FREE",
      lifecycle: "INACTIVE",
      currency: "USD",
      currentPeriodEndUtc: null,
      cancelAtPeriodEnd: false,
      billingOwnerMissing: false,
    },
    usage: {
      evidence: { state: "MEASURED", used: 3, limit: 3, window: "LIFETIME" },
      storage: {
        state: "MEASURED",
        usedBytes: "262144000",
        usedLabel: "250 MB",
        limitBytes: "262144000",
        limitLabel: "250 MB",
        baseBytes: "262144000",
        baseLabel: "250 MB",
        recurringAddonBytes: "0",
        recurringAddonLabel: "0 B",
        legacyAddonBytes: "0",
        legacyAddonLabel: "0 B",
        usagePercent: 100,
        nearLimit: true,
        limitReached: false,
      },
      ai: { state: "NOT_INCLUDED" },
    },
    planOffers: [],
    actionRequired: null,
    storageAddons: { offers: [], active: [] },
    actions: {
      canStartCheckout: true,
      planManagement: { label: "Choose a plan", mode: "CHOOSE", enabled: true },
      canBuyEvidenceCredits: true,
      canBuyStorageAddon: true,
      canRequestCancellation: false,
      contactAccountManager: false,
      manageLabel: null,
    },
    ...over,
  } as unknown as BillingAccountProjection;
}

beforeEach(() => {
  apiFetch.mockReset();
  router.replace.mockReset();
  search = "";
  activeOrganizationId = null;
});

describe("B6-F-60: Contact support reaches the real support route", () => {
  it("is a new-tab link to /support, never /settings/support", () => {
    render(
      <ActionRequiredBanner
        projection={projection({
          actionRequired: { severity: "CRITICAL", title: "Action required", messages: ["A storage add-on may still be charging."], reassurance: null },
          dependentStorageCancellation: { actionAvailable: true, supportRequired: true },
        } as unknown as Partial<BillingAccountProjection>)}
        onRetryStorageCancellation={noop}
      />,
    );
    const link = q<HTMLAnchorElement>("[data-billing-addon-support]")!;
    expect(link).not.toBeNull();
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/support");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(document.body.innerHTML).not.toContain("/settings/support");
  });
});

describe("B6-F-61 / B6-F-62 / B6-F-66: the storage panel", () => {
  const mount = (p: BillingAccountProjection) =>
    render(<StorageAddonsSection projection={p} onManageStorage={noop} onChoosePlan={noop} onCancelAddon={noop} cancelBusyId={null} />);

  it("an ending add-on shows its paid-through end, does not say Renews, and offers no Cancel", () => {
    mount(projection({ storageAddons: { offers: [], active: [addon({ ending: true, endsAtUtc: "2026-12-01T12:00:00.000Z" })] } } as Partial<BillingAccountProjection>));
    const term = q("[data-billing-addon-term]")!;
    expect(term.getAttribute("data-billing-addon-term")).toBe("ending");
    expect(term.textContent).toMatch(/^Ends .+ — not renewing$/);
    expect(q("[data-billing-addon='PERSONAL_50_GB']")!.textContent).not.toMatch(/Renews/);
    expect(q("[data-billing-cancel-addon]")).toBeNull();
  });

  it("a renewing add-on still says Renews and offers Cancel", () => {
    mount(projection({ storageAddons: { offers: [], active: [addon()] } } as Partial<BillingAccountProjection>));
    expect(q("[data-billing-addon-term]")!.textContent).toMatch(/^Renews /);
    expect(q("[data-billing-cancel-addon='addon-1']")).not.toBeNull();
  });

  it("a managed payer with BILLING_CANCEL is offered Cancel although the projection's canCancel is false", () => {
    const managed = projection({
      account: { type: "PERSONAL", id: "user-1", displayName: "Jamie", capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_HISTORY_VIEW", "BILLING_CANCEL"], billingOwnerMissing: false },
      storageAddons: { offers: [], active: [addon({ canCancel: false })] },
    } as unknown as Partial<BillingAccountProjection>);
    mount(managed);
    expect(q("[data-billing-cancel-addon='addon-1']")).not.toBeNull();
  });

  it("Free states that the first issued report and package do not count toward storage", () => {
    mount(projection({ storageAddons: { offers: [], active: [addon()] } } as Partial<BillingAccountProjection>));
    expect(q("[data-billing-storage-first-issuance-note]")!.textContent).toMatch(/first report and verification package/);
  });
});

describe("B6-F-67: cancel copy", () => {
  const paid = (over: Record<string, unknown>) =>
    projection({
      plan: {
        planKey: "PRO", accessKind: "SUBSCRIPTION", displayName: "Pro", model: "MONTHLY", lifecycle: "ACTIVE", priceCents: 1900,
        currency: "USD", currentPeriodEndUtc: "2026-12-01T12:00:00.000Z", cancelAtPeriodEnd: false, billingOwnerMissing: false, ...over,
      },
      actions: {
        canStartCheckout: false, planManagement: { label: "Manage plan", mode: "MANAGE", enabled: true }, canBuyEvidenceCredits: false,
        canBuyStorageAddon: false, canRequestCancellation: true, contactAccountManager: false, manageLabel: null,
      },
    } as unknown as Partial<BillingAccountProjection>);

  it("a PayPal subscription is told it ends immediately, as the confirmation says", () => {
    render(<ManagePlanDrawer open projection={paid({ paymentProviderLabel: "PayPal" })} onClose={noop} onChangePlan={noop} onCancel={noop} changeBusyPlan={null} cancelBusy={false} />);
    const copy = q("[data-billing-manage-cancel-copy]")!.textContent ?? "";
    expect(copy).toMatch(/PayPal ends a subscription immediately/);
    expect(copy).not.toMatch(/at the end of the period you have paid for/);
  });

  it("'no subscription found' does not promise that nothing will be charged", () => {
    const p = paid({});
    (p.actions as unknown as Record<string, unknown>).canRequestCancellation = false;
    (p.actions as unknown as Record<string, unknown>).cancellationUnavailableReason = "NO_SUBSCRIPTION_BOUND";
    render(<ManagePlanDrawer open projection={p} onClose={noop} onChangePlan={noop} onCancel={noop} changeBusyPlan={null} cancelBusy={false} />);
    const copy = q("[data-billing-manage-cancel-unavailable]")!.textContent ?? "";
    expect(copy).toMatch(/nothing here for us to stop/);
    expect(copy).not.toMatch(/nothing will be charged/i);
  });
});

describe("B6-F-68: credits while storage is full", () => {
  it("names storage and offers Add storage beside Buy credits", () => {
    const full = projection({
      evidenceAdmission: {
        planIncludedLifetime: 3, effectiveLifetimeCap: 3, capSource: "PLAN_DEFAULT", recordsHeld: 3, recordsInTrash: 0,
        creditsAvailable: 0, planCapacityRemaining: 0, overCap: false, next: { allowed: false, reason: "PLAN_CAP_REACHED" },
      },
      wallet: { availableCredits: 0, purchasedCredits: 0, grantedCredits: 0, consumedCredits: 0, hasLedgerHistory: false, creditsPerPurchase: 1 },
    } as unknown as Partial<BillingAccountProjection>);
    (full.usage.storage as unknown as Record<string, unknown>).limitReached = true;
    const addStorage = vi.fn();
    render(<EvidenceDetailCard projection={full} onBuyCredits={noop} onChoosePlan={noop} onAddStorage={addStorage} />);
    expect(q("[data-billing-evidence-next]")!.textContent).toMatch(/storage space for the next record/);
    expect(q("[data-billing-buy-credits]")).not.toBeNull();
    q<HTMLButtonElement>("[data-billing-evidence-add-storage]")!.click();
    expect(addStorage).toHaveBeenCalledTimes(1);
  });

  it("says nothing about storage while there is room", () => {
    const roomy = projection({
      evidenceAdmission: {
        planIncludedLifetime: 3, effectiveLifetimeCap: 3, capSource: "PLAN_DEFAULT", recordsHeld: 3, recordsInTrash: 0,
        creditsAvailable: 0, planCapacityRemaining: 0, overCap: false, next: { allowed: false, reason: "PLAN_CAP_REACHED" },
      },
    } as unknown as Partial<BillingAccountProjection>);
    render(<EvidenceDetailCard projection={roomy} onBuyCredits={noop} onChoosePlan={noop} onAddStorage={noop} />);
    expect(q("[data-billing-evidence-next]")!.textContent).not.toMatch(/storage/);
    expect(q("[data-billing-evidence-add-storage]")).toBeNull();
  });
});

describe("B6-F-69: the organization default", () => {
  const ORG = { type: "ORGANIZATION", id: "org-1", displayName: "Acme", capabilities: ["BILLING_ACCOUNT_VIEW"], billingOwnerMissing: false };
  const PERSONAL = projection().account;
  function serve() {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/billing/accounts") return { accounts: [PERSONAL, ORG] };
      if (path.endsWith("/history")) return { items: [], activity: [] };
      if (path.startsWith("/v1/billing/accounts/ORGANIZATION/")) return projection({ account: ORG } as unknown as Partial<BillingAccountProjection>);
      if (path.startsWith("/v1/billing/accounts/PERSONAL/")) return projection();
      throw new Error(`Unrouted ${path}`);
    });
  }
  const firstProjectionRead = () =>
    apiFetch.mock.calls
      .map(([path]) => String(path))
      .find((p) => p.startsWith("/v1/billing/accounts/") && !p.endsWith("/history"));
  const mount = () =>
    render(
      <ToastProvider>
        <ConfirmActionProvider>
          <BillingPage />
        </ConfirmActionProvider>
      </ToastProvider>,
    );

  it("without ?workspace=, an organization-active session opens on the organization", async () => {
    activeOrganizationId = "org-1";
    serve();
    mount();
    await waitFor(() => expect(firstProjectionRead()).toBeDefined());
    expect(firstProjectionRead()).toBe("/v1/billing/accounts/ORGANIZATION/org-1");
  });

  it("an explicit ?workspace=personal still opens Personal", async () => {
    activeOrganizationId = "org-1";
    search = "workspace=personal";
    serve();
    mount();
    await waitFor(() => expect(firstProjectionRead()).toBeDefined());
    expect(firstProjectionRead()).toBe("/v1/billing/accounts/PERSONAL/user-1");
  });
});
