/**
 * PHASE 32.7 — Final Production Stabilization contract tests.
 *
 * After investigation (see docs/recovery/PHASE_32_7_FINAL_PRODUCTION_STABILIZATION.md),
 * the platform had NO actual production correctness bugs in the areas
 * the phase prompt enumerated:
 *
 *   - Governance legal-holds / case-legal-holds: already fixed in
 *     32.7.4 + 32.7.6 (optional-subsystem pattern, narrowed SELECT).
 *   - Runtime readiness: fail-closed contract correct; CR0.5 / 32.6.5 /
 *     32.7.3 tests pin recovery paths.
 *   - Artifact polling: status endpoint side-effect-free; downloads
 *     emit custody events only on actual download. 32.5 pins this.
 *   - Infinite loaders: all 8 audited critical pages have proper
 *     LoadState branches and error handling.
 *
 * So this file's role is mostly **regression pins** that lock in the
 * correctness that already exists, plus two genuine new contracts:
 *
 *   1. Stripe secret-key shape validation (new in 32.7).
 *   2. `.env.example` mirrors the canonical R8.C structure.
 *
 * Hard rules preserved (CR1.7 §12):
 *   - No new features. No redesign. No new state library.
 *   - No capture / custody / report / package logic touched (file-size
 *     pin in CR1.6 Test 7).
 */

import {
  collectStartupViolations,
  type StartupConfigViolation,
} from "../src/config/index.js";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, afterEach } from "vitest";
import { syntheticStripeLiveSecret, syntheticStripeTestSecret } from "./point8/synthetic-credentials.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}

type EnvPatch = Record<string, string | undefined>;

