/**
 * F-15 / A2-11 (audit round 3, slice COM) — the plan's API key allowance on
 * Integrations.
 *
 * POST /v1/integrations/api-keys answers 429 `{ error: { code:
 * "api_key_limit_reached", details: { limit, current } } }` when the workspace's
 * plan allowance (INTEGRATION_API_KEYS_MAX; 0 on plans whose Pricing says API
 * access is "Not included") is used. The page fell through to the 429 bucket and
 * told the owner to try again later — a rate limit, which this is not. Through
 * the real `apiFetch` over a stubbed network. Also: a key the system revoked
 * when its creator was suspended (A2-10) says so in words.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform-context")>()),
  useTeamId: () => "11111111-1111-4111-8111-111111111111",
  useActiveSpaceId: () => "11111111-1111-4111-8111-111111111111",
  useActiveSpace: () => ({ type: "ORGANIZATION", roleLabel: "OWNER" }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: async () => true }),
}));
vi.mock("../../app/(app)/integrations/_sections/EvidenceDeliveryHistorySection", () => ({
  EvidenceDeliveryHistorySection: () => null,
}));

import IntegrationsPage from "../../app/(app)/integrations/page";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn();
const alertMock = vi.fn();

const suspendedKey = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Nightly sync",
  description: null,
  keyPrefix: "pwk_abcd",
  scopes: ["integration.evidence.read"],
  status: "REVOKED",
  createdByUserId: "55555555-5555-4555-8555-555555555555",
  createdAt: "2026-11-01T10:00:00.000Z",
  lastUsedAtUtc: null,
  revokedAtUtc: "2026-11-10T10:00:00.000Z",
  revokedReason: "creator_suspended",
  expiresAtUtc: null,
  rotationRequired: false,
  ipAllowlist: [],
  previousKeyPrefix: null,
  previousValidUntilUtc: null,
};

function serve(createAnswer: () => Response, keys: unknown[] = []) {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/integrations/api-keys") && init?.method === "POST") return createAnswer();
    if (url.includes("/v1/integrations/health")) return json({ error: { code: "unavailable", message: "unavailable" } }, 503);
    if (url.includes("/v1/integrations/diagnostics")) return json({ diagnostics: { enabled: true } });
    if (url.includes("/v1/integrations/api-keys")) return json({ apiKeys: keys });
    if (url.includes("/v1/integrations/webhooks")) return json({ webhooks: [] });
    return json({});
  });
}

async function createKey() {
  render(<IntegrationsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "New API key" }));
  fireEvent.change(await screen.findByPlaceholderText("e.g. Production data sync"), { target: { value: "sync" } });
  const dialogButtons = screen.getAllByRole("button");
  fireEvent.click(dialogButtons[dialogButtons.length - 1]!);
  await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
  return String(alertMock.mock.calls[0]![0]);
}

const limitRefusal = (limit: number, current: number) =>
  json({ error: { code: "api_key_limit_reached", details: { key: "INTEGRATION_API_KEYS_MAX", limit, current } } }, 429);

beforeEach(() => {
  fetchMock.mockReset();
  alertMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", alertMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Integrations words the plan's API key allowance", () => {
  it("a plan without API keys says so, keeps existing keys, and points to Billing — never 'try again later'", async () => {
    serve(() => limitRefusal(0, 1));
    const message = await createKey();
    expect(message).toMatch(/not included in this workspace's plan/);
    expect(message).toMatch(/Keys you already have keep working/);
    expect(message).toMatch(/Billing/);
    expect(message).not.toMatch(/too many|try again/i);
  });

  it("a plan whose keys are all in use names the allowance and the two ways forward", async () => {
    serve(() => limitRefusal(3, 3));
    const message = await createKey();
    expect(message).toMatch(/already has the 3 active API keys its plan includes/);
    expect(message).toMatch(/Revoke a key you no longer use, or upgrade/);
    expect(message).not.toMatch(/too many|try again/i);
  });

  it("without details the shared copy answers (one sentence for every client), not the 429 bucket", async () => {
    serve(() => json({ error: { code: "api_key_limit_reached" } }, 429));
    const message = await createKey();
    expect(message).toMatch(/Your plan does not allow another API key/);
    expect(message).not.toMatch(/too many|try again/i);
  });

  it("a key revoked because its creator was suspended says so, and that restoring does not bring it back", async () => {
    serve(() => json({}), [suspendedKey]);
    render(<IntegrationsPage />);
    const note = await screen.findByTestId("api-key-revoked-reason");
    expect(note.textContent).toMatch(/member who created this key was suspended/);
    expect(note.textContent).toMatch(/Restoring the member does not bring the key back/);
    expect(note.textContent).not.toMatch(/creator_suspended/);
  });
});
