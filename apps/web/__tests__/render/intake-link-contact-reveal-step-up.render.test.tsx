/**
 * OBS-INTAKE-REVEAL-STEPUP (closure phase 3) — the intake-links list's
 * "Show full contact" answers the step-up the reveal route now asks for.
 *
 * POST /v1/workflow/intake-links/:id/recipient-contact answers 401
 * STEP_UP_REQUIRED (purpose INTAKE_LINK_CONTACT_REVEAL, bound to the link)
 * until a fresh approved challenge comes with the request. The REAL
 * `useStepUpAction` + `StepUpModal` and the REAL `apiFetch` run here; only the
 * network (`fetch`) is a double. The proof is that the refused reveal is sent
 * again with `x-proovra-step-up-challenge-id` after the challenge is approved
 * and the raw contact is then shown, and that a cancelled challenge reveals
 * nothing and says nothing.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const TEAM = "11111111-1111-4111-8111-111111111111";
const LINK = "44444444-4444-4444-8444-444444444444";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform-context")>()),
  useActiveWorkspaceId: () => "11111111-1111-4111-8111-111111111111",
  useTeamId: () => "11111111-1111-4111-8111-111111111111",
}));

import { RecordsSurface } from "../../app/(app)/intake-links/_components/RecordsSurface";
import type { IntakeLinkListItem } from "../../app/(app)/intake-links/_lib/types";

const ISO = "2026-11-20T10:00:00.000Z";
const RAW_EMAIL = "recipient@contact.example.test";
const RAW_PHONE = "+447700900123";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const item: IntakeLinkListItem = {
  link: {
    id: LINK,
    teamId: TEAM,
    workflowTemplateSlug: "general-evidence-record",
    workflowTemplateVersion: 1,
    workflowTemplateName: "General evidence record",
    intakeMode: "EXTERNAL_ONE_TIME",
    caseId: null,
    recipientLabel: "Dana",
    customerId: null,
    recipientEmailPreview: "r***@contact.example.test",
    recipientPhonePreview: "+44 ••• 23",
    recipientEmail: null,
    recipientPhone: null,
    hasRecipientEmail: true,
    hasRecipientPhone: true,
    recipientContactRevealAuthorized: true,
    maxUses: 1,
    usedCount: 0,
    status: "ACTIVE",
    expiresAtUtc: "2026-12-20T10:00:00.000Z",
    revokedAtUtc: null,
    revokedReason: null,
    archivedAtUtc: null,
    createdAt: ISO,
    updatedAt: ISO,
  },
  delivery: {
    latestStatus: null,
    latestChannel: "MANUAL",
    latestAtUtc: null,
    latestSentAtUtc: null,
    latestDeliveredAtUtc: null,
    latestFailedAtUtc: null,
    latestErrorCode: null,
    attemptCount: 0,
    channelsAttempted: [],
    latestProviderMessageId: null,
  },
  activity: {
    firstOpenedAtUtc: null,
    lastOpenedAtUtc: null,
    firstStartedAtUtc: null,
    lastStartedAtUtc: null,
    firstSubmittedAtUtc: null,
    lastSubmittedAtUtc: null,
    sessionsCreated: 0,
    sessionsOpened: 0,
    sessionsStarted: 0,
    sessionsSubmitted: 0,
    sessionsExpired: 0,
    sessionsRevoked: 0,
    evidenceCount: 0,
  },
  computedLifecycle: "CREATED",
} as IntakeLinkListItem;

const handlers = {
  onOpenDetails: () => {},
  onOpenDelivery: () => {},
  onOpenSubmissions: () => {},
  onDisable: () => {},
  onArchive: () => {},
  pendingArchiveId: null,
};

const fetchMock = vi.fn();
const header = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers as HeadersInit | undefined).get(name);
const revealCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(`/v1/workflow/intake-links/${LINK}/recipient-contact`));
const startBodies = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/step-up/start"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/step-up/start")) {
      return json({ challenge: { id: "challenge-1" }, method: "TOTP", availableMethods: ["TOTP"] });
    }
    if (url.includes("/step-up/check")) return json({ status: "approved" });
    if (url.includes(`/v1/workflow/intake-links/${LINK}/recipient-contact`)) {
      if (header(init, "x-proovra-step-up-challenge-id") !== "challenge-1") {
        return json(
          {
            error: {
              code: "STEP_UP_REQUIRED",
              message: "Step-up verification required.",
              details: { purpose: "INTAKE_LINK_CONTACT_REVEAL", resourceKind: "workflow_intake_link", resourceId: LINK },
              purpose: "INTAKE_LINK_CONTACT_REVEAL",
              resourceKind: "workflow_intake_link",
              resourceId: LINK,
            },
          },
          401,
        );
      }
      return json({ recipientContact: { recipientEmail: RAW_EMAIL, recipientPhone: RAW_PHONE } });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "alert").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function startReveal() {
  render(<RecordsSurface items={[item]} handlers={handlers} now={Date.parse(ISO)} />);
  expect(screen.queryByText(RAW_EMAIL)).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Show full contact" })[0]!);
  await screen.findByRole("dialog", { name: "Step-up confirmation" });
  await waitFor(() => expect(startBodies()).toHaveLength(1));
  expect(startBodies()[0]).toMatchObject({
    teamId: TEAM,
    purpose: "INTAKE_LINK_CONTACT_REVEAL",
    resourceKind: "workflow_intake_link",
    resourceId: LINK,
  });
}

describe("OBS-INTAKE-REVEAL-STEPUP — the intake-links list answers the reveal's step-up", () => {
  it("the refused reveal opens the step-up dialog; after approval it is retried once with the challenge and the raw contact is shown", async () => {
    await startReveal();
    expect(revealCalls()).toHaveLength(1);
    expect(header(revealCalls()[0]![1] as RequestInit, "x-proovra-step-up-challenge-id")).toBeNull();

    const input = (await waitFor(() => {
      const el = document.querySelector("[data-step-up-modal] input") as HTMLInputElement | null;
      if (!el) throw new Error("no code input yet");
      return el;
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(document.querySelector("[data-step-up-verify]") as HTMLElement);

    await waitFor(() => expect(revealCalls()).toHaveLength(2));
    const retry = revealCalls()[1]![1] as RequestInit;
    expect(retry.method).toBe("POST");
    expect(header(retry, "x-proovra-step-up-challenge-id")).toBe("challenge-1");
    expect((await screen.findAllByText(RAW_EMAIL)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("a cancelled step-up reveals nothing, sends nothing more and shows no failure", async () => {
    await startReveal();
    fireEvent.click(document.querySelector("[data-step-up-cancel]") as HTMLElement);
    await waitFor(() => expect(document.querySelector("[data-step-up-modal]")).toBeNull());
    expect(revealCalls()).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/step-up/check"))).toBe(false);
    expect(screen.queryByText(RAW_EMAIL)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
