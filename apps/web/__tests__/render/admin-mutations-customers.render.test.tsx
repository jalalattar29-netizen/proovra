/**
 * ADMIN CONTROL PLANE — customer-lifecycle, incident and support mutations,
 * driven for real.
 *
 * Mounts the REAL admin pages against contract-shaped fixtures and proves the
 * mutation machinery: every consequential control asks FIRST and names its
 * subject, cancel sends nothing, confirm sends exactly one request with the
 * exact method / path / body, success is announced only after the response
 * resolves (and the page re-reads the server rather than guessing), a failure
 * surfaces through the page's own failure path with no success indicator —
 * and the two incident actions that deliberately do NOT confirm (acknowledge,
 * assign) are pinned as fire-on-click with no dialog.
 *
 * Pages under proof:
 *   app/(app)/admin/provisioning/page.tsx
 *   app/(app)/admin/customers/[id]/page.tsx
 *   app/(app)/admin/operations/page.tsx
 *   app/(app)/admin/support-access/page.tsx
 *
 * Mutations under proof:
 *   "POST /v1/admin/enterprise/provision"
 *   "PATCH /v1/admin/orgs/:id/plan"
 *   "POST /v1/admin/orgs/:id/suspend"
 *   "POST /v1/admin/orgs/:id/resume"
 *   "POST /v1/admin/incidents/:id/acknowledge"
 *   "POST /v1/admin/incidents/:id/resolve"
 *   "POST /v1/admin/incidents/:id/assign"
 *   "POST /v1/support-access/start"
 *   "POST /v1/support-access/enter"
 *   "POST /v1/support-access/revoke"
 *   "POST /v1/break-glass/activate"
 *   "POST /v1/break-glass/revoke"
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  act,
  cleanup,
  fireEvent,
} from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type Reply = unknown;

let requestLog: Array<{ path: string; method: string; body?: string }> = [];

let customerDetailReply: () => Reply = () => ({});
let suspendReply: () => Reply = () => ({ ok: true });
let resumeReply: () => Reply = () => ({ ok: true });
let provisionReply: () => Reply = () => ({});
let planReply: () => Reply = () => ({});
let incidentsReply: () => Reply = () => ({});
let incidentMutationReply: (path: string) => Reply = () => ({ ok: true });
const securityEventsReply: () => Reply = () => ({
  items: [],
  nextCursor: null,
  hasMore: false,
  severityBreakdown: { CRITICAL: 0, HIGH: 0, WARNING: 0, INFO: 0 },
  totalEvents: 0,
});
let supportGrantsReply: () => Reply = () => ({ grants: [] });
let emergencyGrantsReply: () => Reply = () => ({ grants: [] });
let supportMutationReply: (path: string) => Reply = () => ({ ok: true });

/**
 * A rejection shaped exactly like the one `apiFetch` throws: a real Error
 * carrying `statusCode`. Built by a function rather than a class so it is not
 * in the temporal dead zone when Vitest hoists the `vi.mock` factory.
 */
function apiFailure(statusCode: number): Error {
  const err = new Error("request failed") as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** A reply the test resolves by hand, so "pending" is an observable state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    requestLog.push({ path, method, body: init?.body });
    const pick = (r: Reply) => {
      if (r instanceof Error) throw r;
      return r; // a Promise reply is awaited by the caller — the deferred seam
    };
    if (path.startsWith("/v1/admin/customers/")) return pick(customerDetailReply());
    if (/^\/v1\/admin\/orgs\/[^/?]+\/suspend$/.test(path)) return pick(suspendReply());
    if (/^\/v1\/admin\/orgs\/[^/?]+\/resume$/.test(path)) return pick(resumeReply());
    if (/^\/v1\/admin\/orgs\/[^/?]+\/plan$/.test(path)) return pick(planReply());
    if (path === "/v1/admin/enterprise/provision") return pick(provisionReply());
    if (path.startsWith("/v1/admin/incidents?")) return pick(incidentsReply());
    if (path.startsWith("/v1/admin/incidents/")) {
      return pick(incidentMutationReply(path));
    }
    if (path.startsWith("/v1/admin/security-events")) {
      return pick(securityEventsReply());
    }
    if (path.startsWith("/v1/support-access/grants")) {
      return pick(supportGrantsReply());
    }
    if (path.startsWith("/v1/break-glass/grants")) {
      return pick(emergencyGrantsReply());
    }
    if (
      path.startsWith("/v1/support-access/") ||
      path.startsWith("/v1/break-glass/")
    ) {
      return pick(supportMutationReply(path));
    }
    throw new Error(`unrouted request in test: ${method} ${path}`);
  },
  apiBaseUrl: () => "https://api.test.invalid",
  readApiToken: () => null,
  setApiToken: () => {},
  ApiError: class ApiError extends Error {},
}));

let replaced: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: (href: string) => {
      replaced.push(href);
    },
    back: () => {},
  }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/admin/operations",
  useParams: () => ({}),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const COLLEAGUE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

