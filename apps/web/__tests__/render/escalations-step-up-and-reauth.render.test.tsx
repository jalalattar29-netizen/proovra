/**
 * Stage B — T-032 / T-029 on the Escalations page, with the real page, the
 * real StepUpModal and the real apiFetch over a stubbed network.
 *
 * On e4e908e88 a resolve refused with 401 STEP_UP_REQUIRED showed only the
 * text "Confirm your identity and try again" (nothing to confirm with), and a
 * 401 reauth_required showed "Your session may have expired" while the person
 * was signed in. Now:
 *   - STEP_UP_REQUIRED opens the shared dialog in place, a confirmed challenge
 *     retries ONCE with the challenge header, and the reason modal keeps its
 *     text while the dialog is open;
 *   - reauth_required offers "Sign in again" in a separate window, never the
 *     expired-session copy; the action runs again only when the person chooses
 *     Continue, and never as a different account.
 */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/reviewer-ops/escalations",
  useParams: () => ({}),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import EscalationsPage from "../../app/(app)/reviewer-ops/escalations/page";
import { reauthWindow } from "../../components/identity-security/StepUpModal";
import { setActiveWorkspaceId } from "../../lib/api";

const WS = "88888888-8888-4888-8888-888888888888";
const ESC = "e0000000-0000-4000-8000-000000000001";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let resolveAnswers: Array<{ status: number; body: unknown }> = [];
let meId = ME;

function escalation() {
  return {
    id: ESC,
    teamId: WS,
    workflowId: "11111111-2222-4333-8444-555555555555",
    evidenceId: null,
    reason: "SLA_BREACH",
    severity: "HIGH",
    status: "OPEN",
    safeSummary: "Review passed its deadline",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    resolutionNote: null,
    suppressedAtUtc: null,
    suppressionReason: null,
    assignedToUserId: null,
    incidentId: null,
  };
}

