/**
 * AUD-32 (2026-10-20) — an open tab built for an older presentation contract
 * than the API it talks to says so (once) instead of silently interpreting a
 * response it was not written for.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ContractSkewNotice from "../../components/ContractSkewNotice";
import { apiFetch } from "../../lib/api";
import { resetContractSkewForTests } from "../../lib/contract-skew";
import { PRESENTATION_CONTRACT_VERSION } from "@proovra/shared";

function serve(contract: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", ...(contract ? { "x-proovra-contract": contract } : {}) },
      }),
    ),
  );
}

describe("AUD-32 contract skew notice", () => {
  beforeEach(() => resetContractSkewForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("an API on a newer contract shows the reload notice", async () => {
    render(<ContractSkewNotice />);
    serve(String(PRESENTATION_CONTRACT_VERSION + 1));
    await act(async () => {
      await apiFetch("/v1/health", {}, { auth: false });
    });
    expect(screen.getByTestId("contract-skew-notice").textContent).toMatch(/Reload this page/);
  });

  it("the same contract, or none, shows nothing", async () => {
    render(<ContractSkewNotice />);
    serve(String(PRESENTATION_CONTRACT_VERSION));
    await act(async () => {
      await apiFetch("/v1/health", {}, { auth: false });
    });
    serve(null);
    await act(async () => {
      await apiFetch("/v1/health", {}, { auth: false });
    });
    expect(screen.queryByTestId("contract-skew-notice")).toBeNull();
  });
});