// The pages under test read the workspace / platform context through these
// hooks; route-gate access resolution and envelope plumbing are not what this
// file proves, so the hooks answer directly. Every returned value is a STABLE
// singleton: the real hooks are referentially stable across renders, and a
// mock that minted fresh closures per render would refire every
// `useCallback`/`useEffect` chain built on them into an infinite load loop.
vi.mock("../../lib/platform-context", () => {
  const guard = { stamp: () => 0, isStale: () => false };
  const context = {
    envelope: {
      user: { id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" },
    },
  };
  return {
    useTeamId: () => "11111111-1111-4111-8111-111111111111",
    useWorkspaceId: () => "11111111-1111-4111-8111-111111111111",
    useActiveWorkspaceId: () => "11111111-1111-4111-8111-111111111111",
    useTenantGuard: () => guard,
    usePlatformContext: () => context,
  };
});

vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/**
 * Step-up is its own, separately-proven machinery. Here the challenge always
 * passes and the wrapped action runs with empty headers, so what remains under
 * proof is the ordering this file cares about: confirm BEFORE the step-up
 * action even starts. The mock covers the real module's full export surface
 * (useStepUpAction, StepUpModal, StepUpModalProvider).
 */
vi.mock("../../components/identity-security/StepUpModal", () => {
  // One stable control object — the real hook memoizes its return value.
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (
      fn: (headers?: Record<string, string>) => Promise<unknown>,
    ) => fn({}),
    cancel: () => {},
    closeIdle: () => {},
    startChallenge: async () => {},
    verifyAndRetry: async () => {},
  };
  return {
    useStepUpAction: () => control,
    StepUpModal: () => null,
    StepUpModalProvider: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
  };
});

/**
 * The customers [id] page reads its params with React 19's `use(promise)`;
 * the render harness resolves React 18.3, where `use` does not exist.
 * Polyfill ONLY the fulfilled-thenable fast path and keep everything else real.
 */
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const use =
    (actual.use as ((p: unknown) => unknown) | undefined) ??
    ((thenable: unknown) => {
      const t = thenable as { status?: string; value?: unknown };
      if (t && t.status === "fulfilled") return t.value;
      throw thenable;
    });
  const base = (actual.default ?? actual) as Record<string, unknown>;
  return { ...actual, use, default: { ...base, use } };
});

import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import AdminProvisioningPage from "../../app/(app)/admin/provisioning/page";
import AdminOrganizationDetailPage from "../../app/(app)/admin/customers/[id]/page";
import AdminOperationsPage from "../../app/(app)/admin/operations/page";
import SupportAccessPage from "../../app/(app)/admin/support-access/page";

// ---------------------------------------------------------------------------
// Fixtures — minimal but shaped by the pages' own contracts
// ---------------------------------------------------------------------------

const ORG = "33333333-cccc-4ccc-8ccc-333333333333";
const INC_OPEN = "44444444-dddd-4ddd-8ddd-444444444444";
const INC_OWNED = "55555555-eeee-4eee-8eee-555555555555";
const GRANT = "66666666-ffff-4fff-8fff-666666666666";
const EMERGENCY = "77777777-aaaa-4aaa-8aaa-777777777777";

function customerDetail(over: { status?: string } = {}) {
  return {
    lifecycle: { stage: "ACTIVE", reasons: [] },
    customerSuccess: {
      firstEvidenceAt: null,
      firstReportAt: null,
      firstPackageAt: null,
      lastActivityAt: null,
      lastLoginAt: null,
      ssoConfigured: false,
      scimConfigured: false,
      domainVerified: false,
      openIncidents: 0,
      billingIssues: { pastDueWorkspaces: 0, failedPayments: 0 },
      riskStatus: null,
      onboardingCompletion: null,
      accountManager: null,
      supportContact: null,
      renewalDate: null,
      supportTickets: null,
      notModelled: [],
    },
    workspaces: [],
    enterpriseContract: null,
    overview: {
      id: ORG,
      name: "Northgate Insurance",
      legalName: null,
      status: over.status ?? "ACTIVE",
      plan: "ENTERPRISE",
      enterprise: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      onboardingStatus: "HEALTHY" as const,
      setupCompletion: {
        hasWorkspace: true,
        hasOwner: true,
        hasVerifiedDomain: false,
      },
      owner: null,
      admins: [],
      workspaces: [],
      seats: { included: 25, used: 3, overSeatWorkspaceCount: 0 },
    },
    identity: {
      sso: { configured: false, overallHealth: null, connections: [] },
      scim: { enabled: false, activeTokenCount: 0, lastSyncAt: null },
      domains: { verified: [], pending: [] },
    },
    evidence: {
      evidenceCount: 0,
      failedEvidenceCount: null,
      reportCount: null,
      verificationPackageCount: null,
    },
    governance: {
      activeLegalHolds: null,
      activeRetentionPolicies: null,
      pendingDestructionRequests: null,
    },
    billing: {
      billingOwner: null,
      activeSubscriptions: 0,
      failedPayments: 0,
      planCounts: {},
      statusCounts: {},
    },
    activity: { recentEvents: [], provisioningHistory: [] },
  };
}

function incidentRow(over: Record<string, unknown> = {}) {
  return {
    id: INC_OPEN,
    teamId: WS,
    scope: "WORKSPACE",
    category: "REPORT",
    severity: "CRITICAL",
    status: "OPEN",
    title: "Report generation failed",
    safeSummary: "The report pipeline did not produce a document.",
    occurrenceCount: 3,
    firstSeenAtUtc: "2026-08-30T09:00:00.000Z",
    lastSeenAtUtc: "2026-08-30T11:00:00.000Z",
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    assignedOperatorUserId: null,
    runbookSlug: null,
    affected: {
      workspaceId: WS,
      workspaceName: "Northgate Claims",
      workspaceKind: "ORGANIZATION",
      workspaceLifecycle: "LIVE" as const,
      customer: { id: ORG, name: "Northgate Insurance" },
    },
    ...over,
  };
}

