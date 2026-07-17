/**
 * Settings remediation backend contracts (2026-07-17).
 *
 *   - notification-schedule timezone becomes an EXPLICIT inheritance
 *     model (null = inherit account timezone → UTC), end to end:
 *     schema, migration, service, route, digest scheduler.
 *   - /v1/workspaces/ai-usage exposes the plan allowance from the SAME
 *     scope model + enforcement ledger the AI cost guard uses.
 *   - single own-session revocation route (step-up; current session is
 *     never revocable through it).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
const SCHEMA = read("../prisma/schema.prisma");
const MIGRATION = read(
  "../prisma/migrations/20270923000000_notification_schedule_timezone_inherit/migration.sql",
);
const PREFS_SERVICE = read(
  "../src/services/notifications/notification-preferences.service.ts",
);
const PREFS_ROUTES = read("../src/routes/notification-preferences.routes.ts");
const SCHEDULER = read("../src/services/notifications/digest-scheduler.ts");
const AI_ROUTES = read("../src/routes/workspace-ai-policy.routes.ts");
const IDSEC_ROUTES = read("../src/routes/identity-security.routes.ts");
const STEP_UP = read(
  "../src/services/identity-security/account-step-up.service.ts",
);

describe("notification timezone inheritance (§6)", () => {
  it("schema: schedule timezone is nullable with no implicit default", () => {
    const at = SCHEMA.indexOf("model NotificationScheduleSetting");
    const block = SCHEMA.slice(at, at + 1600);
    expect(block).toMatch(/timezone String\? @db\.VarChar\(64\)/);
    expect(block).not.toMatch(/timezone String @default\("UTC"\)/);
  });

  it("migration relaxes the constraint and converts old implicit-UTC rows restrictively", () => {
    expect(MIGRATION).toMatch(/ALTER COLUMN "timezone" DROP NOT NULL/);
    expect(MIGRATION).toMatch(/ALTER COLUMN "timezone" DROP DEFAULT/);
    expect(MIGRATION).toMatch(
      /SET "timezone" = NULL\s*\n?\s*WHERE "timezone" = 'UTC'/,
    );
    expect(MIGRATION).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
  });

  it("service defaults to NO override and validates only explicit values", () => {
    expect(PREFS_SERVICE).toMatch(/timezone: null,/);
    expect(PREFS_SERVICE).toMatch(
      /input\.timezone !== null && !isValidTimezone\(input\.timezone\)/,
    );
    expect(PREFS_SERVICE).toMatch(/timezone: string \| null/);
  });

  it("route accepts null (inherit) and re-validates explicit overrides", () => {
    expect(PREFS_ROUTES).toMatch(/timezone: z\.string\(\)\.min\(1\)\.max\(64\)\.nullable\(\)/);
    expect(PREFS_ROUTES).toMatch(
      /body\.timezone !== null && !isValidTimezone\(body\.timezone\)/,
    );
  });

  it("digest scheduler keeps the ONE precedence: override → account → UTC", () => {
    expect(SCHEDULER).toMatch(
      /timezone:\s*sched\?\.timezone\s*\?\?\s*accountTz\s*\?\?\s*"UTC"/,
    );
  });
});

describe("AI usage allowance (§9)", () => {
  it("allowance is resolved from the SAME scope model the cost guard enforces", () => {
    expect(AI_ROUTES).toMatch(/getWorkspaceAiUsageThisMonth\(scope\)/);
    expect(AI_ROUTES).toMatch(/team\.isPersonal\s*\n?\s*\? await getPersonalWorkspaceScope\(team\.ownerUserId\)\s*\n?\s*: await getTeamWorkspaceScope\(query\.teamId\)/);
  });

  it("response carries plan + monthly cap + consumed + remaining", () => {
    expect(AI_ROUTES).toMatch(/monthlyOperations: cap/);
    expect(AI_ROUTES).toMatch(/remaining: cap === null \? null : Math\.max\(0, cap - consumed\)/);
    expect(AI_ROUTES).toMatch(/allowance,/);
  });
});

describe("single own-session revocation (§4.3)", () => {
  it("route is user-bound, step-up gated, and audited", () => {
    expect(IDSEC_ROUTES).toMatch(/\/v1\/identity-security\/my-sessions\/:id\/revoke/);
    expect(IDSEC_ROUTES).toMatch(/action: "session_revoke"/);
    expect(IDSEC_ROUTES).toMatch(/id: params\.id, userId, revokedAtUtc: null/);
    expect(IDSEC_ROUTES).toMatch(/identity_security\.self_revoke_session/);
    expect(STEP_UP).toMatch(/"session_revoke"/);
  });

  it("the CURRENT session is never revocable through it", () => {
    expect(IDSEC_ROUTES).toMatch(/current_session_not_revocable/);
    expect(IDSEC_ROUTES).toMatch(/target\.sessionIdHash === currentHash/);
  });
});

describe("plan-features envelope (§10)", () => {
  it("planFeatures exposes the AI monthly allowance from the canonical catalog", () => {
    const TYPES = read("../src/services/platform-context/types.ts");
    const SERVICE = read(
      "../src/services/platform-context/platform-context.service.ts",
    );
    expect(TYPES).toMatch(/aiAssistanceMonthlyOperations: number \| null/);
    expect(SERVICE).toMatch(
      /aiAssistanceMonthlyOperations: planCaps\.aiAdvisoryMonthlyOperations/,
    );
  });
});
