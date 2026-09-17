/**
 * BATCH J — Integrations: cancel a scheduled webhook redelivery.
 *
 *   POST /v1/integrations/webhook-deliveries/:id/cancel
 *     app/(app)/integrations/page.tsx (WebhookDeliveriesPanel) — "Cancel
 *     retry" beside Retry on RETRY_SCHEDULED rows only; confirmation; the
 *     payload is { teamId }; success is announced only after the delivery is
 *     reread from GET /v1/integrations/webhook-deliveries/:id and shows
 *     CANCELLED; 409 delivery_not_cancellable reads "already sent or finished".
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("../../app/(app)/integrations/_sections/EvidenceDeliveryHistorySection", () => ({
  EvidenceDeliveryHistorySection: () => null,
}));
vi.mock("../../lib/platform-context", () => {
  const space = { type: "ORGANIZATION", roleLabel: "OWNER" };
  return { useTeamId: () => TEAM, useActiveSpace: () => space };
});

import IntegrationsPage from "../../app/(app)/integrations/page";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOOK = "11111111-1111-4111-8111-111111111111";
const SCHEDULED = "22222222-2222-4222-8222-222222222222";
const FAILED = "33333333-3333-4333-8333-333333333333";
const ISO = "2026-09-01T10:00:00.000Z";

const webhook = {
  id: HOOK, teamId: TEAM, url: "https://receiver.example/hook", description: null, status: "ACTIVE",
  secretPrefix: "whsec_ab", eventTypes: [], failureCount: 0, lastSuccessAtUtc: null, lastFailureAtUtc: null,
  previousSecretPrefix: null, previousSecretValidUntilUtc: null, createdAt: ISO,
};
function delivery(id: string, status: string) {
  return {
    id, endpointId: HOOK, teamId: TEAM, eventId: "44444444-4444-4444-8444-444444444444", eventType: "evidence.created",
    status, attemptCount: 2, nextAttemptAtUtc: status === "RETRY_SCHEDULED" ? ISO : null, responseStatus: 500,
    responseBodyPreview: null, errorMessage: null, sentAtUtc: null, failedAtUtc: null, createdAt: ISO, updatedAt: ISO,
  };
}
function failure(statusCode: number, code?: string): Error {
  return Object.assign(new Error("request failed"), { statusCode, code });
}

let cancelled = false;
function defaultReply(path: string, init?: RequestInit): unknown {
  if (init?.method === "POST" && path.endsWith("/cancel")) {
    cancelled = true;
    return { delivery: delivery(SCHEDULED, "CANCELLED") };
  }
  if (path.startsWith("/v1/integrations/api-keys?")) return { apiKeys: [] };
  if (path.startsWith("/v1/integrations/webhooks?")) return { webhooks: [webhook] };
  if (path.startsWith(`/v1/integrations/webhooks/${HOOK}/deliveries?`)) {
    return { deliveries: [delivery(SCHEDULED, cancelled ? "CANCELLED" : "RETRY_SCHEDULED"), delivery(FAILED, "FAILED")] };
  }
  if (path.startsWith(`/v1/integrations/webhook-deliveries/${SCHEDULED}?`)) {
    return { delivery: delivery(SCHEDULED, cancelled ? "CANCELLED" : "RETRY_SCHEDULED") };
  }
  throw failure(503);
}

beforeEach(() => {
  cancelled = false;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => defaultReply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

const cancels = () => mocks.fetch.mock.calls.filter(([path, init]) => init?.method === "POST" && String(path).endsWith("/cancel"));
async function openPanel(): Promise<HTMLElement> {
  render(<IntegrationsPage />);
  fireEvent.click(await screen.findByTestId(`integrations-webhook-deliveries-toggle-${HOOK}`));
  const panel = await screen.findByTestId(`integrations-webhook-deliveries-panel-${HOOK}`);
  await within(panel).findByTestId(`integrations-webhook-delivery-row-${SCHEDULED}`);
  return panel;
}
const cancelButton = (panel: HTMLElement) => within(panel).getByRole("button", { name: "Cancel scheduled retry of Evidence created delivery" });

describe("webhook delivery cancel-retry workflow", () => {
  it("offers Cancel retry only on a retry-scheduled row", async () => {
    const panel = await openPanel();
    expect(within(within(panel).getByTestId(`integrations-webhook-delivery-row-${SCHEDULED}`)).getByRole("button", { name: /Cancel scheduled retry/ })).toBeTruthy();
    expect(within(within(panel).getByTestId(`integrations-webhook-delivery-row-${FAILED}`)).queryByRole("button", { name: /Cancel scheduled retry/ })).toBeNull();
  });

  it("cancels after confirmation and announces only after the delivery reread shows Cancelled", async () => {
    const panel = await openPanel();
    fireEvent.click(cancelButton(panel));
    await within(panel).findByText("Scheduled retry cancelled and confirmed from the saved delivery record.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Cancel the scheduled retry?", confirmLabel: "Cancel retry" }));
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "POST");
    expect(calls[write][0]).toBe(`/v1/integrations/webhook-deliveries/${SCHEDULED}/cancel`);
    expect(JSON.parse(calls[write][1].body)).toEqual({ teamId: TEAM });
    expect(calls[write + 1][0]).toBe(`/v1/integrations/webhook-deliveries/${SCHEDULED}?teamId=${TEAM}`);
    const row = within(panel).getByTestId(`integrations-webhook-delivery-row-${SCHEDULED}`);
    expect(within(row).getByText("Cancelled")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Cancel scheduled retry/ })).toBeNull();
  });

  it("declining the confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    const panel = await openPanel();
    fireEvent.click(cancelButton(panel));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(cancels()).toHaveLength(0);
    expect(within(panel).queryByText(/Scheduled retry cancelled/)).toBeNull();
  });

  it("maps 409 delivery_not_cancellable to already sent or finished and refreshes the list", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw failure(409, "delivery_not_cancellable");
      return defaultReply(path, init);
    });
    const panel = await openPanel();
    const listReads = () => mocks.fetch.mock.calls.filter(([p]) => String(p).startsWith(`/v1/integrations/webhooks/${HOOK}/deliveries?`)).length;
    const before = listReads();
    fireEvent.click(cancelButton(panel));
    const message = await within(panel).findByText(/already sent or finished/);
    expect(message.getAttribute("role")).toBe("alert");
    await waitFor(() => expect(listReads()).toBe(before + 1));
    expect(within(panel).queryByText(/Scheduled retry cancelled/)).toBeNull();
  });

  it("reports a refusal without claiming success", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw failure(403);
      return defaultReply(path, init);
    });
    const panel = await openPanel();
    fireEvent.click(cancelButton(panel));
    await within(panel).findByText("Your role cannot manage webhook deliveries in this workspace.");
    expect(within(panel).queryByText(/Scheduled retry cancelled/)).toBeNull();
  });

  it("does not claim success when the reread fails", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`/v1/integrations/webhook-deliveries/${SCHEDULED}?`)) throw failure(503);
      return defaultReply(path, init);
    });
    const panel = await openPanel();
    fireEvent.click(cancelButton(panel));
    await within(panel).findByText(/could not be reloaded to confirm it/);
    expect(within(panel).queryByText(/Scheduled retry cancelled/)).toBeNull();
  });

  it("does not claim success when the reread shows another state", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { delivery: delivery(SCHEDULED, "SENT") };
      if (path.startsWith(`/v1/integrations/webhook-deliveries/${SCHEDULED}?`)) return { delivery: delivery(SCHEDULED, "SENT") };
      return defaultReply(path, init);
    });
    const panel = await openPanel();
    fireEvent.click(cancelButton(panel));
    await within(panel).findByText(/now shows as Sent/);
    expect(within(panel).queryByText(/Scheduled retry cancelled/)).toBeNull();
  });

  it("a failed deliveries read is an alert, not the empty state", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith(`/v1/integrations/webhooks/${HOOK}/deliveries?`)) throw failure(403);
      return defaultReply(path, init);
    });
    render(<IntegrationsPage />);
    fireEvent.click(await screen.findByTestId(`integrations-webhook-deliveries-toggle-${HOOK}`));
    const error = await screen.findByTestId(`integrations-webhook-deliveries-error-${HOOK}`);
    expect(error.getAttribute("role")).toBe("alert");
    expect(screen.queryByTestId(`integrations-webhook-deliveries-empty-${HOOK}`)).toBeNull();
  });
});