function incidentsResponse(items: ReturnType<typeof incidentRow>[]) {
  return {
    items,
    severityBreakdown: { CRITICAL: 1, HIGH: 1, WARNING: 0, INFO: 0 },
    statusBreakdown: { OPEN: 1, ACKNOWLEDGED: 1 },
    unresolvedCount: items.length,
    totalIncidents: items.length,
  };
}

const TWO_INCIDENTS = [
  incidentRow(),
  incidentRow({
    id: INC_OWNED,
    status: "ACKNOWLEDGED",
    severity: "HIGH",
    title: "Trusted timestamp failed",
    assignedOperatorUserId: COLLEAGUE,
  }),
];

function supportGrant(over: Record<string, unknown> = {}) {
  return {
    id: GRANT,
    supportUserId: ME,
    organizationId: ORG,
    teamId: null,
    reason: "Investigate a broken evidence export",
    accessLevel: "READ_ONLY",
    status: "ACTIVE",
    approvedByUserId: null,
    startedAtUtc: "2026-09-01T08:00:00.000Z",
    expiresAtUtc: "2026-09-04T08:00:00.000Z",
    revokedAtUtc: null,
    expired: false,
    ...over,
  };
}

function emergencyGrant(over: Record<string, unknown> = {}) {
  return {
    id: EMERGENCY,
    organizationId: ORG,
    emergencyUserId: COLLEAGUE,
    grantedRole: "EMERGENCY_READ_ONLY",
    reason: "Ransomware containment",
    status: "ACTIVE",
    requestedByUserId: ME,
    stepUpProofRecorded: true,
    startedAtUtc: "2026-09-01T08:00:00.000Z",
    expiresAtUtc: "2026-09-02T08:00:00.000Z",
    revokedAtUtc: null,
    revokedByUserId: null,
    expired: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => Array.from(document.querySelectorAll(sel));

const successToasts = () =>
  qa('[data-proovra-toast][data-severity="success"]');
const errorToasts = () => qa('[data-proovra-toast][data-severity="error"]');
const toastText = () =>
  qa("[data-proovra-toast]")
    .map((t) => t.textContent ?? "")
    .join(" | ");

const gets = () => requestLog.filter((r) => r.method === "GET");
const posts = () => requestLog.filter((r) => r.method === "POST");
const patches = () => requestLog.filter((r) => r.method === "PATCH");
const writes = () => requestLog.filter((r) => r.method !== "GET");

const dialog = (testId: string) =>
  q(`[data-confirm-action-modal="${testId}"]`) as HTMLElement | null;

async function click(el: Element | null) {
  expect(el, "expected the control to exist").not.toBeNull();
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
}

async function confirmDialog(testId: string) {
  const d = dialog(testId);
  expect(d, `dialog ${testId} should be open`).not.toBeNull();
  await click(d!.querySelector("[data-confirm-action-submit]"));
}

async function cancelDialog(testId: string) {
  const d = dialog(testId);
  expect(d, `dialog ${testId} should be open`).not.toBeNull();
  await click(d!.querySelector("[data-confirm-action-cancel]"));
}

async function type(el: Element | null, value: string) {
  expect(el, "expected the input to exist").not.toBeNull();
  await act(async () => {
    fireEvent.change(el as HTMLElement, { target: { value } });
  });
}

/** React 19 `use(params)` reads a fulfilled thenable synchronously. */
function resolvedParams<T extends object>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & {
    status?: string;
    value?: T;
  };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

function mountWithProviders(node: React.ReactElement) {
  cleanup();
  return render(
    <ToastProvider>
      <ConfirmActionProvider>{node}</ConfirmActionProvider>
    </ToastProvider>,
  );
}

async function mountProvisioning() {
  mountWithProviders(<AdminProvisioningPage />);
  await settle();
}

async function mountCustomer(id = ORG) {
  mountWithProviders(
    <AdminOrganizationDetailPage params={resolvedParams({ id })} />,
  );
  await settle();
}

async function mountOperations() {
  mountWithProviders(<AdminOperationsPage />);
  await settle();
}

async function mountSupportAccess() {
  mountWithProviders(<SupportAccessPage />);
  await settle();
}

beforeEach(() => {
  requestLog = [];
  replaced = [];
  customerDetailReply = () => customerDetail();
  suspendReply = () => ({ ok: true });
  resumeReply = () => ({ ok: true });
  provisionReply = () => ({
    organizationId: ORG,
    workspaceId: WS,
    ownerUserId: COLLEAGUE,
    provisioned: true,
  });
  planReply = () => ({
    organizationId: ORG,
    plan: "ENTERPRISE",
    seats: 25,
    workspacesUpdated: 2,
  });
  incidentsReply = () => incidentsResponse(TWO_INCIDENTS);
  incidentMutationReply = () => ({ ok: true });
  supportGrantsReply = () => ({ grants: [supportGrant()], total: 1, limit: 50 });
  emergencyGrantsReply = () => ({ grants: [emergencyGrant()] });
  supportMutationReply = () => ({ ok: true });
});

// ===========================================================================
// POST /v1/admin/enterprise/provision — provisioning page
// ===========================================================================

describe("Provisioning — POST /v1/admin/enterprise/provision", () => {
  async function fillProvisionForm() {
    await mountProvisioning();
    await type(q('[data-testid="provision-org-name"]'), "Acme Corporation");
    await type(q('[data-testid="provision-owner-email"]'), "owner@acme.com");
  }

  it("asks BEFORE the step-up action starts, naming the organization and the owner", async () => {
    await fillProvisionForm();
    await click(q('[data-testid="provision-submit"]'));

    const d = dialog("provisioning-provision");
    expect(d).not.toBeNull();
    expect(d!.getAttribute("role")).toBe("dialog");
    expect(d!.textContent).toContain("Acme Corporation");
    expect(d!.textContent).toContain("owner@acme.com");
    // The confirmation comes before the step-up action even begins: nothing
    // has been sent anywhere.
    expect(writes()).toHaveLength(0);
  });

  it("cancel provisions nothing", async () => {
    await fillProvisionForm();
    await click(q('[data-testid="provision-submit"]'));
    await cancelDialog("provisioning-provision");
    expect(writes()).toHaveLength(0);
    expect(q('[data-testid="provision-success-created"]')).toBeNull();
  });

  it("confirm sends exactly ONE POST with the idempotent provision body", async () => {
    await fillProvisionForm();
    await click(q('[data-testid="provision-submit"]'));
    await confirmDialog("provisioning-provision");

    expect(writes()).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path).toBe("/v1/admin/enterprise/provision");
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      idempotencyKey: expect.any(String),
      teamId: WS,
      organizationName: "Acme Corporation",
      ownerEmail: "owner@acme.com",
    });
  });

  it("success is announced only after the server resolves — noOptimisticSuccess", async () => {
    const gate = deferred<unknown>();
    provisionReply = () => gate.promise;
    await fillProvisionForm();
    await click(q('[data-testid="provision-submit"]'));
    await confirmDialog("provisioning-provision");

    expect(posts()).toHaveLength(1);
    expect(successToasts()).toHaveLength(0);
    expect(q('[data-testid="provision-success-created"]')).toBeNull();

    gate.resolve({
      organizationId: ORG,
      workspaceId: WS,
      ownerUserId: COLLEAGUE,
      provisioned: true,
    });
    await settle();

    expect(toastText()).toContain("Enterprise workspace created.");
    expect(q('[data-testid="provision-success-created"]')).not.toBeNull();
    // The server's own organizationId flows into the downstream grant panel.
    expect(
      (q('[data-testid="grant-org-id"]') as HTMLInputElement).value,
    ).toBe(ORG);
  });

  it("a 500 surfaces the failure path and claims no success", async () => {
    provisionReply = () => apiFailure(500);
    await fillProvisionForm();
    await click(q('[data-testid="provision-submit"]'));
    await confirmDialog("provisioning-provision");

    expect(q('[data-testid="provision-error"]')).not.toBeNull();
    expect(errorToasts().length).toBeGreaterThan(0);
    expect(successToasts()).toHaveLength(0);
    expect(q('[data-testid="provision-success-created"]')).toBeNull();
    expect(q('[data-testid="provision-success-pending"]')).toBeNull();
    expect(document.body.textContent).not.toContain("request failed");
  });
});

