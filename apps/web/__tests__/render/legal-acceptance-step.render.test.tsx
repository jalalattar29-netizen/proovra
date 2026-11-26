/**
 * RT-015 — the step after sign-in, through the real `apiFetch` over a stubbed fetch,
 * with the status the route really sends. It is provider-blind: nothing here knows
 * how the session began.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LegalAcceptanceStep } from "../../components/legal/LegalAcceptanceStep";
import { apiFetch } from "../../lib/api";

const OWED = {
  ok: false,
  requiresReacceptance: true,
  missingPolicies: ["terms", "cookies"],
  acceptedVersions: { privacy: "p1" },
  requiredVersions: { terms: "t2", privacy: "p1", cookies: "c2" },
};
const CLEAR = { ...OWED, ok: true, requiresReacceptance: false, missingPolicies: [] };

type Call = { url: string; method: string; body: unknown };

function server(status: unknown, acceptStatus = 200) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "POST") return new Response(JSON.stringify({ items: [] }), { status: acceptStatus, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const step = () => document.querySelector("[data-legal-step]");
const button = () => document.querySelector("[data-legal-step-accept]") as HTMLButtonElement;

describe("the acceptance step after sign-in", () => {
  it("does not appear, and asks nothing, when no session exists", async () => {
    const calls = server(OWED);
    render(<LegalAcceptanceStep active={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(step()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("does not appear for a person who owes nothing", async () => {
    const calls = server(CLEAR);
    render(<LegalAcceptanceStep active />);
    await waitFor(() => expect(calls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(step()).toBeNull();
  });

  it("records exactly the outstanding policies, at the versions the server named, once agreed", async () => {
    const calls = server(OWED);
    render(<LegalAcceptanceStep active />);
    await waitFor(() => expect(step()).not.toBeNull());
    expect(button().disabled).toBe(true);
    fireEvent.click(document.querySelector("[data-legal-step-agree]") as HTMLInputElement);
    fireEvent.click(button());
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/v1/users/legal-acceptance");
    expect(post?.body).toEqual({
      source: "post_sign_in",
      acceptances: [
        { policyKey: "terms", policyVersion: "t2" },
        { policyKey: "cookies", policyVersion: "c2" },
      ],
    });
  });

  it("stays, and says so, when the acceptance cannot be saved", async () => {
    server(OWED, 500);
    render(<LegalAcceptanceStep active />);
    await waitFor(() => expect(step()).not.toBeNull());
    fireEvent.click(document.querySelector("[data-legal-step-agree]") as HTMLInputElement);
    fireEvent.click(button());
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(step()).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});

/**
 * A1-06 — the server now refuses every authenticated write with the shared 428
 * until the current terms are accepted. A refusal that arrives after the page
 * loaded (terms updated mid-session) must bring the step back, through the real
 * apiFetch; "Not now" must let the person reach cancel / export / close; and
 * nothing may re-open the step on its own (no loop).
 */
describe("A1-06 — a write refused for outstanding terms", () => {
  const REFUSAL = {
    error: {
      code: "LEGAL_REACCEPT_REQUIRED",
      message: "You must accept the latest legal policies before continuing.",
      details: { missingPolicies: ["terms"] },
    },
  };

  /** legal-status answers whatever `owed()` says now; POST /v1/shares answers the 428. */
  function liveServer(owed: () => boolean) {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (String(url).includes("/v1/users/legal-status")) return json(owed() ? OWED : CLEAR);
        if (String(url).includes("/v1/users/legal-acceptance")) return json({ ok: true, items: [] });
        return json(REFUSAL, 428);
      }),
    );
    return calls;
  }

  const statusReads = (calls: Call[]) => calls.filter((c) => c.url.includes("/v1/users/legal-status")).length;

  it("brings the actionable step back when a write is refused after the page loaded", async () => {
    let owed = false;
    const calls = liveServer(() => owed);
    render(<LegalAcceptanceStep active />);
    await waitFor(() => expect(statusReads(calls)).toBe(1));
    expect(step()).toBeNull();

    owed = true; // the terms were updated while the page was open
    const err = await apiFetch("/v1/shares", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    expect((err as { body?: { error?: { code?: string } } }).body?.error?.code).toBe("LEGAL_REACCEPT_REQUIRED");

    await waitFor(() => expect(step()).not.toBeNull());
    expect(statusReads(calls)).toBe(2);
    expect(document.body.textContent).toContain("export your data, revoke shares or close your");
  });

  it("can be set aside, and only a later refused write re-opens it — never on its own", async () => {
    const calls = liveServer(() => true);
    render(<LegalAcceptanceStep active />);
    await waitFor(() => expect(step()).not.toBeNull());

    fireEvent.click(document.querySelector("[data-legal-step-dismiss]") as HTMLButtonElement);
    expect(step()).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(step()).toBeNull();
    expect(statusReads(calls)).toBe(1);

    await apiFetch("/v1/shares", { method: "POST", body: "{}" }).catch(() => undefined);
    // The step re-opens at once from the status it already holds, and the
    // refusal also re-reads the status; that read can be issued a moment
    // after the step is back (CI, 2026-11-25: read 1 of 2 when the step
    // appeared). Wait for both, then prove the counts settle exactly there.
    await waitFor(() => {
      expect(step()).not.toBeNull();
      expect(statusReads(calls)).toBe(2);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(statusReads(calls)).toBe(2);
    expect(step()).not.toBeNull();
    // Showing the step retried nothing: one write, one refusal.
    expect(calls.filter((c) => c.url.includes("/v1/shares")).length).toBe(1);
  });

  it("accept -> reload -> the status reads current and the step stays away (no loop)", async () => {
    let owed = true;
    const calls = liveServer(() => owed);
    const first = render(<LegalAcceptanceStep active />);
    await waitFor(() => expect(step()).not.toBeNull());
    fireEvent.click(document.querySelector("[data-legal-step-agree]") as HTMLInputElement);
    fireEvent.click(button());
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    owed = false; // the server recorded the acceptance

    first.unmount(); // the reload
    render(<LegalAcceptanceStep active />);
    await waitFor(() => expect(statusReads(calls)).toBe(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(step()).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
