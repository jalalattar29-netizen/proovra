/**
 * Phase 30.6 — API-key ingestion upload routes source-contract tests.
 *
 * The API-key route surface mirrors the operator/web surface but
 * uses Bearer API key auth instead of session auth. These tests
 * prove the route file enforces the hard contracts in the brief:
 *
 *   1. Every route gated by `requireApiKey` + `requireApiScope` +
 *      `runWithApiAudit`.
 *   2. Mutating routes require the new `integration.evidence.upload`
 *      scope (not `integration.evidence.create` — separation of
 *      concerns). The GET uses `integration.evidence.read`.
 *   3. `idempotencyKey` is REQUIRED (non-optional) on the API-key
 *      session-create path.
 *   4. Workspace governance gate runs BEFORE session creation: the
 *      target evidence row must exist in the caller's team, not be
 *      archived, and not be under an active legal hold.
 *   5. The /verified path is OPERATOR-ONLY — it does NOT appear in
 *      this routes file. API-key clients cannot self-attest server-
 *      side hash verification of their own bytes.
 *   6. Anti-leak: NO storage keys / signed URLs / multipart upload
 *     IDs / ETags / safeNote / abortReason / actorUserId in any
 *     projected response.
 *   7. Every response carries `requestId` for traceability.
 *   8. 404 + 503 + 422 + 409 + 400 statuses map deterministically
 *     from the bounded denial vocabulary.
 *   9. Anti-enumeration: cross-team evidence / sessions return 404
 *      not_found, never a 403 probe surface.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTES_SRC = readSource(
  "../../../services/api/src/routes/integrations-uploads.routes.ts",
);
const SERVER_SRC = readSource("../../../services/api/src/server.ts");
const PERMISSIONS_SRC = readSource(
  "../../../packages/shared/src/permissions.ts",
);
const IDENTITY_SRC = readSource("../../../packages/shared/src/identity.ts");
const METRICS_SRC = readSource(
  "../../../packages/shared-runtime/src/ops/metrics.service.ts",
);

// =============================================================================
// PART 0 — Routes are mounted
// =============================================================================

describe("Phase 30.6 — integrations-uploads routes are mounted", () => {
  it("server.ts imports + registers integrationsUploadsRoutes", () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{\s*integrationsUploadsRoutes\s*\}\s*from\s+"\.\/routes\/integrations-uploads\.routes\.js"/,
    );
    expect(SERVER_SRC).toMatch(
      /app\.register\(\s*integrationsUploadsRoutes\s*\)/,
    );
  });
});

// =============================================================================
// PART 1 — New scope is catalogued
// =============================================================================

describe("Phase 30.6 — integration.evidence.upload scope is catalogued", () => {
  it("permissions catalog declares the new scope", () => {
    expect(PERMISSIONS_SRC).toContain('"integration.evidence.upload"');
  });

  it("ADMIN role inherits the new scope", () => {
    // ADMIN block in ROLE_PERMISSIONS — search for the scope appearing
    // inside the ADMIN array.
    const adminBlock = PERMISSIONS_SRC.match(
      /ADMIN:\s*\[[\s\S]*?\],/,
    )?.[0];
    expect(adminBlock).toBeTruthy();
    expect(adminBlock!).toContain('"integration.evidence.upload"');
  });

  it("INTEGRATION_ADMIN delegated scope includes the new scope", () => {
    const block = IDENTITY_SRC.match(
      /INTEGRATION_ADMIN:\s*\[[\s\S]*?\],/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toContain('"integration.evidence.upload"');
  });
});

// =============================================================================
// PART 2 — Auth + scope gating on every route
// =============================================================================

describe("Phase 30.6 — auth + scope on every route", () => {
  // Phase 30.8 added 4 multipart API-key routes — 5 original + 4 = 9.
  const TOTAL_API_ROUTES = 9;

  it("every route handler calls requireApiKey, requireApiScope, runWithApiAudit", () => {
    const handlers = ROUTES_SRC.match(
      /app\.(?:post|get)\(\s*"[^"]+"[\s\S]*?\}\s*,?\s*\)\s*;/g,
    ) ?? [];
    expect(handlers.length).toBe(TOTAL_API_ROUTES);
    for (const handler of handlers) {
      expect(handler).toMatch(/requireApiKey\(req,\s*reply\)/);
      expect(handler).toMatch(/requireApiScope\(req,\s*reply,/);
      expect(handler).toMatch(/runWithApiAudit\(req,\s*reply,/);
    }
  });

  it("session-create + parts/uploaded + complete + abort + 4 multipart routes require integration.evidence.upload", () => {
    // Original 4 mutating routes + 4 multipart routes = 8.
    const uploads = ROUTES_SRC.match(
      /requireApiScope\(req,\s*reply,\s*"integration\.evidence\.upload"\)/g,
    ) ?? [];
    expect(uploads.length).toBe(8);
  });

  it("GET session uses integration.evidence.read", () => {
    expect(ROUTES_SRC).toMatch(
      /requireApiScope\(req,\s*reply,\s*"integration\.evidence\.read"\)/,
    );
  });

  it("NEVER references operator-only verified scope route", () => {
    // Strip comments so doc-strings naming the absent route don't
    // trip the assertion.
    const noComments = ROUTES_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(noComments).not.toMatch(/\/verified["'`]/);
    expect(noComments).not.toMatch(/markPartVerified/);
  });
});

// =============================================================================
// PART 3 — Idempotency required on API-key path
// =============================================================================

describe("Phase 30.6 — idempotency required on API-key path", () => {
  it("CreateSessionBodySchema declares idempotencyKey as non-optional", () => {
    const schema = ROUTES_SRC.match(
      /CreateSessionBodySchema\s*=\s*z[\s\S]*?\.strict\(\)/,
    )?.[0];
    expect(schema).toBeTruthy();
    // The key must be present + must NOT be marked optional / nullable.
    expect(schema!).toMatch(
      /idempotencyKey:\s*z\.string\(\)\.min\(1\)\.max\(120\)/,
    );
    // Narrow check: only the idempotencyKey line itself. The schema
    // now has other fields with .optional() (Phase 30.12 bridge
    // metadata: targetPartIndex / originalFileName /
    // expectedMimeType), so a greedy `[\s\S]*?` would false-positive.
    const idempotencyLine = schema!.match(
      /idempotencyKey:\s*[^,\n]+/,
    )?.[0];
    expect(idempotencyLine).toBeTruthy();
    expect(idempotencyLine!).not.toMatch(/\.optional\(\)/);
    expect(idempotencyLine!).not.toMatch(/\.nullable\(\)/);
  });

  it("idempotencyKey is forwarded straight to the service (no synthetic fallback)", () => {
    expect(ROUTES_SRC).toMatch(/idempotencyKey:\s*body\.idempotencyKey/);
  });
});

// =============================================================================
// PART 4 — Workspace governance gate
// =============================================================================

describe("Phase 30.6 — workspace governance gate before session creation", () => {
  it("imports isUnderActiveLegalHold from governance service", () => {
    expect(ROUTES_SRC).toMatch(
      /import\s*\{\s*isUnderActiveLegalHold\s*\}\s*from\s+"\.\.\/services\/governance\.service\.js"/,
    );
  });

  it("create route loads evidence + checks teamId match before service call", () => {
    expect(ROUTES_SRC).toMatch(/prisma\.evidence\.findUnique/);
    expect(ROUTES_SRC).toMatch(/evidence\.teamId\s*!==\s*input\.teamId/);
  });

  it("create route refuses archived evidence (403 evidence_archived)", () => {
    expect(ROUTES_SRC).toMatch(/code:\s*"evidence_archived"/);
  });

  it("create route refuses evidence under active legal hold (403 blocked_by_legal_hold)", () => {
    expect(ROUTES_SRC).toMatch(/code:\s*"blocked_by_legal_hold"/);
    expect(ROUTES_SRC).toMatch(/await isUnderActiveLegalHold\(/);
  });

  it("gate runs BEFORE createUploadSession (governance can never be bypassed)", () => {
    // Source-level ordering check: gateEvidenceForUpload should
    // appear before createUploadSession in the create handler.
    // Both must be in the file AND the gate must appear at a
    // lower offset than the service call.
    const gateIdx = ROUTES_SRC.indexOf("await gateEvidenceForUpload");
    const createIdx = ROUTES_SRC.indexOf("await createUploadSession");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(createIdx);
  });

  it("anti-enumeration: cross-team / not-existing evidence both surface as 404 not_found", () => {
    expect(ROUTES_SRC).toMatch(
      /status:\s*404,\s*code:\s*"not_found"/,
    );
  });
});

// =============================================================================
// PART 5 — requestId in every response
// =============================================================================

describe("Phase 30.6 — every response carries requestId", () => {
  it("the central sendDenial helper includes requestId in both branches", () => {
    const helper = ROUTES_SRC.match(
      /function\s+sendDenial\([\s\S]*?\n\}/,
    )?.[0];
    expect(helper).toBeTruthy();
    // The helper has two send sites (404 + non-404); both must
    // reference requestId. Count occurrences to prove both branches
    // are covered, not just one.
    const occurrences = (helper!.match(/requestId/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("every success reply in the handlers carries requestId", () => {
    // Each of the 5 routes sends a success body containing
    // `requestId: req.id ?? null`. The gate-denial branch carries
    // its own `requestId: req.id ?? null`. (sendDenial's helper
    // uses a `const requestId` capture + object shorthand, so it
    // is covered by its own assertion above.)
    const occurrences =
      ROUTES_SRC.match(/requestId:\s*req\.id\s*\?\?\s*null/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(6);
  });

  it("the governance-gate denial response carries requestId", () => {
    // Grab the gate-denial handler block (from `if (!gate.ok)` to
    // its closing brace) and verify requestId appears inside.
    const block = ROUTES_SRC.match(
      /if\s*\(!gate\.ok\)\s*\{[\s\S]*?\n\s*\}/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block!).toMatch(/requestId/);
  });

  it("requestId is sourced from req.id (Fastify auto-generated)", () => {
    expect(ROUTES_SRC).toMatch(/req\.id\s*\?\?\s*null/);
  });
});

// =============================================================================
// PART 6 — Bounded denial mapping
// =============================================================================

describe("Phase 30.6 — bounded denial mapping", () => {
  it("statusForDenial maps the full vocabulary", () => {
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
      expect(ROUTES_SRC, `code ${code} not mapped`).toContain(`"${code}"`);
    }
  });

  it("404 responses use the canonical anti-enumeration shape", () => {
    expect(ROUTES_SRC).toMatch(
      /reply\s*\n?\s*\.code\(404\)[\s\S]*?\{\s*error:\s*\{\s*code:\s*"not_found"\s*\}/,
    );
  });

  it("non-404 denials carry the bounded upload_session_denied envelope", () => {
    expect(ROUTES_SRC).toMatch(
      /code:\s*"upload_session_denied",\s*reason\b/,
    );
  });
});

// =============================================================================
// PART 7 — Anti-leak invariants
// =============================================================================

describe("Phase 30.6 — anti-leak invariants on API-key projections", () => {
  const noComments = ROUTES_SRC
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("no storage keys / signed URLs / bucket identifiers / multipart upload IDs", () => {
    // Phase 30.8 explicitly surfaces `etag` (storage metadata) +
    // `uploadUrl` (short-lived presigned URL) on the multipart
    // complete + presign responses. Those are SEPARATE concerns,
    // covered by the Phase 30.8 anti-leak tests. The Phase 30.6
    // anti-leak still forbids storage_key/bucket identifiers and
    // the internal multipart upload id.
    for (const banned of [
      "storageKey",
      "storage_key",
      "signed_url",
      "signedUrl",
      "presignedUrl",
      "bucketName",
      "s3Key",
      "objectKey",
      "multipartUploadId",
    ]) {
      expect(noComments, `routes leak ${banned}`).not.toContain(banned);
    }
  });

  it("projectSessionForApi strips actorUserId, abortedByUserId, teamId, abortReason, safeNote", () => {
    const fn = ROUTES_SRC.match(
      /function\s+projectSessionForApi\([\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    // Strip comments — the function intentionally documents what
    // it does NOT project, and those names must not trip the test.
    const body = fn!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const stripped of [
      "actorUserId",
      "abortedByUserId",
      "teamId",
      "abortReason",
      "safeNote",
    ]) {
      expect(body, `${stripped} leaks in API projection`).not.toContain(
        stripped,
      );
    }
  });

  it("projectPartForApi strips sessionId, teamId, failureReason, uploadedAtUtcClient", () => {
    const fn = ROUTES_SRC.match(
      /function\s+projectPartForApi\([\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    const body = fn!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const stripped of [
      "sessionId",
      "teamId",
      "failureReason",
      "uploadedAtUtcClient",
    ]) {
      expect(body, `${stripped} leaks in API part projection`).not.toContain(
        stripped,
      );
    }
  });

  it("no banned wording (tamper / forged / altered evidence) in route source", () => {
    const banned =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    expect(noComments).not.toMatch(banned);
  });
});

// =============================================================================
// PART 8 — Service-account actor + audit trail
// =============================================================================

describe("Phase 30.6 — service-account actor + audit", () => {
  it("createUploadSession uses cred.credentialId as actorUserId (never a client-supplied id)", () => {
    expect(ROUTES_SRC).toMatch(
      /createUploadSession\(\{[\s\S]*?actorUserId:\s*cred\.credentialId/,
    );
  });

  it("abortUploadSession uses cred.credentialId as actorUserId", () => {
    expect(ROUTES_SRC).toMatch(
      /abortUploadSession\(\{[\s\S]*?actorUserId:\s*cred\.credentialId/,
    );
  });

  it("teamId always sourced from req.apiCredential.teamId — never from body / query / path", () => {
    // The credential is the team source of truth — every service
    // invocation should read teamId off the credential, not off
    // user input.
    const serviceCalls = ROUTES_SRC.match(
      /(createUploadSession|resumeUploadSession|markPartUploaded|completeUploadSession|abortUploadSession)\(\{[\s\S]*?\}\)/g,
    ) ?? [];
    // 5 original session service calls. Multipart service calls are
    // a separate vocabulary asserted by Phase 30.8 tests.
    expect(serviceCalls.length).toBe(5);
    for (const call of serviceCalls) {
      expect(call).toMatch(/teamId:\s*cred\.teamId/);
      expect(call).not.toMatch(/teamId:\s*body\./);
      expect(call).not.toMatch(/teamId:\s*req\.body/);
    }
  });

  it("every audit action is bounded snake_case (no PII / no free-text)", () => {
    const actions = ROUTES_SRC.match(
      /runWithApiAudit\(req,\s*reply,\s*"([^"]+)"/g,
    ) ?? [];
    // 5 original + 4 multipart = 9.
    expect(actions.length).toBe(9);
    for (const a of actions) {
      // Each action label must be lowercase + dot/underscore only.
      expect(a).toMatch(/"[a-z][a-z0-9_.]*"/);
    }
  });
});

// =============================================================================
// PART 9 — Input validation
// =============================================================================

describe("Phase 30.6 — input validation", () => {
  it("evidenceId is a UUID at the route level", () => {
    expect(ROUTES_SRC).toMatch(
      /evidenceId:\s*z\.string\(\)\.uuid\(\)/,
    );
  });

  it("expectedPartCount + expectedTotalBytes match the service bounds (defense in depth)", () => {
    expect(ROUTES_SRC).toMatch(
      /expectedPartCount:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\(10_000\)/,
    );
    expect(ROUTES_SRC).toMatch(/expectedTotalBytes[\s\S]*?50\s*\*\s*1024\s*\*\*\s*3/);
  });

  it("hashes enforce 64-hex regex + lowercase normalization", () => {
    expect(
      (ROUTES_SRC.match(/regex\(\/\^\[a-f0-9\]\{64\}\$\/i\)/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    expect((ROUTES_SRC.match(/\.toLowerCase\(\)/g) ?? []).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("partIndex coerced + bounded to [0, 9_999]", () => {
    expect(ROUTES_SRC).toMatch(
      /partIndex:\s*z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(9_999\)/,
    );
  });

  it("abort reason bounded to <= 120 chars (matches service slice)", () => {
    expect(ROUTES_SRC).toMatch(
      /reason:\s*z\.string\(\)\.min\(1\)\.max\(120\)/,
    );
  });

  it("body schemas are .strict() (reject unknown keys)", () => {
    const strictCount = (ROUTES_SRC.match(/\.strict\(\)/g) ?? []).length;
    // Phase 30.6: CreateSession + MarkPartUploaded + Abort = 3.
    // Phase 30.8: MultipartInitiateApi + MultipartPresignApi +
    // MultipartCompleteApi = 3 (multipart abort reuses AbortBodySchema).
    expect(strictCount).toBe(6);
  });
});

// =============================================================================
// PART 10 — Metric catalog registration
// =============================================================================

describe("Phase 30.6 — metric counters registered + bumped", () => {
  it("metric catalog registers the new route-level counters", () => {
    expect(METRICS_SRC).toContain('"upload_session_route_created_total"');
    expect(METRICS_SRC).toContain('"upload_session_route_completed_total"');
  });

  it("API-key routes bump created counter on session creation", () => {
    expect(ROUTES_SRC).toContain(
      'bump("upload_session_route_created_total")',
    );
  });

  it("API-key routes bump completed counter on session completion", () => {
    expect(ROUTES_SRC).toContain(
      'bump("upload_session_route_completed_total")',
    );
  });
});

// =============================================================================
// PART 11 — Route surface completeness
// =============================================================================

describe("Phase 30.6 — API-key routes declared", () => {
  it("declares the canonical /v1/integrations/api/uploads/* path set", () => {
    for (const path of [
      '"/v1/integrations/api/uploads/sessions"',
      '"/v1/integrations/api/uploads/sessions/:sessionId"',
      '"/v1/integrations/api/uploads/sessions/:sessionId/parts/:partIndex/uploaded"',
      '"/v1/integrations/api/uploads/sessions/:sessionId/complete"',
      '"/v1/integrations/api/uploads/sessions/:sessionId/abort"',
    ]) {
      expect(ROUTES_SRC, `${path} missing`).toContain(path);
    }
  });

  it("Phase 30.6 surface is 5 routes + Phase 30.8 adds 4 multipart routes (no /verified, no /status)", () => {
    const declarations = ROUTES_SRC.match(
      /app\.(?:post|get)\(\s*"\/v1\/integrations\/api\/uploads\/[^"]*"/g,
    ) ?? [];
    // 5 original + 4 multipart = 9.
    expect(declarations.length).toBe(9);
  });
});
