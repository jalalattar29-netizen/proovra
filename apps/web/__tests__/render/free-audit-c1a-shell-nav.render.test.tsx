/**
 * Free-user audit 0ea0 — WEB-C1A-SHELL-NAV, rendered behaviour.
 *
 * Real `apiFetch` with `fetch` mocked (flat errors are not ApiError — the
 * brief's trap), the real PlatformContextProvider with a test envelope, and
 * RTL `cleanup()` between tests (never resetting document.body).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pushes: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (p: string) => pushes.push(p), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  notFound: () => {
    throw new Error("notFound");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { SidebarStorageWidget } from "../../components/app-shell-v2/SidebarStorageWidget";
import { WorkspaceUpgradeLink } from "../../components/billing/WorkspaceUpgradeLink";
import { PageRouteGate } from "../../components/navigation/PageRouteGate";
import { LegalAcceptanceStep } from "../../components/legal/LegalAcceptanceStep";
import { EvidenceProvenanceChainSection } from "../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection";
import { useDeepLinkNavigation, type DeepLinkOpenResult } from "../../lib/navigation/useDeepLinkNavigation";
import { USAGE_CHANGED_EVENT } from "../../lib/billing/personal-allowance";
import { LEGAL_ACCEPTED_EVENT } from "../../lib/session-events";
import { apiFetch } from "../../lib/api";
import SubprocessorsPage from "../../app/(app)/trust-center/subprocessors/page";

const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type Space = "own" | "shared" | "org";
function envelope(space: Space, extra: Record<string, unknown> = {}) {
  const id = space === "own" ? PERSONAL : OTHER;
  const role = space === "own" ? "OWNER" : "MEMBER";
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { INTAKE_LINKS_MANAGE: true, CASES_VIEW: true, EVIDENCE_VIEW: true },
    diagnostics: { requestId: "test" },
    workspace: { id, name: "W", status: "active", scope: space === "org" ? "TEAM" : "PERSONAL", membership: { role } },
    activeSpace:
      space === "org"
        ? { type: "ORGANIZATION", id, displayName: "Acme", roleLabel: role, plan: "TEAM" }
        : { type: "PERSONAL", id, displayName: space === "own" ? "Personal Space" : "Ada's workspace", roleLabel: space === "own" ? "Owner" : role, plan: space === "own" ? "FREE" : "PRO", shared: space === "shared" },
    personalSpace: { id: PERSONAL, status: "active", plan: "FREE" },
    contextOptions: {
      personalSpace: { workspaceId: PERSONAL, name: "Personal Space", kind: "PERSONAL", role: "OWNER", lifecycleStatus: "active" },
      ownedWorkspaces: [],
      sharedWorkspaces: space === "shared" ? [{ workspaceId: OTHER, name: "Ada's workspace", kind: "PERSONAL", role, lifecycleStatus: "active" }] : [],
      organizations: space === "org" ? [{ organizationId: "org-1", organizationName: "Acme", workspaces: [{ workspaceId: OTHER, workspaceName: "Acme", kind: "ORGANIZATION", workspaceRole: role, lifecycleStatus: "active" }] }] : [],
      activeContext: { workspaceId: id, kind: space === "org" ? "ORGANIZATION" : "PERSONAL", organizationId: space === "org" ? "org-1" : null, displayName: "W" },
    },
    planFeatures: { intakeIncluded: false, casesIncluded: false, reportsIncluded: true },
    account: { userId: ME, accountPlan: "FREE", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    ...extra,
  };
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let answer: (url: string, method: string, body: unknown) => { status?: number; body: unknown } | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  pushes.length = 0;
  calls = [];
  answer = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: String(url), method, body });
      const a = answer(String(url), method, body);
      return json(a?.body ?? {}, a?.status ?? (a ? 200 : 404));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const withEnvelope = (space: Space, node: React.ReactNode, extra?: Record<string, unknown>) => (
  <PlatformContextProvider testEnvelope={envelope(space, extra) as never}>{node}</PlatformContextProvider>
);

const PROJECTION = {
  usage: {
    storage: {
      state: "MEASURED", usedBytes: "5242880", usedLabel: "5 MB", limitBytes: "262144000", limitLabel: "250 MB",
      baseBytes: "262144000", baseLabel: "250 MB", recurringAddonBytes: "0", recurringAddonLabel: "0 B",
      legacyAddonBytes: "0", legacyAddonLabel: "0 B", usagePercent: 2, nearLimit: false, limitReached: false,
    },
    evidence: { state: "MEASURED", used: 3, limit: 3, window: "LIFETIME" },
    ai: { state: "NOT_INCLUDED" },
  },
  evidenceAdmission: {
    planIncludedLifetime: 3, effectiveLifetimeCap: 3, capSource: "PLAN_DEFAULT", recordsHeld: 3, creditsAvailable: 0,
    planCapacityRemaining: 0, overCap: false, next: { allowed: false, reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS" },
  },
};

function billingAnswers(url: string) {
  if (url.includes("/v1/billing/accounts/PERSONAL/")) return { body: PROJECTION };
  if (url.includes("/v1/billing/accounts")) return { body: { accounts: [{ type: "PERSONAL", id: ME, displayName: "Me", capabilities: [], billingOwnerMissing: false }] } };
  if (url.includes("/v1/billing/overview")) return { body: { workspaces: { personal: { storage: { usedBytes: "5242880", limitBytes: "262144000" } } } } };
  return undefined;
}

describe("B2A-F-01 / B2A-F-02 / B2A-F-03 — the shell plan meter", () => {
  it("own Personal Space: the server's labels (5 MB of 250 MB) and x of 3 records with the limit", async () => {
    answer = (url) => billingAnswers(url);
    render(withEnvelope("own", <SidebarStorageWidget />));
    await waitFor(() => expect(document.querySelector("[data-sidebar-storage-detail]")?.textContent).toBe("5 MB of 250 MB"));
    expect(document.querySelector("[data-sidebar-records]")?.textContent).toContain("3 of 3 records");
    expect(document.querySelector("[data-sidebar-records-limit]")?.getAttribute("href")).toBe("/billing");
    expect(document.body.textContent).not.toMatch(/0\.24 GB|0 GB/);
  });

  it("re-reads when Capture signals a sealed record", async () => {
    answer = (url) => billingAnswers(url);
    render(withEnvelope("own", <SidebarStorageWidget />));
    await waitFor(() => expect(document.querySelector("[data-sidebar-storage-detail]")).not.toBeNull());
    const before = calls.filter((c) => c.url.includes("/v1/billing/accounts/PERSONAL/")).length;
    await act(async () => {
      window.dispatchEvent(new Event(USAGE_CHANGED_EVENT));
      await Promise.resolve();
    });
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/v1/billing/accounts/PERSONAL/")).length).toBeGreaterThan(before));
  });

  it.each(["shared", "org"] as const)("%s workspace: no personal meter, and the personal account is not read", async (space) => {
    answer = (url) => billingAnswers(url);
    render(withEnvelope(space, <SidebarStorageWidget />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(document.querySelector("[data-sidebar-storage]")).toBeNull();
    expect(calls.some((c) => c.url.includes("/v1/billing/"))).toBe(false);
  });
});

describe("B3A-F-004 — Upgrade only for the payer of the active workspace", () => {
  const link = <WorkspaceUpgradeLink className="x" testId="cta">Upgrade plan</WorkspaceUpgradeLink>;

  it("own Personal Space: the link to /billing", async () => {
    render(withEnvelope("own", link));
    expect(screen.getByTestId("cta").getAttribute("href")).toBe("/billing");
  });

  it("a joined workspace: who manages billing, and no link", async () => {
    render(withEnvelope("shared", link));
    expect(screen.queryByTestId("cta")).toBeNull();
    expect(screen.getByTestId("cta-ask-owner").textContent).toBe(
      "Billing for this workspace is managed by its owner. Ask them to change the plan.",
    );
  });

  it("an organization: a link only when /v1/billing/accounts lists that organization", async () => {
    answer = (url) => (url.includes("/v1/billing/accounts") ? { body: { accounts: [{ type: "PERSONAL", id: ME, displayName: "Me", capabilities: [], billingOwnerMissing: false }] } } : undefined);
    render(withEnvelope("org", link));
    await waitFor(() => expect(screen.getByTestId("cta-ask-owner").textContent).toMatch(/billing administrators/));
    expect(screen.queryByTestId("cta")).toBeNull();
    cleanup();
    answer = (url) =>
      url.includes("/v1/billing/accounts")
        ? { body: { accounts: [{ type: "ORGANIZATION", id: "org-1", displayName: "Acme", capabilities: [], billingOwnerMissing: false }] } }
        : undefined;
    render(withEnvelope("org", link));
    await waitFor(() => expect(screen.getByTestId("cta").getAttribute("href")).toBe("/billing"));
  });
});

describe("B2A-F-23 — route gates do not send a member to their own billing", () => {
  it("a joined workspace on a plan-gated route: no View plans, and who manages billing", async () => {
    render(withEnvelope("shared", <PageRouteGate routeId="workspace.intake_links"><div>page</div></PageRouteGate>));
    await waitFor(() => expect(document.querySelector("[data-page-route-gate-state='NEEDS_UPGRADE']")).not.toBeNull());
    expect(screen.queryByText("View plans")).toBeNull();
    expect(document.body.textContent).toContain("Billing for this workspace is managed by its owner.");
  });

  it("own Personal Space keeps View plans", async () => {
    render(withEnvelope("own", <PageRouteGate routeId="workspace.intake_links"><div>page</div></PageRouteGate>));
    await waitFor(() => expect(screen.getByText("View plans")).toBeTruthy());
  });
});

describe("B2A-F-07 — deep links open in their workspace, with their remainder", () => {
  function Harness({ href, onResult }: { href: string; onResult: (r: DeepLinkOpenResult) => void }) {
    const { open } = useDeepLinkNavigation();
    return <button onClick={() => void open(href).then(onResult)}>go</button>;
  }
  async function openVia(space: Space, href: string) {
    let result: DeepLinkOpenResult | null = null;
    render(withEnvelope(space, <Harness href={href} onResult={(r) => (result = r)} />));
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(result).not.toBeNull());
    return result!;
  }

  it("a record in another workspace: resolve, switch to it, then open the exact tab", async () => {
    answer = (url, method) => {
      if (url.includes("/v1/deep-link/resolve")) return { body: { ok: true, workspaceId: OTHER, resourceType: "evidence", resourceId: "E-1" } };
      if (url.includes("/v1/platform/context/switch-workspace") && method === "POST") return { body: envelope("org") };
      return undefined;
    };
    const r = await openVia("own", "/evidence/E-1?tab=discussion#note-3");
    expect(r).toEqual({ status: "navigated", path: "/evidence/E-1?tab=discussion#note-3" });
    const sw = calls.find((c) => c.url.includes("/v1/platform/context/switch-workspace"));
    expect(sw?.body).toEqual({ workspaceId: OTHER });
    expect(pushes).toEqual(["/evidence/E-1?tab=discussion#note-3"]);
    expect(calls.findIndex((c) => c.url.includes("switch-workspace"))).toBeLessThan(calls.length);
  });

  it("a record in the active workspace opens without a switch", async () => {
    answer = (url) => (url.includes("/v1/deep-link/resolve") ? { body: { ok: true, workspaceId: PERSONAL, resourceType: "evidence", resourceId: "E-2" } } : undefined);
    await openVia("own", "/evidence/E-2?tab=integrity");
    expect(calls.some((c) => c.url.includes("switch-workspace"))).toBe(false);
    expect(pushes).toEqual(["/evidence/E-2?tab=integrity"]);
  });

  it("the case graph resolves its case; section pages open plainly instead of being denied", async () => {
    answer = (url) => (url.includes("/v1/deep-link/resolve") ? { body: { ok: true, workspaceId: PERSONAL, resourceType: "cases", resourceId: "K-1" } } : undefined);
    await openVia("own", "/investigation/cases/K-1/graph");
    const resolve = calls.find((c) => c.url.includes("/v1/deep-link/resolve"));
    expect(resolve?.body).toMatchObject({ resourceType: "cases", resourceId: "K-1" });
    expect(pushes).toEqual(["/investigation/cases/K-1/graph"]);
    cleanup();
    pushes.length = 0;
    calls = [];
    const plain = await openVia("own", "/review/queues");
    expect(plain).toEqual({ status: "navigated", path: "/review/queues" });
    expect(calls.some((c) => c.url.includes("/v1/deep-link/resolve"))).toBe(false);
  });

  it("an evidence denial still navigates nothing", async () => {
    answer = (url) => (url.includes("/v1/deep-link/resolve") ? { status: 404, body: { error: { code: "not_found" } } } : undefined);
    const r = await openVia("own", "/evidence/E-hidden");
    expect(r).toEqual({ status: "denied" });
    expect(pushes).toEqual([]);
  });
});

describe("B1-F-010 — accepting re-issued terms mid-action keeps the page", () => {
  it("a write refused after load: accept closes the step without reloading, the form keeps its value", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
    let owed = false;
    answer = (url) => {
      if (url.includes("/v1/users/legal-status")) return { body: owed ? { requiresReacceptance: true, missingPolicies: ["terms"], requiredVersions: { terms: "t2" } } : { requiresReacceptance: false, missingPolicies: [], requiredVersions: {} } };
      if (url.includes("/v1/users/legal-acceptance")) return { body: { ok: true, items: [] } };
      return { status: 428, body: { error: { code: "LEGAL_REACCEPT_REQUIRED", message: "Accept the terms", details: { missingPolicies: ["terms"] } } } };
    };
    const accepted = vi.fn();
    window.addEventListener(LEGAL_ACCEPTED_EVENT, accepted);
    render(
      <div>
        <input aria-label="draft" defaultValue="" />
        <LegalAcceptanceStep active />
      </div>,
    );
    await waitFor(() => expect(calls.filter((c) => c.url.includes("legal-status")).length).toBe(1));
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "half-typed note" } });
    owed = true;
    await apiFetch("/v1/shares", { method: "POST", body: "{}" }).catch(() => undefined);
    await waitFor(() => expect(document.querySelector("[data-legal-step]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-legal-step-agree]") as HTMLInputElement);
    owed = false;
    fireEvent.click(document.querySelector("[data-legal-step-accept]") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector("[data-legal-step]")).toBeNull());
    expect(reload).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("half-typed note");
    window.removeEventListener(LEGAL_ACCEPTED_EVENT, accepted);
  });
});

describe("B2A-F-06 — provenance copy matches the rule", () => {
  it("a Personal workspace is told provenance is not recorded there, without a request", async () => {
    render(withEnvelope("own", <EvidenceProvenanceChainSection evidenceId="E-1" />));
    await waitFor(() => expect(document.querySelector("[data-evidence-provenance-state='denied']")).not.toBeNull());
    expect(document.body.textContent).toContain("not recorded for captures in a personal workspace");
    expect(document.body.textContent).not.toContain("Switch to the organisation");
    expect(calls.some((c) => c.url.includes("/v1/provenance/"))).toBe(false);
  });

  it("an organization 403 gets neutral copy, never 'switch organisation'", async () => {
    answer = (url) => (url.includes("/v1/provenance/") ? { status: 403, body: { denial: "WORKSPACE_NOT_FOUND" } } : undefined);
    render(withEnvelope("org", <EvidenceProvenanceChainSection evidenceId="E-1" />));
    await waitFor(() => expect(document.querySelector("[data-evidence-provenance-state='denied']")).not.toBeNull());
    expect(document.body.textContent).toContain("A provenance record is not available for this evidence in the workspace you are in.");
    expect(document.body.textContent).not.toContain("Switch to the organisation");
  });
});

describe("B7B-F08 — Trust Center re-seed only for the role that may use it", () => {
  const subs = () => ({ body: { subprocessors: [] } });
  it("a MEMBER sees no Re-seed defaults", async () => {
    answer = (url) => (url.includes("/v1/trust/subprocessors") ? subs() : undefined);
    render(withEnvelope("shared", <SubprocessorsPage />));
    await waitFor(() => expect(document.querySelector("[data-subprocessors-refresh]")).not.toBeNull());
    expect(document.querySelector("[data-subprocessors-seed]")).toBeNull();
  });
  it("the OWNER does", async () => {
    answer = (url) => (url.includes("/v1/trust/subprocessors") ? subs() : undefined);
    render(withEnvelope("own", <SubprocessorsPage />));
    await waitFor(() => expect(document.querySelector("[data-subprocessors-seed]")).not.toBeNull());
  });
});
