/**
 * Phase 21 — Observability, incident, alert regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests covering the
 * Phase 21 surface:
 *
 *   - Metadata redactor scrubs known secret keys + bounds payload.
 *   - Noop observability provider never throws.
 *   - Sentry provider only reports ready when SENTRY_DSN is set.
 *   - Provider registry resolution rules (OBSERVABILITY_ENABLED off →
 *     Noop; on + SENTRY_DSN missing → Noop; on + DSN set → Sentry).
 *   - Alert provider rate limiter throttles repeated dispatches.
 *   - Alert webhook provider refuses non-http(s) URLs.
 *   - Incident routes wired with the right auth posture.
 *   - SecurityEvent auto-incident: HIGH events route to maybeAutoCreateIncident.
 *   - Public verify isolation: no Phase 21 import.
 *   - Untouched-files invariant: worker/pdf/report.ts unchanged.
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";

import {
  redactMetadata,
  safeJsonSnapshot,
} from "../src/services/observability/redact.js";
import { NoopObservabilityProvider } from "../src/services/observability/noop-provider.js";
import { SentryObservabilityProvider } from "../src/services/observability/sentry-provider.js";
import {
  buildObservabilityHealth,
  getObservabilityProvider,
  isObservabilityFeatureEnabled,
  setObservabilityProviderForTests,
} from "../src/services/observability/registry.js";
import { IncidentError } from "../src/services/observability/incident.service.js";
import {
  __resetAlertThrottleForTests,
  dispatchOpsAlert,
  setAlertProviderForTests,
} from "../src/services/alerts/alert.service.js";
import { NoopAlertProvider } from "../src/services/alerts/noop-provider.js";
import { WebhookAlertProvider } from "../src/services/alerts/webhook-provider.js";

// -----------------------------------------------------------------------------
// Metadata redactor
// -----------------------------------------------------------------------------

describe("Phase 21 — metadata redactor", () => {
  it("redacts known secret keys", () => {
    const out = redactMetadata({
      ok: true,
      token: "abc",
      apiKey: "xyz",
      cookie: "session=xxx",
      password: "p",
      authorization: "Bearer abc",
      nested: { secret: "s", normal: "n" },
    }) as Record<string, unknown>;
    expect(out["token"]).toBe("[REDACTED]");
    expect(out["apiKey"]).toBe("[REDACTED]");
    expect(out["cookie"]).toBe("[REDACTED]");
    expect(out["password"]).toBe("[REDACTED]");
    expect(out["authorization"]).toBe("[REDACTED]");
    const nested = out["nested"] as Record<string, unknown>;
    expect(nested["secret"]).toBe("[REDACTED]");
    expect(nested["normal"]).toBe("n");
  });

  it("preserves harmless fields", () => {
    const out = redactMetadata({ id: "abc", teamId: "t", count: 5 });
    expect(out).toEqual({ id: "abc", teamId: "t", count: 5 });
  });

  it("bounds long strings", () => {
    const out = redactMetadata({ value: "X".repeat(5000) }) as Record<string, unknown>;
    const s = out["value"] as string;
    expect(s.length).toBeLessThanOrEqual(2000);
    expect(s.endsWith("…")).toBe(true);
  });

  it("bounds large arrays", () => {
    const arr = Array.from({ length: 200 }, (_, i) => i);
    const out = redactMetadata({ values: arr }) as Record<string, unknown>;
    const v = out["values"] as unknown[];
    expect(v.length).toBeLessThanOrEqual(51); // 50 + marker
  });

  it("handles circular references safely", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    const out = redactMetadata({ a }) as Record<string, unknown>;
    const inner = out["a"] as Record<string, unknown>;
    expect(inner["self"]).toBe("[circular]");
  });

  it("returns JSON-serialisable snapshot", () => {
    const snap = safeJsonSnapshot({ a: 1, b: { c: "d" } });
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});

// -----------------------------------------------------------------------------
// Observability providers
// -----------------------------------------------------------------------------

describe("Phase 21 — NoopObservabilityProvider", () => {
  it("never throws on any method", () => {
    const p = new NoopObservabilityProvider();
    expect(p.isReady()).toBe(false);
    const span = p.startSpan("test", { attr: 1 });
    expect(() => span.addEvent("e", { k: "v" })).not.toThrow();
    expect(() => span.setAttribute("k", "v")).not.toThrow();
    expect(() => span.recordException(new Error("e"))).not.toThrow();
    expect(() => span.end()).not.toThrow();
    expect(() =>
      p.captureException({ err: new Error("x"), severity: "HIGH" }),
    ).not.toThrow();
    expect(() => p.setUserContext({ userId: "u", teamId: "t" })).not.toThrow();
  });
});

describe("Phase 21 — SentryObservabilityProvider", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("reports ready=true when SENTRY_DSN is set", () => {
    process.env = { ...ORIGINAL, SENTRY_DSN: "https://example@sentry.io/123" };
    const p = new SentryObservabilityProvider();
    expect(p.isReady()).toBe(true);
  });

  it("reports ready=false when SENTRY_DSN is missing", () => {
    process.env = { ...ORIGINAL, SENTRY_DSN: "" };
    const p = new SentryObservabilityProvider();
    expect(p.isReady()).toBe(false);
  });

  it("captureException never throws even without DSN", () => {
    process.env = { ...ORIGINAL, SENTRY_DSN: "" };
    const p = new SentryObservabilityProvider();
    expect(() =>
      p.captureException({
        err: new Error("test"),
        context: { token: "secret-do-not-leak", other: "ok" },
        requestId: "rid",
      }),
    ).not.toThrow();
  });
});

describe("Phase 21 — observability registry", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
    setObservabilityProviderForTests(null);
  });

  it("returns Noop when OBSERVABILITY_ENABLED is not true", () => {
    process.env = { ...ORIGINAL, OBSERVABILITY_ENABLED: "false" };
    setObservabilityProviderForTests(null);
    expect(getObservabilityProvider().name).toBe("noop");
    expect(isObservabilityFeatureEnabled()).toBe(false);
  });

  it("returns Noop when feature enabled but SENTRY_DSN missing", () => {
    process.env = {
      ...ORIGINAL,
      OBSERVABILITY_ENABLED: "true",
      SENTRY_ENABLED: "true",
      SENTRY_DSN: "",
    };
    setObservabilityProviderForTests(null);
    expect(getObservabilityProvider().name).toBe("noop");
  });

  it("returns Sentry when feature + DSN configured", () => {
    process.env = {
      ...ORIGINAL,
      OBSERVABILITY_ENABLED: "true",
      SENTRY_ENABLED: "true",
      SENTRY_DSN: "https://example@sentry.io/123",
    };
    setObservabilityProviderForTests(null);
    expect(getObservabilityProvider().name).toBe("sentry");
  });

  it("buildObservabilityHealth never echoes the DSN", () => {
    process.env = {
      ...ORIGINAL,
      OBSERVABILITY_ENABLED: "true",
      SENTRY_ENABLED: "true",
      SENTRY_DSN: "https://supersecret-dsn@sentry.io/123",
    };
    setObservabilityProviderForTests(null);
    const h = buildObservabilityHealth();
    const json = JSON.stringify(h);
    expect(json).not.toContain("supersecret-dsn");
    expect(json).not.toContain("sentry.io");
  });
});

// -----------------------------------------------------------------------------
// Incident error surface
// -----------------------------------------------------------------------------

describe("Phase 21 — IncidentError surface", () => {
  it("covers every code the route maps", () => {
    for (const c of [
      "incident_not_found",
      "invalid_fingerprint",
      "invalid_status_transition",
    ] as const) {
      const e = new IncidentError(c);
      expect(e.code).toBe(c);
      expect(e.message).toBe(c);
    }
  });
});

// -----------------------------------------------------------------------------
// Alert provider + rate limiter
// -----------------------------------------------------------------------------

describe("Phase 21 — Noop alert provider", () => {
  it("never throws", async () => {
    const p = new NoopAlertProvider();
    expect(p.isReady()).toBe(false);
    const r = await p.dispatch({
      category: "INCIDENT_HIGH_CREATED",
      severity: "HIGH",
      safeSummary: "test",
      title: "t",
      fingerprint: "f:test",
    });
    expect(r.ok).toBe(false);
  });
});

describe("Phase 21 — Webhook alert provider", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("isReady=false when env unset", () => {
    process.env = { ...ORIGINAL, OPS_ALERT_WEBHOOK_URL: "" };
    const p = new WebhookAlertProvider();
    expect(p.isReady()).toBe(false);
  });

  it("refuses non-http(s) URLs (defense in depth)", () => {
    process.env = {
      ...ORIGINAL,
      OPS_ALERT_WEBHOOK_URL: "file:///etc/passwd",
    };
    const p = new WebhookAlertProvider();
    expect(p.isReady()).toBe(false);
  });

  it("isReady=true for https URL", () => {
    process.env = {
      ...ORIGINAL,
      OPS_ALERT_WEBHOOK_URL: "https://hooks.example.com/abc",
    };
    const p = new WebhookAlertProvider();
    expect(p.isReady()).toBe(true);
  });
});

describe("Phase 21 — dispatchOpsAlert rate limiter", () => {
  beforeEach(() => {
    __resetAlertThrottleForTests();
    // Inject a fake provider that always succeeds so we can count
    // throttling deterministically.
    setAlertProviderForTests({
      name: "webhook",
      isReady: () => true,
      async dispatch() {
        return { ok: true, provider: "webhook" };
      },
    });
  });
  afterEach(() => {
    setAlertProviderForTests(null);
  });

  it("first dispatch for a fingerprint succeeds", async () => {
    const r = await dispatchOpsAlert({
      category: "INCIDENT_HIGH_CREATED",
      severity: "HIGH",
      safeSummary: "s",
      title: "t",
      fingerprint: "alert:test:1",
    });
    expect(r.ok).toBe(true);
  });

  it("second dispatch within window is rate-limited", async () => {
    await dispatchOpsAlert({
      category: "INCIDENT_HIGH_CREATED",
      severity: "HIGH",
      safeSummary: "s",
      title: "t",
      fingerprint: "alert:test:2",
    });
    const r = await dispatchOpsAlert({
      category: "INCIDENT_HIGH_CREATED",
      severity: "HIGH",
      safeSummary: "s",
      title: "t",
      fingerprint: "alert:test:2",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rate_limited");
  });

  it("different fingerprint is not throttled", async () => {
    await dispatchOpsAlert({
      category: "INCIDENT_HIGH_CREATED",
      severity: "HIGH",
      safeSummary: "s",
      title: "t",
      fingerprint: "alert:test:3a",
    });
    const r = await dispatchOpsAlert({
      category: "INCIDENT_HIGH_CREATED",
      severity: "HIGH",
      safeSummary: "s",
      title: "t",
      fingerprint: "alert:test:3b",
    });
    expect(r.ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Source-level wiring assertions
// -----------------------------------------------------------------------------

describe("Phase 21 — auto-incident wiring", () => {
  it("safeEmitSecurityEvent source routes HIGH events to maybeAutoCreateIncident", async () => {
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
    expect(src).toMatch(/maybeAutoCreateIncident/);
    expect(src).toMatch(/observability\/incident\.service/);
    expect(src).toMatch(/severity === "HIGH"/);
  });

  it("communications webhook bumps webhook_invalid_signature_total on bad signature", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/communications.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/webhook_invalid_signature_total/);
  });
});

// -----------------------------------------------------------------------------
// Route auth posture
// -----------------------------------------------------------------------------

describe("Phase 21 — incident routes auth posture", () => {
  it("incident routes use requireAuth + 404-on-non-member", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/ops.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(
      /app\.get\(\s*"\/v1\/ops\/incidents"[\s\S]{0,200}preHandler:\s*requireAuth/,
    );
    expect(src).toMatch(
      /app\.post\(\s*"\/v1\/ops\/incidents\/:id\/ack"[\s\S]{0,200}preHandler:\s*requireAuth/,
    );
    expect(src).toMatch(
      /app\.post\(\s*"\/v1\/ops\/incidents\/:id\/resolve"[\s\S]{0,200}preHandler:\s*requireAuth/,
    );
    expect(src).toMatch(
      /app\.post\(\s*"\/v1\/ops\/incidents\/:id\/suppress"[\s\S]{0,200}preHandler:\s*requireAuth/,
    );
    expect(src).toMatch(/code:\s*"not_found"/);
  });

  it("incident mutations require identity.access_review.action permission", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/ops.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/identity\.access_review\.action/);
  });
});

// -----------------------------------------------------------------------------
// Public verify isolation
// -----------------------------------------------------------------------------

describe("Phase 21 — public verify isolation", () => {
  it("public verify route does not read Phase 21 tables", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    const start = src.indexOf('app.get("/public/verify/:id"');
    expect(start).toBeGreaterThan(-1);
    const verifyBlock = src.slice(start, start + 8000);
    expect(verifyBlock).not.toMatch(/operationalIncident/);
    expect(verifyBlock).not.toMatch(/operationalIncidentEvent/);
  });

  it("public verify route does not import Phase 21 services", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/observability\/incident/);
    expect(src).not.toMatch(/observability\/registry/);
    expect(src).not.toMatch(/alerts\/alert\.service/);
  });
});

// -----------------------------------------------------------------------------
// Untouched files invariant
// -----------------------------------------------------------------------------

describe("Phase 21 — untouched files invariant", () => {
  it("services/worker/src/pdf/report.ts has NO Phase 21 markers", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../../worker/src/pdf/report.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).not.toMatch(/Phase 21/);
    expect(src).not.toMatch(/operationalIncident/);
    expect(src).not.toMatch(/observability\/incident/);
  });
});

// -----------------------------------------------------------------------------
// Migration safety
// -----------------------------------------------------------------------------

describe("Phase 21 migration — additive only", () => {
  it("uses IF NOT EXISTS / EXCEPTION blocks; never drops or renames", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../prisma/migrations/20260529100000_add_operational_incidents_phase21/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(src).toMatch(/EXCEPTION WHEN duplicate_object/);
    expect(src.match(/^\s*ALTER TABLE [^;]+DROP COLUMN/m)).toBeNull();
    expect(src.match(/^\s*ALTER TABLE [^;]+RENAME COLUMN/m)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Wording sweep — runbooks
// -----------------------------------------------------------------------------

describe("Phase 21 — runbooks wording sweep", () => {
  const FORBIDDEN = [
    /tamper.?proof/i,
    /court.?approved/i,
    /guaranteed authentic/i,
    /impossible to alter/i,
    /detects fake/i,
    /forensic proof/i,
    /legally admissible/i,
  ];

  it("each runbook avoids forbidden overclaim phrasing", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../../../docs/runbooks", import.meta.url));
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      // README.md intentionally enumerates the forbidden phrases as
      // part of its wording invariant; the operational runbooks must
      // never USE them.
      if (f === "README.md") continue;
      const src = await readFile(`${dir}/${f}`, "utf8");
      for (const re of FORBIDDEN) {
        expect(src, `${f} contains forbidden phrasing matching ${re}`).not.toMatch(re);
      }
    }
  });
});
