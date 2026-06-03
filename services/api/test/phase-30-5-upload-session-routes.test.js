/**
 * Phase 30.5 — Upload session REST route source-contract tests.
 *
 * The Phase 30 service layer already has 36 source-contract +
 * behavior tests covering custody-safe semantics. These tests cover
 * the REST surface specifically:
 *
 *   1. Every route requires `requireAuth` AND `authorizeOrFail` —
 *      no route is accessible without both.
 *   2. Every mutation uses `evidence.create`; every read uses
 *      `evidence.read`.
 *   3. Every route is `antiEnumeration: true` so non-members of the
 *      workspace see 404 not_found, not 403.
 *   4. Denials map to bounded HTTP statuses via `statusForDenial` —
 *      no free-text, no raw Prisma errors.
 *   5. Anti-leak: route source contains NO references to storage
 *     keys, signed URLs, S3 bucket names, or AWS object identifiers.
 *   6. Idempotency: create returns 200 on reuse, 201 on fresh insert.
 *   7. The session + part projections strip server-only fields.
 *   8. Server-supplied SHA-256 is required from trusted callers on
 *      the `/verified` route — never accepted via untrusted channels.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
const ROUTES_SRC = readSource("../../../services/api/src/routes/upload-sessions.routes.ts");
const SERVER_SRC = readSource("../../../services/api/src/server.ts");
// =============================================================================
// PART 1 — Routes are registered in server.ts
// =============================================================================
describe("Phase 30.5 — upload session routes are mounted", () => {
    it("server.ts imports uploadSessionsRoutes", () => {
        expect(SERVER_SRC).toMatch(/import\s*\{\s*uploadSessionsRoutes\s*\}\s*from\s+"\.\/routes\/upload-sessions\.routes\.js"/);
    });
    it("server.ts registers uploadSessionsRoutes", () => {
        expect(SERVER_SRC).toMatch(/app\.register\(\s*uploadSessionsRoutes\s*\)/);
    });
});
// =============================================================================
// PART 2 — Authentication + authorization invariants
// =============================================================================
describe("Phase 30.5 — every route is auth + authorize-gated", () => {
    // Phase 30.8 extends the route surface with 4 multipart routes
    // (initiate, presign, complete, abort) — so post-30.8 the file
    // should have 11 routes total. The invariants below apply to all
    // of them.
    const TOTAL_ROUTES = 11;
    it("every app.post + app.get block declares { preHandler: requireAuth }", () => {
        const handlerBlocks = ROUTES_SRC.match(/app\.(?:post|get)\([\s\S]*?\)\s*;/g) ?? [];
        expect(handlerBlocks.length).toBe(TOTAL_ROUTES);
        for (const block of handlerBlocks) {
            expect(block).toMatch(/preHandler:\s*requireAuth/);
        }
    });
    it("every route calls authorizeOrFail with antiEnumeration: true", () => {
        const authorizeCalls = ROUTES_SRC.match(/await authorizeOrFail\(\s*req,\s*reply,\s*\{[\s\S]*?\}\s*\)/g) ?? [];
        expect(authorizeCalls.length).toBe(TOTAL_ROUTES);
        for (const call of authorizeCalls) {
            expect(call).toMatch(/antiEnumeration:\s*true/);
        }
    });
    it("every authorize call returns early on null actor (no implicit allow)", () => {
        const earlyReturns = ROUTES_SRC.match(/if\s*\(!actor\)\s*return\s*;/g) ?? [];
        expect(earlyReturns.length).toBe(TOTAL_ROUTES);
    });
    it("read routes use evidence.read; write routes use evidence.create", () => {
        const readCalls = ROUTES_SRC.match(/permission:\s*"evidence\.read"/g) ?? [];
        const writeCalls = ROUTES_SRC.match(/permission:\s*"evidence\.create"/g) ?? [];
        // GET single + GET status = 2 reads.
        expect(readCalls.length).toBe(2);
        // 5 original writes (create/uploaded/verified/complete/abort) +
        // 4 multipart writes (initiate/presign/complete/abort) = 9.
        expect(writeCalls.length).toBe(9);
    });
});
// =============================================================================
// PART 3 — Bounded denial vocabulary mapping
// =============================================================================
describe("Phase 30.5 — bounded denial mapping", () => {
    it("statusForDenial covers every denial code from the service catalog", () => {
        // The mapping must reference each denial code at least once so
        // routes never fall into the default branch silently.
        for (const code of [
            "session_not_found",
            "service_unavailable",
            "hash_mismatch",
            "invalid_part_index",
            "invalid_part_count",
            "invalid_expiry",
            "completion_blocked_pending_parts",
            "session_not_active",
            "session_already_completed",
            "session_already_terminal",
            "invalid_state_transition",
        ]) {
            expect(ROUTES_SRC, `denial code ${code} missing from mapping`).toContain(`"${code}"`);
        }
    });
    it("404 responses use the canonical anti-enumeration shape", () => {
        expect(ROUTES_SRC).toMatch(/reply\.code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"\s*\}\s*\}\)/);
    });
    it("non-404 denials use the bounded upload_session_denied envelope", () => {
        expect(ROUTES_SRC).toMatch(/error:\s*\{\s*code:\s*"upload_session_denied",\s*reason\b/);
    });
    it("session_not_found maps to 404 (anti-enumeration)", () => {
        // After Phase 30.8 the case is grouped with multipart_not_found
        // — both fall through to `return 404`.
        expect(ROUTES_SRC).toMatch(/case\s+"session_not_found":[\s\S]*?return\s+404/);
    });
    it("service_unavailable maps to 503 (fail-closed)", () => {
        expect(ROUTES_SRC).toMatch(/case\s+"service_unavailable":[\s\S]*?return\s+503/);
    });
    it("hash_mismatch maps to 422 (semantic refusal)", () => {
        expect(ROUTES_SRC).toMatch(/case\s+"hash_mismatch":\s*\n\s*return\s+422/);
    });
});
// =============================================================================
// PART 4 — Anti-leak — no storage keys / signed URLs / S3 identifiers
// =============================================================================
describe("Phase 30.5 — anti-leak invariants", () => {
    const noComments = ROUTES_SRC
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
    it("routes do not reference signed URLs / bucket identifiers / object keys", () => {
        // Phase 30.8 explicitly surfaces `etag` (storage metadata) on
        // the multipart complete response — that is a SEPARATE concern
        // from the legacy session routes and is covered by the 30.8
        // tests. The Phase 30.5 anti-leak still forbids signed URLs,
        // bucket / object identifiers, and storage_key/storageKey.
        for (const banned of [
            "storageKey",
            "storage_key",
            "signed_url",
            "signedUrl",
            "presignedUrl",
            "bucketName",
            "s3Key",
            "objectKey",
        ]) {
            expect(noComments, `routes leak ${banned}`).not.toContain(banned);
        }
    });
    it("session projection strips workspace-internal fields", () => {
        // The projectSession helper should NOT project actorUserId or
        // teamId — both are derivable from the authorize context and
        // leaking them across responses is unnecessary attack surface.
        const fn = ROUTES_SRC.match(/function\s+projectSession\([\s\S]*?\n\}/)?.[0];
        expect(fn).toBeTruthy();
        expect(fn).not.toContain("actorUserId");
        expect(fn).not.toContain("teamId");
        expect(fn).not.toContain("abortedByUserId");
    });
    it("part projection strips session-id + team-id (redundant with route URL)", () => {
        const fn = ROUTES_SRC.match(/function\s+projectPart\([\s\S]*?\n\}/)?.[0];
        expect(fn).toBeTruthy();
        expect(fn).not.toContain("sessionId");
        expect(fn).not.toContain("teamId");
        expect(fn).not.toContain('id:');
    });
    it("no banned wording in route source (tamper / forged / altered evidence)", () => {
        const banned = /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
        expect(noComments).not.toMatch(banned);
    });
});
// =============================================================================
// PART 5 — Schema validation invariants
// =============================================================================
describe("Phase 30.5 — input validation contracts", () => {
    it("teamId always validated as a UUID", () => {
        const teamIdMatches = ROUTES_SRC.match(/teamId:\s*z\.string\(\)\.uuid\(\)/g) ?? [];
        expect(teamIdMatches.length).toBeGreaterThanOrEqual(5);
    });
    it("sessionId param always validated as UUID", () => {
        expect(ROUTES_SRC).toMatch(/sessionId:\s*z\.string\(\)\.uuid\(\)/);
    });
    it("partIndex coerced + bounded to [0, 9999]", () => {
        expect(ROUTES_SRC).toMatch(/partIndex:\s*z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(9_999\)/);
    });
    it("expectedPartCount is bounded to [1, 10_000] (matches service contract)", () => {
        expect(ROUTES_SRC).toMatch(/expectedPartCount:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\(10_000\)/);
    });
    it("expectedTotalBytes is bounded to 50 GiB at the route layer (defense in depth)", () => {
        expect(ROUTES_SRC).toMatch(/expectedTotalBytes[\s\S]*?50\s*\*\s*1024\s*\*\*\s*3/);
    });
    it("clientSha256 + serverSha256 + expectedSha256 enforce 64-char hex at the route layer", () => {
        const shaPatterns = ROUTES_SRC.match(/regex\(\/\^\[a-f0-9\]\{64\}\$\/i\)/g) ?? [];
        // Three sha-256 fields in three Zod schemas.
        expect(shaPatterns.length).toBeGreaterThanOrEqual(3);
    });
    it("hashes are normalized to lowercase before service invocation", () => {
        const lowerCalls = ROUTES_SRC.match(/\.toLowerCase\(\)/g) ?? [];
        // expectedSha256, clientSha256, serverSha256 → at least 3 sites.
        expect(lowerCalls.length).toBeGreaterThanOrEqual(3);
    });
    it("abort.reason is bounded to <=120 chars (matches service slice)", () => {
        expect(ROUTES_SRC).toMatch(/reason:\s*z\.string\(\)\.min\(1\)\.max\(120\)/);
    });
    it("safeNote is bounded to <=400 chars (matches service slice)", () => {
        expect(ROUTES_SRC).toMatch(/safeNote:\s*z\.string\(\)\.max\(400\)/);
    });
    it("idempotencyKey is bounded to <=120 chars (matches service slice)", () => {
        expect(ROUTES_SRC).toMatch(/idempotencyKey:\s*z\.string\(\)\.min\(1\)\.max\(120\)/);
    });
    it("all body schemas are .strict() so unknown keys are rejected", () => {
        const strictCalls = ROUTES_SRC.match(/\.strict\(\)/g) ?? [];
        // Original 5 (CreateSession, MarkPartUploaded, MarkPartVerified,
        // Complete, Abort) + Phase 30.8's 3 (MultipartInitiate,
        // MultipartPresign, MultipartComplete). MultipartAbort reuses
        // AbortBodySchema — no new schema.
        expect(strictCalls.length).toBe(8);
    });
});
// =============================================================================
// PART 6 — Idempotency + state-machine contracts
// =============================================================================
describe("Phase 30.5 — idempotency + state-machine contracts", () => {
    it("create returns 200 on idempotent reuse, 201 on fresh insert", () => {
        expect(ROUTES_SRC).toMatch(/reply\.code\(result\.reused\s*\?\s*200\s*:\s*201\)/);
    });
    it("complete surfaces pendingPartIndices on completion_blocked_pending_parts", () => {
        expect(ROUTES_SRC).toMatch(/result\.pendingPartIndices[\s\S]*?\{\s*pendingPartIndices:\s*result\.pendingPartIndices\s*\}/);
    });
    it("status endpoint surfaces pendingPartCount + state (cheap probe)", () => {
        expect(ROUTES_SRC).toMatch(/pendingPartCount:\s*result\.pendingPartIndices\.length/);
    });
});
// =============================================================================
// PART 7 — Trusted server-side hash on /verified
// =============================================================================
describe("Phase 30.5 — verified path requires trusted server hash", () => {
    it("MarkPartVerifiedBodySchema requires serverSha256 (non-optional)", () => {
        const schema = ROUTES_SRC.match(/MarkPartVerifiedBodySchema\s*=\s*z[\s\S]*?\.strict\(\)/)?.[0];
        expect(schema).toBeTruthy();
        expect(schema).toMatch(/serverSha256:\s*z\.string\(\)\.regex\(\/\^\[a-f0-9\]\{64\}\$\/i\)/);
        // No .optional() / .nullable() on serverSha256.
        expect(schema).not.toMatch(/serverSha256[\s\S]*?\.optional\(\)/);
        expect(schema).not.toMatch(/serverSha256[\s\S]*?\.nullable\(\)/);
    });
    it("verified route requires evidence.create — never silently accepts contributor-only roles", () => {
        const block = ROUTES_SRC.match(/"\/v1\/uploads\/sessions\/:sessionId\/parts\/:partIndex\/verified"[\s\S]*?app\./)?.[0];
        expect(block).toBeTruthy();
        expect(block).toMatch(/permission:\s*"evidence\.create"/);
    });
});
// =============================================================================
// PART 8 — Route surface completeness
// =============================================================================
describe("Phase 30.5 — route surface is complete + bounded", () => {
    it("declares the original 7 Phase 30.5 routes (plus the 4 Phase 30.8 multipart routes)", () => {
        const declarations = ROUTES_SRC.match(/app\.(?:post|get)\(\s*"\/v1\/uploads\/sessions[^"]*"/g) ?? [];
        // 7 original routes + 4 multipart routes = 11.
        expect(declarations.length).toBe(11);
    });
    it("declares the canonical session path set", () => {
        for (const path of [
            '"/v1/uploads/sessions"',
            '"/v1/uploads/sessions/:sessionId"',
            '"/v1/uploads/sessions/:sessionId/status"',
            '"/v1/uploads/sessions/:sessionId/parts/:partIndex/uploaded"',
            '"/v1/uploads/sessions/:sessionId/parts/:partIndex/verified"',
            '"/v1/uploads/sessions/:sessionId/complete"',
            '"/v1/uploads/sessions/:sessionId/abort"',
        ]) {
            expect(ROUTES_SRC, `path ${path} missing`).toContain(path);
        }
    });
});
