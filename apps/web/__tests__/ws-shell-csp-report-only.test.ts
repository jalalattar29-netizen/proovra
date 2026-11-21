/**
 * PRO-PW-09 (closure, owner decision J) — behavioural, through the real
 * middleware in a production build:
 *
 *   - the enforced policy is still sent, as strong as before;
 *   - the named-origin policy is sent as Content-Security-Policy-Report-Only
 *     with a report endpoint, and names no bare scheme source;
 *   - the runbook early answers carry the policy (they carried none);
 *   - the failure path is never wider than the enforced policy.
 */
import "./support/production-csp-env";

import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { FAIL_SAFE_CSP, middleware } from "../middleware";
import { SPLIT_HOSTS } from "./support/split-host-env";
import { TEST_API_ORIGIN, TEST_SENTRY_ORIGIN, TEST_TILE_ORIGIN } from "./support/production-csp-env";

type Policy = Map<string, string[]>;

function parse(header: string | null): Policy {
  assert.ok(header, "policy header missing");
  const out: Policy = new Map();
  for (const part of header.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/** The sources a directive effectively allows (fetch directives fall back to default-src). */
function effective(policy: Policy, directive: string): string[] {
  const own = policy.get(directive);
  if (own) return own;
  if (directive.startsWith("script-src-") || directive.startsWith("style-src-")) {
    const base = directive.replace(/-(elem|attr)$/, "");
    if (policy.has(base)) return policy.get(base)!;
  }
  const NO_FALLBACK = new Set(["base-uri", "form-action", "frame-ancestors"]);
  return NO_FALLBACK.has(directive) ? ["*"] : (policy.get("default-src") ?? ["*"]);
}

const appReq = (path: string) => new NextRequest(`https://${SPLIT_HOSTS.app}${path}`, { headers: { host: SPLIT_HOSTS.app } });

test("PRO-PW-09: a normal response keeps the enforced nonce policy and adds the named-origin Report-Only policy", async () => {
  const res = await middleware(appReq("/home"));
  const enforced = parse(res.headers.get("content-security-policy"));
  const script = enforced.get("script-src") ?? [];
  assert.ok(script.some((s) => /^'nonce-.+'$/.test(s)), "enforced script-src carries the nonce");
  assert.ok(!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'") && !script.includes("https:"));
  assert.deepEqual(enforced.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(enforced.get("object-src"), ["'none'"]);
  assert.deepEqual(enforced.get("default-src"), ["'self'"]);

  const reportOnly = parse(res.headers.get("content-security-policy-report-only"));
  // Same nonce in both headers.
  const nonce = script.find((s) => s.startsWith("'nonce-"));
  assert.ok(reportOnly.get("script-src")?.includes(nonce!));
  // No bare scheme source anywhere: every external origin is named.
  for (const [name, sources] of reportOnly) {
    for (const bare of ["https:", "http:", "wss:", "ws:", "*"]) {
      assert.ok(!sources.includes(bare), `${name} carries bare ${bare}`);
    }
  }
  assert.ok(reportOnly.get("connect-src")?.includes(TEST_SENTRY_ORIGIN), "Sentry ingest origin named from the DSN");
  assert.ok(reportOnly.get("connect-src")?.includes(TEST_API_ORIGIN));
  assert.ok(reportOnly.get("connect-src")?.includes("https://proovra-evidence-prod-eu.s3.eu-central-1.amazonaws.com"));
  assert.ok(reportOnly.get("img-src")?.includes(TEST_TILE_ORIGIN), "approved tile origin named");
  assert.ok(reportOnly.get("img-src")?.includes("https://*.googleusercontent.com"));
  assert.deepEqual(reportOnly.get("font-src"), ["'self'", "data:"]);
  assert.deepEqual(reportOnly.get("report-uri"), ["/api/csp-report"]);
  assert.deepEqual(reportOnly.get("report-to"), ["csp-endpoint"]);
  assert.equal(res.headers.get("reporting-endpoints"), 'csp-endpoint="/api/csp-report"');
});

test("PRO-PW-09: the Report-Only policy is never wider than the enforced one, directive by directive", async () => {
  const res = await middleware(appReq("/home"));
  const enforced = parse(res.headers.get("content-security-policy"));
  const reportOnly = parse(res.headers.get("content-security-policy-report-only"));
  for (const [name, sources] of reportOnly) {
    if (name === "report-uri" || name === "report-to") continue;
    const allowed = effective(enforced, name);
    for (const s of sources) {
      const covered =
        allowed.includes(s) || (s.startsWith("https://") && allowed.includes("https:"));
      assert.ok(covered, `${name} ${s} is not allowed by the enforced policy`);
    }
  }
});

test("PRO-PW-09: a malformed runbook slug's not-found rewrite carries the enforced policy (it carried none)", async () => {
  const res = await middleware(appReq("/admin/platform/runbooks/%E0%A4%A"));
  assert.equal(res.headers.get("x-middleware-rewrite")?.endsWith("/not-found"), true);
  assert.ok(parse(res.headers.get("content-security-policy")).get("script-src")?.some((s) => s.startsWith("'nonce-")));
  assert.ok(res.headers.get("content-security-policy-report-only"));
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("PRO-PW-09: the failure path answers with FAIL_SAFE_CSP, which is no wider than the enforced policy", async () => {
  const normal = await middleware(appReq("/home"));
  const enforced = parse(normal.headers.get("content-security-policy"));

  // Force an exception inside the middleware's try block.
  const broken = appReq("/home");
  Object.defineProperty(broken, "headers", {
    get() {
      throw new Error("boom");
    },
  });
  const res = await middleware(broken);
  assert.equal(res.headers.get("content-security-policy"), FAIL_SAFE_CSP);

  const failSafe = parse(FAIL_SAFE_CSP);
  assert.deepEqual(failSafe.get("script-src"), ["'self'"]);
  for (const [name, sources] of failSafe) {
    assert.ok(!sources.includes("https:"), `${name} allows any https origin`);
    const allowed = effective(enforced, name);
    for (const s of sources) assert.ok(allowed.includes(s), `failure-path ${name} ${s} exceeds the enforced policy`);
  }
  // Fetch directives without their own entry fall back to 'self' only.
  for (const d of ["connect-src", "frame-src", "media-src", "worker-src"]) {
    assert.deepEqual(effective(failSafe, d), ["'self'"], d);
  }
});
