/**
 * OPS-13 — an automatically disabled webhook destination says so.
 *
 * The panel read `enabled ? "Enabled" : disabledAt ? "Disabled" : "Not yet
 * enabled"`, and the delivery runtime's automatic disable sets neither
 * `enabled` nor `disabledAt` — so a destination Automation had switched off
 * after ten failed deliveries told its admin it had never been turned on.
 * The server now projects `autoDisabledAt` / `disabledReason`, and the status
 * line names the automatic disable and its reason.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: mocks.confirm }),
}));

import {
  AutomationWebhookDestinationsPanel,
  destinationStatusLabel,
  type AutomationWebhookDestination,
} from "../../components/automation/AutomationWebhookDestinationsPanel";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "11111111-1111-4111-8111-111111111111";
const ISO = "2026-09-01T10:00:00.000Z";

function dest(over: Partial<AutomationWebhookDestination> = {}): AutomationWebhookDestination {
  return {
    id: ID, teamId: TEAM, name: "Receiver", url: "https://receiver.example/hook", urlOrigin: "https://receiver.example",
    secretFingerprint: "fp", enabled: false, createdAt: ISO, updatedAt: ISO, disabledAt: null,
    lastSuccessAt: null, lastFailureAt: ISO, failureCount: 42, ...over,
  };
}

afterEach(cleanup);

describe("automatically disabled webhook destination", () => {
  it("reads 'Disabled automatically' with the failure count from its reason, not 'Not yet enabled'", async () => {
    mocks.fetch.mockResolvedValue({
      destinations: [
        dest({
          autoDisabledAt: ISO,
          disabledReason: "auto_disabled:consecutive_failures:10",
          consecutiveFailureCount: 10,
        }),
      ],
      limits: { maxDestinationsPerTeam: 10 },
    });
    render(<AutomationWebhookDestinationsPanel teamId={TEAM} canManage />);
    const item = (await screen.findByText("Receiver")).closest("li") as HTMLElement;
    expect(within(item).getByText("Disabled automatically after 10 consecutive failed deliveries")).toBeTruthy();
    expect(within(item).queryByText("Not yet enabled")).toBeNull();
    // The "Consecutive failures" field shows the consecutive run, not the lifetime total.
    expect(within(item).getByText("10")).toBeTruthy();
  });

  it("labels every state truthfully", () => {
    expect(destinationStatusLabel(dest({ enabled: true }))).toBe("Enabled");
    expect(destinationStatusLabel(dest({ disabledAt: ISO }))).toBe("Disabled");
    expect(destinationStatusLabel(dest())).toBe("Not yet enabled");
    expect(destinationStatusLabel(dest({ autoDisabledAt: ISO, disabledReason: null }))).toBe(
      "Disabled automatically after repeated failed deliveries",
    );
    // Re-enabled: the server cleared autoDisabledAt with the counter.
    expect(destinationStatusLabel(dest({ enabled: true, autoDisabledAt: null }))).toBe("Enabled");
  });
});
