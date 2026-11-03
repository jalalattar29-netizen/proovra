/**
 * RT-015 — the step after sign-in, through the real `apiFetch` over a stubbed fetch,
 * with the status the route really sends. It is provider-blind: nothing here knows
 * how the session began.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LegalAcceptanceStep } from "../../components/legal/LegalAcceptanceStep";

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
