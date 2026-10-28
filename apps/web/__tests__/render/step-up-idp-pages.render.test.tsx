/**
 * 2026-10-28 — /step-up/idp and /step-up/idp, through the rendered pages.
 *
 *  /step-up/idp: the challenge + token come from the URL FRAGMENT (never the
 *  query), the fragment is cleared from history, the begin call carries them in
 *  the BODY, and the browser goes to the returned IdP URL. `return=app` is
 *  remembered for the result page. Refusals are calm.
 *
 *  /step-up/idp: app round trips go to proovra://step-up/complete with the
 *  outcome; popups post {type:"proovra-step-up-idp", result} to their own
 *  origin and close; otherwise the outcome is shown with a way back to the app.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/api", () => ({ apiBaseUrl: () => "https://api.test" }));

import { IdpHandoff, IDP_RETURN_TO_APP_KEY, idpNavigation } from "../../app/step-up/idp/IdpHandoff";
import { IdpDone, idpDoneWindow } from "../../app/step-up/idp/IdpDone";

const CHALLENGE = "33333333-3333-4333-8333-333333333333";
const TOKEN = "k".repeat(43);

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let beginStatus = 200;
let beginBody: unknown = { redirectUrl: "https://idp.example.com/sso?SAMLRequest=x" };
const assign = vi.fn();
const close = vi.fn();

beforeEach(() => {
  calls = [];
  beginStatus = 200;
  beginBody = { redirectUrl: "https://idp.example.com/sso?SAMLRequest=x" };
  assign.mockReset();
  close.mockReset();
  vi.spyOn(idpNavigation, "assign").mockImplementation(assign);
  vi.spyOn(idpDoneWindow, "assign").mockImplementation(assign);
  vi.spyOn(idpDoneWindow, "close").mockImplementation(close);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return { status: beginStatus, ok: beginStatus < 300, json: async () => beginBody } as unknown as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "opener", { value: null, configurable: true, writable: true });
  window.history.replaceState(null, "", "/");
});

function at(path: string) {
  window.history.replaceState(null, "", path);
}

describe("/step-up/idp", () => {
  it("reads the fragment, clears it, posts the pair in the body and goes to the IdP", async () => {
    at(`/step-up/idp?challenge=ignored#challenge=${CHALLENGE}&token=${TOKEN}`);
    render(<IdpHandoff />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://idp.example.com/sso?SAMLRequest=x"));
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test/v1/identity-security/step-up/handoff/idp/begin");
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.body).toEqual({ challengeId: CHALLENGE, token: TOKEN });
    expect(window.sessionStorage.getItem(IDP_RETURN_TO_APP_KEY)).toBeNull();
  });

  it("remembers return=app for the result page", async () => {
    at(`/step-up/idp#challenge=${CHALLENGE}&token=${TOKEN}&return=app`);
    render(<IdpHandoff />);
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(window.sessionStorage.getItem(IDP_RETURN_TO_APP_KEY)).toBe("1");
  });

  it("never reads the token from the query", async () => {
    at(`/step-up/idp?challenge=${CHALLENGE}&token=${TOKEN}`);
    render(<IdpHandoff />);
    await waitFor(() => expect(screen.getByText("This link can't be used")).toBeTruthy());
    expect(calls).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });

  it("an expired link is reported calmly and nothing navigates", async () => {
    beginStatus = 400;
    beginBody = { error: { code: "IDP_REAUTH_EXPIRED" } };
    at(`/step-up/idp#challenge=${CHALLENGE}&token=${TOKEN}`);
    render(<IdpHandoff />);
    await waitFor(() => expect(screen.getByText("This link has expired")).toBeTruthy());
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("/step-up/idp", () => {
  it("an app round trip navigates to the app's return URL with the outcome", async () => {
    window.sessionStorage.setItem(IDP_RETURN_TO_APP_KEY, "1");
    at("/step-up/idp?result=denied&reason=IDP_CONTEXT_INSUFFICIENT");
    render(<IdpDone />);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "proovra://step-up/complete?result=denied&reason=IDP_CONTEXT_INSUFFICIENT",
      ),
    );
    expect(window.sessionStorage.getItem(IDP_RETURN_TO_APP_KEY)).toBeNull();
  });

  it("?app=1 also returns to the app (approved)", async () => {
    at("/step-up/idp?result=approved&app=1");
    render(<IdpDone />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("proovra://step-up/complete?result=approved"));
  });

  it("a popup posts the result to its OWN origin and closes", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "opener", { value: { postMessage }, configurable: true, writable: true });
    at("/step-up/idp?result=approved");
    render(<IdpDone />);
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(postMessage).toHaveBeenCalledWith(
      { type: "proovra-step-up-idp", result: "approved" },
      window.location.origin,
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("otherwise shows a calm denial with a way back to the app", async () => {
    at("/step-up/idp?result=denied&reason=IDP_REAUTH_CANCELLED");
    render(<IdpDone />);
    await waitFor(() => expect(screen.getByText("Sign-in was cancelled")).toBeTruthy());
    expect(screen.getByText(/Nothing was changed/)).toBeTruthy();
    const back = screen.getByTestId("step-up-idp-return-app") as HTMLAnchorElement;
    expect(back.textContent).toBe("Return to the PROOVRA app");
    expect(back.getAttribute("href")).toBe("proovra://step-up/complete?result=denied&reason=IDP_REAUTH_CANCELLED");
  });

  it("an unknown reason is shown generically (no echo of arbitrary text)", async () => {
    at("/step-up/idp?result=denied&reason=%3Cscript%3E");
    render(<IdpDone />);
    await waitFor(() => expect(screen.getByText("We couldn't confirm it's you")).toBeTruthy());
    expect(document.body.innerHTML).not.toContain("<script>");
  });
});
