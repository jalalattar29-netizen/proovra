/**
 * D49 (2026-09-17) — the workflow instance detail page's legacy step waive
 * goes through the shared step-up flow.
 *
 *   POST /v1/workflows/instances/:id/steps/:stepKey/waive
 *     app/(app)/workflows/[id]/page.tsx — "Waive" behind "Show legacy step
 *     controls". The API requires an approved step-up challenge. The page
 *     used to POST without the step-up header and only alert, so the waive
 *     could never succeed from the UI.
 *
 * The step-up ceremony here is the REAL `useStepUpAction` + `StepUpModal`:
 * only `apiFetch` (the network edge) is a double. The proof is that the
 * refused request is sent AGAIN, after the challenge is approved, carrying
 * `x-proovra-step-up-challenge-id` — and that a cancelled challenge sends
 * nothing more.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: mocks.confirm }),
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const INSTANCE = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/workflows/x",
  useParams: () => ({ id: "11111111-1111-4111-8111-111111111111" }),
}));
vi.mock("../../lib/platform-context", () => ({
  useTeamId: () => "22222222-2222-4222-8222-222222222222",
}));

import WorkflowInstancePage from "../../app/(app)/workflows/[id]/page";

const ISO = "2026-09-01T10:00:00.000Z";
const WAIVE_PATH = `/v1/workflows/instances/${INSTANCE}/steps/scene-photo/waive`;

function stepUpRequired(): Error {
  // The shape `apiFetch` throws for the API's 401 STEP_UP_REQUIRED body.
  return Object.assign(new Error("Step-up verification required."), {
    code: "STEP_UP_REQUIRED",
    statusCode: 401,
    details: {
      purpose: "SESSION_SANITY_CHECK",
      resourceKind: "evidence_workflow_step_instance",
      resourceId: INSTANCE,
    },
  });
}

let waived = false;
function reply(path: string, init?: RequestInit & { headers?: Record<string, string> }): unknown {
  if (path === WAIVE_PATH) {
    if (!init?.headers?.["x-proovra-step-up-challenge-id"]) throw stepUpRequired();
    waived = true;
    return { step: { stepKey: "scene-photo", status: "WAIVED" } };
  }
  if (path === "/v1/identity-security/step-up/start") {
    return { challenge: { id: "challenge-1" }, method: "TOTP" };
  }
  if (path === "/v1/identity-security/step-up/check") return { status: "approved" };
  if (path.startsWith(`/v1/workflows/instances/${INSTANCE}/timeline`)) return { events: [] };
  if (path.startsWith(`/v1/workflows/instances/${INSTANCE}/export-policy`)) return null;
  if (path.startsWith(`/v1/workflows/instances/${INSTANCE}?`)) {
    return {
      instance: {
        id: INSTANCE,
        teamId: WS,
        status: "DRAFT",
        intakeMode: "AUTHENTICATED_STANDARD",
        actorRole: "OPERATOR",
        templateSlug: null,
        templateVersion: null,
        title: "Claim intake",
        assignedReviewerUserId: null,
        createdAt: ISO,
        updatedAt: ISO,
        submittedAtUtc: null,
        approvedAtUtc: null,
        closedAtUtc: null,
      },
      steps: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          stepKey: "scene-photo",
          title: "Scene photo",
          required: true,
          orderIndex: 0,
          status: waived ? "WAIVED" : "NOT_STARTED",
          mappedEvidenceId: null,
          completedAtUtc: null,
          waiverReason: waived ? "Scene no longer accessible." : null,
        },
      ],
      mappedEvidence: [],
    };
  }
  throw new Error("unexpected " + path);
}

const waiveCalls = () => mocks.fetch.mock.calls.filter(([path]) => path === WAIVE_PATH);

beforeEach(() => {
  waived = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit & { headers?: Record<string, string> }) =>
    reply(path, init),
  );
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  vi.spyOn(window, "prompt").mockReturnValue("Scene no longer accessible.");
  vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function startWaive() {
  render(<WorkflowInstancePage />);
  await screen.findByText("Scene photo");
  fireEvent.click(screen.getByLabelText("Show legacy step controls"));
  fireEvent.click(await screen.findByTestId("workflow-instance-legacy-step-waive"));
  // The API refused the first attempt: the real step-up modal opens and
  // mints a challenge for the resource the API named.
  const input = await waitFor(() => {
    const el = document.querySelector("[data-step-up-code-input]") as HTMLInputElement | null;
    expect(el).toBeTruthy();
    return el as HTMLInputElement;
  });
  const start = mocks.fetch.mock.calls.find(([p]) => p === "/v1/identity-security/step-up/start");
  expect(JSON.parse(start![1].body)).toEqual({
    teamId: WS,
    purpose: "SESSION_SANITY_CHECK",
    resourceKind: "evidence_workflow_step_instance",
    resourceId: INSTANCE,
  });
  return input;
}

describe("workflow instance legacy step waive — step-up (D49)", () => {
  it("retries the refused waive with the approved challenge id and rereads the step", async () => {
    const input = await startWaive();
    expect(waiveCalls()).toHaveLength(1);
    expect(waiveCalls()[0][1].headers["x-proovra-step-up-challenge-id"]).toBeUndefined();

    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(document.querySelector("[data-step-up-verify]") as HTMLElement);

    await waitFor(() => expect(waiveCalls()).toHaveLength(2));
    const [, retry] = waiveCalls()[1];
    expect(retry.method).toBe("POST");
    expect(retry.headers["x-proovra-step-up-challenge-id"]).toBe("challenge-1");
    expect(JSON.parse(retry.body)).toEqual({ teamId: WS, reason: "Scene no longer accessible." });
    // The page rereads and shows the waived step; the modal is closed and no
    // failure was shown.
    await screen.findByText(/waiver: Scene no longer accessible\./);
    expect(document.querySelector("[data-step-up-modal]")).toBeNull();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("a cancelled challenge sends nothing further and shows no failure", async () => {
    await startWaive();
    fireEvent.click(document.querySelector("[data-step-up-cancel]") as HTMLElement);
    await waitFor(() => expect(document.querySelector("[data-step-up-modal]")).toBeNull());
    expect(waiveCalls()).toHaveLength(1);
    expect(mocks.fetch.mock.calls.some(([p]) => p === "/v1/identity-security/step-up/check")).toBe(false);
    expect(window.alert).not.toHaveBeenCalled();
    expect(waived).toBe(false);
  });
});
