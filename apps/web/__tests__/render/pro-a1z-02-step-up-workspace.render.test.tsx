import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * PRO-A1Z-02 — the step-up challenge is minted in the workspace the server will
 * consume it against, not always the page's workspace.
 *
 * The real `useStepUpAction` + `StepUpModal` and the real `apiFetch` run over a
 * stubbed network. The protected action answers 401 STEP_UP_REQUIRED; the test
 * reads the teamId the modal sends to POST /v1/identity-security/step-up/start.
 *   - allowed: a per-action workspace (options.teamId) is used;
 *   - allowed: the workspace the refusal names (details.teamId) is used when
 *     the caller gave none;
 *   - control: with neither, the page's workspace is used;
 *   - refused: the page's workspace is never sent when the action names another.
 */

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { StepUpModal, useStepUpAction } from "../../components/identity-security/StepUpModal";
import { apiFetch } from "../../lib/api";

let starts: Array<Record<string, unknown>> = [];
let refusalDetails: Record<string, unknown> = {};

beforeEach(() => {
  starts = [];
  refusalDetails = { purpose: "SESSION_REVOKE", resourceKind: "session", resourceId: "s-1" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v1/identity-security/step-up/start")) {
        starts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ challenge: { id: "ch-1", status: "PENDING" }, method: "TOTP" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/v1/protected")) {
        return new Response(
          JSON.stringify({ error: { code: "STEP_UP_REQUIRED", message: "step up", details: refusalDetails } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ actionTeamId }: { actionTeamId?: string }) {
  const control = useStepUpAction({ teamId: "team-page" });
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void control
            .runStepUpAction(
              (headers) => apiFetch("/v1/protected", { method: "POST", headers }),
              actionTeamId ? { teamId: actionTeamId } : undefined,
            )
            .catch(() => undefined);
        }}
      >
        Run protected action
      </button>
      <StepUpModal control={control} />
    </>
  );
}

async function runAndReadStart(actionTeamId?: string) {
  render(<Harness actionTeamId={actionTeamId} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Run protected action" }));
  });
  await waitFor(() => expect(starts).toHaveLength(1));
  return starts[0];
}

describe("PRO-A1Z-02 — step-up challenge workspace", () => {
  it("allowed: a per-action workspace is the challenge's workspace, not the page's", async () => {
    const body = await runAndReadStart("team-holder");
    expect(body.teamId).toBe("team-holder");
    expect(body.teamId).not.toBe("team-page");
    expect(body.purpose).toBe("SESSION_REVOKE");
  });

  it("allowed: with no per-action workspace, the workspace the refusal names is used", async () => {
    refusalDetails = { ...refusalDetails, teamId: "team-from-refusal" };
    const body = await runAndReadStart();
    expect(body.teamId).toBe("team-from-refusal");
  });

  it("control: with neither, the page's workspace is used", async () => {
    const body = await runAndReadStart();
    expect(body.teamId).toBe("team-page");
  });
});