// ===========================================================================
// PATCH /v1/admin/orgs/:id/plan — provisioning page, grant panel
// ===========================================================================

describe("Provisioning — PATCH /v1/admin/orgs/:id/plan", () => {
  async function fillGrantForm() {
    await mountProvisioning();
    await type(q('[data-testid="grant-org-id"]'), ORG);
  }

  it("asks first, naming the organization the plan lands on, before any request", async () => {
    await fillGrantForm();
    await click(q('[data-testid="grant-submit"]'));

    const d = dialog("provisioning-grant-plan");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain(ORG);
    expect(d!.textContent).toContain("ENTERPRISE");
    expect(writes()).toHaveLength(0);
  });

  it("cancel grants nothing", async () => {
    await fillGrantForm();
    await click(q('[data-testid="grant-submit"]'));
    await cancelDialog("provisioning-grant-plan");
    expect(writes()).toHaveLength(0);
  });

  it("confirm PATCHes once with { teamId, plan }, and success waits for the server", async () => {
    const gate = deferred<unknown>();
    planReply = () => gate.promise;
    await fillGrantForm();
    await click(q('[data-testid="grant-submit"]'));
    await confirmDialog("provisioning-grant-plan");

    expect(writes()).toHaveLength(1);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].path).toBe(`/v1/admin/orgs/${ORG}/plan`);
    expect(JSON.parse(patches()[0].body as string)).toEqual({
      teamId: WS,
      plan: "ENTERPRISE",
    });
    expect(successToasts()).toHaveLength(0);
    expect(q('[data-testid="grant-success"]')).toBeNull();

    gate.resolve({
      organizationId: ORG,
      plan: "ENTERPRISE",
      seats: 25,
      workspacesUpdated: 2,
    });
    await settle();

    expect(toastText()).toContain("ENTERPRISE plan granted.");
    expect(q('[data-testid="grant-success"]')).not.toBeNull();
  });

  it("a 500 keeps the failure path — error box, no success box", async () => {
    planReply = () => apiFailure(500);
    await fillGrantForm();
    await click(q('[data-testid="grant-submit"]'));
    await confirmDialog("provisioning-grant-plan");

    expect(q('[data-testid="grant-error"]')).not.toBeNull();
    expect(q('[data-testid="grant-success"]')).toBeNull();
    expect(successToasts()).toHaveLength(0);
  });
});

