/**
 * AUD-021 — the pure origin decision shared by credentialed CORS and the
 * cookie-mutation guard (`http/cors-origin-policy.ts`).
 */
import { describe, expect, it } from "vitest";

import {
  evaluateCookieMutation,
  isCorsOriginAllowed,
  isProovraProductionRequest,
  isTrustedWebOrigin,
} from "../src/http/cors-origin-policy.js";

const PROD = { NODE_ENV: "production", CORS_ORIGINS: "" };
const DEV = { NODE_ENV: "development", CORS_ORIGINS: "https://preview.example.dev" };

describe("isTrustedWebOrigin — exact allow-list", () => {
  it("admits exactly the Proovra web origins in production", () => {
    for (const o of ["https://proovra.com", "https://www.proovra.com", "https://app.proovra.com", "https://APP.proovra.com/"]) {
      expect(isTrustedWebOrigin(o, PROD), o).toBe(true);
    }
  });

  it("refuses sibling subdomains, look-alike suffixes/prefixes, http, and null", () => {
    for (const o of [
      "https://status.proovra.com",
      "https://evil.app.proovra.com",
      "https://proovra.com.evil.com",
      "https://evilproovra.com",
      "http://app.proovra.com",
      "null",
      "",
    ]) {
      expect(isTrustedWebOrigin(o, PROD), o).toBe(false);
      expect(isTrustedWebOrigin(o, DEV), o).toBe(false);
    }
  });

  it("CORS_ORIGINS entries are exact", () => {
    expect(isTrustedWebOrigin("https://preview.example.dev", DEV)).toBe(true);
    expect(isTrustedWebOrigin("https://preview.example.dev.evil.com", DEV)).toBe(false);
    expect(isTrustedWebOrigin("https://staging.proovra.com", { ...PROD, CORS_ORIGINS: "https://staging.proovra.com" })).toBe(true);
  });

  it("loopback dev origins only outside production; development never reflects arbitrary origins", () => {
    expect(isTrustedWebOrigin("http://localhost:3000", DEV)).toBe(true);
    expect(isTrustedWebOrigin("http://127.0.0.1:3007", DEV)).toBe(true);
    expect(isTrustedWebOrigin("http://[::1]:3000", DEV)).toBe(true);
    expect(isTrustedWebOrigin("http://localhost:3000", PROD)).toBe(false);
    expect(isTrustedWebOrigin("http://localhost.evil.com", DEV)).toBe(false);
    expect(isCorsOriginAllowed("https://attacker.example", DEV)).toBe(false);
    expect(isCorsOriginAllowed("https://attacker.example", { NODE_ENV: "test" })).toBe(false);
    // No Origin header = same-origin / non-browser.
    expect(isCorsOriginAllowed(undefined, PROD)).toBe(true);
  });

  it("an unpinned extension origin is never trusted", () => {
    expect(isTrustedWebOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop", DEV)).toBe(false);
  });
});

describe("evaluateCookieMutation", () => {
  const base = { method: "POST", hasBearer: false, hasSessionCookie: true };

  it("safe methods, bearer clients and cookie-less requests are not cookie mutations", () => {
    expect(evaluateCookieMutation({ ...base, method: "GET" }, PROD).ok).toBe(true);
    expect(evaluateCookieMutation({ ...base, method: "OPTIONS" }, PROD).ok).toBe(true);
    expect(evaluateCookieMutation({ ...base, hasBearer: true }, PROD).ok).toBe(true);
    expect(evaluateCookieMutation({ ...base, hasSessionCookie: false }, PROD).ok).toBe(true);
  });

  it("allowed Origin passes; every unsafe method is guarded", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(evaluateCookieMutation({ ...base, method, origin: "https://app.proovra.com" }, PROD)).toEqual({ ok: true });
      expect(evaluateCookieMutation({ ...base, method, origin: "https://status.proovra.com" }, PROD)).toEqual({
        ok: false,
        reason: "origin_not_allowed",
      });
    }
  });

  it("missing Origin and Referer is refused; Referer origin stands in", () => {
    expect(evaluateCookieMutation(base, PROD)).toEqual({ ok: false, reason: "origin_missing" });
    expect(evaluateCookieMutation({ ...base, referer: "https://app.proovra.com/settings?x=1" }, PROD).ok).toBe(true);
    expect(evaluateCookieMutation({ ...base, referer: "https://app.proovra.com.evil.com/x" }, PROD)).toEqual({
      ok: false,
      reason: "origin_not_allowed",
    });
    expect(evaluateCookieMutation({ ...base, referer: "not a url" }, PROD).ok).toBe(false);
  });

  it("Sec-Fetch-Site: cross-site is refused even with an allowed Origin", () => {
    expect(
      evaluateCookieMutation({ ...base, origin: "https://app.proovra.com", secFetchSite: "cross-site" }, PROD),
    ).toEqual({ ok: false, reason: "cross_site_request" });
    expect(
      evaluateCookieMutation({ ...base, origin: "https://app.proovra.com", secFetchSite: "same-site" }, PROD).ok,
    ).toBe(true);
  });
});

describe("isProovraProductionRequest — exact host parsing", () => {
  it("never matches a host or origin that merely contains proovra.com", () => {
    expect(isProovraProductionRequest("api.proovra.com", undefined)).toBe(true);
    expect(isProovraProductionRequest("proovra.com.evil.com", undefined)).toBe(false);
    expect(isProovraProductionRequest("evilproovra.com", "https://evilproovra.com")).toBe(false);
    expect(isProovraProductionRequest("localhost:8080", "https://proovra.com.evil.com")).toBe(false);
  });
});
