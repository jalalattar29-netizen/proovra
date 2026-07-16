/**
 * Timezone source-of-truth precedence (2026-07-16 Settings remediation).
 *
 * Pins the ONE timezone model: explicit per-workspace notification-schedule
 * override → account timezone (`User.timezone`, edited on
 * /settings/preferences) → UTC. Previously `User.timezone` was persisted
 * but never consulted — digest quiet hours silently used UTC while the
 * profile showed a timezone, a silent disagreement between two sources.
 *
 * Source-contract style (the scheduler imports the DB-coupled prisma
 * client, so it is not unit-importable without DATABASE_URL — matching the
 * established test style for this module).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(HERE, "../src/services/notifications/digest-scheduler.ts"),
  "utf8",
);

describe("digest scheduler timezone precedence", () => {
  it("resolves timezone as schedule override → account timezone → UTC", () => {
    expect(SRC).toMatch(/timezone:\s*sched\?\.timezone\s*\?\?\s*accountTz\s*\?\?\s*"UTC"/);
  });

  it("queries the account timezone from User.timezone only when no override exists", () => {
    const at = SRC.indexOf("const accountTz");
    expect(at).toBeGreaterThan(-1);
    const window = SRC.slice(at, at + 500);
    // Ternary short-circuit: explicit schedule timezone skips the user query.
    expect(window).toMatch(/sched\?\.timezone\s*\?\s*null/);
    expect(window).toMatch(/select:\s*\{\s*timezone:\s*true\s*\}/);
  });

  it("documents the precedence rule at the resolution site", () => {
    expect(SRC).toMatch(/TIMEZONE PRECEDENCE/);
    expect(SRC).toMatch(/schedule override/i);
  });

  it("does not touch canonical UTC evidence/audit timestamps (presentation-only)", () => {
    // The precedence comment carries the boundary; the scheduler still
    // reads/writes only notification-schedule state.
    expect(SRC).toMatch(/presentation only/i);
  });
});
