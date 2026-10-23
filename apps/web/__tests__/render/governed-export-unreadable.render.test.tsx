/**
 * GovernedExportAction — an answer this build cannot read is an UNAVAILABLE
 * check, never a render crash and never an enabled export (2026-10-23).
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

let body: unknown = null;
vi.mock("../../lib/api", () => ({
  apiFetch: async () => body,
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { GovernedExportAction, readEligibilityResult } from "../../components/governance/GovernedExportAction";

afterEach(() => cleanup());

describe("readEligibilityResult", () => {
  it("reads a known verdict and refuses anything else", () => {
    expect(readEligibilityResult({ outcome: "ALLOWED", reason: "ok", lifecycleState: "ACTIVE" })).toEqual({
      outcome: "ALLOWED",
      reason: "ok",
      lifecycleState: "ACTIVE",
    });
    for (const bad of [null, undefined, "x", [], { items: [] }, { outcome: "NEW_VERDICT" }, { outcome: 7 }, { outcome: "toString" }]) {
      expect(readEligibilityResult(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("GovernedExportAction", () => {
  for (const [name, b] of [
    ["a list", { items: [] }],
    ["an unknown verdict", { outcome: "NEW_VERDICT", reason: "x", lifecycleState: null }],
  ] as const) {
    it(`${name}: renders the unavailable state with the action disabled`, async () => {
      body = b;
      const onAction = vi.fn();
      const view = render(
        <GovernedExportAction
          evidenceId="ev-1"
          teamId="team-1"
          actionLabel="Report PDF"
          compactWhenAllowed
          onAction={onAction}
          renderAction={({ disabled, onClick }) => (
            <button type="button" disabled={disabled} onClick={onClick} data-test-export>
              Report PDF
            </button>
          )}
        />,
      );
      await waitFor(() => expect(view.container.querySelector("[data-governed-export-error]")).not.toBeNull());
      expect(view.container.textContent).toContain("cannot read");
      expect(view.container.querySelector("[data-test-export]")).toBeNull();
      expect(onAction).not.toHaveBeenCalled();
    });
  }

  it("a readable ALLOWED answer still renders the enabled action", async () => {
    body = { outcome: "ALLOWED", reason: "ok", lifecycleState: "ACTIVE" };
    const view = render(
      <GovernedExportAction
        evidenceId="ev-1"
        teamId="team-1"
        actionLabel="Report PDF"
        compactWhenAllowed
        renderAction={({ disabled }) => (
          <button type="button" disabled={disabled} data-test-export>
            Report PDF
          </button>
        )}
      />,
    );
    await waitFor(() => expect(view.container.querySelector('[data-governed-export-allowed="true"]')).not.toBeNull());
    expect((view.container.querySelector("[data-test-export]") as HTMLButtonElement).disabled).toBe(false);
  });
});
