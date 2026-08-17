/**
 * PHASE 1 §4 — every unauthenticated public WRITE is bounded, and the bound is
 * applied before anything is persisted.
 *
 * `UnboundedPublicWriteRoutes = 0` is a Phase-1 exit counter. FINAL-004 bounded
 * the two Citizen Capture writes; this suite is what stops the counter being
 * satisfied by inspection, because two more public writes were found afterwards
 * (PHASE1-005: `/v1/contact-sales` and `/v1/demo-requests`), and they had gone
 * unnoticed for a specific and repeatable reason.
 *
 * Both files documented anti-abuse in their headers. Both descriptions were
 * true and neither was a bound: the web tier's limit guards the Next proxy
 * rather than the API route, which is reachable directly, and the service
 * layer's "IP-hammer" sets a spam FLAG that changes priority while the
 * `create` runs regardless. Reading the comments was enough to conclude the
 * routes were protected; only reading the write path showed they were not.
 *
 * So these assertions are about the SOURCE of the handlers — that a limiter is
 * consulted, and that the refusal returns before the persist call. Whether a
 * 429 is actually emitted end-to-end is a runtime proof (§11) and is not
 * claimed here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(path.join(REPO, rel), "utf8").replace(/\r\n/g, "\n");

/** Comments removed: a file that DESCRIBES a limit must not pass for having one. */
const code = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Every unauthenticated public write in the release surface, with the persist
 * call each handler must not reach while rate-limited.
 */
const PUBLIC_WRITES = [
  {
    route: "POST /v1/contact-sales",
    file: "services/api/src/routes/contact-sales.routes.ts",
    // The symbol the HANDLER calls to apply the bound. For two of these it is
    // `enforceRateLimit` directly; the citizen routes call a helper that wraps
    // both the per-IP and per-link layers.
    limiterCall: "enforceRateLimit",
    persist: "createContactSalesRequest",
    limiterKey: "contact-sales:ip:",
  },
  {
    route: "POST /v1/demo-requests",
    file: "services/api/src/routes/demo-requests.routes.ts",
    limiterCall: "enforceRateLimit",
    persist: "createDemoRequest",
    limiterKey: "demo-requests:ip:",
  },
  {
    route: "POST /v1/intake/citizen/sessions",
    file: "services/api/src/routes/citizen-capture.routes.ts",
    limiterCall: "applyCitizenRateLimits",
    // The first thing this handler persists: device registration precedes the
    // capture-session descriptor, so it is the write that must not be reached.
    persist: "registerDevice(",
    limiterKey: "citizen-intake:ip:",
  },
] as const;

describe("PHASE 1 §4 — unauthenticated public writes are bounded", () => {
  for (const w of PUBLIC_WRITES) {
    it(`${w.route} consults a rate limiter`, () => {
      const c = code(w.file);
      expect(
        c.includes("enforceRateLimit"),
        `${w.file} performs an unauthenticated write with no rate limiter`,
      ).toBe(true);
      expect(c).toContain(w.limiterKey);
    });

    it(`${w.route} keys its limiter on the TRUSTED address`, () => {
      // A bound keyed on a caller-supplied header is not a bound (PHASE1-002).
      const c = code(w.file);
      expect(c).toContain("trustedClientIpKey");
      expect(
        c.match(/headers\s*\[\s*["'](x-forwarded-for|cf-connecting-ip)["']\s*\]/gi),
        `${w.file} derives an address from a caller-controlled header`,
      ).toBeNull();
    });

    it(`${w.route} refuses BEFORE it persists`, () => {
      // The ordering is the property that matters: a limiter consulted after
      // the write bounds nothing, and a 429 returned after a row is created is
      // a lie to the caller as well.
      const c = code(w.file);
      const persistAt = c.indexOf(w.persist);
      expect(persistAt, `${w.file}: persist call ${w.persist} not found`).toBeGreaterThanOrEqual(0);

      // The LAST gate invocation that still precedes the persist. Using the
      // last one rather than the first is what makes this meaningful for a
      // file with several handlers: every persist must have a gate ahead of it.
      const gateBefore = c.lastIndexOf(w.limiterCall, persistAt);
      expect(
        gateBefore,
        `${w.file}: nothing applies a rate limit before ${w.persist} — a rate-limited request would still write`,
      ).toBeGreaterThanOrEqual(0);
      expect(gateBefore).toBeLessThan(persistAt);
      expect(c, `${w.file}: no 429 refusal anywhere`).toContain("429");
    });
  }

  it("the recorded IP on lead rows is the trusted one, not a header", () => {
    // The service layer counts rows sharing `ipAddress` as a spam signal, and
    // an operator reads it while triaging. Both are worthless if the sender
    // chose the value.
    for (const f of [
      "services/api/src/routes/contact-sales.routes.ts",
      "services/api/src/routes/demo-requests.routes.ts",
    ]) {
      expect(code(f)).toContain("trustedClientIp");
    }
  });
});
