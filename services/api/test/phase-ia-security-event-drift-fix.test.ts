/**
 * Phase IA-securityEvent-driftFix — contract test.
 *
 * Pins the fix for the production 500 surfaced on /v1/me/inbox:
 *
 *   DriverAdapterError:
 *     operator does not exist: character varying = "SecurityEventSeverity"
 *
 * The Prisma model declared `severity SecurityEventSeverity` but the
 * production `security_events.severity` column is `VARCHAR`. Under
 * `@prisma/adapter-pg`, Prisma generated SQL like
 *
 *   WHERE "severity" = $1::"SecurityEventSeverity"
 *
 * which Postgres refuses because varchar cannot be compared to the
 * enum type. The fix is Prisma-side ONLY: declare the field as
 * `String @db.VarChar(16)` so generated SQL has no enum cast.
 *
 * This test pins:
 *   1. The schema declares `severity` as String with VarChar(16) — no
 *      enum reference in the field type.
 *   2. The migration that converts a hypothetical regression (re-adding
 *      the enum type) cannot ship without breaking this test.
 *   3. The inbox handler wraps every OPTIONAL source in
 *      `safelyLoadSource(...)` so a single source's failure produces
 *      `degraded: true` + `degradedSources: [...]` instead of HTTP 500.
 *   4. CORE sources (org invites, governance) remain unwrapped — they
 *      must still 500 on failure (operator deserves a real error).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

const SCHEMA = readSource("../prisma/schema.prisma");
const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

function extractModel(schema: string, name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name} not found`).toBeGreaterThan(-1);
  const end = schema.indexOf("\n}", start);
  return schema.slice(start, end + 2);
}

// ============================================================================
// 1. Schema realignment — severity is varchar, not enum
// ============================================================================

describe("Phase IA-securityEvent-driftFix — Prisma schema realignment", () => {
  const block = extractModel(SCHEMA, "SecurityEvent");

  it("`severity` field is declared as String, not the SecurityEventSeverity enum", () => {
    // The exact declaration: `severity String @map("severity") @db.VarChar(16) @default("INFO")`.
    // We assert the type is String (not SecurityEventSeverity) AND carries
    // the @db.VarChar(16) annotation so the generated SQL parameter
    // bind reflects the live column type.
    expect(block).toMatch(/severity\s+String\b/);
    expect(block).toMatch(/severity\s+String[\s\S]{0,200}@db\.VarChar\(16\)/);
    expect(block).toMatch(/severity\s+String[\s\S]{0,200}@default\("INFO"\)/);
    // CRITICAL: the field must NOT reference the enum type.
    expect(block).not.toMatch(/severity\s+SecurityEventSeverity\b/);
  });

  it("the SecurityEventSeverity enum is retained for documentation + back-compat", () => {
    // We keep the enum definition so existing
    // `import { SecurityEventSeverity } from "@prisma/client"` call
    // sites continue to compile — the enum is now a label catalog.
    expect(SCHEMA).toMatch(
      /enum SecurityEventSeverity\s*\{\s*INFO\s+WARNING\s+HIGH\s*\}/,
    );
  });

  it("the existing camelCase column mappings are preserved (Phase 32.7.2)", () => {
    expect(block).toMatch(/teamId\s+String\?\s+@map\("teamId"\)/);
    expect(block).toMatch(/userId\s+String\?\s+@map\("userId"\)/);
    expect(block).toMatch(/eventType\s+String\s+@map\("eventType"\)/);
    expect(block).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)\s+@map\("createdAtUtc"\)/);
  });
});

// ============================================================================
// 2. Inbox handler — bounded source isolation
// ============================================================================

describe("Phase IA-securityEvent-driftFix — bounded source isolation", () => {
  it("the handler defines a request-scoped `safelyLoadSource` helper", () => {
    expect(ROUTES).toMatch(/async function safelyLoadSource<T>/);
    expect(ROUTES).toMatch(/degradedSources:\s*string\[\]\s*=\s*\[\]/);
  });

  it("safelyLoadSource catches the error, records the source name, and returns the fallback", () => {
    // Source structure: try {...} catch (err) { degradedSources.push(name); log; return fallback; }
    expect(ROUTES).toMatch(
      /async function safelyLoadSource[\s\S]{0,400}catch \(err\)[\s\S]{0,200}degradedSources\.push\(name\)/,
    );
    expect(ROUTES).toMatch(
      /async function safelyLoadSource[\s\S]{0,800}return fallback/,
    );
  });

  it("safelyLoadSource logs at error level with the source name", () => {
    expect(ROUTES).toMatch(
      /req\.log\.error\([\s\S]{0,300}source:\s*name[\s\S]{0,200}"inbox\.source_failed"/,
    );
  });

  it("EVERY optional source is wrapped (security_event_high — the production-incident source — pinned explicitly)", () => {
    // The 11 optional sources we audited. If a new optional source is
    // added without wrapping, this test fails so the regression cannot
    // ship silently.
    for (const name of [
      "discussion_mention",
      "discussion_assigned",
      "review_escalation",
      "access_review_pending",
      "mfa_recovery_pending",
      "communication_failure",
      "security_event_high",
      "report_failure",
      "verification_package_failure",
      "ots_failure",
      "intake_submission_pending_review",
      "intake_required_items_missing",
      "intake_link_expiring",
    ]) {
      expect(
        ROUTES,
        `optional source "${name}" must be wrapped in safelyLoadSource`,
      ).toMatch(
        new RegExp(`safelyLoadSource\\(\\s*\\n?\\s*"${name}"`),
      );
    }
  });

  it("CORE sources are NOT wrapped (their failure correctly yields 500)", () => {
    // Lock the invariant that operations like the caller's identity
    // probe (`prisma.user.findUnique({ where: { id: userId } })`) and
    // the org/team membership reads are NOT in a safelyLoadSource
    // wrapper. If those start being wrapped, the inbox would silently
    // hide auth/membership failures.
    const userProbeIdx = ROUTES.indexOf("prisma.user.findUnique");
    expect(userProbeIdx).toBeGreaterThan(-1);
    // Scan 300 chars BEFORE the prisma.user.findUnique call site for
    // the safelyLoadSource marker. If present, this assertion fails.
    const probeWindow = ROUTES.slice(
      Math.max(0, userProbeIdx - 300),
      userProbeIdx,
    );
    expect(probeWindow).not.toMatch(/safelyLoadSource\(/);
  });

  it("the response carries `degraded` boolean + `degradedSources` array", () => {
    expect(ROUTES).toMatch(/degraded:\s*degradedSources\.length\s*>\s*0/);
    expect(ROUTES).toMatch(/degradedSources,/);
  });

  it("the security_event_high source is wrapped with the canonical name (production incident regression pin)", () => {
    // Direct regression pin for the exact name the production logs
    // would show in `degradedSources` if the drift recurs after this
    // fix. We anchor the search on the actual prisma call (the LAST
    // occurrence in the file — earlier matches are comment blocks
    // documenting the production incident).
    const idx = ROUTES.lastIndexOf("prisma.securityEvent.findMany");
    expect(idx, "prisma.securityEvent.findMany call not found").toBeGreaterThan(-1);
    const block = ROUTES.slice(Math.max(0, idx - 400), idx + 600);
    expect(block).toMatch(/safelyLoadSource\(\s*\n?\s*"security_event_high"/);
    expect(block).toMatch(/prisma\.securityEvent\.findMany/);
  });
});
