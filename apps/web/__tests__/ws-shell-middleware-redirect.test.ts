/**
 * PRO-A1-02 / PRO-PW-01 — the web-host → app-host redirect keeps the query.
 * PRO-PW-09 — a malformed runbook slug is a 404 rewrite, and the failure-path
 * CSP has an explicit script policy.
 *
 * Behavioural: the real middleware on a split-host deployment.
 */
import "./support/split-host-env";

import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { FAIL_SAFE_CSP, middleware } from "../middleware";
import { SPLIT_HOSTS } from "./support/split-host-env";

const onWebHost = (pathAndQuery: string) =>
  new NextRequest(`https://${SPLIT_HOSTS.web}${pathAndQuery}`, { headers: { host: SPLIT_HOSTS.web } });

test("PRO-A1-02: /billing?workspace=personal&plan=PRO on the web host redirects to the app host WITH the plan hint", async () => {
  const res = await middleware(onWebHost("/billing?workspace=personal&plan=PRO"));
  assert.ok(res.status >= 300 && res.status < 400, `status ${res.status}`);
  const location = new URL(res.headers.get("location") ?? "");
  assert.equal(location.host, SPLIT_HOSTS.app);
  assert.equal(location.pathname, "/billing");
  assert.equal(location.searchParams.get("workspace"), "personal");
  assert.equal(location.searchParams.get("plan"), "PRO");
});

test("PRO-PW-01: a query-carrying deep link (/evidence/E?tab=artifacts) survives the host switch; a bare path stays bare", async () => {
  const deep = await middleware(onWebHost("/evidence/abc?tab=artifacts"));
  assert.equal(new URL(deep.headers.get("location") ?? "").search, "?tab=artifacts");
  const bare = await middleware(onWebHost("/home"));
  assert.equal(new URL(bare.headers.get("location") ?? "").search, "");
});

test("PRO-PW-09: the failure-path policy states script-src 'self'", () => {
  assert.match(FAIL_SAFE_CSP, /(^|; )script-src 'self'(;|$)/);
});

test("PRO-PW-09: a malformed %-escape in a runbook slug is rewritten to not-found, not thrown onto the failure path", async () => {
  const req = new NextRequest(`https://${SPLIT_HOSTS.app}/admin/platform/runbooks/%E0%A4%A`, {
    headers: { host: SPLIT_HOSTS.app },
  });
  const res = await middleware(req);
  assert.equal(res.headers.get("x-middleware-rewrite")?.endsWith("/not-found"), true);
});
