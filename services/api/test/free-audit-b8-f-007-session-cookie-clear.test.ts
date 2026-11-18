/**
 * B8-F-007 (Free acceptance pass, 2026-11-18) — the session-cookie CLEAR scope.
 *
 * The first fix made a staging-classified process stop SETTING cookies on
 * Domain=.proovra.com, but every sign-in setter (password, SAML, OIDC) still
 * CLEARED `proovra_session` on .proovra.com unconditionally — so a staging API
 * under *.proovra.com signed the production session out of a shared browser on
 * every staging sign-in. And logout never cleared a session set on
 * SSO_COOKIE_DOMAIN. One helper now names the domains a process may clear:
 * host-only always, .proovra.com only when this process IS the production
 * cookie domain, and SSO_COOKIE_DOMAIN when configured.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { sessionCookieClearDomains } from "../src/http/cors-origin-policy.js";

describe("B8-F-007 — which session-cookie domains a process clears", () => {
  it("production keeps clearing host-only and .proovra.com (nobody's session scope changes)", () => {
    expect(sessionCookieClearDomains("api.proovra.com", "https://www.proovra.com", {})).toEqual([".proovra.com", undefined]);
  });

  it("a staging process under *.proovra.com never clears the production .proovra.com cookie", () => {
    const domains = sessionCookieClearDomains("api.staging.proovra.com", "https://staging.proovra.com", { PROOVRA_ENV: "staging" });
    expect(domains).not.toContain(".proovra.com");
    expect(domains).toEqual([undefined]);
  });

  it("an SSO_COOKIE_DOMAIN session is cleared too, once", () => {
    expect(
      sessionCookieClearDomains("api.staging.proovra.com", undefined, { PROOVRA_ENV: "staging", SSO_COOKIE_DOMAIN: ".staging.proovra.com" }),
    ).toEqual([".staging.proovra.com", undefined]);
    expect(sessionCookieClearDomains("api.proovra.com", undefined, { SSO_COOKIE_DOMAIN: ".proovra.com" })).toEqual([".proovra.com", undefined]);
  });

  it("local development clears host-only only", () => {
    expect(sessionCookieClearDomains("localhost:8080", "http://localhost:3000", {})).toEqual([undefined]);
  });

  it("no route clears proovra_session on a hard-coded domain any more", () => {
    for (const file of ["auth.routes.ts", "saml-auth.routes.ts", "sso-auth.routes.ts"]) {
      const source = readFileSync(resolve(__dirname, "..", "src", "routes", file), "utf8");
      expect(source, file).not.toMatch(/clearCookie\("proovra_session",\s*\{\s*path:\s*"\/",\s*domain:\s*"\.proovra\.com"/);
      expect(source, file).toContain("sessionCookieClearDomains(");
    }
  });
});
