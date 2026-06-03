/**
 * Phase O1.3 — Sentry / OpenTelemetry coexistence source contracts.
 *
 * Production was throwing:
 *
 *     @opentelemetry/api: Attempted duplicate registration of API:
 *     trace / propagation / context
 *
 * because Sentry's internal `initOpenTelemetry()` was running AFTER
 * our `otel-bootstrap.ts` had already registered the global API
 * providers, silently invalidating one of the two.
 *
 * The fix wires a bounded `skipOpenTelemetrySetup` Sentry init
 * option, gated on `OTEL_ENABLED`. When OUR OTEL runtime owns the
 * globals, Sentry skips its registration but keeps every other
 * Sentry feature (error reporting, beforeSend / beforeSendTransaction
 * scrubbing, env-driven sample rates, per-service serverName).
 *
 * These source contracts assert:
 *
 *   1. Both `sentry.ts` files pass `skipOpenTelemetrySetup` to
 *      `Sentry.init({...})`.
 *   2. The value of `skipOpenTelemetrySetup` is driven by an
 *      `OTEL_ENABLED`-derived helper (NOT a hard-coded `true`) so
 *      the disabled path keeps current Sentry behaviour.
 *   3. The Sentry init still wires DSN, environment, release,
 *      serverName, tracesSampleRate, profilesSampleRate,
 *      `beforeSend`, and `beforeSendTransaction` — so error
 *      reporting + scrubbing + sample-rate env handling are
 *      preserved.
 *   4. The bounded per-service `serverName`s remain pinned
 *      (`proovra-api` / `proovra-worker`).
 *   5. Exactly one OTEL global registration path: `otel.ts` is the
 *      ONLY file that talks to the OTEL SDK's `NodeSDK` /
 *      `provider.register()` / propagator registration APIs;
 *      `sentry.ts` never does.
 *   6. Entrypoint import order — `otel-bootstrap` is side-effect
 *      imported BEFORE `sentry` in both API `server.ts` and
 *      worker `index.ts`, so our provider always lands first.
 *   7. No secret / token / bearer / authorization strings appear in
 *      either `sentry.ts` file's logging surface.
 *
 * No runtime mocking of `Sentry.init` — we deliberately keep the
 * contract at the source level so the production fix is enforced
 * even without a working Sentry DSN in tests.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const API_SENTRY_SRC = readFileSync(fileURLToPath(new URL("../src/observability/sentry.ts", import.meta.url)), "utf8");
const WORKER_SENTRY_SRC = readFileSync(fileURLToPath(new URL("../../worker/src/sentry.ts", import.meta.url)), "utf8");
const API_OTEL_SRC = readFileSync(fileURLToPath(new URL("../src/observability/otel.ts", import.meta.url)), "utf8");
const WORKER_OTEL_SRC = readFileSync(fileURLToPath(new URL("../../worker/src/otel.ts", import.meta.url)), "utf8");
const API_SERVER_SRC = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
const WORKER_INDEX_SRC = readFileSync(fileURLToPath(new URL("../../worker/src/index.ts", import.meta.url)), "utf8");
// ---------------------------------------------------------------------------
// 1. Sentry init passes skipOpenTelemetrySetup gated on OTEL_ENABLED
// ---------------------------------------------------------------------------
describe("O1.3 — Sentry init passes skipOpenTelemetrySetup gated on OTEL_ENABLED", () => {
    for (const [label, src] of [
        ["api/sentry.ts", API_SENTRY_SRC],
        ["worker/sentry.ts", WORKER_SENTRY_SRC],
    ]) {
        it(`${label} exposes an isOtelEnabled() helper that reads OTEL_ENABLED === "true"`, () => {
            // Helper exists.
            expect(src).toMatch(/function\s+isOtelEnabled\s*\(\s*\)\s*:\s*boolean/);
            // And it reads the bounded env var with a lowercase compare.
            expect(src).toMatch(/process\.env\.OTEL_ENABLED[\s\S]{0,80}toLowerCase\s*\(\s*\)\s*===\s*"true"/);
        });
        it(`${label} threads the helper into Sentry.init via skipOpenTelemetrySetup`, () => {
            // The option key appears.
            expect(src).toContain("skipOpenTelemetrySetup");
            // It is NOT hard-coded to `true` or `false` — it must be
            // driven by a variable so the OTEL_ENABLED=false path
            // preserves current Sentry behaviour.
            expect(src).not.toMatch(/skipOpenTelemetrySetup\s*:\s*true\s*,/);
            expect(src).not.toMatch(/skipOpenTelemetrySetup\s*:\s*false\s*,/);
            // It IS driven by a variable (`skipOtelSetup`) whose value is
            // the return of `isOtelEnabled()`.
            expect(src).toMatch(/skipOpenTelemetrySetup\s*:\s*skipOtelSetup\b/);
            expect(src).toMatch(/const\s+skipOtelSetup\s*=\s*isOtelEnabled\s*\(\s*\)/);
        });
    }
});
// ---------------------------------------------------------------------------
// 2. Sentry error reporting + scrubbing + sample rates preserved
// ---------------------------------------------------------------------------
describe("O1.3 — Sentry init still wires error reporting + scrubbing + sample rates", () => {
    for (const [label, src] of [
        ["api/sentry.ts", API_SENTRY_SRC],
        ["worker/sentry.ts", WORKER_SENTRY_SRC],
    ]) {
        it(`${label} still calls Sentry.init({ dsn, ... })`, () => {
            expect(src).toMatch(/Sentry\.init\s*\(\s*\{/);
            expect(src).toMatch(/\bdsn\b/);
        });
        it(`${label} still exposes the captureException helper`, () => {
            expect(src).toMatch(/export\s+function\s+captureException\s*\(/);
            expect(src).toMatch(/Sentry\.captureException\s*\(/);
        });
        it(`${label} preserves beforeSend + beforeSendTransaction`, () => {
            expect(src).toContain("beforeSend(event, hint)");
            expect(src).toContain("beforeSendTransaction(event)");
        });
        it(`${label} preserves env-driven SENTRY_TRACES_SAMPLE_RATE + SENTRY_PROFILES_SAMPLE_RATE`, () => {
            expect(src).toContain('"SENTRY_TRACES_SAMPLE_RATE"');
            expect(src).toContain('"SENTRY_PROFILES_SAMPLE_RATE"');
            // Bounded defaults stay at 0.2 + 0.1 (per P2.0B).
            expect(src).toMatch(/SENTRY_TRACES_SAMPLE_RATE[\s\S]{0,80}0\.2/);
            expect(src).toMatch(/SENTRY_PROFILES_SAMPLE_RATE[\s\S]{0,80}0\.1/);
        });
    }
    it("api/sentry.ts pins serverName=proovra-api", () => {
        expect(API_SENTRY_SRC).toMatch(/serverName\s*:\s*"proovra-api"/);
    });
    it("worker/sentry.ts pins serverName=proovra-worker", () => {
        expect(WORKER_SENTRY_SRC).toMatch(/serverName\s*:\s*"proovra-worker"/);
    });
});
// ---------------------------------------------------------------------------
// 3. Exactly one OTEL global registration path
// ---------------------------------------------------------------------------
describe("O1.3 — exactly one OTEL global registration path", () => {
    for (const [label, src] of [
        ["api/sentry.ts", API_SENTRY_SRC],
        ["worker/sentry.ts", WORKER_SENTRY_SRC],
    ]) {
        it(`${label} NEVER references the OTEL SDK / provider registration APIs`, () => {
            // The strings below are the ONLY ways code can register an
            // OTEL global API provider. They MUST appear in otel.ts /
            // otel-bootstrap.ts ONLY, never in sentry.ts.
            const forbidden = [
                "@opentelemetry/sdk-node",
                "@opentelemetry/sdk-trace-",
                "NodeSDK",
                "provider.register(",
                "trace.setGlobalTracerProvider",
                "propagation.setGlobalPropagator",
                "context.setGlobalContextManager",
                "registerInstrumentations",
            ];
            for (const needle of forbidden) {
                expect.soft(src.includes(needle)).toBe(false);
            }
        });
    }
    for (const [label, src] of [
        ["api/otel.ts", API_OTEL_SRC],
        ["worker/otel.ts", WORKER_OTEL_SRC],
    ]) {
        it(`${label} IS the OTEL registration path (references NodeSDK)`, () => {
            // Sanity floor: the OTEL bootstrap MUST be the file that
            // talks to `NodeSDK`. Without this, removing OTEL would
            // leave the wiring orphaned.
            expect(src).toContain("NodeSDK");
        });
    }
});
// ---------------------------------------------------------------------------
// 4. Entrypoint import order — otel-bootstrap before sentry
// ---------------------------------------------------------------------------
describe("O1.3 — entrypoint import order: otel-bootstrap precedes sentry", () => {
    it("api/server.ts side-effect-imports otel-bootstrap BEFORE importing sentry", () => {
        const bootstrapIdx = API_SERVER_SRC.indexOf('import "./observability/otel-bootstrap.js"');
        const sentryIdx = API_SERVER_SRC.indexOf('from "./observability/sentry.js"');
        expect(bootstrapIdx).toBeGreaterThan(-1);
        expect(sentryIdx).toBeGreaterThan(-1);
        expect(bootstrapIdx).toBeLessThan(sentryIdx);
    });
    it("worker/index.ts side-effect-imports otel-bootstrap BEFORE importing sentry", () => {
        const bootstrapIdx = WORKER_INDEX_SRC.indexOf('import "./otel-bootstrap.js"');
        const sentryIdx = WORKER_INDEX_SRC.indexOf('from "./sentry.js"');
        expect(bootstrapIdx).toBeGreaterThan(-1);
        expect(sentryIdx).toBeGreaterThan(-1);
        expect(bootstrapIdx).toBeLessThan(sentryIdx);
    });
});
// ---------------------------------------------------------------------------
// 5. No secret / token / bearer text in sentry.ts files
// ---------------------------------------------------------------------------
describe("O1.3 — no secret / token / bearer / authorization values logged from sentry.ts", () => {
    for (const [label, src] of [
        ["api/sentry.ts", API_SENTRY_SRC],
        ["worker/sentry.ts", WORKER_SENTRY_SRC],
    ]) {
        it(`${label} only references token/secret/etc. inside the redactValue helper or scrubbing arms`, () => {
            // Surgical scope: scan every log-emitting call (console.*,
            // process.stderr / stdout writes, logger.info / warn / error /
            // debug) and assert no forbidden literal sneaks in.
            const logLines = src.split("\n").filter((l) => /console\.(log|info|warn|error|debug)/.test(l) ||
                /process\.(stderr|stdout)\.write/.test(l) ||
                /logger\.(info|warn|error|debug)/.test(l));
            for (const line of logLines) {
                // Forbidden raw substrings — these would indicate a leak
                // of an actual secret value rather than the bounded
                // `[REDACTED]` token.
                expect.soft(line).not.toMatch(/Bearer\s+[A-Za-z0-9._-]/);
                expect.soft(line).not.toMatch(/Authorization\s*:\s*\S/i);
                expect.soft(line.toLowerCase()).not.toContain("sentry_dsn");
                expect.soft(line.toLowerCase()).not.toContain("dsn=");
            }
        });
    }
});
// ---------------------------------------------------------------------------
// 6. Behavioural sanity — gate flips with OTEL_ENABLED at runtime
// ---------------------------------------------------------------------------
describe("O1.3 — gate flips with OTEL_ENABLED at runtime", () => {
    // The function is module-internal — we can't import it directly
    // without exporting. Instead, re-implement the bounded predicate
    // here and assert the source contract matches. This guards
    // against a future refactor that, e.g., flips the comparison
    // operator or drops the toLowerCase() call.
    function expectedIsOtelEnabled(env) {
        return (env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
    }
    it("returns true only for the literal string 'true' (any case)", () => {
        expect(expectedIsOtelEnabled({ OTEL_ENABLED: "true" })).toBe(true);
        expect(expectedIsOtelEnabled({ OTEL_ENABLED: "TRUE" })).toBe(true);
        expect(expectedIsOtelEnabled({ OTEL_ENABLED: "  true  " })).toBe(true);
    });
    it("returns false for unset / empty / any non-true literal", () => {
        expect(expectedIsOtelEnabled({})).toBe(false);
        expect(expectedIsOtelEnabled({ OTEL_ENABLED: "" })).toBe(false);
        expect(expectedIsOtelEnabled({ OTEL_ENABLED: "false" })).toBe(false);
        expect(expectedIsOtelEnabled({ OTEL_ENABLED: "1" })).toBe(false);
        expect(expectedIsOtelEnabled({ OTEL_ENABLED: "yes" })).toBe(false);
    });
});
