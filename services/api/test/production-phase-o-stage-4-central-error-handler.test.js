/**
 * Phase O Stage 4 — Central error handler regression pins.
 *
 * The Fastify `setErrorHandler` in `services/api/src/server.ts` was
 * extended additively so that ZodError + Prisma known-request errors
 * never escape as a generic 500 / leaked error JSON. The Stage 3 per-
 * route handlers remain the FIRST line of defence (every route already
 * converted `.parse()` → `.safeParse()` and every Prisma call site has
 * a bounded try/catch). These central mappings are belt-and-braces for
 * any route that forgets, AND they emit the canonical wire shapes that
 * the legacy `createErrorResponse` path cannot emit (custom `code`,
 * `fields[]`, etc.).
 *
 * The three new central mappings are:
 *
 *   1. ZodError                              → 400 INVALID_INPUT with bounded fields[] (max 5)
 *   2. Prisma P2022 / P2021                  → 503 SCHEMA_NOT_READY
 *   3. Prisma other known-request errors     → 500 DATABASE_ERROR
 *
 * Style: source-contract (file-text). Matches the existing
 * `production-phase-o-stream-{a,c}-route-fixes.test.ts` files. NO DB
 * I/O. Pins the exact code shape so a future refactor that
 * accidentally removes the central mappings (or weakens the anti-leak
 * invariants) fails CI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readApi(rel) {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
const SERVER = readApi("src/server.ts");
describe("Phase O Stage 4 — central error handler ZodError → 400 INVALID_INPUT", () => {
    it("intercepts ZodError BEFORE the legacy normalizeUnknownError path", () => {
        // The new ZodError branch must appear inside setErrorHandler and
        // must run before the legacy `const appError = normalizeUnknownError(err);`
        // call so the canonical INVALID_INPUT wire shape wins over the
        // legacy VALIDATION_ERROR shape.
        expect(SERVER).toMatch(/app\.setErrorHandler[\s\S]{0,4000}!isAppError\(err\) && err instanceof ZodError[\s\S]{0,2400}const appError = normalizeUnknownError\(err\);/);
    });
    it("emits INVALID_INPUT code + bounded message + fields[] + requestId", () => {
        expect(SERVER).toMatch(/code: "INVALID_INPUT"[\s\S]{0,400}fields,[\s\S]{0,400}requestId,/);
    });
    it("caps fields[] at 5 entries via ZOD_FIELD_LIMIT", () => {
        expect(SERVER).toMatch(/const ZOD_FIELD_LIMIT = 5;/);
        expect(SERVER).toMatch(/issues\.slice\(0, ZOD_FIELD_LIMIT\)/);
    });
    it("bounds the summary message length", () => {
        expect(SERVER).toMatch(/const ZOD_MESSAGE_LIMIT = 200;/);
        expect(SERVER).toMatch(/\.slice\(0, ZOD_MESSAGE_LIMIT\)/);
    });
    it("bounds each field path + message length to prevent leakage", () => {
        expect(SERVER).toMatch(/const ZOD_FIELD_PATH_LIMIT = 120;/);
        expect(SERVER).toMatch(/const ZOD_FIELD_MESSAGE_LIMIT = 200;/);
    });
    it("logs zod issue count + bounded fields internally", () => {
        expect(SERVER).toMatch(/errorCode: "INVALID_INPUT"[\s\S]{0,400}zodIssueCount: wire\.log\.issueCount[\s\S]{0,200}zodFields: wire\.log\.fields/);
        expect(SERVER).toMatch(/"request\.failed\.validation"/);
    });
});
describe("Phase O Stage 4 — central error handler Prisma P2022/P2021 → 503 SCHEMA_NOT_READY", () => {
    it("detects PrismaClientKnownRequestError by name + string code", () => {
        expect(SERVER).toMatch(/function isPrismaKnownRequestError\(err: unknown\): err is Error & \{[\s\S]{0,200}code: string;/);
        expect(SERVER).toMatch(/err\.name !== "PrismaClientKnownRequestError"/);
    });
    it("maps P2022 + P2021 to 503 SCHEMA_NOT_READY with bounded message", () => {
        expect(SERVER).toMatch(/diag\.code === "P2022" \|\| diag\.code === "P2021"[\s\S]{0,1400}code: "SCHEMA_NOT_READY"[\s\S]{0,200}message: "Resource temporarily unavailable\."[\s\S]{0,200}requestId,/);
    });
    it("status code is exactly 503 for SCHEMA_NOT_READY", () => {
        expect(SERVER).toMatch(/return reply\.code\(503\)\.send\(\{\s*error: \{\s*code: "SCHEMA_NOT_READY"/);
    });
    it("logs prisma code + missing column/table internally (operator-safe)", () => {
        expect(SERVER).toMatch(/errorCode: "SCHEMA_NOT_READY"[\s\S]{0,400}prismaCode: diag\.code[\s\S]{0,200}prismaMissingColumn: diag\.meta\.column[\s\S]{0,200}prismaMissingTable: diag\.meta\.table/);
        expect(SERVER).toMatch(/"request\.failed\.schema_not_ready"/);
    });
});
describe("Phase O Stage 4 — central error handler other Prisma → 500 DATABASE_ERROR", () => {
    it("maps any other Prisma known-request code to 500 DATABASE_ERROR", () => {
        expect(SERVER).toMatch(/code: "DATABASE_ERROR"[\s\S]{0,200}message: "Request failed\."[\s\S]{0,200}requestId,/);
        expect(SERVER).toMatch(/return reply\.code\(500\)\.send\(\{\s*error: \{\s*code: "DATABASE_ERROR"/);
    });
    it("calls captureException for non-schema-drift Prisma errors", () => {
        // Schema drift is operator-known + repaired by Phase 2 migration —
        // no Sentry noise. Any OTHER Prisma error is a real bug → Sentry.
        expect(SERVER).toMatch(/errorCode: "DATABASE_ERROR"[\s\S]{0,1400}captureException\(err, requestContext\);/);
    });
    it("logs prisma diagnostic internally for DATABASE_ERROR path", () => {
        expect(SERVER).toMatch(/errorCode: "DATABASE_ERROR"[\s\S]{0,600}prismaCode: diag\.code/);
        expect(SERVER).toMatch(/"request\.failed\.database_error"/);
    });
});
describe("Phase O Stage 4 — anti-leak invariants", () => {
    it("never sends raw Prisma message body to the client", () => {
        // The two reply.send(...) blocks for SCHEMA_NOT_READY + DATABASE_ERROR
        // must NOT reference diag.message between `reply.code(...)` and the
        // bounded canned message string — internal logging may include
        // diag.message, but the wire payload must use the canned message.
        const schemaReadyWire = SERVER.match(/reply\.code\(503\)\.send\([\s\S]{0,400}?"Resource temporarily unavailable\."/);
        expect(schemaReadyWire).toBeTruthy();
        expect(schemaReadyWire[0]).not.toMatch(/diag\.message/);
        const dbErrorWire = SERVER.match(/reply\.code\(500\)\.send\([\s\S]{0,400}?"Request failed\."/);
        expect(dbErrorWire).toBeTruthy();
        expect(dbErrorWire[0]).not.toMatch(/diag\.message/);
    });
    it("readPrismaDiagnostic bounds message to 300 chars + meta strings to 120", () => {
        expect(SERVER).toMatch(/err\.message\.slice\(0, 300\)/);
        expect(SERVER).toMatch(/value\.slice\(0, 120\)/);
    });
    it("requestId is read from req.id with null fallback", () => {
        expect(SERVER).toMatch(/const requestId = typeof req\.id === "string" \? req\.id : null;/);
    });
});
describe("Phase O Stage 4 — additive (preserves legacy behaviour)", () => {
    it("does NOT remove the legacy normalizeUnknownError call", () => {
        expect(SERVER).toMatch(/const appError = normalizeUnknownError\(err\);/);
    });
    it("does NOT remove the legacy AppError → createErrorResponse path", () => {
        expect(SERVER).toMatch(/if \(appError\) \{[\s\S]{0,2400}createErrorResponse\(\s*appError\.code/);
    });
    it("does NOT remove the legacy INTERNAL_SERVER_ERROR fall-through", () => {
        expect(SERVER).toMatch(/ErrorCode\.INTERNAL_SERVER_ERROR[\s\S]{0,200}req\.id\s*\)[\s\S]{0,200}reply\.code\(500\)\.send\(errorResponse\)/);
    });
    it("AppError instances skip the new central mappings (existing AppError path wins)", () => {
        // The new branches are gated by `!isAppError(err)` so a route that
        // wraps a ZodError in an AppError keeps the AppError code/message.
        expect(SERVER).toMatch(/!isAppError\(err\) && err instanceof ZodError/);
        expect(SERVER).toMatch(/!isAppError\(err\) && isPrismaKnownRequestError\(err\)/);
    });
});
