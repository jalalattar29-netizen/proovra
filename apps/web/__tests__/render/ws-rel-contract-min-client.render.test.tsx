/**
 * WS-REL / PRO-PW-08 — version negotiation is no longer advisory only.
 *
 *  - a served minimum client contract above this build raises a BLOCKING
 *    reload prompt (no dismiss) that warns about unsaved work;
 *  - equal versions (or an older API without the header) show nothing;
 *  - the advisory notice can be dismissed;
 *  - the skew notice and the service-worker prompt are visible together, in
 *    one stack, neither covering the other.
 * Drives the REAL apiFetch against a stubbed fetch.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENTATION_CONTRACT_VERSION } from "@proovra/shared";

import ContractSkewNotice from "../../components/ContractSkewNotice";
import BottomOverlay from "../../components/BottomOverlay";
import { apiFetch } from "../../lib/api";
import { resetContractSkewForTests } from "../../lib/contract-skew";

function serve(headers: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      }),
    ),
  );
}

async function call() {
  await act(async () => {
    await apiFetch("/v1/health", {}, { auth: false });
  });
}

describe("PRO-PW-08 minimum client contract", () => {
  beforeEach(() => resetContractSkewForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a served minimum above this build is a blocking reload prompt with an unsaved-work warning", async () => {
    render(<ContractSkewNotice />);
    serve({
      "x-proovra-contract": String(PRESENTATION_CONTRACT_VERSION),
      "x-proovra-min-client-contract": String(PRESENTATION_CONTRACT_VERSION + 1),
    });
    await call();
    const notice = screen.getByTestId("contract-skew-notice");
    expect(notice.getAttribute("data-contract-skew")).toBe("UPDATE_REQUIRED");
    expect(notice.getAttribute("role")).toBe("alertdialog");
    const labels = Array.from(notice.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Reload"]);
    expect(screen.getByTestId("contract-skew-unsaved-warning").textContent).toMatch(/unsaved work/);
  });

  it("equal versions, or no header, show nothing", async () => {
    render(<ContractSkewNotice />);
    serve({
      "x-proovra-contract": String(PRESENTATION_CONTRACT_VERSION),
      "x-proovra-min-client-contract": String(PRESENTATION_CONTRACT_VERSION),
    });
    await call();
    serve({});
    await call();
    expect(screen.queryByTestId("contract-skew-notice")).toBeNull();
  });

  it("the advisory notice can be dismissed, and a later blocking state still appears", async () => {
    render(<ContractSkewNotice />);
    serve({ "x-proovra-contract": String(PRESENTATION_CONTRACT_VERSION + 1) });
    await call();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("contract-skew-notice")).toBeNull();
    serve({
      "x-proovra-contract": String(PRESENTATION_CONTRACT_VERSION + 1),
      "x-proovra-min-client-contract": String(PRESENTATION_CONTRACT_VERSION + 1),
    });
    await call();
    expect(screen.getByTestId("contract-skew-notice").getAttribute("data-contract-skew")).toBe("UPDATE_REQUIRED");
  });

  it("two notices share one stack and are both visible", async () => {
    render(
      <>
        <ContractSkewNotice />
        <BottomOverlay>
          <div data-testid="other-notice">another notice</div>
        </BottomOverlay>
      </>,
    );
    serve({ "x-proovra-contract": String(PRESENTATION_CONTRACT_VERSION + 1) });
    await call();
    const skew = screen.getByTestId("contract-skew-notice");
    const other = screen.getByTestId("other-notice");
    const stack = document.querySelector("[data-overlay-stack]");
    expect(stack).not.toBeNull();
    expect(stack!.contains(skew)).toBe(true);
    expect(stack!.contains(other)).toBe(true);
    // Neither notice is positioned on its own.
    expect((skew as HTMLElement).style.position).toBe("");
  });
});
