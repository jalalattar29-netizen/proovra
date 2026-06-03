/**
 * Phase 32.6.2 — Reviewer ops naming drift regression guard.
 *
 * Root cause being closed:
 *   Five reviewer_ops Prisma fields shipped without `@map("snake_case")`
 *   annotations. Prisma client emitted quoted camelCase column names in
 *   SQL ("safeSummary", "resolutionNote", "safeNote", "dedupKey") while
 *   migrations created snake_case columns. Production ended up with two
 *   physical columns per field — Prisma client read/wrote one, migrations
 *   managed the other. Runtime schema validation flagged reviewer_ops as
 *   degraded.
 *
 * This test parses services/api/prisma/schema.prisma and asserts that
 * EVERY scalar field on the reviewer_ops models uses either:
 *   - a snake_case identifier (no mapping needed), OR
 *   - a camelCase identifier paired with an `@map("snake_case")`
 *     annotation.
 *
 * A new field added to one of these models that omits @map will fail
 * this test rather than reaching production as a duplicate-column
 * defect.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const SCHEMA_PATH = fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url));
const REVIEWER_OPS_MODELS = [
    "ReviewEscalation",
    "ReviewerWorkloadSnapshot",
    "ReviewerOpsReminder",
];
// Scalar field types whose underlying column name is determined by the
// field identifier (the ones susceptible to the camelCase quoting drift).
// Relation fields use `@relation`, not a column name, so they are exempt.
const SCALAR_TYPE_PATTERN = /^(String|Int|BigInt|Boolean|DateTime|Decimal|Float|Bytes|Json)(\?|\[\])?$/;
function readSchema() {
    return readFileSync(SCHEMA_PATH, "utf8");
}
function extractModelBlock(schema, modelName) {
    const re = new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
    const match = schema.match(re);
    expect(match, `model ${modelName} must exist in schema.prisma`).toBeTruthy();
    return match[1];
}
function stripLineComments(line) {
    // Prisma supports `//` line comments and `///` doc comments. Both end
    // a logical field line for our purposes.
    const idx = line.indexOf("//");
    return idx >= 0 ? line.slice(0, idx) : line;
}
function parseModel(schema, modelName) {
    const block = extractModelBlock(schema, modelName);
    const rawLines = block.split(/\r?\n/);
    const fields = [];
    rawLines.forEach((rawLine, idx) => {
        const line = stripLineComments(rawLine).trim();
        if (line === "")
            return;
        // Skip block-level directives: @@map, @@index, @@unique, @@id, etc.
        if (line.startsWith("@@"))
            return;
        // A field declaration begins with `<identifier> <Type>` — match that
        // prefix and capture both. Anything else (e.g. block start/end) is
        // ignored.
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([^\s]+)/);
        if (!match)
            return;
        const [, name, typeToken] = match;
        fields.push({ name, typeToken, raw: line, line: idx + 1 });
    });
    return { name: modelName, fields };
}
function isCamelCase(identifier) {
    // snake_case has at least one underscore. anything without an
    // underscore that starts lower and contains an uppercase letter is
    // camelCase.
    if (identifier.includes("_"))
        return false;
    return /[A-Z]/.test(identifier);
}
function hasMapAnnotation(fieldRaw, expectedSnake) {
    const re = new RegExp(`@map\\(\\s*"${expectedSnake}"\\s*\\)`);
    return re.test(fieldRaw);
}
function camelToSnake(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function isScalarType(typeToken) {
    return SCALAR_TYPE_PATTERN.test(typeToken);
}
describe("Phase 32.6.2 — reviewer_ops naming drift regression guard", () => {
    const schema = readSchema();
    for (const modelName of REVIEWER_OPS_MODELS) {
        describe(`model ${modelName}`, () => {
            const model = parseModel(schema, modelName);
            it("has at least one field (sanity check parse)", () => {
                expect(model.fields.length).toBeGreaterThan(0);
            });
            it("every camelCase scalar field carries @map(\"snake_case\")", () => {
                const offenders = [];
                for (const field of model.fields) {
                    if (!isScalarType(field.typeToken))
                        continue;
                    if (!isCamelCase(field.name))
                        continue;
                    const expectedSnake = camelToSnake(field.name);
                    if (!hasMapAnnotation(field.raw, expectedSnake)) {
                        offenders.push(`  ${modelName}.${field.name} (line ${field.line}) — expected @map("${expectedSnake}")`);
                    }
                }
                if (offenders.length > 0) {
                    throw new Error(`Phase 32.6.2 contract violation: reviewer_ops camelCase scalar fields must carry an @map annotation that pins them to the snake_case migration column. Offending fields:\n${offenders.join("\n")}\n\nWhy: without @map, the Prisma client emits quoted camelCase SQL ("fieldName") while migrations create snake_case columns. Production ends up with two physical columns per field. See services/api/prisma/migrations/20260620200000_reviewer_ops_naming_drift_repair/migration.sql for the repair history.`);
                }
            });
        });
    }
    it("review_escalations.safe_summary @map is present (canonical anchor)", () => {
        const model = parseModel(schema, "ReviewEscalation");
        const field = model.fields.find((f) => f.name === "safeSummary");
        expect(field, "ReviewEscalation.safeSummary must exist").toBeTruthy();
        expect(hasMapAnnotation(field.raw, "safe_summary")).toBe(true);
    });
    it("review_escalations.resolution_note @map is present", () => {
        const model = parseModel(schema, "ReviewEscalation");
        const field = model.fields.find((f) => f.name === "resolutionNote");
        expect(field).toBeTruthy();
        expect(hasMapAnnotation(field.raw, "resolution_note")).toBe(true);
    });
    it("reviewer_workload_snapshots.safe_note @map is present", () => {
        const model = parseModel(schema, "ReviewerWorkloadSnapshot");
        const field = model.fields.find((f) => f.name === "safeNote");
        expect(field).toBeTruthy();
        expect(hasMapAnnotation(field.raw, "safe_note")).toBe(true);
    });
    it("reviewer_ops_reminders.dedup_key @map is present", () => {
        const model = parseModel(schema, "ReviewerOpsReminder");
        const field = model.fields.find((f) => f.name === "dedupKey");
        expect(field).toBeTruthy();
        expect(hasMapAnnotation(field.raw, "dedup_key")).toBe(true);
    });
    it("reviewer_ops_reminders.safe_summary @map is present", () => {
        const model = parseModel(schema, "ReviewerOpsReminder");
        const field = model.fields.find((f) => f.name === "safeSummary");
        expect(field).toBeTruthy();
        expect(hasMapAnnotation(field.raw, "safe_summary")).toBe(true);
    });
    it("repair migration file ships alongside the schema fix", () => {
        const migrationPath = fileURLToPath(new URL("../prisma/migrations/20260620200000_reviewer_ops_naming_drift_repair/migration.sql", import.meta.url));
        const sql = readFileSync(migrationPath, "utf8");
        // The migration must be idempotent (information_schema-guarded)
        // and must NOT drop the camelCase columns (rollback safety).
        expect(sql).toContain("information_schema.columns");
        expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
        // It must touch all five fields.
        expect(sql).toMatch(/safe_summary[\s\S]*"safeSummary"/);
        expect(sql).toMatch(/resolution_note[\s\S]*"resolutionNote"/);
        expect(sql).toMatch(/safe_note[\s\S]*"safeNote"/);
        expect(sql).toMatch(/dedup_key[\s\S]*"dedupKey"/);
    });
});
