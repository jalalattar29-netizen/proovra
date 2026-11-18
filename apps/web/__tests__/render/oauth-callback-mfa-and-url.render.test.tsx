/**
 * B-12 / A1-08 — the legacy OAuth redirect callback (`/auth/callback/ui`).
 *
 * B-12: an account with a second factor answers the Google/Apple exchange with
 *   200 `{ mfaRequired: true }` (and the pending cookie), not a session. The
 *   callback threw "Missing access token" and showed "Sign-in failed"; it now
 *   continues on `/auth/mfa-challenge` with the validated return path, as
 *   /login does. A 403 MFA_ENROLLMENT_REQUIRED goes to the guided enrolment.
 * A1-08: the provider's `id_token` / `code` / `state` are removed from the
 *   address bar and the history entry as soon as the page has read them.
 *
 * The REAL page runs over a stubbed network; only the auth provider, toasts and
 * `window.location.replace` (navigation) are doubles.
 */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setToken = vi.fn();
vi.mock("../../app/providers", () => ({ useAuth: () => ({ setToken }) }));
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast: vi.fn() }) }));

import CallbackPage from "../../app/auth/callback/ui/page";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realLocation = window.location;
const replace = vi.fn();
let answer: (path: string) => Response;
const posts: string[] = [];

beforeEach(() => {
  replace.mockReset();
  setToken.mockReset();
  posts.length = 0;
  sessionStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() {
        return realLocation.href;
      },
      get search() {
        return realLocation.search;
      },
      get hash() {
        return realLocation.hash;
      },
      get pathname() {
        return realLocation.pathname;
      },
      get hostname() {
        return realLocation.hostname;
      },
      get origin() {
        return realLocation.origin;
      },
      replace,
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0] as string;
      if ((init?.method ?? "GET") === "POST") posts.push(path);
      return answer(path);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function openCallback(query: string) {
  window.history.replaceState(null, "", `/auth/callback/ui${query}`);
  return render(<CallbackPage />);
}

describe("B-12 — an MFA-required social sign-in continues on the challenge page", () => {
  it("200 { mfaRequired } goes to /auth/mfa-challenge with the validated next, never 'Sign-in failed'", async () => {
    sessionStorage.setItem("proovra-return-url", "/cases?tab=open");
    answer = (path) =>
      path === "/v1/auth/google"
        ? json(200, { mfaRequired: true, mfaPendingToken: "pending-secret", mfaPendingExpiresInSeconds: 300 })
        : json(404, {});
    openCallback("?provider=google&id_token=tok-mfa-1");
    await settle();
    expect(posts).toEqual(["/v1/auth/google"]);
    expect(replace).toHaveBeenCalledWith(`/auth/mfa-challenge?next=${encodeURIComponent("/cases?tab=open")}`);
    expect(setToken).not.toHaveBeenCalled();
    expect(screen.queryByText("Sign-in failed")).toBeNull();
  });

  it("an off-site return path is not carried to the challenge", async () => {
    sessionStorage.setItem("proovra-return-url", "//evil.example/x");
    answer = () => json(200, { mfaRequired: true, mfaPendingToken: "p" });
    openCallback("?provider=google&id_token=tok-mfa-2");
    await settle();
    expect(replace).toHaveBeenCalledWith(`/auth/mfa-challenge?next=${encodeURIComponent("/home")}`);
  });

  it("403 MFA_ENROLLMENT_REQUIRED goes to the guided enrolment", async () => {
    answer = () =>
      json(403, {
        mfaRequired: true,
        mfaEnrollmentRequired: true,
        code: "MFA_ENROLLMENT_REQUIRED",
        mfaEnrollmentToken: "enrol",
        message: "Enrol a factor.",
      });
    openCallback("?provider=apple&id_token=tok-mfa-3");
    await settle();
    expect(posts).toEqual(["/v1/auth/apple"]);
    expect(replace).toHaveBeenCalledWith(`/auth/mfa-challenge?enroll=1&next=${encodeURIComponent("/home")}`);
    expect(screen.queryByText("Sign-in failed")).toBeNull();
  });

  it("a plain session still lands on the return path (control)", async () => {
    sessionStorage.setItem("proovra-return-url", "/evidence");
    answer = (path) =>
      path === "/v1/auth/google"
        ? json(200, { token: "session-jwt", user: { id: "u1" } })
        : path === "/v1/auth/me"
          ? json(200, { user: { id: "u1" } })
          : json(404, {});
    openCallback("?provider=google&id_token=tok-plain-1");
    await settle();
    expect(setToken).toHaveBeenCalledWith("session-jwt");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(String(replace.mock.calls[0]![0])).toMatch(/\/evidence$/);
  });
});

describe("A1-08 — provider credentials leave the URL once read", () => {
  it("id_token and state are stripped from the query; provider stays", async () => {
    answer = () => json(200, { mfaRequired: true, mfaPendingToken: "p" });
    openCallback("?provider=google&id_token=tok-strip-1&state=google");
    expect(realLocation.search).not.toContain("id_token");
    expect(realLocation.search).not.toContain("state=");
    expect(realLocation.search).toContain("provider=google");
    await settle();
    // The exchange still used the token it read.
    expect(posts).toEqual(["/v1/auth/google"]);
  });

  it("an Apple code in the fragment is stripped too", async () => {
    answer = () => json(401, { message: "nonce_invalid" });
    sessionStorage.setItem("proovra-apple-state", "s1");
    openCallback("?provider=apple#code=apple-code-1&state=s1");
    expect(realLocation.hash).toBe("");
    await settle();
    expect(posts).toEqual(["/v1/auth/apple"]);
  });

  it("PRO-A1-15: a state this browser never stored is refused before any API call", async () => {
    sessionStorage.removeItem("proovra-apple-state");
    answer = () => json(200, { token: "t" });
    openCallback("?provider=apple#code=apple-code-2&state=forged");
    await settle();
    expect(posts).toEqual([]);
    expect(setToken).not.toHaveBeenCalled();
  });
});