// ===========================================================================
// POST /v1/admin/orgs/:id/suspend and /resume — customers/[id]
// ===========================================================================

describe("Customer detail — POST /v1/admin/orgs/:id/suspend", () => {
  it("asks first with a typed-confirm gate, naming the organization, before any request", async () => {
    await mountCustomer();
    await type(
      q('[data-testid="customer-suspend-reason"]'),
      "Fraud investigation",
    );
    await click(q('[data-testid="customer-suspend"]'));

    const d = dialog("customer-suspend");
    expect(d).not.toBeNull();
    expect(d!.getAttribute("data-confirm-action-tone")).toBe("danger");
    expect(d!.textContent).toContain("Northgate Insurance");
    expect(d!.textContent).toContain("Fraud investigation");
    expect(writes()).toHaveLength(0);

    // The typed-confirm gate: the submit stays disabled until the operator
    // types SUSPEND exactly.
    const submit = d!.querySelector(
      "[data-confirm-action-submit]",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await type(d!.querySelector("[data-confirm-action-typed-input]"), "SUSPEND");
    expect(
      (d!.querySelector("[data-confirm-action-submit]") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    // Still nothing sent — the gate opening is not the action running.
    expect(writes()).toHaveLength(0);
  });

  it("cancel suspends nothing", async () => {
    await mountCustomer();
    await click(q('[data-testid="customer-suspend"]'));
    await cancelDialog("customer-suspend");
    expect(writes()).toHaveLength(0);
  });

  it("confirm posts once with { teamId, reason }, re-reads, then announces", async () => {
    const gate = deferred<unknown>();
    suspendReply = () => gate.promise;
    await mountCustomer();
    const readsBefore = gets().length;

    await type(
      q('[data-testid="customer-suspend-reason"]'),
      "Fraud investigation",
    );
    await click(q('[data-testid="customer-suspend"]'));
    const d = dialog("customer-suspend")!;
    await type(d.querySelector("[data-confirm-action-typed-input]"), "SUSPEND");
    await confirmDialog("customer-suspend");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/v1/admin/orgs/${ORG}/suspend`);
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      teamId: WS,
      reason: "Fraud investigation",
    });
    // In flight: no success claim, no premature re-read.
    expect(successToasts()).toHaveLength(0);
    expect(gets().length).toBe(readsBefore);

    customerDetailReply = () => customerDetail({ status: "SUSPENDED" });
    gate.resolve({ ok: true });
    await settle();

    // refreshFromServer — the badge and the button flip from the server's row.
    expect(gets().length).toBeGreaterThan(readsBefore);
    expect(toastText()).toContain("Organization suspended.");
    expect(q('[data-testid="customer-resume"]')).not.toBeNull();
    expect(q('[data-testid="customer-suspend"]')).toBeNull();
  });

  it("a suspend without a reason omits the field entirely", async () => {
    await mountCustomer();
    await click(q('[data-testid="customer-suspend"]'));
    const d = dialog("customer-suspend")!;
    await type(d.querySelector("[data-confirm-action-typed-input]"), "SUSPEND");
    await confirmDialog("customer-suspend");
    expect(JSON.parse(posts()[0].body as string)).toEqual({ teamId: WS });
  });

  it("a 500 surfaces an error, claims no success, and leaves the customer ACTIVE", async () => {
    suspendReply = () => apiFailure(500);
    await mountCustomer();
    const readsBefore = gets().length;
    await click(q('[data-testid="customer-suspend"]'));
    const d = dialog("customer-suspend")!;
    await type(d.querySelector("[data-confirm-action-typed-input]"), "SUSPEND");
    await confirmDialog("customer-suspend");

    expect(errorToasts().length).toBeGreaterThan(0);
    expect(successToasts()).toHaveLength(0);
    // failureLeavesStateCorrect — still the suspend affordance, no resume.
    expect(q('[data-testid="customer-suspend"]')).not.toBeNull();
    expect(q('[data-testid="customer-resume"]')).toBeNull();
    expect(gets().length).toBe(readsBefore);
    expect(document.body.textContent).not.toContain("request failed");
  });
});

describe("Customer detail — POST /v1/admin/orgs/:id/resume", () => {
  it("a SUSPENDED customer offers Resume; confirm posts { teamId } once and re-reads", async () => {
    customerDetailReply = () => customerDetail({ status: "SUSPENDED" });
    await mountCustomer();
    expect(q('[data-testid="customer-suspend"]')).toBeNull();

    await click(q('[data-testid="customer-resume"]'));
    const d = dialog("customer-resume");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Northgate Insurance");
    // Resume is deliberately NOT typed-confirm gated.
    expect(d!.querySelector("[data-confirm-action-typed-input]")).toBeNull();
    expect(writes()).toHaveLength(0);

    const readsBefore = gets().length;
    customerDetailReply = () => customerDetail({ status: "ACTIVE" });
    await confirmDialog("customer-resume");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/v1/admin/orgs/${ORG}/resume`);
    expect(JSON.parse(posts()[0].body as string)).toEqual({ teamId: WS });
    expect(gets().length).toBeGreaterThan(readsBefore);
    expect(toastText()).toContain("Organization resumed.");
    expect(q('[data-testid="customer-suspend"]')).not.toBeNull();
  });

  it("cancel resumes nothing", async () => {
    customerDetailReply = () => customerDetail({ status: "SUSPENDED" });
    await mountCustomer();
    await click(q('[data-testid="customer-resume"]'));
    await cancelDialog("customer-resume");
    expect(writes()).toHaveLength(0);
    expect(q('[data-testid="customer-resume"]')).not.toBeNull();
  });
});

// ===========================================================================
// POST /v1/admin/incidents/:id/{acknowledge,resolve,assign} — operations
// ===========================================================================

describe("Operations — incident actions", () => {
  it("acknowledge deliberately does NOT confirm: the click fires the request with no dialog", async () => {
    await mountOperations();
    await click(
      screen.getByRole("button", {
        name: 'Acknowledge "Report generation failed"',
      }),
    );

    // POST /v1/admin/incidents/:id/acknowledge — no dialog ever appeared.
    expect(q('[role="dialog"]')).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/v1/admin/incidents/${INC_OPEN}/acknowledge`);
    expect(JSON.parse(posts()[0].body as string)).toEqual({});
    expect(toastText()).toContain("Incident acknowledged.");
  });

  it("assign-to-me deliberately does NOT confirm, and posts the caller's own id", async () => {
    await mountOperations();
    await click(
      screen.getByRole("button", {
        name: 'Assign to me: "Report generation failed"',
      }),
    );

    // POST /v1/admin/incidents/:id/assign — no dialog ever appeared.
    expect(q('[role="dialog"]')).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/v1/admin/incidents/${INC_OPEN}/assign`);
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      assigneeUserId: ME,
    });
    expect(toastText()).toContain("Incident assigned to you.");
  });

  it("unassign posts null — the same route, one transition, no dialog", async () => {
    await mountOperations();
    await click(
      screen.getByRole("button", {
        name: 'Unassign: "Trusted timestamp failed"',
      }),
    );

    expect(q('[role="dialog"]')).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/v1/admin/incidents/${INC_OWNED}/assign`);
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      assigneeUserId: null,
    });
    expect(toastText()).toContain("Incident returned to the unassigned queue.");
  });

  it("resolve DOES confirm first, naming the condition and its workspace, with nothing sent", async () => {
    await mountOperations();
    const resolveButtons = screen.getAllByRole("button", { name: "Resolve" });
    await click(resolveButtons[0]);

    const d = dialog("confirm-action-modal");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Report generation failed");
    expect(d!.textContent).toContain("Northgate Claims");
    expect(writes()).toHaveLength(0);
  });

  it("cancel resolves nothing", async () => {
    await mountOperations();
    await click(screen.getAllByRole("button", { name: "Resolve" })[0]);
    await cancelDialog("confirm-action-modal");
    expect(writes()).toHaveLength(0);
  });

  it("confirm posts once to /resolve, re-reads the feed, then announces", async () => {
    const gate = deferred<unknown>();
    incidentMutationReply = () => gate.promise;
    await mountOperations();
    const feedReadsBefore = gets().filter((r) =>
      r.path.startsWith("/v1/admin/incidents?"),
    ).length;

    await click(screen.getAllByRole("button", { name: "Resolve" })[0]);
    await confirmDialog("confirm-action-modal");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/v1/admin/incidents/${INC_OPEN}/resolve`);
    expect(JSON.parse(posts()[0].body as string)).toEqual({});
    expect(successToasts()).toHaveLength(0);

    gate.resolve({ ok: true });
    await settle();

    expect(toastText()).toContain("Incident resolved.");
    const feedReadsAfter = gets().filter((r) =>
      r.path.startsWith("/v1/admin/incidents?"),
    ).length;
    expect(feedReadsAfter).toBeGreaterThan(feedReadsBefore);
  });

  it("a refused resolve surfaces as a refusal, with no success indicator", async () => {
    incidentMutationReply = () => apiFailure(500);
    await mountOperations();
    await click(screen.getAllByRole("button", { name: "Resolve" })[0]);
    await confirmDialog("confirm-action-modal");

    expect(errorToasts().length).toBeGreaterThan(0);
    expect(successToasts()).toHaveLength(0);
    expect(toastText()).not.toContain("Incident resolved.");
    expect(document.body.textContent).not.toContain("request failed");
  });

  it("a failed acknowledge changes nothing and claims nothing", async () => {
    incidentMutationReply = () => apiFailure(500);
    await mountOperations();
    const feedReadsBefore = gets().filter((r) =>
      r.path.startsWith("/v1/admin/incidents?"),
    ).length;
    await click(
      screen.getByRole("button", {
        name: 'Acknowledge "Report generation failed"',
      }),
    );

    expect(errorToasts().length).toBeGreaterThan(0);
    expect(successToasts()).toHaveLength(0);
    // No re-read on failure — the queue keeps the rows the last read returned.
    expect(
      gets().filter((r) => r.path.startsWith("/v1/admin/incidents?")).length,
    ).toBe(feedReadsBefore);
    expect(
      screen.getByRole("button", {
        name: 'Acknowledge "Report generation failed"',
      }),
    ).toBeTruthy();
  });
});

