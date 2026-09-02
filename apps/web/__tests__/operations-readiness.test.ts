/**
 * Phase 8 — Enterprise Production Readiness page contract (SCOPE F/I/J).
 *
 * Source-contract pins (node:test style, matching sibling web tests):
 *
 *   1. The page exists at app/(app)/admin/platform/readiness/page.tsx.
 *   2. It is gated by <PageRouteGate routeId="operations.readiness">.
 *   3. It renders honest posture — the DB-backup label is a neutral
 *      "Managed platform (assumed)" / "Not configured", never a
 *      fabricated positive, and there is no fake uptime / SLA / SOC2 /
 *      penetration-test claim.
 *   4. It renders the known-limitations list and links the runbooks.
 *   5. Errors flow through the sanctioned path (`toSafeUserError`).
 *   6. It reads from GET /v1/operations/readiness.
 *
 * NOTE: this test deliberately does NOT assert on ROUTE_REGISTRY —
 * the `operations.readiness` registry / pillar / tiers entries are
 * owned by the shared-wiring owner and are wired separately. Coupling
 * to that here would make the contract fail before wiring lands.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = resolve(dirname(__filename), "..");
const PAGE = resolve(APP_ROOT, "app/(app)/admin/platform/readiness/page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — page exists", () => {
  it("app/(app)/admin/platform/readiness/page.tsx exists", () => {
    assert.ok(existsSync(PAGE), "readiness page.tsx should exist");
  });
});

describe("Pin 2 — gated by PageRouteGate routeId=operations.readiness", () => {
  it("wraps content in the exact route gate", () => {
    const src = read(PAGE);
    assert.match(src, /<PageRouteGate\s+routeId="operations\.readiness">/);
  });
});

describe("Pin 3 — honest posture, no fabricated positives", () => {
  const src = read(PAGE);

  it("renders honest DB-backup labels (managed / not configured)", () => {
    assert.match(src, /Managed platform \(assumed\)/);
    assert.match(src, /Not configured/);
  });

  it("has NO fake uptime / SLA / SOC2 / pentest positive claims", () => {
    assert.doesNotMatch(src, /99\.9%\s*uptime/i);
    assert.doesNotMatch(src, /guaranteed\s*uptime/i);
    assert.doesNotMatch(src, /soc\s*2\s*(certified|compliant)/i);
    assert.doesNotMatch(src, /iso\s*27001\s*(certified|compliant)/i);
    assert.doesNotMatch(src, /has\s+passed\s+a\s+penetration\s+test/i);
  });

  it("explicitly disclaims uptime / SLA / certification / pentest", () => {
    // The subtitle states the surface makes no such claims. Note: specific
    // certification NAMES (SOC 2 / ISO 27001) are intentionally NOT rendered
    // in app JSX — the forbidden-copy guard (phase-32-8 Test 7) bans naming
    // certifications in-app even to disclaim them; they live in the legal
    // docs only. The page uses the generic "third-party security-certification".
    assert.match(
      src,
      /makes no uptime, SLA, third-party\s*[\r\n]?\s*security-certification, or penetration-test claims/,
    );
    assert.doesNotMatch(src, /SOC 2|ISO 27001/);
  });
});

describe("Pin 4 — limitations + runbooks", () => {
  const src = read(PAGE);

  it("renders the known-limitations list", () => {
    assert.match(src, /knownLimitations/);
    assert.match(src, /Known limitations/);
  });

  it("links the four runbooks to the in-app reader, by slug", () => {
    // This used to assert the page contained "sre-runbooks.md" — a REPOSITORY
    // PATH. The page did print those, under links that all went to the runbook
    // INDEX, so during an incident an operator got a filename they cannot open
    // beside a link that made them search a list for it.
    //
    // The four are real slugs in the generated catalog and the reader at
    // /admin/platform/runbooks/:slug renders them. The test now pins the thing
    // worth pinning: that each is reachable, and that the path is gone.
    for (const slug of [
      "disaster-recovery",
      "sre-runbooks",
      "pentest-readiness",
      "security-review",
    ]) {
      assert.match(src, new RegExp('slug: "' + slug + '"'));
    }
    assert.ok(
      src.includes("/admin/platform/runbooks/${r.slug}"),
      "each runbook must link its own reader, not the index",
    );
  });

  it("prints no repository path", () => {
    // Comments stripped: this file and the page both DISCUSS the paths they
    // must not render, and a check that cannot tell prose from output teaches
    // people to stop explaining themselves.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /docs\/runbooks\//);
  });

  it("says so when the backend flags no limitations", () => {
    // An empty list previously rendered the sentence "These are real, flagged
    // caveats" above nothing, which reads as a section that failed to load —
    // on the one surface whose entire purpose is being believed.
    assert.match(src, /limitations\.length === 0/);
  });
});

describe("Pin 5 — sanctioned error path", () => {
  it("uses toSafeUserError", () => {
    const src = read(PAGE);
    assert.match(src, /toSafeUserError/);
    // No raw error.message passthrough into setError.
    assert.doesNotMatch(src, /setError\(\s*err\.message/);
  });
});

describe("Pin 6 — reads the readiness endpoint", () => {
  it("fetches GET /v1/operations/readiness", () => {
    const src = read(PAGE);
    assert.match(src, /\/v1\/operations\/readiness/);
  });
});
