/**
 * Phase IA-home-acceptance — dev-login + persona-seed source contracts.
 *
 * The dev-login endpoint mints real sessions for the Playwright Home
 * acceptance suite. Because it is an auth surface, its production guard
 * and persona allowlist are safety-critical — pinned here so a
 * regression can never ship a prod-reachable impersonation login.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { devAuthEnabled } from "../src/dev/dev-login.js";
import {
  HOME_PERSONAS,
  HOME_PERSONA_KEYS,
  isHomePersonaKey,
} from "../src/dev/home-personas.js";
import { signJwt } from "../src/services/jwt.js";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

// ============================================================================
// 1. Production guard (three layers)
// ============================================================================

describe("Phase IA-dev-auth — production safety", () => {
  const ORIG = { node: process.env.NODE_ENV, flag: process.env.DEV_AUTH_ENABLED };

  it("devAuthEnabled() is FALSE in production even with the flag on", () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_AUTH_ENABLED = "true";
    expect(devAuthEnabled()).toBe(false);
    process.env.NODE_ENV = ORIG.node;
    process.env.DEV_AUTH_ENABLED = ORIG.flag;
  });

  it("devAuthEnabled() is FALSE outside production unless explicitly opted in", () => {
    process.env.NODE_ENV = "development";
    delete process.env.DEV_AUTH_ENABLED;
    expect(devAuthEnabled()).toBe(false);
    process.env.DEV_AUTH_ENABLED = "true";
    expect(devAuthEnabled()).toBe(true);
    process.env.NODE_ENV = ORIG.node;
    process.env.DEV_AUTH_ENABLED = ORIG.flag;
  });

  it("the route plugin is registered ONLY behind devAuthEnabled() in server.ts", () => {
    const SERVER = readApi("src/server.ts");
    expect(SERVER).toMatch(/if \(devAuthEnabled\(\)\) \{[\s\S]*?await app\.register\(devLoginRoutes\)/);
  });

  it("the handler re-checks devAuthEnabled() and 404s (defence in depth)", () => {
    const ROUTE = readApi("src/dev/dev-login.ts");
    expect(ROUTE).toMatch(/if \(!devAuthEnabled\(\)\)/);
    expect(ROUTE).toMatch(/code\(404\)/);
  });
});

// ============================================================================
// 2. Persona allowlist + token minting
// ============================================================================

describe("Phase IA-dev-auth — persona allowlist + minting", () => {
  it("accepts ONLY the three fixed persona keys", () => {
    expect(HOME_PERSONA_KEYS).toEqual(["pro-empty", "pro-populated", "team-org"]);
    expect(isHomePersonaKey("pro-empty")).toBe(true);
    expect(isHomePersonaKey("admin")).toBe(false);
    expect(isHomePersonaKey("../../etc/passwd")).toBe(false);
  });

  it("mints a token verifiable by the SAME signJwt the production login uses", () => {
    const secret = "test-secret-at-least-32-bytes-long-xxxxx";
    const p = HOME_PERSONAS["pro-populated"];
    const token = signJwt(
      { sub: p.userId, provider: "DEV_IMPERSONATION", email: p.email },
      secret,
      60 * 60 * 24,
    );
    // 3-segment JWT.
    expect(token.split(".")).toHaveLength(3);
  });

  it("the route signs with provider DEV_IMPERSONATION (auditable) + 24h expiry", () => {
    const ROUTE = readApi("src/dev/dev-login.ts");
    expect(ROUTE).toMatch(/provider: "DEV_IMPERSONATION"/);
    expect(ROUTE).toMatch(/60 \* 60 \* 24/);
    // Reuses the production signer + secret resolver — no bespoke crypto.
    expect(ROUTE).toMatch(/signJwt\(/);
    expect(ROUTE).toMatch(/getSecret\("AUTH_JWT_SECRET"\)/);
  });

  it("each persona has a stable userId, workspaceId, plan and space type", () => {
    for (const key of HOME_PERSONA_KEYS) {
      const p = HOME_PERSONAS[key];
      expect(p.userId).toMatch(/^[0-9a-f-]{36}$/);
      expect(p.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(["PRO", "TEAM"]).toContain(p.plan);
      expect(["PERSONAL", "ORGANIZATION"]).toContain(p.workspaceType);
    }
    // The personas the brief mandates.
    expect(HOME_PERSONAS["pro-empty"].workspaceType).toBe("PERSONAL");
    expect(HOME_PERSONAS["pro-populated"].workspaceType).toBe("PERSONAL");
    expect(HOME_PERSONAS["team-org"].workspaceType).toBe("ORGANIZATION");
    expect(HOME_PERSONAS["team-org"].plan).toBe("TEAM");
  });
});

// ============================================================================
// 3. Seed script shape
// ============================================================================

describe("Phase IA-dev-auth — persona seed script", () => {
  const SEED = readApi("scripts/seed-home-personas.ts");

  it("the seed script exists and refuses to run in production", () => {
    expect(existsSync(fileURLToPath(new URL("../scripts/seed-home-personas.ts", import.meta.url)))).toBe(true);
    expect(SEED).toMatch(/NODE_ENV === "production"/);
    expect(SEED).toMatch(/REFUSING to seed personas in production/);
  });

  it("seeds the data each persona needs for its widgets", () => {
    // pro-populated: evidence + report + package + intake link + delivery + custody.
    expect(SEED).toMatch(/prisma\.evidence\.create/);
    expect(SEED).toMatch(/prisma\.report\.create/);
    expect(SEED).toMatch(/prisma\.verificationPackage\.create/);
    expect(SEED).toMatch(/prisma\.workflowIntakeLink\.create/);
    expect(SEED).toMatch(/prisma\.communicationMessage\.create/);
    expect(SEED).toMatch(/prisma\.custodyEvent\.createMany/);
    // team-org: pending submission + case.
    expect(SEED).toMatch(/prisma\.evidenceRequest\.create/);
    expect(SEED).toMatch(/prisma\.case\.create/);
    // entitlement drives the PRO/TEAM plan.
    expect(SEED).toMatch(/prisma\.entitlement\.create/);
  });

  it("sets REAL Evidence trust columns so trust-summary returns live counts", () => {
    expect(SEED).toMatch(/tsaStatus: "OK"/);
    expect(SEED).toMatch(/otsStatus: "ANCHORED"/);
    expect(SEED).toMatch(/signatureBase64:/);
    expect(SEED).toMatch(/publicVerifyState: "PUBLISHED"/);
  });

  it("the pending submission is RESPONSE_RECEIVED with no reviewer (inbox-visible)", () => {
    expect(SEED).toMatch(/status: "RESPONSE_RECEIVED"/);
    expect(SEED).toMatch(/assignedReviewerUserId: null/);
  });

  it("is idempotent — wipes the seed's fixed ids before recreating", () => {
    expect(SEED).toMatch(/async function wipe\(\)/);
    expect(SEED).toMatch(/deleteMany/);
  });
});

// ============================================================================
// 4. Playwright acceptance spec shape (the gate that must pass live)
// ============================================================================

describe("Phase IA-dev-auth — Playwright acceptance spec", () => {
  const specPath = fileURLToPath(
    new URL("../../../apps/web/e2e/home-v2-acceptance.spec.ts", import.meta.url),
  );

  it("the acceptance spec exists", () => {
    expect(existsSync(specPath)).toBe(true);
  });

  const SPEC = readFileSync(specPath, "utf8");

  it("logs in as all three personas via /v1/dev/login", () => {
    expect(SPEC).toMatch(/\/v1\/dev\/login\?persona=/);
    expect(SPEC).toMatch(/loginAs\(page, "pro-empty"\)/);
    expect(SPEC).toMatch(/loginAs\(page, "pro-populated"\)/);
    expect(SPEC).toMatch(/loginAs\(page, "team-org"\)/);
  });

  it("takes a screenshot per persona", () => {
    expect(SPEC).toMatch(/pro-empty\.png/);
    expect(SPEC).toMatch(/pro-populated\.png/);
    expect(SPEC).toMatch(/team-org\.png/);
  });

  it("fails on 404 / blank page", () => {
    expect(SPEC).toMatch(/must not be a 404/);
    expect(SPEC).toMatch(/must not be blank/);
  });

  it("fails if banned routes appear (/workspaces, bare /evidence-requests, /v/)", () => {
    expect(SPEC).toMatch(/\/workspaces/);
    expect(SPEC).toMatch(/evidence-requests\(\?:\\\?\|\$\)/);
    expect(SPEC).toMatch(/\\\/v\\\//);
  });

  it("verifies Personal Space has no Team Work", () => {
    expect(SPEC).toMatch(/team-work'\]"\)\)\.toHaveCount\(0\)/);
    expect(SPEC).toMatch(/team-work'\]"\)\)\.toBeVisible\(\)/); // present for team-org
  });

  it("verifies Trust State shows live counts", () => {
    expect(SPEC).toMatch(/data-trust-key='tsa'/);
    expect(SPEC).toMatch(/stamped/);
  });

  it("verifies Request & Collect shows live intake/delivery data", () => {
    expect(SPEC).toMatch(/data-collection-id/);
    expect(SPEC).toMatch(/data-delivery-status='DELIVERED'/);
  });

  it("verifies Submissions appears for the team-org persona", () => {
    expect(SPEC).toMatch(/submissions-to-review/);
    expect(SPEC).toMatch(/data-submission-action='review'/);
  });

  it("verifies Activity shows real events", () => {
    expect(SPEC).toMatch(/activity'\] \[data-activity-kind\]/);
  });

  it("a playwright config exists pointing at the web base", () => {
    const cfg = fileURLToPath(new URL("../../../apps/web/playwright.config.ts", import.meta.url));
    expect(existsSync(cfg)).toBe(true);
  });
});