// ===========================================================================
// POST /v1/support-access/{start,enter,revoke} — support-access
// ===========================================================================

describe("Support access — POST /v1/support-access/start", () => {
  async function fillMintForm() {
    await mountSupportAccess();
    await type(q('[data-testid="mint-organization-id"]'), ORG);
    await type(
      q('[data-testid="mint-reason"]'),
      "Customer export incident 4821",
    );
  }

  it("asks first, before any request; cancel mints nothing", async () => {
    await fillMintForm();
    await click(screen.getByRole("button", { name: "Create support grant" }));

    const d = dialog("support-access-start");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("support grant");
    expect(writes()).toHaveLength(0);

    await cancelDialog("support-access-start");
    expect(writes()).toHaveLength(0);
    expect(q("[data-support-access-notice]")).toBeNull();
  });

  it("confirm posts once with the full mint body, and the notice waits for the server", async () => {
    const gate = deferred<unknown>();
    supportMutationReply = () => gate.promise;
    await fillMintForm();
    const grantReadsBefore = gets().filter((r) =>
      r.path.startsWith("/v1/support-access/grants"),
    ).length;

    await click(screen.getByRole("button", { name: "Create support grant" }));
    await confirmDialog("support-access-start");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe("/v1/support-access/start");
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      teamId: WS,
      organizationId: ORG,
      reason: "Customer export incident 4821",
      accessLevel: "READ_ONLY",
    });
    expect(q("[data-support-access-notice]")).toBeNull();

    gate.resolve({ ok: true });
    await settle();

    expect(q("[data-support-access-notice]")?.textContent).toContain(
      "Support grant created.",
    );
    // refreshFromServer — the grants table was re-read.
    expect(
      gets().filter((r) => r.path.startsWith("/v1/support-access/grants"))
        .length,
    ).toBeGreaterThan(grantReadsBefore);
  });

  it("a 500 shows the mutation-failure card and no notice", async () => {
    supportMutationReply = () => apiFailure(500);
    await fillMintForm();
    await click(screen.getByRole("button", { name: "Create support grant" }));
    await confirmDialog("support-access-start");

    expect(q('[data-support-access-mutation-failure="error"]')).not.toBeNull();
    expect(q("[data-support-access-notice]")).toBeNull();
    expect(document.body.textContent).not.toContain("request failed");
  });
});

