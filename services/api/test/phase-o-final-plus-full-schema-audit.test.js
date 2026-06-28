/**
 * Phase O-Final+ — Full production schema audit contract + behaviour.
 *
 * Asserts:
 *   1. The audit script exists at the documented path.
 *   2. The audit script uses `pg.Pool` directly and NEVER constructs
 *      `new PrismaClient()` (Prisma 7 in this project requires the
 *      adapter factory; bypassing the ORM is mandatory for drift
 *      diagnosis).
 *   3. The audit script is READ-ONLY — no ALTER / INSERT / UPDATE /
 *      DELETE / DROP / TRUNCATE in real (non-comment) code.
 *   4. parsePrismaSchema correctly extracts model name, table name,
 *      field column (`@map`), optional flag, dbType, default, id,
 *      and unique — including the documented edge cases (`@@map`,
 *      `@db.Uuid`, relation fields skipped, list fields skipped,
 *      enum fields tagged as such).
 *   5. detectNamingDrift identifies snake↔camel drift correctly.
 *   6. classifyFinding assigns CRITICAL / HIGH / MEDIUM / LOW
 *      consistently with the documented risk model.
 *   7. fieldToSqlType produces additive ADD COLUMN sql fragments
 *      for common types.
 *   8. scanMigrationsForRiskPatterns detects `CREATE TABLE IF NOT
 *      EXISTS` patterns in the migrations folder and flags the known
 *      Phase 16 collaboration table family.
 *   9. The docs ship at the documented path and reference the safe
 *      operator commands (snapshot + safe-migrate).
 *  10. The script is callable in `--parse-only` mode (i.e. import
 *      cost + arg parsing are reachable without a DB connection).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel) {
    return readFileSync(REPO_ROOT + rel, "utf8");
}
function exists(rel) {
    return existsSync(REPO_ROOT + rel);
}
function stripJsComments(src) {
    return src
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .filter((line) => !/^\s*\*/.test(line))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");
}
const AUDIT_SCRIPT = "services/api/scripts/full-production-schema-audit.mjs";
// ---------------------------------------------------------------------------
// 1-3. Contract: file presence, read-only-ness, no PrismaClient
// ---------------------------------------------------------------------------
describe("O-Final+ — audit script contract", () => {
    it("ships at the documented path", () => {
        expect(exists(AUDIT_SCRIPT)).toBe(true);
        expect(statSync(REPO_ROOT + AUDIT_SCRIPT).size).toBeGreaterThan(2000);
    });
    it("uses pg.Pool and never constructs a PrismaClient", () => {
        const src = read(AUDIT_SCRIPT);
        // Static OR dynamic import of pg is acceptable. The script
        // uses dynamic import so `--parse-only` mode does not require
        // pg to be installed in the runtime path.
        expect(src).toMatch(/(from\s+["']pg["']|import\(["']pg["']\))/);
        expect(src).toMatch(/new\s+Pool\(/);
        const code = stripJsComments(src);
        expect.soft(code).not.toMatch(/new\s+PrismaClient\(/);
        expect.soft(code).not.toMatch(/from\s+["']@prisma\/client["']/);
    });
    it("is read-only by construction — every pool.query goes through safeQuery", () => {
        const src = read(AUDIT_SCRIPT);
        // Structural rule: the only `pool.query(` call site in the file
        // is inside `safeQuery`. (`suggestRepair` / `suggestAddColumn`
        // intentionally embed SUGGESTION strings containing ALTER /
        // ADD COLUMN — those are template strings returned for operator
        // review, never executed.)
        const allPoolQuery = src.match(/pool\.query\(/g) ?? [];
        // Exactly one — the call inside `safeQuery`.
        expect(allPoolQuery.length).toBe(1);
        // Cross-check: that single call is inside the safeQuery body.
        expect(src).toMatch(/async function safeQuery\([\s\S]*?pool\.query\(/);
    });
    it("declares a safe-query guard refusing non-SELECT statements", () => {
        const src = read(AUDIT_SCRIPT);
        expect(src).toMatch(/READ_ONLY_PREFIX/);
        expect(src).toMatch(/non-SELECT statement constructed/);
        // The regex MUST anchor on SELECT at the start.
        expect(src).toMatch(/READ_ONLY_PREFIX\s*=\s*\/\^\\s\*SELECT/);
    });
    it("repair SUGGESTIONS use ADD COLUMN IF NOT EXISTS (additive only)", () => {
        const src = read(AUDIT_SCRIPT);
        // The suggestion helpers exist and emit ADD COLUMN IF NOT EXISTS.
        expect(src).toMatch(/ADD COLUMN IF NOT EXISTS/);
        // Suggestion strings ALSO use ALTER TABLE IF EXISTS (not bare ALTER).
        expect(src).toMatch(/ALTER TABLE IF EXISTS/);
        // No suggestion uses destructive keywords.
        expect.soft(src).not.toMatch(/DROP COLUMN/);
        expect.soft(src).not.toMatch(/DROP TABLE/);
        expect.soft(src).not.toMatch(/TRUNCATE/);
        expect.soft(src).not.toMatch(/DELETE FROM/);
    });
    it("redacts DATABASE_URL before printing", () => {
        const src = read(AUDIT_SCRIPT);
        expect(src).toMatch(/redactDatabaseUrl/);
    });
});
// ---------------------------------------------------------------------------
// 4-7. Behaviour: import the exported pure functions and exercise them.
// ---------------------------------------------------------------------------
async function loadAuditCore() {
    const mod = await import(REPO_ROOT + AUDIT_SCRIPT);
    return mod;
}
describe("O-Final+ — parsePrismaSchema", () => {
    const FIXTURE = `
// A trivial fixture that exercises every supported feature.

enum Color {
  RED
  GREEN
  BLUE
  @@map("widget_color")
}

model Widget {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  teamId    String?  @map("team_id") @db.Uuid
  name      String   @db.VarChar(120)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  color     Color    @default(RED)
  parts     Part[]
  owner     User     @relation(fields: [ownerId], references: [id])
  ownerId   String   @map("owner_id") @db.Uuid

  @@unique([teamId, name])
  @@index([color])
  @@map("widgets")
}

model Part {
  id       String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  widgetId String @map("widget_id") @db.Uuid
}

model User {
  id String @id @db.Uuid
}
`;
    it("extracts model + table + enum names", async () => {
        const { parsePrismaSchema } = await loadAuditCore();
        const p = parsePrismaSchema(FIXTURE);
        expect(p.models.map((m) => m.name).sort()).toEqual(["Part", "User", "Widget"]);
        expect(p.models.find((m) => m.name === "Widget")?.table).toBe("widgets");
        // Part has no @@map, so table === model name.
        expect(p.models.find((m) => m.name === "Part")?.table).toBe("Part");
        expect(p.enums.map((e) => e.name)).toEqual(["Color"]);
        expect(p.enums[0].dbName).toBe("widget_color");
        expect(p.enums[0].values).toEqual(["RED", "GREEN", "BLUE"]);
    });
    it("respects @map for column names, defaults to field name otherwise", async () => {
        const { parsePrismaSchema } = await loadAuditCore();
        const p = parsePrismaSchema(FIXTURE);
        const widget = p.models.find((m) => m.name === "Widget");
        const team = widget.fields.find((f) => f.fieldName === "teamId");
        const name = widget.fields.find((f) => f.fieldName === "name");
        const created = widget.fields.find((f) => f.fieldName === "createdAt");
        expect(team?.column).toBe("team_id");
        expect(name?.column).toBe("name"); // no @map → default to field name
        expect(created?.column).toBe("created_at");
    });
    it("captures @db.X type + arg", async () => {
        const { parsePrismaSchema } = await loadAuditCore();
        const p = parsePrismaSchema(FIXTURE);
        const widget = p.models.find((m) => m.name === "Widget");
        const teamId = widget.fields.find((f) => f.fieldName === "teamId");
        const name = widget.fields.find((f) => f.fieldName === "name");
        expect(teamId?.dbType).toBe("Uuid");
        expect(name?.dbType).toBe("VarChar");
        expect(name?.dbTypeArg).toBe("120");
    });
    it("captures optional flag", async () => {
        const { parsePrismaSchema } = await loadAuditCore();
        const p = parsePrismaSchema(FIXTURE);
        const widget = p.models.find((m) => m.name === "Widget");
        expect(widget.fields.find((f) => f.fieldName === "teamId")?.optional).toBe(true);
        expect(widget.fields.find((f) => f.fieldName === "name")?.optional).toBe(false);
    });
    it("captures @id and @default", async () => {
        const { parsePrismaSchema } = await loadAuditCore();
        const p = parsePrismaSchema(FIXTURE);
        const widget = p.models.find((m) => m.name === "Widget");
        const id = widget.fields.find((f) => f.fieldName === "id");
        expect(id.isId).toBe(true);
        expect(id.defaultExpr).toMatch(/dbgenerated/);
    });
    it("EXCLUDES relation fields and list fields", async () => {
        const { parsePrismaSchema } = await loadAuditCore();
        const p = parsePrismaSchema(FIXTURE);
        const widget = p.models.find((m) => m.name === "Widget");
        const names = widget.fields.map((f) => f.fieldName);
        // `parts: Part[]` is a list relation, excluded.
        expect(names).not.toContain("parts");
        // `owner: User @relation(...)` is a relation field, excluded.
        expect(names).not.toContain("owner");
        // `ownerId: String @map("owner_id")` IS a scalar FK column.
        expect(names).toContain("ownerId");
        expect(widget.fields.find((f) => f.fieldName === "ownerId")?.column).toBe("owner_id");
    });
    it("tags enum-typed fields as isEnum", async () => {
        const { parsePrismaSchema } = await loadAuditCore();
        const p = parsePrismaSchema(FIXTURE);
        const widget = p.models.find((m) => m.name === "Widget");
        expect(widget.fields.find((f) => f.fieldName === "color")?.isEnum).toBe(true);
    });
    it("uses enum @@map for the expected Postgres udt name", async () => {
        const { parsePrismaSchema, expectedPgType } = await loadAuditCore();
        const p = parsePrismaSchema(FIXTURE);
        const widget = p.models.find((m) => m.name === "Widget");
        const color = widget.fields.find((f) => f.fieldName === "color");
        expect(expectedPgType(color)).toEqual({
            acceptable: ["USER-DEFINED"],
            expectedUdt: "widget_color",
        });
    });
    it("captures @@unique and @@index", async () => {
        const { parsePrismaSchema } = await loadAuditCore();
        const p = parsePrismaSchema(FIXTURE);
        const widget = p.models.find((m) => m.name === "Widget");
        const kinds = widget.indexes.map((i) => i.kind).sort();
        expect(kinds).toEqual(["index", "unique"]);
    });
    it("parses the real PROOVRA schema without crashing + finds DiscussionMention.teamId", async () => {
        const { parsePrismaSchema } = await loadAuditCore();
        const src = read("services/api/prisma/schema.prisma");
        const p = parsePrismaSchema(src);
        expect(p.models.length).toBeGreaterThan(100);
        expect(p.enums.length).toBeGreaterThan(50);
        const dm = p.models.find((m) => m.name === "DiscussionMention");
        expect(dm).toBeTruthy();
        expect(dm.table).toBe("discussion_mentions");
        const teamId = dm.fields.find((f) => f.fieldName === "teamId");
        expect(teamId).toBeTruthy();
        expect(teamId.column).toBe("team_id");
        expect(teamId.optional).toBe(true);
        expect(teamId.dbType).toBe("Uuid");
    });
});
describe("O-Final+ — detectNamingDrift", () => {
    it("returns null when expected column is present", async () => {
        const { detectNamingDrift } = await loadAuditCore();
        expect(detectNamingDrift("team_id", new Set(["team_id", "name"]))).toBeNull();
    });
    it("detects snake→camel drift (Prisma expects snake, DB has camel)", async () => {
        const { detectNamingDrift } = await loadAuditCore();
        const r = detectNamingDrift("team_id", new Set(["teamId"]));
        expect(r).toEqual({ kind: "snake_to_camel", actual: "teamId" });
    });
    it("detects camel→snake drift (Prisma expects camel, DB has snake)", async () => {
        const { detectNamingDrift } = await loadAuditCore();
        const r = detectNamingDrift("teamId", new Set(["team_id"]));
        expect(r).toEqual({ kind: "camel_to_snake", actual: "team_id" });
    });
    it("returns null when neither variant present", async () => {
        const { detectNamingDrift } = await loadAuditCore();
        expect(detectNamingDrift("team_id", new Set(["other"]))).toBeNull();
    });
});
describe("O-Final+ — classifyFinding", () => {
    it("MISSING_TABLE is CRITICAL", async () => {
        const { classifyFinding } = await loadAuditCore();
        expect(classifyFinding({ kind: "MISSING_TABLE" })).toBe("CRITICAL");
    });
    it("MISSING_COLUMN is CRITICAL (Prisma queries SELECT every field)", async () => {
        const { classifyFinding } = await loadAuditCore();
        expect(classifyFinding({ kind: "MISSING_COLUMN" })).toBe("CRITICAL");
    });
    it("NAMING_DRIFT is CRITICAL", async () => {
        const { classifyFinding } = await loadAuditCore();
        expect(classifyFinding({ kind: "NAMING_DRIFT" })).toBe("CRITICAL");
    });
    it("TYPE_MISMATCH is HIGH", async () => {
        const { classifyFinding } = await loadAuditCore();
        expect(classifyFinding({ kind: "TYPE_MISMATCH" })).toBe("HIGH");
    });
    it("NULLABLE_DB_NULLABLE_PRISMA_REQUIRED is HIGH", async () => {
        const { classifyFinding } = await loadAuditCore();
        expect(classifyFinding({ kind: "NULLABLE_DB_NULLABLE_PRISMA_REQUIRED" })).toBe("HIGH");
    });
    it("NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL is LOW (over-strict DB)", async () => {
        const { classifyFinding } = await loadAuditCore();
        expect(classifyFinding({ kind: "NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL" })).toBe("LOW");
    });
    it("MISSING_INDEX is LOW (perf only)", async () => {
        const { classifyFinding } = await loadAuditCore();
        expect(classifyFinding({ kind: "MISSING_INDEX" })).toBe("LOW");
    });
    it("MISSING_ENUM_VALUE is HIGH", async () => {
        const { classifyFinding } = await loadAuditCore();
        expect(classifyFinding({ kind: "MISSING_ENUM_VALUE" })).toBe("HIGH");
    });
});
describe("O-Final+ — fieldToSqlType + suggestRepair", () => {
    it("produces UUID for @db.Uuid", async () => {
        const { fieldToSqlType } = await loadAuditCore();
        expect(fieldToSqlType({
            isEnum: false,
            dbType: "Uuid",
            dbTypeArg: null,
            baseType: "String",
        })).toBe("UUID");
    });
    it("produces VARCHAR(N) for @db.VarChar(N)", async () => {
        const { fieldToSqlType } = await loadAuditCore();
        expect(fieldToSqlType({
            isEnum: false,
            dbType: "VarChar",
            dbTypeArg: "120",
            baseType: "String",
        })).toBe("VARCHAR(120)");
    });
    it("produces TIMESTAMPTZ(N) for @db.Timestamptz(N)", async () => {
        const { fieldToSqlType } = await loadAuditCore();
        expect(fieldToSqlType({
            isEnum: false,
            dbType: "Timestamptz",
            dbTypeArg: "6",
            baseType: "DateTime",
        })).toBe("TIMESTAMPTZ(6)");
    });
    it("returns null for enum types (need user-defined type)", async () => {
        const { fieldToSqlType } = await loadAuditCore();
        expect(fieldToSqlType({
            isEnum: true,
            dbType: null,
            dbTypeArg: null,
            baseType: "MyEnum",
        })).toBeNull();
    });
    it("suggestRepair for MISSING_COLUMN emits ADD COLUMN IF NOT EXISTS", async () => {
        const { suggestRepair } = await loadAuditCore();
        const r = suggestRepair({
            kind: "MISSING_COLUMN",
            table: "widgets",
            column: "team_id",
            fieldName: "teamId",
            expectedTypes: ["uuid"],
            suggestedSql: "UUID",
        });
        expect(r).toMatch(/ALTER TABLE IF EXISTS "widgets"/);
        expect(r).toMatch(/ADD COLUMN IF NOT EXISTS "team_id" UUID/);
    });
    it("suggestRepair for NAMING_DRIFT requires operator decision (no auto-fix)", async () => {
        const { suggestRepair } = await loadAuditCore();
        const r = suggestRepair({
            kind: "NAMING_DRIFT",
            table: "widgets",
            expectedColumn: "team_id",
            driftedTo: "teamId",
        });
        expect(r).toMatch(/Operator must DECIDE|Do NOT auto-fix/);
    });
});
// ---------------------------------------------------------------------------
// 8. Migration risk-pattern scan
// ---------------------------------------------------------------------------
describe("O-Final+ — scanMigrationsForRiskPatterns", () => {
    it("detects CREATE TABLE IF NOT EXISTS in real PROOVRA migrations", async () => {
        const { scanMigrationsForRiskPatterns } = await loadAuditCore();
        const out = scanMigrationsForRiskPatterns(REPO_ROOT + "services/api/prisma/migrations");
        // The Phase 16 collaboration migration is the documented root-cause
        // exemplar — must appear with discussion_mentions.
        const phase16 = out.find((r) => r.migration === "20260525100000_add_collaboration_phase16" &&
            r.table === "discussion_mentions");
        expect(phase16).toBeTruthy();
        // At least 10 risky migrations across history.
        expect(out.length).toBeGreaterThan(10);
    });
});
// ---------------------------------------------------------------------------
// 9. Docs presence
// ---------------------------------------------------------------------------
describe("O-Final+ — closure documentation", () => {
    const DOC = "docs/operations/full-production-schema-audit.md";
    it(`${DOC} exists and is non-empty`, () => {
        expect(exists(DOC)).toBe(true);
        expect(statSync(REPO_ROOT + DOC).size).toBeGreaterThan(500);
    });
    it("doc references the safe operator commands + Neon snapshot rule", () => {
        const src = read(DOC);
        expect(src).toMatch(/full-production-schema-audit\.mjs/);
        expect(src).toMatch(/safe-migrate\.mjs/);
        expect(src).toMatch(/snapshot/i);
        expect(src).toMatch(/CRITICAL|HIGH|MEDIUM|LOW/);
        expect(src).toMatch(/DATABASE_URL/);
    });
    it("doc documents the camelCase/snake_case drift example", () => {
        const src = read(DOC);
        // The doc must show the exemplar drift case.
        expect(src).toMatch(/team_id|naming drift|NAMING_DRIFT/);
    });
});
