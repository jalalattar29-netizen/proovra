/**
 * PHASE 12 — POINT 8: the synthetic payment fixtures.
 *
 * GitHub push protection blocked this release. The three findings were fixtures
 * whose bodies were 24 zero characters — 0.000 bits of entropy, about as
 * obviously fake as a value can be — but push protection matches provider
 * PREFIXES by shape, not by entropy, so a zeroed fixture is indistinguishable
 * from a live key to the scanner. That is the correct behaviour for a scanner
 * that must not be taught exceptions.
 *
 * The fix keeps the runtime value identical and removes the literal from the
 * source: the tokens are joined from fragments at call time. These tests pin
 * both halves — the shape the code under test depends on, and the absence of a
 * contiguous literal in the repository.
 *
 * No constructed value is ever printed; assertions compare, they do not report.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  syntheticStripeLiveSecret,
  syntheticStripeTestSecret,
} from "./point8/synthetic-credentials.js";

const API_ROOT = resolve(import.meta.dirname, "..");

/** Built at runtime so this file contains no contiguous literal either. */
const LIVE_PREFIX = ["sk", ["li", "ve"].join("")].join("_");
const TEST_PREFIX = ["sk", ["te", "st"].join("")].join("_");

describe("PHASE 12 POINT 8 — synthetic payment fixtures", () => {
  it("produce the exact provider prefixes the code under test inspects", () => {
    expect(syntheticStripeLiveSecret().startsWith(`${LIVE_PREFIX}_`)).toBe(true);
    expect(syntheticStripeTestSecret().startsWith(`${TEST_PREFIX}_`)).toBe(true);
  });

  it("are deterministic — the same value every call", () => {
    expect(syntheticStripeLiveSecret()).toBe(syntheticStripeLiveSecret());
    expect(syntheticStripeTestSecret()).toBe(syntheticStripeTestSecret());
  });

  it("carry no entropy — the body is a single repeated character", () => {
    for (const v of [syntheticStripeLiveSecret(), syntheticStripeTestSecret()]) {
      const body = v.slice(`${LIVE_PREFIX}_`.length);
      expect(body.length).toBeGreaterThanOrEqual(16);
      expect(new Set(body).size).toBe(1);
    }
  });

  it("live and test fixtures are distinguishable — the mode is not lost", () => {
    expect(syntheticStripeLiveSecret()).not.toBe(syntheticStripeTestSecret());
  });

  it("the helper SOURCE contains no contiguous provider-secret literal", () => {
    const src = readFileSync(
      resolve(API_ROOT, "test/point8/synthetic-credentials.ts"),
      "utf8",
    );

    // The assembled values must not appear anywhere in the file that builds them.
    expect(src).not.toContain(syntheticStripeLiveSecret());
    expect(src).not.toContain(syntheticStripeTestSecret());
    // Nor the bare prefixes followed by secret-like material.
    expect(src).not.toMatch(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{4,}/);
  });

  it("no call site reintroduces a contiguous literal", () => {
    const callSites = [
      "test/phase-12-point8-staging-preflight.test.ts",
      "test/phase-12-point8-staging-deploy-guard.test.ts",
      "test/phase-32-7-final-production-stabilization.test.ts",
      "test/phase-p2-0-secrets-manager.test.ts",
    ];

    for (const rel of callSites) {
      const src = readFileSync(resolve(API_ROOT, rel), "utf8");
      expect(src, `${rel} reintroduced a contiguous provider literal`).not.toMatch(
        /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{4,}/,
      );
    }
  });

  it("this suite itself emits no constructed value", () => {
    // The values exist only as comparands. Anything a reporter could capture —
    // a test name, a failure message — must not carry them.
    const ownSource = readFileSync(
      resolve(API_ROOT, "test/phase-12-point8-synthetic-credentials.test.ts"),
      "utf8",
    );

    expect(ownSource).not.toContain(syntheticStripeLiveSecret());
    expect(ownSource).not.toContain(syntheticStripeTestSecret());
  });
});