describe("Support access — POST /v1/support-access/enter", () => {
  it("asks first; cancel enters nothing", async () => {
    await mountSupportAccess();
    await click(q(`[data-support-access-enter="${GRANT}"]`));

    const d = dialog("support-access-enter");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("support audit trail");
    expect(writes()).toHaveLength(0);

    await cancelDialog("support-access-enter");
    expect(writes()).toHaveLength(0);
    expect(q("[data-support-context-active]")).toBeNull();
  });

  it("confirm posts { teamId, grantId } once; the context banner waits for the server and the token never renders", async () => {
    const gate = deferred<unknown>();
    supportMutationReply = () => gate.promise;
    await mountSupportAccess();

    await click(q(`[data-support-access-enter="${GRANT}"]`));
    await confirmDialog("support-access-enter");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe("/v1/support-access/enter");
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      teamId: WS,
      grantId: GRANT,
    });
    expect(q("[data-support-context-active]")).toBeNull();

    gate.resolve({
      supportContextToken: "SECRET-CONTEXT-TOKEN-NEVER-RENDERED",
      expiresInSeconds: 900,
    });
    await settle();

    expect(q(`[data-support-context-active="${GRANT}"]`)).not.toBeNull();
    expect(q("[data-support-access-notice]")?.textContent).toContain(
      "Support context active for this tab.",
    );
    // Secret discipline — the token reaches no rendered markup.
    expect(document.body.innerHTML).not.toContain(
      "SECRET-CONTEXT-TOKEN-NEVER-RENDERED",
    );
  });

  it("a 500 leaves the tab out of support context", async () => {
    supportMutationReply = () => apiFailure(500);
    await mountSupportAccess();
    await click(q(`[data-support-access-enter="${GRANT}"]`));
    await confirmDialog("support-access-enter");

    expect(q('[data-support-access-mutation-failure="error"]')).not.toBeNull();
    expect(q("[data-support-context-active]")).toBeNull();
    expect(q("[data-support-access-notice]")).toBeNull();
  });
});

describe("Support access — POST /v1/support-access/revoke", () => {
  it("asks first with the danger tone; cancel revokes nothing", async () => {
    await mountSupportAccess();
    await click(q(`[data-support-access-revoke="${GRANT}"]`));

    const d = dialog("support-access-revoke");
    expect(d).not.toBeNull();
    expect(d!.getAttribute("data-confirm-action-tone")).toBe("danger");
    expect(writes()).toHaveLength(0);

    await cancelDialog("support-access-revoke");
    expect(writes()).toHaveLength(0);
  });

  it("confirm posts { teamId, grantId } once, re-reads the grants, then announces", async () => {
    const gate = deferred<unknown>();
    supportMutationReply = () => gate.promise;
    await mountSupportAccess();
    const grantReadsBefore = gets().filter((r) =>
      r.path.startsWith("/v1/support-access/grants"),
    ).length;

    await click(q(`[data-support-access-revoke="${GRANT}"]`));
    await confirmDialog("support-access-revoke");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe("/v1/support-access/revoke");
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      teamId: WS,
      grantId: GRANT,
    });
    expect(q("[data-support-access-notice]")).toBeNull();

    supportGrantsReply = () => ({
      grants: [
        supportGrant({
          status: "REVOKED",
          revokedAtUtc: "2026-09-03T09:00:00.000Z",
        }),
      ],
      total: 1,
      limit: 50,
    });
    gate.resolve({ ok: true });
    await settle();

    expect(q("[data-support-access-notice]")?.textContent).toContain(
      "Support grant revoked.",
    );
    expect(
      gets().filter((r) => r.path.startsWith("/v1/support-access/grants"))
        .length,
    ).toBeGreaterThan(grantReadsBefore);
  });

  it("a 500 keeps the failure card and no notice", async () => {
    supportMutationReply = () => apiFailure(500);
    await mountSupportAccess();
    await click(q(`[data-support-access-revoke="${GRANT}"]`));
    await confirmDialog("support-access-revoke");

    expect(q('[data-support-access-mutation-failure="error"]')).not.toBeNull();
    expect(q("[data-support-access-notice]")).toBeNull();
  });
});

