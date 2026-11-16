/**
 * B8-F-402 (free-audit 0ea0) — the web observes `x-proovra-route-epoch` and,
 * when this build's route table is NEWER than the live API's, raises the
 * existing OPS-015 "an update is finishing" notice. An absent header (older
 * API) or an API ahead of the page changes nothing.
 *
 * The build's own epoch comes from @proovra/shared when it exports
 * PRESENTATION_CONTRACT_ROUTE_EPOCH; it is stubbed to 3 here so a served 2 is
 * "page newer than the API".
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@proovra/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@proovra/shared")>()),
  PRESENTATION_CONTRACT_ROUTE_EPOCH: 3,
}));

import ContractSkewNotice from "../../components/ContractSkewNotice";
import { apiFetch } from "../../lib/api";
import { resetContractSkewForTests, routeEpochSkew, webRouteEpoch } from "../../lib/contract-skew";

function serve(headers: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "x-proovra-contract": "1", ...headers },
      }),
    ),
  );
}

describe("B8-F-402 route epoch skew on the web", () => {
  beforeEach(() => resetContractSkewForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a page built for a newer route table than the API's says an update is finishing", async () => {
    expect(webRouteEpoch()).toBe(3);
    render(<ContractSkewNotice />);
    serve({ "x-proovra-route-epoch": "2" });
    await act(async () => {
      await apiFetch("/v1/health", {}, { auth: false });
    });
    const notice = screen.getByTestId("contract-skew-notice");
    expect(notice.textContent).toMatch(/update to PROOVRA is finishing/);
  });

  it("an older API without the header, the same epoch, or an API ahead of the page change nothing", async () => {
    render(<ContractSkewNotice />);
    const variants: Array<Record<string, string>> = [{}, { "x-proovra-route-epoch": "3" }, { "x-proovra-route-epoch": "4" }, { "x-proovra-route-epoch": "junk" }];
    for (const headers of variants) {
      serve(headers);
      await act(async () => {
        await apiFetch("/v1/health", {}, { auth: false });
      });
    }
    expect(screen.queryByTestId("contract-skew-notice")).toBeNull();
    expect(routeEpochSkew(null)).toBe("UNKNOWN");
    expect(routeEpochSkew("2", 3)).toBe("CLIENT_NEWER");
    expect(routeEpochSkew("4", 3)).toBe("CLIENT_OLDER");
  });
});
