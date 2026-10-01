import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * UC-EXT-006 (web half) — /auth/extension/continue requires sign-in,
 * validates the OAuth parameters, and hands the auth window back to the API's
 * authorize endpoint on the canonical API origin.
 */
let query = "";
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query),
  useRouter: () => ({ replace, push: vi.fn() }),
}));
let auth: { user: unknown; authReady: boolean } = { user: null, authReady: true };
vi.mock("../../app/providers", () => ({ useAuth: () => auth }));
vi.mock("../../lib/api", () => ({ apiBaseUrl: () => "https://api.example.test" }));

import ExtensionContinuePage from "../../app/auth/extension/continue/page";
import { validateExtensionAuthorizeQuery } from "../../lib/extension/extension-authorize-request";

const VALID = {
  response_type: "code",
  client_id: "proovra-extension",
  redirect_uri: "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth2",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "st-123",
  scope: "capture",
};
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

let locationReplace: ReturnType<typeof vi.fn>;
beforeEach(() => {
  replace.mockReset();
  locationReplace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, replace: locationReplace },
  });
});
afterEach(() => {
  auth = { user: null, authReady: true };
});

describe("validateExtensionAuthorizeQuery", () => {
  it("accepts the canonical request and drops unknown parameters", () => {
    const r = validateExtensionAuthorizeQuery(new URLSearchParams({ ...VALID, evil: "x" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query).not.toContain("evil");
  });

  it.each([
    ["client_id", { client_id: "other" }],
    ["redirect_uri host", { redirect_uri: "https://evil.example/oauth2" }],
    ["redirect_uri id charset", { redirect_uri: "https://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.chromiumapp.org/oauth2" }],
    ["redirect_uri http", { redirect_uri: "http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth2" }],
    ["short challenge", { code_challenge: "abc" }],
    ["plain method", { code_challenge_method: "plain" }],
    ["empty state", { state: "" }],
    ["long state", { state: "s".repeat(257) }],
    ["response_type", { response_type: "token" }],
  ])("rejects %s", (_label, override) => {
    expect(validateExtensionAuthorizeQuery(new URLSearchParams({ ...VALID, ...override })).ok).toBe(false);
  });

  it("rejects a duplicated redirect_uri", () => {
    const q = new URLSearchParams(VALID);
    q.append("redirect_uri", "https://evil.example/");
    expect(validateExtensionAuthorizeQuery(q).ok).toBe(false);
  });
});

describe("/auth/extension/continue", () => {
  it("signed out → /login with this page (and its validated query) as next", async () => {
    query = qs(VALID);
    auth = { user: null, authReady: true };
    render(<ExtensionContinuePage />);
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    const target = String(replace.mock.calls[0][0]);
    expect(target.startsWith("/login?next=")).toBe(true);
    const next = decodeURIComponent(target.slice("/login?next=".length));
    expect(next.startsWith("/auth/extension/continue?")).toBe(true);
    expect(new URLSearchParams(next.split("?")[1]).get("state")).toBe("st-123");
    expect(locationReplace).not.toHaveBeenCalled();
  });

  it("signed in → the auth window goes to the API authorize endpoint on the API origin", async () => {
    query = qs(VALID);
    auth = { user: { id: "u1" }, authReady: true };
    render(<ExtensionContinuePage />);
    await waitFor(() => expect(locationReplace).toHaveBeenCalledTimes(1));
    const url = new URL(String(locationReplace.mock.calls[0][0]));
    expect(url.origin).toBe("https://api.example.test");
    expect(url.pathname).toBe("/v1/oauth/extension/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(VALID.redirect_uri);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("invalid parameters → error UI, no navigation at all", async () => {
    query = qs({ ...VALID, redirect_uri: "https://evil.example/" });
    auth = { user: { id: "u1" }, authReady: true };
    const { container } = render(<ExtensionContinuePage />);
    await waitFor(() =>
      expect(container.querySelector("[data-extension-continue-state='invalid']")).not.toBeNull(),
    );
    expect(locationReplace).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("waits while the session is resolving", () => {
    query = qs(VALID);
    auth = { user: null, authReady: false };
    render(<ExtensionContinuePage />);
    expect(replace).not.toHaveBeenCalled();
    expect(locationReplace).not.toHaveBeenCalled();
  });

  it("never issues a relative /v1 navigation", () => {
    const src = readFileSync(resolve(__dirname, "../../app/auth/extension/continue/page.tsx"), "utf8");
    expect(src).not.toMatch(/["'`]\/v1\//);
    expect(src).toMatch(/apiBaseUrl\(\)/);
  });
});
