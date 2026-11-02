/**
 * OPS-015 — the web deploys first, so a page can be newer than the API it talks
 * to. Reloading does not help then, and the notice does not offer it. With the
 * contract at 1 no served value is older yet, so the comparison is stubbed; what
 * this proves is the notice's behaviour for that answer.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@proovra/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@proovra/shared")>()),
  presentationContractSkew: () => "CLIENT_NEWER",
}));

import ContractSkewNotice from "../../components/ContractSkewNotice";
import { apiFetch } from "../../lib/api";
import { resetContractSkewForTests } from "../../lib/contract-skew";

describe("OPS-015 page newer than the API", () => {
  beforeEach(() => resetContractSkewForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says an update is finishing and offers no reload", async () => {
    render(<ContractSkewNotice />);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json", "x-proovra-contract": "1" },
        }),
      ),
    );
    await act(async () => {
      await apiFetch("/v1/health", {}, { auth: false });
    });
    const notice = screen.getByTestId("contract-skew-notice");
    expect(notice.textContent).toMatch(/update to PROOVRA is finishing/);
    expect(notice.querySelector("button")).toBeNull();
  });
});