// ===========================================================================
// POST /v1/break-glass/{activate,revoke} — support-access
// ===========================================================================

describe("Break-glass — POST /v1/break-glass/activate", () => {
  async function fillBreakGlassForm() {
    await mountSupportAccess();
    await type(q('[data-testid="mint-organization-id"]'), ORG);
    await type(q('[data-testid="mint-reason"]'), "Ransomware containment");
    await type(q('[data-testid="break-glass-user-id"]'), COLLEAGUE);
  }

  it("asks first with the danger tone; cancel activates nothing", async () => {
    await fillBreakGlassForm();
    await click(screen.getByRole("button", { name: "Activate break-glass" }));

    const d = dialog("break-glass-activate");
    expect(d).not.toBeNull();
    expect(d!.getAttribute("data-confirm-action-tone")).toBe("danger");
    expect(d!.textContent).toContain("bypasses the ordinary permission model");
    expect(writes()).toHaveLength(0);

    await cancelDialog("break-glass-activate");
    expect(writes()).toHaveLength(0);
    expect(q("[data-support-access-notice]")).toBeNull();
  });

  it("confirm posts the full emergency body once, re-reads, then announces", async () => {
    const gate = deferred<unknown>();
    supportMutationReply = () => gate.promise;
    await fillBreakGlassForm();
    const emergencyReadsBefore = gets().filter((r) =>
      r.path.startsWith("/v1/break-glass/grants"),
    ).length;

    await click(screen.getByRole("button", { name: "Activate break-glass" }));
    await confirmDialog("break-glass-activate");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe("/v1/break-glass/activate");
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      teamId: WS,
      organizationId: ORG,
      emergencyUserId: COLLEAGUE,
      reason: "Ransomware containment",
      grantedRole: "EMERGENCY_READ_ONLY",
    });
    expect(q("[data-support-access-notice]")).toBeNull();

    gate.resolve({ ok: true });
    await settle();

    expect(q("[data-support-access-notice]")?.textContent).toContain(
      "Break-glass access activated.",
    );
    expect(
      gets().filter((r) => r.path.startsWith("/v1/break-glass/grants")).length,
    ).toBeGreaterThan(emergencyReadsBefore);
  });

  it("a 500 shows the failure card and activates nothing", async () => {
    supportMutationReply = () => apiFailure(500);
    await fillBreakGlassForm();
    await click(screen.getByRole("button", { name: "Activate break-glass" }));
    await confirmDialog("break-glass-activate");

    expect(q('[data-support-access-mutation-failure="error"]')).not.toBeNull();
    expect(q("[data-support-access-notice]")).toBeNull();
  });
});

describe("Break-glass — POST /v1/break-glass/revoke", () => {
  it("asks first; cancel keeps the emergency grant untouched", async () => {
    await mountSupportAccess();
    await click(q(`[data-break-glass-revoke="${EMERGENCY}"]`));

    const d = dialog("break-glass-revoke");
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("cut immediately");
    expect(writes()).toHaveLength(0);

    await cancelDialog("break-glass-revoke");
    expect(writes()).toHaveLength(0);
  });

  it("confirm posts { teamId, grantId } once, re-reads the emergency grants, then announces", async () => {
    const gate = deferred<unknown>();
    supportMutationReply = () => gate.promise;
    await mountSupportAccess();
    const emergencyReadsBefore = gets().filter((r) =>
      r.path.startsWith("/v1/break-glass/grants"),
    ).length;

    await click(q(`[data-break-glass-revoke="${EMERGENCY}"]`));
    await confirmDialog("break-glass-revoke");

    expect(writes()).toHaveLength(1);
    expect(posts()[0].path).toBe("/v1/break-glass/revoke");
    expect(JSON.parse(posts()[0].body as string)).toEqual({
      teamId: WS,
      grantId: EMERGENCY,
    });
    expect(q("[data-support-access-notice]")).toBeNull();

    gate.resolve({ ok: true });
    await settle();

    expect(q("[data-support-access-notice]")?.textContent).toContain(
      "Break-glass grant revoked.",
    );
    expect(
      gets().filter((r) => r.path.startsWith("/v1/break-glass/grants")).length,
    ).toBeGreaterThan(emergencyReadsBefore);
  });

  it("a 500 keeps the failure card, no notice", async () => {
    supportMutationReply = () => apiFailure(500);
    await mountSupportAccess();
    await click(q(`[data-break-glass-revoke="${EMERGENCY}"]`));
    await confirmDialog("break-glass-revoke");

    expect(q('[data-support-access-mutation-failure="error"]')).not.toBeNull();
    expect(q("[data-support-access-notice]")).toBeNull();
  });
});
