/**
 * PHASE1-002 — the citizen-intake rate limit must not be defeatable by a header.
 *
 * FINAL-004 added a per-IP bound to the two unauthenticated Citizen Capture
 * write routes. Its first implementation derived the limiter key by reading
 * `x-forwarded-for` directly and taking the first value, with no trust gate.
 *
 * This service's documented default is `API_TRUST_PROXY` unset — it does not
 * trust forwarded headers from the public internet, and it has a canonical
 * helper, `getTrustedClientIp`, that encodes exactly that decision. Bypassing
 * that helper meant an attacker could send a different `X-Forwarded-For` on
 * every request and receive a brand-new rate-limit bucket each time, on the
 * precise surface the limit was written to protect — a control that reads as
 * protection in review and provides none at runtime.
 *
 * These cases drive the REAL exported key-derivation rather than a copy of its
 * rules, because a copy would only prove something about the copy. They are
 * pure source-level assertions on the trust decision: no database, no Redis and
 * no HTTP, so they run anywhere. The end-to-end 429 behaviour is a runtime
 * proof (Phase 1 §11) and is NOT claimed here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getTrustedClientIp } from "@proovra/shared-runtime/technical-metadata";

const REPO = path.resolve(__dirname, "../../..");
const src = (rel: string) =>
  readFileSync(path.join(REPO, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * BOTH public intake surfaces. PHASE1-003 is the same defect in
 * `external-intake.routes.ts` — the file the citizen limiter was modelled on —
 * and pinning only the one that was found first is how the pair drifts apart
 * again.
 */
const INTAKE_ROUTE_FILES = [
  "services/api/src/routes/citizen-capture.routes.ts",
  "services/api/src/routes/external-intake.routes.ts",
] as const;
const ROUTE_SRC = src(INTAKE_ROUTE_FILES[0]);

const SOCKET_IP = "203.0.113.7";
const trustProxyOff = { trustProxy: false };

describe("PHASE1-002 — the limiter's IP is the TRUSTED ip, not a caller-supplied one", () => {
  it("ignores X-Forwarded-For entirely when the deployment does not declare a proxy", () => {
    const spoofed = getTrustedClientIp({
      reqIp: SOCKET_IP,
      headers: { "x-forwarded-for": "198.51.100.1" },
      ...trustProxyOff,
    });
    expect(
      spoofed,
      "a forwarded header changed the identity used for rate limiting on an untrusted deployment",
    ).toBe(SOCKET_IP);
  });

  it("header ROTATION yields ONE identity, not a fresh bucket per request", () => {
    // The actual attack: same socket, a different forwarded value each time.
    const identities = new Set(
      ["198.51.100.1", "198.51.100.2", "198.51.100.3", "10.0.0.1", ""].map((xff) =>
        getTrustedClientIp({
          reqIp: SOCKET_IP,
          headers: { "x-forwarded-for": xff },
          ...trustProxyOff,
        }),
      ),
    );
    expect(
      [...identities],
      "rotating the forwarded header produced more than one limiter identity — the per-IP bound is bypassable",
    ).toEqual([SOCKET_IP]);
  });

  it("ignores CF-Connecting-IP too when no proxy is declared", () => {
    expect(
      getTrustedClientIp({
        reqIp: SOCKET_IP,
        headers: { "cf-connecting-ip": "198.51.100.9" },
        ...trustProxyOff,
      }),
    ).toBe(SOCKET_IP);
  });

  it("PHASE 13 §1 (NEW-022): getTrustedClientIp no longer walks headers — it normalises the resolved reqIp", () => {
    // The forwarded-hop SELECTION moved to Fastify's @fastify/proxy-addr,
    // configured by the declared ProxyTrustPolicy. By the time reqIp reaches
    // this function it is ALREADY the resolved client (the rightmost hop for a
    // single-proxy topology, the socket peer when trust is off). So the header
    // must NOT influence the result — honouring it here would reintroduce the
    // second, forgeable resolver NEW-022 removed. The end-to-end selection is
    // proven against real processes in
    // phase13-public-write-bounds.integration.test.ts.
    expect(
      getTrustedClientIp({
        reqIp: "198.51.100.42",
        headers: { "x-forwarded-for": "10.0.0.9, 192.168.1.4, 203.0.113.1" },
        trustProxy: true,
      }),
    ).toBe("198.51.100.42");
  });

  it("PHASE 13 §1 (NEW-022): normalises an IPv4-mapped resolved address", () => {
    expect(getTrustedClientIp({ reqIp: "::ffff:198.51.100.42" })).toBe(
      "198.51.100.42",
    );
  });
});

describe("PHASE1-002 / PHASE1-003 — neither intake surface keeps a private copy", () => {
  for (const file of INTAKE_ROUTE_FILES) {
    it(`derives the limiter IP through the canonical binding: ${file}`, () => {
      expect(
        src(file).includes("trustedClientIpKey"),
        `${file} must derive the limiter IP from the canonical trusted-IP binding`,
      ).toBe(true);
    });

    it(`does not read a forwarded header on its own again: ${file}`, () => {
      // The specific regression. Anything that reaches for the raw header in a
      // rate-limiting path is re-creating the bypass, whatever it then does
      // with the value. Comments are stripped so the explanation of the defect
      // does not read as the defect.
      const code = src(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const rawHeaderReads = code.match(
        /headers\s*\[\s*["'](x-forwarded-for|cf-connecting-ip)["']\s*\]/gi,
      );
      expect(
        rawHeaderReads,
        `${file} reads a forwarded header directly again — route the decision through trustedClientIpKey`,
      ).toBeNull();
    });
  }

  it("still applies BOTH the per-IP and per-capability bounds", () => {
    // A distributed attacker with many real addresses defeats any per-IP bound;
    // the intake-link layer is what bounds that. Losing either is a regression.
    expect(ROUTE_SRC).toMatch(/citizen-intake:ip:/);
    expect(ROUTE_SRC).toMatch(/citizen-intake:token:/);
  });
});