beforeEach(() => {
  calls = [];
  resolveAnswers = [];
  meId = ME;
  setActiveWorkspaceId(WS);
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ path, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path.startsWith("/v1/reviewer-ops/escalations?")) return json(200, { escalations: [escalation()], total: 1 });
    if (path.startsWith(`/v1/reviewer-ops/escalations/${ESC}/resolve`)) {
      const next = resolveAnswers.shift() ?? { status: 200, body: { escalation: escalation() } };
      return json(next.status, next.body);
    }
    if (path === "/v1/identity-security/step-up/start") {
      return json(200, { challenge: { id: "c0000000-0000-4000-8000-000000000001", status: "PENDING" }, method: "TOTP" });
    }
    if (path === "/v1/identity-security/step-up/check") return json(200, { status: "approved" });
    if (path === "/v1/auth/me") return json(200, { user: { id: meId } });
    return json(404, { error: { code: "not_found" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function envelope() {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: {
      EVIDENCE_VIEW: true,
      REVIEWER_OPS_VIEW: true,
      REVIEWER_OPS_ACT: true,
      ESCALATIONS_VIEW: true,
      REVIEW_ASSIGN: true,
    },
    diagnostics: { requestId: "stage-b-escalations" },
    user: { id: ME, email: null, displayName: null, firstName: null, lastName: null, avatarUrl: null, locale: null, timezone: null },
    workspace: { id: WS, name: "Personal Space", status: "active", scope: "PERSONAL", membership: { role: "OWNER" } },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: "Owner" },
    personalSpace: { id: WS, status: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
    account: { accountPlan: "TEAM", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { reviewerOperationsIncluded: true, reviewQueuesIncluded: true },
  };
}

async function settle() {
  for (let i = 0; i < 14; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function openResolveAndSubmit(note: string) {
  render(
    <PlatformContextProvider testEnvelope={envelope() as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <EscalationsPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
  await settle();
  fireEvent.click(document.querySelector("[data-escalation-action-resolve]") as HTMLElement);
  await settle();
  const input = document.querySelector("[data-reviewer-reason-input]") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: note } });
  await act(async () => {
    fireEvent.click(document.querySelector("[data-reviewer-reason-submit]") as HTMLElement);
  });
  await settle();
}

const resolveCalls = () => calls.filter((c) => c.path.startsWith(`/v1/reviewer-ops/escalations/${ESC}/resolve`));

describe("T-032 the shared step-up flow runs on the Escalations page", () => {
  it("a 401 STEP_UP_REQUIRED on resolve opens the dialog with the reason; a confirmed challenge retries once with the header", async () => {
    resolveAnswers = [
      {
        status: 401,
        body: {
          error: {
            code: "STEP_UP_REQUIRED",
            message: "Step-up verification required.",
            details: {
              purpose: "REVIEWER_OPS_ESCALATION_RESOLVE",
              resourceKind: "review_escalation",
              resourceId: ESC,
              teamId: WS,
              reason: "policy_flag:requireStepUpForEscalationResolve",
            },
          },
        },
      },
    ];
    await openResolveAndSubmit("Handled with the client");
    const dialog = document.querySelector("[data-step-up-modal]");
    expect(dialog).not.toBeNull();
    expect(document.querySelector("[data-step-up-reason]")!.textContent).toMatch(/resolve or suppress escalations/);
    // The reason modal and its text are still there behind the dialog.
    expect((document.querySelector("[data-reviewer-reason-input]") as HTMLTextAreaElement).value).toBe("Handled with the client");
    expect(document.body.textContent).not.toMatch(/Confirm your identity and try again/);

    const code = document.querySelector("[data-step-up-code-input]") as HTMLInputElement;
    fireEvent.change(code, { target: { value: "123456" } });
    await act(async () => {
      fireEvent.submit(document.querySelector('[data-step-up-form="code"]') as HTMLFormElement);
    });
    await settle();
    const sent = resolveCalls();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers["x-proovra-step-up-challenge-id"]).toBe("c0000000-0000-4000-8000-000000000001");
    expect(sent[1]!.body).toMatchObject({ teamId: WS, resolutionNote: "Handled with the client" });
    expect(document.querySelector("[data-step-up-modal]")).toBeNull();
  });

  it("no factor: the enrolment state says why, offers Set up two-factor (returning here) and Not now — never only Close, never 'cancelled'", async () => {
    resolveAnswers = [
      {
        status: 401,
        body: {
          error: {
            code: "STEP_UP_REQUIRED",
            message: "Step-up verification required.",
            details: { purpose: "REVIEWER_OPS_ESCALATION_RESOLVE", resourceKind: "review_escalation", resourceId: ESC, teamId: WS, reason: "elevated_session_risk" },
          },
        },
      },
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/v1/identity-security/step-up/start")) {
        return new Response(
          JSON.stringify({ error: { code: "STEP_UP_ENROLLMENT_REQUIRED", message: "x", acceptedFactors: ["TOTP"] } }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return (realFetch as (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    await openResolveAndSubmit("Handled");
    const panel = document.querySelector("[data-step-up-enrollment-required]") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toMatch(/unusual sign-in activity/);
    const enrol = document.querySelector("[data-step-up-enroll-now]") as HTMLAnchorElement;
    expect(enrol.textContent).toBe("Set up two-factor");
    expect(enrol.getAttribute("href")).toMatch(/^\/settings\?returnTo=%2F.*#security$/);
    expect((document.querySelector("[data-step-up-cancel]") as HTMLElement).textContent).toBe("Not now");
    await act(async () => {
      fireEvent.click(document.querySelector("[data-step-up-cancel]") as HTMLElement);
    });
    await settle();
    expect(document.body.textContent).not.toMatch(/cancelled/i);
    expect(document.body.textContent).toMatch(/needs a second factor: set one up under Settings/);
    expect(resolveCalls()).toHaveLength(1);
  });
});

describe("T-029 reauth_required is 'sign in again', returns to the task and never runs on its own", () => {
  const reauth = {
    status: 401,
    body: {
      error: {
        code: "reauth_required",
        message: "Sign in again to perform this action.",
        reason: "session_too_old_for_privileged_action",
        details: { reason: "session_age_window", technicalReason: "session_too_old_for_privileged_action", action: "REVIEW_ESCALATION_RESOLVE", windowHours: 8 },
      },
    },
  };

  it("offers Sign in again (separate window), keeps the typed text, and re-runs once only after Continue", async () => {
    resolveAnswers = [reauth];
    const opened: string[] = [];
    vi.spyOn(reauthWindow, "open").mockImplementation((url: string) => {
      opened.push(url);
      return true;
    });
    await openResolveAndSubmit("Typed before the refusal");
    const panel = document.querySelector("[data-step-up-reauth-required]") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toMatch(/sign in again/i);
    expect(panel.textContent).toMatch(/last 8 hours/);
    expect(document.body.textContent).not.toMatch(/session may have expired/i);
    expect((document.querySelector("[data-reviewer-reason-input]") as HTMLTextAreaElement).value).toBe("Typed before the refusal");

    await act(async () => {
      fireEvent.click(document.querySelector("[data-step-up-reauth-sign-in]") as HTMLElement);
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^\/login\?reauth=1&next=%2Fauth%2Freauth-complete$/);
    await settle();
    // Nothing ran on its own while the person signed in.
    expect(resolveCalls()).toHaveLength(1);

    await act(async () => {
      fireEvent.click(document.querySelector("[data-step-up-reauth-continue]") as HTMLElement);
    });
    await settle();
    const sent = resolveCalls();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toMatchObject({ resolutionNote: "Typed before the refusal" });
    expect(document.querySelector("[data-step-up-modal]")).toBeNull();
  });

  it("a different account in the sign-in window does not run the action", async () => {
    resolveAnswers = [reauth];
    vi.spyOn(reauthWindow, "open").mockImplementation(() => true);
    await openResolveAndSubmit("Typed");
    await act(async () => {
      fireEvent.click(document.querySelector("[data-step-up-reauth-sign-in]") as HTMLElement);
    });
    await settle();
    meId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await act(async () => {
      fireEvent.click(document.querySelector("[data-step-up-reauth-continue]") as HTMLElement);
    });
    await settle();
    expect(resolveCalls()).toHaveLength(1);
    expect(document.querySelector("[data-step-up-reauth-notice]")!.textContent).toMatch(/different account/);
  });
});
