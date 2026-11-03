/**
 * THE BRANCHES THAT WERE DEAD ON FLAT ROUTES, ONE PER PATTERN.
 *
 * `apiFetch` raises ApiError only for a nested `error.code`. Each case drives the
 * shipped branch through the real `apiFetch` over a stubbed fetch, with a body a flat
 * route really sends, and asserts what the person sees. Before the repair every one
 * of these fell to its "could not reach" or generic fallback.
 *
 *   status:   `isApiResponseError(err) && err.statusCode === 403`  (QcSamplingPanel)
 *   server or network: `!isApiResponseError(err)`                  (lifecycle resolver)
 *   denial:   details.denial from a top-level `denial` field       (resolveLifecycleError)
 *   code:     err.code from a flat `{ code }`                      (identity-admin code reader)
 *   envelope: `err.body?.error?.code` on a flat refusal            (apiFetch itself)
 *   reason:   `flatReason` from `{ error: "<reason>" }`            (authenticator enrolment)
 */
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/platform-context", async (original) => ({
  ...(await original<typeof import("../../lib/platform-context")>()),
  useActiveWorkspaceId: () => "11111111-1111-4111-8111-111111111111",
}));

import { apiFetch } from "../../lib/api";
import { resolveLifecycleError } from "../../app/(app)/evidence-lifecycle/_shared";
import { QcSamplingPanel } from "../../components/ai-copilot/QcSamplingPanel";

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

async function failure(path = "/v1/x"): Promise<unknown> {
  try {
    await apiFetch(path, undefined, { retryAuthOnce: false });
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("flat refusals reach the branch written for them", () => {
  it("status: a flat 403 is a denial, not a failure", async () => {
    respond(403, { message: "Only workspace owners can read QC samples." });
    render(<QcSamplingPanel />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not a member of this workspace"));
  });

  it("denial: a top-level denial names the missing entitlement", async () => {
    respond(403, { denial: "ENTITLEMENT_REQUIRED", entitlement: "FEATURE_LEGAL_HOLD" });
    const denial = resolveLifecycleError(await failure());
    expect(denial?.denial).toBe("ENTITLEMENT_REQUIRED");
  });

  it("server or network: a flat 401 asks for sign-in and a network failure does not", async () => {
    respond(401, { code: "reauthentication_required" });
    expect(resolveLifecycleError(await failure())?.denial).toBe("AUTHENTICATION_REQUIRED");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(resolveLifecycleError(await failure())?.denial).not.toBe("AUTHENTICATION_REQUIRED");
  });

  it("envelope: err.body.error.code reads a flat code", async () => {
    respond(409, { code: "OWNERSHIP_TRANSFER_REQUIRED", message: "Transfer ownership first." });
    const err = (await failure()) as { body?: { error?: { code?: string; message?: string } } };
    expect(err.body?.error?.code).toBe("OWNERSHIP_TRANSFER_REQUIRED");
    expect(err.body?.error?.message).toBe("Transfer ownership first.");
  });

  it("reason: a flat { error } reaches the bounded reason and no sentence of its own", async () => {
    respond(400, { error: "code_invalid" });
    const err = (await failure()) as { flatReason?: string; message: string };
    expect(err.flatReason).toBe("code_invalid");
    expect(err.message).not.toContain("code_invalid");
  });
});
