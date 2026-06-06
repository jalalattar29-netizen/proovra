/**
 * PHASE 4 — Governance Policy + SLA Operations copy regression lock.
 *
 * Brief required:
 *
 *   • /governance/policy intro must clarify it sets the workspace
 *     baseline SLA + step-up enforcement, and that workflow templates
 *     can override SLA per template.
 *
 *   • /reviewer-ops/sla intro must clarify it is a read-only
 *     operations dashboard reflecting current SLA pressure; policy
 *     is administered at /governance/policy.
 *
 *   • Backend routes are unchanged. Pages are NOT relocated.
 *
 * Runs under Node's built-in `node:test`. Invoke with e.g.
 *   `node --test --import tsx \
 *      apps/web/__tests__/governance-policy-copy.test.ts`
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const POLICY_PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "governance",
  "policy",
  "page.tsx",
);
const SLA_PAGE_PATH = resolve(
  __dirname,
  "..",
  "app",
  "(app)",
  "reviewer-ops",
  "sla",
  "page.tsx",
);

const POLICY_PAGE_SOURCE = readFileSync(POLICY_PAGE_PATH, "utf8");
const SLA_PAGE_SOURCE = readFileSync(SLA_PAGE_PATH, "utf8");

// ---------------------------------------------------------------------------
// 1. /governance/policy intro copy.
// ---------------------------------------------------------------------------

test("/governance/policy intro is tagged for regression detection", () => {
  assert.match(
    POLICY_PAGE_SOURCE,
    /data-governance-policy-intro/,
    "Intro paragraph must carry data-governance-policy-intro so " +
      "tests can scope the copy assertion.",
  );
});

test("/governance/policy intro mentions workspace baseline SLA", () => {
  assert.match(
    POLICY_PAGE_SOURCE,
    /workspace baseline SLA/i,
    "Intro must mention the workspace baseline SLA so operators " +
      "understand the scope of this surface.",
  );
});

test("/governance/policy intro mentions step-up enforcement", () => {
  assert.match(
    POLICY_PAGE_SOURCE,
    /step-up enforcement/i,
    "Intro must mention step-up enforcement to surface the second " +
      "responsibility of this page.",
  );
});

test("/governance/policy intro clarifies templates can override SLA per template", () => {
  assert.match(
    POLICY_PAGE_SOURCE,
    /Workflow templates can override\s+\n?\s*the SLA per template/i,
    "Intro must clarify workflow templates can override SLA per " +
      "template — the brief mandates this explicit framing.",
  );
});

// ---------------------------------------------------------------------------
// 2. /reviewer-ops/sla intro copy.
// ---------------------------------------------------------------------------

test("/reviewer-ops/sla intro is tagged for regression detection", () => {
  assert.match(
    SLA_PAGE_SOURCE,
    /data-sla-dashboard-intro/,
    "Intro paragraph must carry data-sla-dashboard-intro so tests " +
      "can scope the copy assertion.",
  );
});

test("/reviewer-ops/sla intro clarifies it is a read-only operations dashboard", () => {
  assert.match(
    SLA_PAGE_SOURCE,
    /[Rr]ead-only operations dashboard/,
    "Intro must explicitly state this is a read-only operations " +
      "dashboard — the brief mandates this framing.",
  );
});

test("/reviewer-ops/sla intro mentions current SLA pressure", () => {
  // The intro paragraph may wrap, so we accept whitespace (including
  // newlines + indentation) between the words.
  assert.match(
    SLA_PAGE_SOURCE,
    /current SLA\s+pressure/i,
    "Intro must mention 'current SLA pressure' so operators understand " +
      "this surface reflects state, not policy.",
  );
});

test("/reviewer-ops/sla intro points to /governance/policy for policy administration", () => {
  assert.match(
    SLA_PAGE_SOURCE,
    /SLA policy is\s+\n?\s*administered at \/governance\/policy/,
    "Intro must redirect policy administration to /governance/policy " +
      "so operators do not look here for the wrong control.",
  );
});

// ---------------------------------------------------------------------------
// 3. Pages are NOT relocated, routes unchanged.
// ---------------------------------------------------------------------------

test("/governance/policy still calls /v1/reviewer-ops/sla-policy", () => {
  // The brief mandates: do NOT rename backend routes. The page must
  // continue to hit the same canonical endpoint.
  assert.match(
    POLICY_PAGE_SOURCE,
    /\/v1\/reviewer-ops\/sla-policy/,
    "Policy page must continue to call /v1/reviewer-ops/sla-policy — " +
      "renaming the backend route is forbidden in this phase.",
  );
});

test("/reviewer-ops/sla still calls the canonical dashboard / analytics routes", () => {
  // The dashboard route is canonical and must not be renamed.
  assert.match(
    SLA_PAGE_SOURCE,
    /\/v1\/reviewer-ops\/dashboard/,
    "SLA page must continue to call the canonical dashboard route.",
  );
  assert.match(
    SLA_PAGE_SOURCE,
    /\/v1\/reviewer-ops\/analytics\/escalations/,
    "SLA page must continue to call the canonical escalation " +
      "analytics route.",
  );
});

test("/governance/policy keeps its PageRouteGate routeId", () => {
  // Relocation is forbidden — the page must continue to declare its
  // canonical route id.
  assert.match(
    POLICY_PAGE_SOURCE,
    /routeId="governance\.policy"/,
    "Policy page must keep routeId=governance.policy — relocation is " +
      "forbidden.",
  );
});

test("/reviewer-ops/sla keeps its PageRouteGate routeId", () => {
  assert.match(
    SLA_PAGE_SOURCE,
    /routeId="review\.sla"/,
    "SLA page must keep routeId=review.sla — relocation is " +
      "forbidden.",
  );
});

// ---------------------------------------------------------------------------
// 4. Bounded copy — no developer markers.
// ---------------------------------------------------------------------------

test("intro copy on both pages is free of dev markers", () => {
  for (const [name, src] of [
    ["/governance/policy", POLICY_PAGE_SOURCE],
    ["/reviewer-ops/sla", SLA_PAGE_SOURCE],
  ] as const) {
    assert.doesNotMatch(
      src,
      /TODO|FIXME|XXX/i,
      `${name} source must be free of TODO / FIXME / XXX markers.`,
    );
  }
});