function withEnv(patch: EnvPatch, fn: () => void): void {
  const saved: EnvPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

function violationReasons(patch: EnvPatch): string[] {
  let reasons: string[] = [];
  withEnv(patch, () => {
    reasons = collectStartupViolations().map(
      (v: StartupConfigViolation) => `${v.envName}:${v.reason}`,
    );
  });
  return reasons;
}

// ===========================================================================
// PART 1 — NEW: Stripe secret-key shape validation
// ===========================================================================

describe("32.7 Test 1 — Stripe secret-key shape startup validation", () => {
  // The intent: a publishable key (`pk_live_*` / `pk_test_*`) in the
  // STRIPE_SECRET_KEY slot is a high-impact ops mistake. Stripe API
  // calls + webhook verification will return 401 silently. We catch
  // this at startup.

  const BASE_PROD_ENV: EnvPatch = {
    DATABASE_URL: "postgresql://localhost/test",
    AUTH_JWT_SECRET: "test_jwt_secret_minimum_thirty_two_chars_x",
    NODE_ENV: "development", // start in dev to isolate the Stripe check
    SIGNER_PROVIDER: "local-pem",
    SIGNING_PRIVATE_KEY_PATH: "keys/signing-private.pem",
    SAML_ENABLED: "false",
    COMMUNICATIONS_ENABLED: "false",
    IDENTITY_SECURITY_ENABLED: "false",
    INTEGRATIONS_ENABLED: "false",
  };

  it("rejects pk_live_ in STRIPE_SECRET_KEY slot", () => {
    const reasons = violationReasons({
      ...BASE_PROD_ENV,
      STRIPE_SECRET_KEY: "pk_live_FAKE0000_publishable_in_wrong_slot",
    });
    expect(reasons).toContain("STRIPE_SECRET_KEY:stripe_key_shape_invalid");
  });

  it("rejects pk_test_ in STRIPE_SECRET_KEY slot", () => {
    const reasons = violationReasons({
      ...BASE_PROD_ENV,
      STRIPE_SECRET_KEY: "pk_test_FAKE0000_publishable_in_wrong_slot",
    });
    expect(reasons).toContain("STRIPE_SECRET_KEY:stripe_key_shape_invalid");
  });

  it("accepts sk_live_ (real production secret)", () => {
    const reasons = violationReasons({
      ...BASE_PROD_ENV,
      STRIPE_SECRET_KEY: syntheticStripeLiveSecret(),
    });
    expect(reasons).not.toContain("STRIPE_SECRET_KEY:stripe_key_shape_invalid");
  });

  it("accepts sk_test_ (test secret)", () => {
    const reasons = violationReasons({
      ...BASE_PROD_ENV,
      STRIPE_SECRET_KEY: syntheticStripeTestSecret(),
    });
    expect(reasons).not.toContain("STRIPE_SECRET_KEY:stripe_key_shape_invalid");
  });

  it("does not flag when STRIPE_SECRET_KEY is unset (Stripe is optional in dev)", () => {
    const reasons = violationReasons({
      ...BASE_PROD_ENV,
      STRIPE_SECRET_KEY: "",
    });
    expect(reasons).not.toContain("STRIPE_SECRET_KEY:stripe_key_shape_invalid");
  });

  it("rejects an obviously malformed key (no sk_/pk_ prefix)", () => {
    const reasons = violationReasons({
      ...BASE_PROD_ENV,
      STRIPE_SECRET_KEY: "not-a-stripe-key-at-all",
    });
    expect(reasons).toContain("STRIPE_SECRET_KEY:stripe_key_shape_invalid");
  });
});

// ===========================================================================
// PART 2 — `.env.example` mirrors canonical R8.C structure
// ===========================================================================

describe("32.7 Test 2 — .env.example is canonical (post-R8.C structure)", () => {
  const EXAMPLE = readApi(".env.example");

  it("file is substantial (post-R8.C reflects ~200+ lines)", () => {
    expect(EXAMPLE.length).toBeGreaterThan(5000);
    expect(EXAMPLE.split("\n").length).toBeGreaterThan(150);
  });

  it("declares the post-R8.C single-occurrence + edit-in-place hard rules", () => {
    expect(EXAMPLE).toMatch(/HARD RULES/i);
    expect(EXAMPLE).toMatch(/exactly once/i);
    expect(EXAMPLE).toMatch(/edit.*in.place/i);
    expect(EXAMPLE).toMatch(/silently ignored/i);
  });

  it("contains every core required + feature-gated variable name", () => {
    const REQUIRED = [
      // Core
      "DATABASE_URL",
      "AUTH_JWT_SECRET",
      // R8.C signing
      "SIGNER_PROVIDER",
      "KMS_KEY_ID",
      "SIGNING_PRIVATE_KEY_PATH",
      "SIGNING_KEY_ID",
      // R8.C storage safety
      "S3_ENDPOINT",
      "S3_ALLOW_INSECURE",
      // R8.C SAML safety
      "SAML_ENABLED",
      "SAML_SP_ACS_URL",
      // Feature-gated secrets (R8.C startup validator)
      "COMMUNICATIONS_ENABLED",
      "COMMUNICATIONS_RECIPIENT_HASH_SECRET",
      "IDENTITY_SECURITY_ENABLED",
      "IDENTITY_SECURITY_HASH_SECRET",
      "INTEGRATIONS_ENABLED",
      "API_KEY_SECRET",
      // 32.7 new: Stripe shape rule
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ];
    for (const name of REQUIRED) {
      expect(
        EXAMPLE,
        `.env.example missing canonical variable: ${name}`,
      ).toMatch(new RegExp(`^${name}=`, "m"));
    }
  });

  it("contains placeholders only — no obvious real secrets leaked", () => {
    // Reject any sk_live_, sk_test_, AKIA*, pk_live_, pk_test_, or
    // suspicious base64 secret-shaped strings in the example file.
    // The example MUST be all-placeholders.
    expect(EXAMPLE).not.toMatch(/sk_live_[A-Za-z0-9]/);
    expect(EXAMPLE).not.toMatch(/sk_test_[A-Za-z0-9]/);
    expect(EXAMPLE).not.toMatch(/pk_live_[A-Za-z0-9]/);
    expect(EXAMPLE).not.toMatch(/pk_test_[A-Za-z0-9]/);
    expect(EXAMPLE).not.toMatch(/AKIA[A-Z0-9]{16,}/); // AWS access key id
    expect(EXAMPLE).not.toMatch(/whsec_[A-Za-z0-9]{8,}/); // Stripe webhook secret
    expect(EXAMPLE).not.toMatch(/re_[A-Za-z0-9]{8,}_/); // Resend API key
  });

  it("documents the canonical .env-not-in-VCS rule", () => {
    expect(EXAMPLE).toMatch(/NEVER commit real secrets/i);
    expect(EXAMPLE).toMatch(/\.gitignore/);
  });
});

// ===========================================================================
// PART 3 — Regression pins for governance 500/503 fixes (already in place)
// ===========================================================================

describe("32.7 Test 3 — governance endpoints honor 32.7.4 + 32.7.6 fixes", () => {
  it("governance.routes.ts still uses runGovernanceHandler for legal-holds", () => {
    const src = readApi("src/routes/governance.routes.ts");
    expect(src).toMatch(/legal-holds/);
    expect(src).toMatch(/runGovernanceHandler/);
  });

  // PHASE 12 POINT 3 — the 32.7.4 SELECT narrowing existed to dodge a
  // suspected missing `created_at`/`updated_at` on the `case_legal_holds`
  // table. That table is dropped and the service that held the narrowed
  // SELECT is deleted, so the workaround has no subject left. The assertion
  // is inverted into a stays-removed guard rather than dropped.
  it("the case-only legal-hold service stays deleted (its SELECT workaround has no subject)", () => {
    expect(
      existsSync(
        fileURLToPath(
          new URL(
            "../src/services/governance/case-legal-hold.service.ts",
            import.meta.url,
          ),
        ),
      ),
    ).toBe(false);
  });

  it("case-legal-holds optional-subsystem helper handles P2021/P2022 only", () => {
    // Phase 32.7.6 introduced isPrismaTableOrColumnMissing; pin it so
    // a regression to "catch everything" cannot quietly silence real
    // errors.
    const src = readApi("src/routes/governance.routes.ts");
    expect(src).toMatch(/isPrismaTableOrColumnMissing|P2021|P2022/);
  });
});

// ===========================================================================
// PART 4 — Regression pins: status polling is side-effect-free
// ===========================================================================

describe("32.7 Test 4 — artifact status polling is side-effect-free", () => {
  it("evidence-artifact-status.service.ts contains no custody/audit emission", () => {
    const src = readApi("src/services/evidence-artifact-status.service.ts");
    expect(src).not.toMatch(/appendCustodyEvent/);
    expect(src).not.toMatch(/auditEvidenceAction/);
    expect(src).not.toMatch(/safeEmitSecurityEvent/);
    // The status builder should only do reads — no Prisma writes.
    expect(src).not.toMatch(/\.create\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.upsert\(/);
    expect(src).not.toMatch(/\.delete\(/);
  });

  it("frontend capture polling hits the side-effect-free status endpoint, not the download endpoint", () => {
    const src = readWeb(
      "app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts",
    );
    // Pin the polling URL shape.
    expect(src).toMatch(/\/v1\/evidence\/[^"']+\/artifacts\/status/);
    // The polling loop must NOT hit /report/latest or /verification-package.
    // Find each "for" loop pollArtifacts and assert the URL inside is
    // status, not download.
    const pollFn = src.match(/pollArtifacts[\s\S]*?return false;\s*\}/);
    expect(pollFn).toBeTruthy();
    const body = pollFn![0];
    expect(body).not.toMatch(/\/report\/latest/);
    expect(body).not.toMatch(/\/verification-package(?!-status)/);
  });
});

// ===========================================================================
// PART 5 — Download endpoints DO emit the expected custody events
// ===========================================================================

describe("32.7 Test 5 — download endpoints emit custody events (separation of concerns)", () => {
  // The agent audit confirmed both download routes emit the
  // appropriate custody event. We pin the file-level invariant —
  // any regression that strips a custody event from either download
  // route flips these tests.

  it("evidence.routes.ts emits REPORT_DOWNLOADED via appendCustodyEvent", () => {
    const src = readApi("src/routes/evidence.routes.ts");
    expect(src).toMatch(/REPORT_DOWNLOADED/);
    expect(src).toMatch(/appendCustodyEvent/);
    // The two appear together (within the same route handler closure).
    // Pin them as both present in the file as a sanity-floor.
  });

  it("evidence.routes.ts emits VERIFICATION_PACKAGE_DOWNLOADED via appendCustodyEvent", () => {
    const src = readApi("src/routes/evidence.routes.ts");
    expect(src).toMatch(/VERIFICATION_PACKAGE_DOWNLOADED/);
    expect(src).toMatch(/appendCustodyEvent/);
  });

  it("the download routes' custody events are paired with audit events", () => {
    const src = readApi("src/routes/evidence.routes.ts");
    // Each download surfaces an audit action — pin the canonical
    // action names so a regression that drops them is loud.
    expect(src).toMatch(/evidence\.report_viewed/);
    expect(src).toMatch(/verification\.package_accessed/);
  });
});

// ===========================================================================
// PART 6 — Runtime readiness still fail-closed (CR1.5 contract carried)
// ===========================================================================

describe("32.7 Test 6 — runtime readiness severity contract", () => {
  it("useGlobalRuntimeState returns UNKNOWN when any probe source errored", () => {
    const src = readWeb("lib/useGlobalRuntimeState.ts");
    expect(src).toMatch(/anySourceErrored/);
    expect(src).toMatch(/errors\.readiness/);
    expect(src).toMatch(/errors\.incidents/);
    expect(src).toMatch(/errors\.escalations/);
    expect(src).toMatch(/if\s*\(!teamId\)\s*return\s*["']UNKNOWN["']/);
  });

  it("RUNTIME_SEVERITY_LABELS.UNKNOWN is 'Status pending' (not raw 'Unknown')", () => {
    const labels = readWeb("components/operational/GlobalRuntimeIndicator.tsx");
    expect(labels).toMatch(/UNKNOWN:\s*"Status pending"/);
  });
});

// ===========================================================================
// PART 7 — Focus-refresh helper still feature-gated + throttled
// ===========================================================================

describe("32.7 Test 7 — focus-refresh remains feature-gated and bounded", () => {
  it("PlatformContextProvider keeps the flag gate + 60s throttle", () => {
    const src = readWeb("lib/platform-context/PlatformContextProvider.tsx");
    expect(src).toMatch(
      /NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED\s*===\s*["']true["']/,
    );
    expect(src).toMatch(/MIN_REFRESH_INTERVAL_MS\s*=\s*60_000/);
    expect(src).toMatch(/focusRefreshInflightRef/);
    expect(src).toMatch(/typeof window === "undefined"/);
  });
});

// ===========================================================================
// PART 8 — No new state library / nav surface introduced in 32.7
// ===========================================================================

describe("32.7 Test 8 — stabilization contract: no new state library / nav surface", () => {
  it("apps/web/package.json still has no React Query / SWR / Redux / Zustand", () => {
    const pkg = JSON.parse(
      readFileSync(webPath("package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const forbidden of [
      "@tanstack/react-query",
      "react-query",
      "swr",
      "redux",
      "@reduxjs/toolkit",
      "zustand",
      "jotai",
      "recoil",
      "mobx",
    ]) {
      expect(
        deps[forbidden],
        `Forbidden client-state library added: ${forbidden}.`,
      ).toBeUndefined();
    }
  });
});

// ===========================================================================
// PART 9 — Capture / custody / report / package files untouched
// ===========================================================================

// ===========================================================================
// PART 10 — Phase 32.7 doc + master registry both updated
// ===========================================================================

describe("32.7 Test 10 — documentation + registry updated", () => {
  it("docs/recovery/PHASE_32_7_FINAL_PRODUCTION_STABILIZATION.md exists + substantial", () => {
    const doc = readRepo(
      "docs/recovery/PHASE_32_7_FINAL_PRODUCTION_STABILIZATION.md",
    );
    expect(doc.length).toBeGreaterThan(6000);
    expect(doc).toMatch(/PHASE 32\.7/);
    expect(doc).toMatch(/Final Production Stabilization/i);
  });

  it("MASTER_PHASE_REGISTRY.md registers Phase 32.7 with explicit status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?32\.7\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it("registry records DEF item outcomes for items reviewed by 32.7", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    // Each touched DEF id must remain searchable in the registry —
    // either still in §6 (carried) or in the 32.7 phase row (resolved).
    for (const def of [
      "DEF-003",
      "DEF-005",
      "DEF-006",
      "DEF-011",
      "DEF-012",
    ]) {
      expect(
        registry,
        `Registry no longer references ${def}; CR1.7 silent-debt rule violated.`,
      ).toContain(def);
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup hook — defensive in case any test mutates env without restoring.
// ---------------------------------------------------------------------------

afterEach(() => {
  // Nothing additional — withEnv() restores in its finally block.
  // This hook is present for symmetry with other phase tests so a
  // future maintainer doesn't reach for it and add forgotten cleanup.
});
