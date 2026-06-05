/**
 * Phase 20 — Production hardening regression tests.
 *
 * No DB. Source-text + pure-evaluator + projection tests covering the
 * Phase 20 critical fixes:
 *
 *   - resolveSecret throws ProductionConfigError when NODE_ENV ===
 *     "production" and the env var is missing; falls back in non-prod.
 *   - collectStartupViolations surfaces required + feature-enabled
 *     missing secrets.
 *   - getFeatureSnapshot never echoes a raw secret value.
 *   - metrics catalog is fixed; ad-hoc names are dropped.
 *   - SecurityEvent emit path bumps the metric on failure.
 *   - Errors module exposes the Phase 20 standardized codes with
 *     consistent status code mapping.
 *   - Ops routes exist + are wired with the right auth posture.
 *   - Dev-fallback hash key strings are NO LONGER present in the
 *     three services (regression guard).
 *   - Wording sweep: forbidden overclaims are NOT present in any
 *     user-facing surface (security-center / communications / identity
 *     pages + notifications templates).
 *   - Untouched-files invariant: report-v2 / worker pdf / public verify
 *     / OTS unchanged.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ErrorCode, getStatusCode } from "../src/errors.js";
import {
  ProductionConfigError,
  collectStartupViolations,
  envBool,
  envInt,
  getFeatureSnapshot,
  resolveSecret,
} from "../src/config/index.js";
import {
  COUNTER_NAMES,
  GAUGE_NAMES,
  bump,
  readCounter,
  readGauge,
  setGauge,
  snapshotMetrics,
  __resetMetricsForTests,
} from "../src/services/ops/metrics.service.js";

// -----------------------------------------------------------------------------
// resolveSecret — fail-closed in production
// -----------------------------------------------------------------------------

describe("Phase 20 — resolveSecret", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("returns the env value when set", () => {
    process.env = {
      ...ORIGINAL,
      COMMUNICATIONS_RECIPIENT_HASH_SECRET: "real-secret-from-env",
    };
    const v = resolveSecret("COMMUNICATIONS_RECIPIENT_HASH_SECRET");
    expect(v).toBe("real-secret-from-env");
  });

  it("returns a namespaced non-prod fallback when env is missing and NODE_ENV is not production", () => {
    process.env = {
      ...ORIGINAL,
      NODE_ENV: "test",
      COMMUNICATIONS_RECIPIENT_HASH_SECRET: "",
    };
    const v = resolveSecret("COMMUNICATIONS_RECIPIENT_HASH_SECRET");
    expect(v).toMatch(/^non-prod-fallback::/);
    expect(v).toMatch(/COMMUNICATIONS_RECIPIENT_HASH_SECRET/);
  });

  it("THROWS ProductionConfigError when env is missing in NODE_ENV=production", () => {
    process.env = {
      ...ORIGINAL,
      NODE_ENV: "production",
      COMMUNICATIONS_RECIPIENT_HASH_SECRET: "",
    };
    expect(() => resolveSecret("COMMUNICATIONS_RECIPIENT_HASH_SECRET")).toThrow(
      ProductionConfigError,
    );
  });

  it("non-prod fallback values are deterministic (same name -> same value)", () => {
    process.env = {
      ...ORIGINAL,
      NODE_ENV: "test",
      IDENTITY_SECURITY_HASH_SECRET: "",
    };
    const a = resolveSecret("IDENTITY_SECURITY_HASH_SECRET");
    const b = resolveSecret("IDENTITY_SECURITY_HASH_SECRET");
    expect(a).toBe(b);
  });
});

// -----------------------------------------------------------------------------
// collectStartupViolations
// -----------------------------------------------------------------------------

describe("Phase 20 — collectStartupViolations", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("reports DATABASE_URL + AUTH_JWT_SECRET when missing", () => {
    process.env = { ...ORIGINAL, DATABASE_URL: "", AUTH_JWT_SECRET: "" };
    const v = collectStartupViolations();
    const names = v.map((x) => x.envName);
    expect(names).toContain("DATABASE_URL");
    expect(names).toContain("AUTH_JWT_SECRET");
  });

  it("reports COMMUNICATIONS_RECIPIENT_HASH_SECRET only when COMMUNICATIONS_ENABLED=true", () => {
    process.env = {
      ...ORIGINAL,
      COMMUNICATIONS_ENABLED: "false",
      COMMUNICATIONS_RECIPIENT_HASH_SECRET: "",
    };
    expect(
      collectStartupViolations().some(
        (v) => v.envName === "COMMUNICATIONS_RECIPIENT_HASH_SECRET",
      ),
    ).toBe(false);

    process.env = {
      ...ORIGINAL,
      COMMUNICATIONS_ENABLED: "true",
      COMMUNICATIONS_RECIPIENT_HASH_SECRET: "",
    };
    expect(
      collectStartupViolations().some(
        (v) => v.envName === "COMMUNICATIONS_RECIPIENT_HASH_SECRET",
      ),
    ).toBe(true);
  });

  it("reports IDENTITY_SECURITY_HASH_SECRET only when IDENTITY_SECURITY_ENABLED=true", () => {
    process.env = {
      ...ORIGINAL,
      IDENTITY_SECURITY_ENABLED: "true",
      IDENTITY_SECURITY_HASH_SECRET: "",
    };
    expect(
      collectStartupViolations().some(
        (v) => v.envName === "IDENTITY_SECURITY_HASH_SECRET",
      ),
    ).toBe(true);
  });

  it("reports API_KEY_SECRET only when INTEGRATIONS_ENABLED=true", () => {
    process.env = {
      ...ORIGINAL,
      INTEGRATIONS_ENABLED: "true",
      API_KEY_SECRET: "",
    };
    expect(
      collectStartupViolations().some((v) => v.envName === "API_KEY_SECRET"),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// getFeatureSnapshot — privacy contract
// -----------------------------------------------------------------------------

describe("Phase 20 — getFeatureSnapshot privacy", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("never echoes the raw secret value", () => {
    process.env = {
      ...ORIGINAL,
      DATABASE_URL: "postgres://supersecret@example/abc",
      AUTH_JWT_SECRET: "verysecretjwt",
      TWILIO_API_SECRET: "twilio-secret-value",
      RESEND_API_KEY: "re_secret",
      OPENAI_API_KEY: "sk-secret",
      API_KEY_SECRET: "api-key-secret",
      IDENTITY_SECURITY_HASH_SECRET: "id-sec-secret",
      COMMUNICATIONS_RECIPIENT_HASH_SECRET: "comms-secret",
    };
    const snapshot = getFeatureSnapshot();
    const json = JSON.stringify(snapshot);
    for (const forbidden of [
      "supersecret",
      "verysecretjwt",
      "twilio-secret-value",
      "re_secret",
      "sk-secret",
      "api-key-secret",
      "id-sec-secret",
      "comms-secret",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("reports configured=true/false for each feature without value leakage", () => {
    process.env = {
      ...ORIGINAL,
      NODE_ENV: "test",
      COMMUNICATIONS_ENABLED: "true",
      IDENTITY_SECURITY_ENABLED: "true",
    };
    const s = getFeatureSnapshot();
    expect(typeof s.communications.configured).toBe("boolean");
    expect(typeof s.identitySecurity.configured).toBe("boolean");
    expect(typeof s.database.configured).toBe("boolean");
  });
});

// -----------------------------------------------------------------------------
// env helpers
// -----------------------------------------------------------------------------

describe("Phase 20 — envBool + envInt", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("envBool only returns true on literal 'true'", () => {
    process.env.X = "true";
    expect(envBool("X")).toBe(true);
    process.env.X = "TRUE";
    expect(envBool("X")).toBe(false);
    process.env.X = "1";
    expect(envBool("X")).toBe(false);
    delete process.env.X;
    expect(envBool("X")).toBe(false);
  });

  it("envInt clamps to [min,max]; falls back on invalid", () => {
    process.env.N = "50";
    expect(envInt("N", 10, 0, 100)).toBe(50);
    process.env.N = "9999";
    expect(envInt("N", 10, 0, 100)).toBe(100);
    process.env.N = "-1";
    expect(envInt("N", 10, 0, 100)).toBe(0);
    process.env.N = "abc";
    expect(envInt("N", 10, 0, 100)).toBe(10);
    delete process.env.N;
    expect(envInt("N", 10, 0, 100)).toBe(10);
  });
});

// -----------------------------------------------------------------------------
// Metrics
// -----------------------------------------------------------------------------

describe("Phase 20 — metrics", () => {
  beforeEach(() => __resetMetricsForTests());

  it("bump is monotonic for catalogued counters", () => {
    bump("step_up_started");
    bump("step_up_started");
    bump("step_up_started", 3);
    expect(readCounter("step_up_started")).toBe(5);
  });

  it("bump silently drops ad-hoc / typo'd counter names", () => {
    // Cast to bypass the strict type for the test — production callers
    // can never reach this because TS rejects ad-hoc strings.
    bump("not_a_real_counter" as never);
    const snap = snapshotMetrics();
    expect((snap.counters as Record<string, number>)["not_a_real_counter"]).toBeUndefined();
  });

  it("setGauge is last-write-wins for catalogued gauges", () => {
    setGauge("trusted_devices_active", 7);
    setGauge("trusted_devices_active", 9);
    expect(readGauge("trusted_devices_active")).toBe(9);
  });

  it("snapshot includes every catalogued name with default 0", () => {
    const snap = snapshotMetrics();
    for (const name of COUNTER_NAMES) {
      expect(snap.counters).toHaveProperty(name);
    }
    for (const name of GAUGE_NAMES) {
      expect(snap.gauges).toHaveProperty(name);
    }
  });

  it("snapshot is bounded (only catalogued names)", () => {
    const snap = snapshotMetrics();
    expect(Object.keys(snap.counters).length).toBe(COUNTER_NAMES.length);
    expect(Object.keys(snap.gauges).length).toBe(GAUGE_NAMES.length);
  });
});

// -----------------------------------------------------------------------------
// Standardized error codes
// -----------------------------------------------------------------------------

describe("Phase 20 — standardized error codes", () => {
  it("STEP_UP_REQUIRED maps to 401", () => {
    expect(getStatusCode(ErrorCode.STEP_UP_REQUIRED)).toBe(401);
  });
  it("HIGH_RISK_ACTION_BLOCKED + GOVERNANCE_BLOCKED map to 403", () => {
    expect(getStatusCode(ErrorCode.HIGH_RISK_ACTION_BLOCKED)).toBe(403);
    expect(getStatusCode(ErrorCode.GOVERNANCE_BLOCKED)).toBe(403);
  });
  it("RATE_LIMITED maps to 429", () => {
    expect(getStatusCode(ErrorCode.RATE_LIMITED)).toBe(429);
  });
  it("PROVIDER_ERROR maps to 502", () => {
    expect(getStatusCode(ErrorCode.PROVIDER_ERROR)).toBe(502);
  });
  it("PRODUCTION_CONFIG_VIOLATION maps to 503", () => {
    expect(getStatusCode(ErrorCode.PRODUCTION_CONFIG_VIOLATION)).toBe(503);
  });
});

// -----------------------------------------------------------------------------
// Source-level regression — dev-fallback strings are GONE
// -----------------------------------------------------------------------------

describe("Phase 20 — dev-fallback hash keys removed from production paths", () => {
  it("communication.service.ts uses resolveSecret (no literal phase18-dev-fallback)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/communications/communication.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/phase18-dev-fallback-hash-key/);
    expect(src).toMatch(/resolveSecret/);
  });

  it("identity-security/risk.service.ts uses resolveSecret (no literal phase19-dev-fallback)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/identity-security/risk.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/phase19-dev-fallback-hash-key/);
    expect(src).toMatch(/resolveSecret/);
  });

  it("identity-security/session-revocation.service.ts uses resolveSecret (no literal phase19-dev-fallback)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/identity-security/session-revocation.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/phase19-dev-fallback-hash-key/);
    expect(src).toMatch(/resolveSecret/);
  });
});

// -----------------------------------------------------------------------------
// SecurityEvent observability
// -----------------------------------------------------------------------------

describe("Phase 20 — safeEmitSecurityEvent observability", () => {
  it("source wires the failure path to the metrics module", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/security/security-event.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/security_event_emit_failed/);
    expect(src).toMatch(/security_event_emit_dropped_unknown_type/);
    // The fire-and-forget contract is preserved (no throw on failure).
    expect(src).not.toMatch(/throw new Error.*emitSecurityEvent/);
  });
});

// -----------------------------------------------------------------------------
// Ops routes — auth posture
// -----------------------------------------------------------------------------

describe("Phase 20 — ops routes auth posture", () => {
  it("/healthz and /readyz are public (no requireAuth preHandler)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(new URL("../src/routes/ops.routes.ts", import.meta.url)),
      "utf8",
    );
    const healthzBlock = src.match(
      /app\.get\(\s*"\/healthz"[\s\S]{0,300}/,
    );
    expect(healthzBlock).not.toBeNull();
    if (healthzBlock) {
      expect(healthzBlock[0]).not.toMatch(/preHandler:\s*requireAuth/);
    }
    const readyzBlock = src.match(/app\.get\(\s*"\/readyz"[\s\S]{0,300}/);
    expect(readyzBlock).not.toBeNull();
    if (readyzBlock) {
      expect(readyzBlock[0]).not.toMatch(/preHandler:\s*requireAuth/);
    }
  });

  it("/v1/ops/health and /v1/ops/metrics use requireAuth + 404-on-non-member", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(new URL("../src/routes/ops.routes.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(
      /app\.get\(\s*"\/v1\/ops\/health"[\s\S]{0,200}preHandler:\s*requireAuth/,
    );
    expect(src).toMatch(
      /app\.get\(\s*"\/v1\/ops\/metrics"[\s\S]{0,200}preHandler:\s*requireAuth/,
    );
    // requireOpsActor returns 404 for non-members (anti-enumeration).
    expect(src).toMatch(/code:\s*"not_found"/);
  });

  it("/v1/ops/reconcile is cron-secret protected (no requireAuth preHandler)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(new URL("../src/routes/ops.routes.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(
      /app\.post\(\s*"\/v1\/ops\/reconcile"[\s\S]{0,400}/,
    );
    expect(src).toMatch(/requireIntegrationCronSecret/);
  });
});

// -----------------------------------------------------------------------------
// Wording sweep — forbidden overclaims absent from user-facing surfaces
// -----------------------------------------------------------------------------

describe("Phase 20 — wording sweep (user-facing surfaces clean of overclaims)", () => {
  const FORBIDDEN = [
    /tamper.?proof/i,
    /court.?approved/i,
    /guaranteed authentic/i,
    /impossible to alter/i,
    /detects fake/i,
    /forensic proof/i,
  ];

  it("Phase 18 communications page contains no forbidden overclaim phrasing", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/communications/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    for (const re of FORBIDDEN) {
      expect(src).not.toMatch(re);
    }
  });

  it("Phase 19 security-center page contains no forbidden overclaim phrasing", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/security-center/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    for (const re of FORBIDDEN) {
      expect(src).not.toMatch(re);
    }
  });

  it("Phase 17 identity surface (now /admin/identity) contains no forbidden overclaim phrasing", async () => {
    // Phase Final-Closure-Remediation — the legacy
    // `app/(app)/identity/page.tsx` workspace-internal console was
    // deleted and the legacy URL was folded into the canonical
    // `/admin/identity` enterprise operator control plane via
    // `next.config.js` `redirects()`. The vocabulary discipline pin
    // now reads the canonical surface.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/app/(app)/admin/identity/page.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    for (const re of FORBIDDEN) {
      expect(src).not.toMatch(re);
    }
  });

  it("Notifications templates contain no forbidden overclaim phrasing", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/notifications/templates.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    for (const re of FORBIDDEN) {
      expect(src).not.toMatch(re);
    }
  });

  it("Shared communications body templates contain no forbidden overclaim phrasing", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../../../packages/shared/src/communications.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    for (const re of FORBIDDEN) {
      // Body templates allow the phrase "secure" but never "tamper-proof"
      // or "court-approved".
      expect(src).not.toMatch(re);
    }
  });
});

// -----------------------------------------------------------------------------
// Untouched files invariant — confirm Phase 20 left forbidden paths alone
// -----------------------------------------------------------------------------

describe("Phase 20 — untouched files invariant", () => {
  it("services/worker/src/pdf/report.ts has NO Phase 20 markers", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../../worker/src/pdf/report.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/Phase 20/);
    expect(src).not.toMatch(/resolveSecret/);
    expect(src).not.toMatch(/ops\/metrics/);
  });

  it("public verify route in evidence.routes.ts has no Phase 20 import", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/from "\.\.\/config\/index/);
    expect(src).not.toMatch(/from "\.\.\/services\/ops\/metrics/);
  });
});

// -----------------------------------------------------------------------------
// Route permission matrix snapshot — the riskiest routes are gated
// -----------------------------------------------------------------------------

describe("Phase 20 — route permission matrix (high-risk surfaces)", () => {
  it("identity routes wire step-up on every documented sensitive purpose", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/identity.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    for (const purpose of [
      "MEMBER_SUSPEND",
      "MEMBER_REVOKE",
      "MEMBER_ROLE_CHANGE",
      "DELEGATED_ADMIN_GRANT",
      "DELEGATED_ADMIN_REVOKE",
      "SERVICE_ACCOUNT_DISABLE",
    ]) {
      expect(src).toMatch(new RegExp(`purpose:\\s*"${purpose}"`));
    }
  });

  it("governance routes wire step-up on every documented sensitive purpose", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/governance.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    for (const purpose of [
      "LEGAL_HOLD_RELEASE",
      "PUBLIC_VERIFY_PUBLISH",
      "PUBLIC_VERIFY_UNPUBLISH",
      "PUBLIC_VERIFY_SUSPEND",
      "GOVERNANCE_POLICY_UPDATE",
    ]) {
      expect(src).toMatch(new RegExp(`purpose:\\s*"${purpose}"`));
    }
  });

  it("integrations routes wire step-up on API key create + revoke", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/integrations.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // Phase 4 closure migrated these to dedicated INTEGRATION_API_KEY_*
    // purposes. The legacy SERVICE_ACCOUNT_* purposes remain accepted on
    // already-issued challenges via the alias map in @proovra/shared.
    // See phase-closure-integration-step-up-purposes.test.ts for the
    // full back-compat pin.
    expect(src).toMatch(/purpose:\s*"INTEGRATION_API_KEY_CREATE"/);
    expect(src).toMatch(/purpose:\s*"INTEGRATION_API_KEY_REVOKE"/);
  });

  it("identity-security routes self-protect MFA policy update with step-up", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/routes/identity-security.routes.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/purpose:\s*"MFA_POLICY_UPDATE"/);
  });
});

// -----------------------------------------------------------------------------
// Configuration violations summary structure (operator-readable)
// -----------------------------------------------------------------------------

describe("Phase 20 — violation reason surface", () => {
  it("every violation has envName + a non-empty reason string", () => {
    const ORIGINAL = { ...process.env };
    process.env = {
      ...ORIGINAL,
      DATABASE_URL: "",
      AUTH_JWT_SECRET: "",
      COMMUNICATIONS_ENABLED: "true",
      COMMUNICATIONS_RECIPIENT_HASH_SECRET: "",
    };
    try {
      const v = collectStartupViolations();
      expect(v.length).toBeGreaterThan(0);
      for (const item of v) {
        expect(typeof item.envName).toBe("string");
        expect(item.envName.length).toBeGreaterThan(0);
        expect(typeof item.reason).toBe("string");
        expect(item.reason.length).toBeGreaterThan(0);
      }
    } finally {
      process.env = { ...ORIGINAL };
    }
  });
});
