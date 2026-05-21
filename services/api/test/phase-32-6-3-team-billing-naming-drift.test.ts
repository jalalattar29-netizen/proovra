/**
 * Phase 32.6.3 — Team billing naming drift regression guard.
 *
 * Root cause being closed:
 *   Four Team billing fields (billingPlan, billingStatus, includedSeats,
 *   overSeatLimit) shipped without `@map("snake_case")`. No migration ever
 *   created their columns. Production was minted by `prisma db push` with
 *   quoted camelCase column names. Same class of bug as Phase 32.6.2 on
 *   reviewer_ops.
 *
 *   The same audit also found three orphan Prisma models (AuditLog,
 *   Webhook, WebhookEvent) with no migration and no production code
 *   reference. They were removed in Phase 32.6.3.
 *
 * This test asserts:
 *   1. Every scalar field on the Team model that is camelCase carries an
 *      `@map("snake_case")` annotation pinning it to the migration column.
 *   2. The repair migration ships and is idempotent (no DROP COLUMN, uses
 *      information_schema guards, ADD COLUMN IF NOT EXISTS).
 *   3. The orphan Prisma models (AuditLog / Webhook / WebhookEvent) and
 *      their dead enums (AuditAction / WebhookStatus) are not present in
 *      schema.prisma.
 *   4. The live audit / webhook subsystems remain (AdminAuditLog +
 *      WebhookEndpoint).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCHEMA_PATH = fileURLToPath(
  new URL("../prisma/schema.prisma", import.meta.url),
);

const MIGRATION_PATH = fileURLToPath(
  new URL(
    "../prisma/migrations/20260620300000_team_billing_naming_drift_repair/migration.sql",
    import.meta.url,
  ),
);

const SCALAR_TYPE_PATTERN =
  /^(String|Int|BigInt|Boolean|DateTime|Decimal|Float|Bytes|Json|PlanType|TeamBillingStatus|RetentionPolicy|OrganizationVerificationState|WorkspaceCategory)(\?|\[\])?$/;

interface PrismaField {
  readonly name: string;
  readonly typeToken: string;
  readonly raw: string;
  readonly line: number;
}

function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}

function extractModelBlock(schema: string, modelName: string): string {
  const re = new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  const match = schema.match(re);
  expect(match, `model ${modelName} must exist in schema.prisma`).toBeTruthy();
  return match![1];
}

function stripLineComments(line: string): string {
  const idx = line.indexOf("//");
  return idx >= 0 ? line.slice(0, idx) : line;
}

function parseModelFields(schema: string, modelName: string): PrismaField[] {
  const block = extractModelBlock(schema, modelName);
  const rawLines = block.split(/\r?\n/);
  const fields: PrismaField[] = [];
  rawLines.forEach((rawLine, idx) => {
    const line = stripLineComments(rawLine).trim();
    if (line === "") return;
    if (line.startsWith("@@")) return;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([^\s]+)/);
    if (!match) return;
    const [, name, typeToken] = match;
    fields.push({ name, typeToken, raw: line, line: idx + 1 });
  });
  return fields;
}

function isCamelCase(identifier: string): boolean {
  if (identifier.includes("_")) return false;
  return /[A-Z]/.test(identifier);
}

function hasMapAnnotation(fieldRaw: string, expectedSnake: string): boolean {
  const re = new RegExp(`@map\\(\\s*"${expectedSnake}"\\s*\\)`);
  return re.test(fieldRaw);
}

function hasAnyMap(fieldRaw: string): boolean {
  return /@map\(/.test(fieldRaw);
}

function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function isScalarType(typeToken: string): boolean {
  return SCALAR_TYPE_PATTERN.test(typeToken);
}

describe("Phase 32.6.3 — Team billing naming drift regression guard", () => {
  const schema = readSchema();

  describe("model Team", () => {
    const fields = parseModelFields(schema, "Team");

    it("parses fields (sanity)", () => {
      expect(fields.length).toBeGreaterThan(0);
    });

    it("every camelCase scalar field carries an @map annotation", () => {
      const offenders: string[] = [];
      for (const field of fields) {
        if (!isScalarType(field.typeToken)) continue;
        if (!isCamelCase(field.name)) continue;
        if (!hasAnyMap(field.raw)) {
          offenders.push(
            `  Team.${field.name} (model-line ${field.line}, type ${field.typeToken}) — expected @map("${camelToSnake(field.name)}")`,
          );
        }
      }
      if (offenders.length > 0) {
        throw new Error(
          `Phase 32.6.3 contract violation: Team camelCase scalar fields must carry @map. Offenders:\n${offenders.join(
            "\n",
          )}\n\nWhy: without @map the Prisma client emits quoted camelCase column names. The Team table has no greenfield migration covering these; production was minted by 'prisma db push' and has been running on phantom camelCase columns. See services/api/prisma/migrations/20260620300000_team_billing_naming_drift_repair for the repair history.`,
        );
      }
    });

    it("billingPlan is @map(\"billing_plan\")", () => {
      const f = fields.find((x) => x.name === "billingPlan");
      expect(f).toBeTruthy();
      expect(hasMapAnnotation(f!.raw, "billing_plan")).toBe(true);
    });

    it("billingStatus is @map(\"billing_status\")", () => {
      const f = fields.find((x) => x.name === "billingStatus");
      expect(f).toBeTruthy();
      expect(hasMapAnnotation(f!.raw, "billing_status")).toBe(true);
    });

    it("includedSeats is @map(\"included_seats\")", () => {
      const f = fields.find((x) => x.name === "includedSeats");
      expect(f).toBeTruthy();
      expect(hasMapAnnotation(f!.raw, "included_seats")).toBe(true);
    });

    it("overSeatLimit is @map(\"over_seat_limit\")", () => {
      const f = fields.find((x) => x.name === "overSeatLimit");
      expect(f).toBeTruthy();
      expect(hasMapAnnotation(f!.raw, "over_seat_limit")).toBe(true);
    });
  });

  describe("repair migration", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");

    it("is idempotent (information_schema guards + ADD COLUMN IF NOT EXISTS)", () => {
      expect(sql).toContain("information_schema.columns");
      expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    });

    it("does NOT drop the camelCase columns (rollback safety)", () => {
      expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
    });

    it("ensures TeamBillingStatus enum exists (idempotent)", () => {
      expect(sql).toMatch(/CREATE TYPE\s+"TeamBillingStatus"/);
      expect(sql).toMatch(/typname\s*=\s*'TeamBillingStatus'/);
    });

    it("backfills all four billing columns from camelCase residue", () => {
      expect(sql).toMatch(/billing_plan[\s\S]*?"billingPlan"/);
      expect(sql).toMatch(/billing_status[\s\S]*?"billingStatus"/);
      expect(sql).toMatch(/included_seats[\s\S]*?"includedSeats"/);
      expect(sql).toMatch(/over_seat_limit[\s\S]*?"overSeatLimit"/);
    });
  });

  describe("orphan Prisma models removed", () => {
    it("AuditLog model is gone", () => {
      expect(schema).not.toMatch(/\bmodel\s+AuditLog\s*\{/);
    });

    it("Webhook model is gone (WebhookEndpoint is the live model and must remain)", () => {
      expect(schema).not.toMatch(/\bmodel\s+Webhook\s*\{/);
      expect(schema).toMatch(/\bmodel\s+WebhookEndpoint\s*\{/);
    });

    it("WebhookEvent model is gone", () => {
      expect(schema).not.toMatch(/\bmodel\s+WebhookEvent\s*\{/);
    });

    it("AuditAction enum (orphan) is gone; AdminAuditLog (live audit model) remains", () => {
      expect(schema).not.toMatch(/\benum\s+AuditAction\s*\{/);
      expect(schema).toMatch(/\bmodel\s+AdminAuditLog\s*\{/);
    });

    it("WebhookStatus enum (orphan) is gone", () => {
      expect(schema).not.toMatch(/\benum\s+WebhookStatus\s*\{/);
    });
  });
});
