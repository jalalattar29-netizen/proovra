/**
 * Phase 30.8 — S3 native multipart upload integration tests.
 *
 * Five layers of coverage:
 *
 *   1. **Schema** — SQL drift patch shape: new columns + indexes +
 *      constraints, idempotent re-runs, internal-only key columns.
 *
 *   2. **Storage abstraction** — `storage-multipart.ts` source contract:
 *      canonical key builder shape, bounded denial vocabulary,
 *      Object Lock defaults applied at CreateMultipartUpload time,
 *      ETag never treated as hash, presign expiry bounded, idempotent
 *      abort path, no raw S3 SDK errors leak.
 *
 *   3. **Service lifecycle** — `upload-session.service.ts` multipart
 *      helpers: state-machine guards, missing-ETag refusal, hash-
 *      mismatch path flips session to FAILED, reaper bounded, every
 *      mutation team-anchored.
 *
 *   4. **Routes** — anti-leak projections (no storageKey / storageBucket /
 *      multipartUploadId / etag-as-hash), bounded denial mapping,
 *      authorizeOrFail / requireApiKey on every new route, presigned
 *      URL response shape narrow.
 *
 *   5. **Custody invariants** — no custody event in multipart routes,
 *      uploadedAt never written by multipart code, ETag never used
 *      as serverSha256, finalize gate still authoritative.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  STORAGE_MULTIPART_LIFECYCLE_DENIAL_CODES,
  type StorageMultipartLifecycleDenialCode,
} from "../src/services/uploads/upload-session.service.js";
import {
  STORAGE_MULTIPART_DENIAL_CODES,
  buildMultipartStorageKey,
  type StorageMultipartDenialCode,
} from "../src/services/uploads/storage-multipart.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — SQL DRIFT PATCH
// =============================================================================

describe("Phase 30.8 — multipart SQL drift patch", () => {
  const sql = readSource(
    "../../../services/api/sql/drift-patches/2026-05-19-evidence-upload-multipart.sql",
  );

  it("uses BEGIN/COMMIT for partial-state safety", () => {
    expect(sql).toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).toMatch(/^\s*COMMIT\s*;/m);
  });

  it("adds multipart bookkeeping columns to evidence_upload_sessions (idempotent)", () => {
    for (const col of [
      "multipart_upload_id",
      "storage_bucket",
      "storage_key",
      "completed_object_etag",
      "completed_object_size",
      "completed_at_storage_utc",
      "aborted_at_storage_utc",
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `ADD COLUMN IF NOT EXISTS\\s+"${col}"`,
          "i",
        ),
      );
    }
  });

  it("adds part_etag + part_size_bytes + presign timestamps to evidence_upload_session_parts", () => {
    for (const col of [
      "part_etag",
      "part_size_bytes",
      "presigned_at_utc",
      "presign_expires_at_utc",
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `ADD COLUMN IF NOT EXISTS\\s+"${col}"`,
          "i",
        ),
      );
    }
  });

  it("creates unique (team_id, multipart_upload_id) index — prevents double-booking", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "evidence_upload_sessions_multipart_uk"[\s\S]*?\("team_id", "multipart_upload_id"\)[\s\S]*?WHERE "multipart_upload_id" IS NOT NULL/i,
    );
  });

  it("creates reaper index targeting only live unresolved multipart sessions", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "evidence_upload_sessions_multipart_reaper_idx"[\s\S]*?WHERE "multipart_upload_id" IS NOT NULL[\s\S]*?"completed_at_storage_utc" IS NULL[\s\S]*?"aborted_at_storage_utc" IS NULL/i,
    );
  });

  it("uses DO blocks for constraint existence checks (idempotent)", () => {
    expect(sql).toMatch(
      /DO \$\$[\s\S]*?SELECT 1 FROM pg_constraint[\s\S]*?conname = 'evidence_upload_sessions_completed_size_nonneg'/,
    );
  });

  it("documents that multipart_upload_id is internal-only", () => {
    expect(sql).toMatch(/multipart_upload_id[`\s]+is INTERNAL ONLY/i);
  });

  it("documents that ETag is NOT integrity proof", () => {
    expect(sql).toMatch(/integrity proof|NOT a hash|NOT.*custody-grade integrity/i);
  });
});

// =============================================================================
// PART 2 — STORAGE ABSTRACTION SOURCE CONTRACT
// =============================================================================

describe("Phase 30.8 — storage-multipart abstraction", () => {
  const src = readSource(
    "../../../services/api/src/services/uploads/storage-multipart.ts",
  );

  it("imports the multipart SDK commands (and only those)", () => {
    expect(src).toMatch(/CreateMultipartUploadCommand/);
    expect(src).toMatch(/UploadPartCommand/);
    expect(src).toMatch(/CompleteMultipartUploadCommand/);
    expect(src).toMatch(/AbortMultipartUploadCommand/);
    expect(src).toMatch(/HeadObjectCommand/);
  });

  it("does NOT issue any custody event from this file", () => {
    expect(src).not.toMatch(/appendCustody/);
    expect(src).not.toMatch(/CustodyEvent/);
  });

  it("does NOT set uploadedAt anywhere in storage code", () => {
    expect(src).not.toMatch(/uploadedAt\b/);
  });

  it("canonical key builder refuses non-UUID inputs (anti-path-traversal)", () => {
    expect(src).toMatch(
      /uuidRegex[\s\S]*?test\(input\.evidenceId\)[\s\S]*?test\(input\.sessionId\)/,
    );
    // Behavioral assertion: a bad input throws.
    expect(() =>
      buildMultipartStorageKey({
        evidenceId: "../etc/passwd",
        sessionId: "abc",
      }),
    ).toThrow();
  });

  it("canonical key has the expected stable shape", () => {
    const evidenceId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    expect(
      buildMultipartStorageKey({ evidenceId, sessionId }),
    ).toBe(`evidence/${evidenceId}/multipart/${sessionId}/object`);
  });

  it("bounded denial vocabulary is exhaustive + snake_case", () => {
    for (const required of [
      "storage_unavailable",
      "multipart_not_found",
      "invalid_part",
      "complete_failed",
      "head_failed",
      "hash_mismatch",
      "configuration_missing",
    ] as ReadonlyArray<StorageMultipartDenialCode>) {
      expect(STORAGE_MULTIPART_DENIAL_CODES).toContain(required);
    }
    for (const code of STORAGE_MULTIPART_DENIAL_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it("ETag is never assigned to a SHA-256 variable name", () => {
    // Defensive: catch any rename that conflates storage ETag with
    // custody hash. ETag must only appear next to `etag` /
    // `partEtag` / `completedObjectEtag` / S3 SDK names.
    const lines = src.split("\n");
    for (const line of lines) {
      if (/sha256|Sha256|SHA256/.test(line) && /etag|ETag/i.test(line)) {
        // Allow a single explicit comment that mentions both for
        // contrast — but not an assignment.
        expect(line, `mixed sha256+etag line: ${line}`).not.toMatch(
          /\b(sha256|serverSha256|clientSha256)\s*[:=]\s*.*[Ee][Tt]ag/,
        );
      }
    }
  });

  it("Object Lock defaults are attached at CreateMultipartUpload time (NOT at presign)", () => {
    expect(src).toMatch(
      /CreateMultipartUploadCommand\(\{[\s\S]*?\.\.\.objectLock[\s\S]*?\}\)/,
    );
    // UploadPartCommand must NOT carry Object Lock fields — those
    // belong on the create, not the part.
    expect(src).not.toMatch(
      /UploadPartCommand\(\{[\s\S]*?ObjectLockMode/,
    );
  });

  it("presign expiry is hard-capped at 900 seconds", () => {
    expect(src).toMatch(/Math\.min\(explicit,\s*900\)/);
    expect(src).toMatch(/Math\.min\(Math\.max\(fallback,\s*60\),\s*900\)/);
  });

  it("abort treats NoSuchUpload as idempotent success", () => {
    expect(src).toMatch(
      /name === "NoSuchUpload"[\s\S]*?ok:\s*true,\s*alreadyAbsent:\s*true/,
    );
  });

  it("complete returns multipart_not_found on NoSuchUpload (retriable signal)", () => {
    expect(src).toMatch(
      /completeMultipartUpload[\s\S]*?name === "NoSuchUpload"[\s\S]*?reason:\s*"multipart_not_found"/,
    );
  });

  it("verifyCompletedObject streams through SHA-256 + compares case-insensitively to expected", () => {
    expect(src).toMatch(/sha256HexFromStream/);
    expect(src).toMatch(
      /expectedSha256\.toLowerCase\(\)\s*!==\s*serverSha256\.toLowerCase\(\)/,
    );
  });

  it("part numbers are bounded to [1, 10000] per S3 contract", () => {
    expect(src).toMatch(/input\.partNumber < 1[\s\S]*?input\.partNumber > 10_000/);
  });

  it("complete sorts parts in ascending order (S3 requirement)", () => {
    expect(src).toMatch(
      /\.sort\(\(a, b\)\s*=>\s*a\.partNumber\s*-\s*b\.partNumber\)/,
    );
  });
});

// =============================================================================
// PART 3 — SERVICE LIFECYCLE SOURCE CONTRACT
// =============================================================================

describe("Phase 30.8 — upload-session multipart lifecycle", () => {
  const src = readSource(
    "../../../services/api/src/services/uploads/upload-session.service.ts",
  );

  it("exports five new lifecycle helpers", () => {
    for (const fn of [
      "initiateStorageMultipart",
      "presignStorageUploadPart",
      "recordPartEtag",
      "completeStorageMultipart",
      "abortStorageMultipart",
      "reapStaleMultipartUploads",
    ]) {
      expect(src).toMatch(
        new RegExp(`export async function ${fn}\\b`),
      );
    }
  });

  it("denial catalog includes both session + storage codes", () => {
    expect(STORAGE_MULTIPART_LIFECYCLE_DENIAL_CODES).toContain(
      "session_not_found" satisfies StorageMultipartLifecycleDenialCode,
    );
    expect(STORAGE_MULTIPART_LIFECYCLE_DENIAL_CODES).toContain(
      "multipart_already_initiated" satisfies StorageMultipartLifecycleDenialCode,
    );
    expect(STORAGE_MULTIPART_LIFECYCLE_DENIAL_CODES).toContain(
      "multipart_not_initiated" satisfies StorageMultipartLifecycleDenialCode,
    );
    expect(STORAGE_MULTIPART_LIFECYCLE_DENIAL_CODES).toContain(
      "missing_part_etag" satisfies StorageMultipartLifecycleDenialCode,
    );
  });

  it("initiateStorageMultipart is idempotent for sessions that already have an upload_id", () => {
    expect(src).toMatch(
      /if\s*\(session\.multipart_upload_id\)\s*\{[\s\S]*?storageBucket:\s*session\.storage_bucket/,
    );
  });

  it("initiateStorageMultipart cleans up S3 on DB persist failure", () => {
    // The catch path must call abortMultipartUpload to avoid
    // leaking a paid resource if the post-create UPDATE fails.
    expect(src).toMatch(
      /catch\s*\{[\s\S]*?await abortMultipartUpload\([\s\S]*?multipartUploadId:\s*storage\.multipartUploadId/,
    );
  });

  it("presign refuses if the session is not UPLOADING (no presigns from terminal sessions)", () => {
    expect(src).toMatch(
      /presignStorageUploadPart[\s\S]*?session\.state !== "UPLOADING"[\s\S]*?session_already_terminal/,
    );
  });

  it("presign refuses if multipart not initiated yet", () => {
    expect(src).toMatch(
      /presignStorageUploadPart[\s\S]*?!session\.multipart_upload_id[\s\S]*?multipart_not_initiated/,
    );
  });

  it("recordPartEtag rejects empty etag (missing_part_etag)", () => {
    expect(src).toMatch(
      /recordPartEtag[\s\S]*?!input\.etag\.trim\(\)[\s\S]*?missing_part_etag/,
    );
  });

  it("completeStorageMultipart refuses when ANY part is missing an ETag", () => {
    expect(src).toMatch(
      /missing = parts[\s\S]*?\.filter\(\(p\)\s*=>\s*!p\.part_etag/,
    );
    expect(src).toMatch(
      /missing\.length > 0[\s\S]*?reason:\s*"missing_part_etag"[\s\S]*?missingEtags:\s*missing/,
    );
  });

  it("completeStorageMultipart refuses on terminal session states", () => {
    expect(src).toMatch(
      /completeStorageMultipart[\s\S]*?session\.state === "COMPLETED"[\s\S]*?session_already_terminal/,
    );
  });

  it("hash mismatch in completeStorageMultipart flips session to FAILED + emits SecurityEvent", () => {
    expect(src).toMatch(
      /verify\.reason === "hash_mismatch"[\s\S]*?eventType:\s*"multipart_hash_mismatch"[\s\S]*?SET "state" = 'FAILED'/,
    );
  });

  it("abortStorageMultipart refuses to abort already-COMPLETED sessions", () => {
    expect(src).toMatch(
      /abortStorageMultipart[\s\S]*?session\.state === "COMPLETED"[\s\S]*?session_already_completed/,
    );
  });

  it("abortStorageMultipart uses server-side session row for bucket/key/uploadId (no client trust)", () => {
    expect(src).toMatch(
      /abortStorageMultipart[\s\S]*?bucket:\s*session\.storage_bucket[\s\S]*?key:\s*session\.storage_key[\s\S]*?multipartUploadId:\s*session\.multipart_upload_id/,
    );
  });

  it("reapStaleMultipartUploads is bounded to 100 rows + idempotent", () => {
    expect(src).toMatch(/reapStaleMultipartUploads[\s\S]*?LIMIT 100/);
    // Idempotent: a failed S3 abort doesn't crash the loop.
    expect(src).toMatch(
      /reapStaleMultipartUploads[\s\S]*?if\s*\(!result\.ok\)\s*\{[\s\S]*?failed \+= 1[\s\S]*?continue/,
    );
  });

  it("every multipart query is team-anchored (no cross-workspace reads)", () => {
    // Every multipart UPDATE / DELETE inside the file must include
    // team_id in the WHERE.
    const block = src.slice(src.indexOf("Phase 30.8"));
    const updates = block.match(/UPDATE\s+"evidence_upload_sessions"[\s\S]*?WHERE [^;]+/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      // The reaper UPDATE is per-row inside a JS loop and binds
      // team_id from the row — count both styles.
      expect(u, `UPDATE missing team_id: ${u.slice(0, 120)}…`).toMatch(
        /"team_id"\s*=\s*\$/,
      );
    }
  });

  it("storage helpers never directly write uploadedAt to Evidence (Phase 30.12 update)", () => {
    // Phase 30.12 added a `client.evidencePart.create()` bridge call
    // that DELIBERATELY OMITS uploadedAtUtc — the canonical
    // completeEvidence transaction sets it atomically with the
    // legacy parts. The original assertion's regex was too broad;
    // it would catch the doc-comment that explains the absence.
    // The tighter check: strip comments + look for an actual
    // `uploadedAtUtc:` or `uploadedAtUtc =` assignment.
    const block = src.slice(src.indexOf("Phase 30.8"));
    const noComments = block
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // No `uploadedAtUtc:` field assignment in executable code.
    expect(noComments).not.toMatch(/uploadedAtUtc\s*:\s*[a-zA-Z_]/);
    // No `uploadedAtUtc: now` (the legacy finalize pattern that
    // belongs only in completeEvidence).
    expect(noComments).not.toMatch(/uploadedAtUtc:\s*now/);
  });

  it("multipart helpers never emit custody events directly", () => {
    const block = src.slice(src.indexOf("Phase 30.8"));
    expect(block).not.toMatch(/appendCustody/);
    expect(block).not.toMatch(/CustodyEvent/);
  });
});

// =============================================================================
// PART 4 — WEB ROUTES SOURCE CONTRACT
// =============================================================================

describe("Phase 30.8 — multipart web routes", () => {
  const src = readSource(
    "../../../services/api/src/routes/upload-sessions.routes.ts",
  );

  it("declares the four canonical multipart routes", () => {
    for (const p of [
      '"/v1/uploads/sessions/:sessionId/multipart/initiate"',
      '"/v1/uploads/sessions/:sessionId/parts/:partIndex/presign"',
      '"/v1/uploads/sessions/:sessionId/multipart/complete"',
      '"/v1/uploads/sessions/:sessionId/multipart/abort"',
    ]) {
      expect(src, `path ${p} missing`).toContain(p);
    }
  });

  // Helper: locate the `app.post("<path>", ...)` invocation and
  // slice from there until the next `app.post(` (or end of file).
  // Comments are stripped so doc-strings don't trip anti-leak checks.
  function routeBlock(path: string): string {
    const marker = `"${path}"`;
    const pathIdx = src.indexOf(marker);
    expect(pathIdx, `path missing: ${path}`).toBeGreaterThan(-1);
    const start = src.lastIndexOf("app.post", pathIdx);
    expect(start, `no app.post before ${path}`).toBeGreaterThan(-1);
    const nextStart = src.indexOf("app.post", start + 1);
    const raw = src.slice(start, nextStart > -1 ? nextStart : src.length);
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  }

  it("every multipart route uses authorizeOrFail with antiEnumeration: true + evidence.create", () => {
    for (const p of [
      '/v1/uploads/sessions/:sessionId/multipart/initiate',
      '/v1/uploads/sessions/:sessionId/parts/:partIndex/presign',
      '/v1/uploads/sessions/:sessionId/multipart/complete',
      '/v1/uploads/sessions/:sessionId/multipart/abort',
    ]) {
      const block = routeBlock(p);
      expect(block, `${p} missing authorizeOrFail`).toMatch(
        /await authorizeOrFail\(/,
      );
      expect(block, `${p} missing antiEnumeration`).toMatch(
        /antiEnumeration:\s*true/,
      );
      expect(block, `${p} missing evidence.create permission`).toMatch(
        /permission:\s*"evidence\.create"/,
      );
    }
  });

  it("initiate response NEVER projects storage key / bucket / uploadId", () => {
    const block = routeBlock("/v1/uploads/sessions/:sessionId/multipart/initiate");
    for (const banned of [
      "storageBucket",
      "storage_bucket",
      "storageKey",
      "storage_key",
      "multipartUploadId",
      "multipart_upload_id",
    ]) {
      expect(block, `initiate leaks ${banned}`).not.toContain(banned);
    }
  });

  it("presign response has the bounded safe shape (uploadUrl, method, expiresAt, partIndex)", () => {
    const block = routeBlock("/v1/uploads/sessions/:sessionId/parts/:partIndex/presign");
    expect(block).toMatch(/uploadUrl:\s*result\.uploadUrl/);
    expect(block).toMatch(/method:\s*result\.method/);
    expect(block).toMatch(/expiresAt:\s*result\.expiresAt/);
    expect(block).toMatch(/partIndex:\s*result\.partIndex/);
    expect(block).not.toContain("storage_bucket");
    expect(block).not.toContain("multipart_upload_id");
  });

  it("complete response surfaces etag + contentLength + serverSha256 only", () => {
    const block = routeBlock("/v1/uploads/sessions/:sessionId/multipart/complete");
    expect(block).toMatch(/etag:\s*result\.etag/);
    expect(block).toMatch(/contentLength:\s*result\.contentLength/);
    expect(block).toMatch(/serverSha256:\s*result\.serverSha256/);
    expect(block).not.toContain("storage_bucket");
    expect(block).not.toContain("multipart_upload_id");
  });

  it("complete surfaces missingPartIndices on missing_part_etag for actionable UI", () => {
    expect(src).toMatch(
      /missingPartIndices:\s*result\.missingEtags/,
    );
  });

  it("statusForDenial maps multipart codes to bounded HTTP statuses", () => {
    for (const code of [
      "multipart_not_found",
      "storage_unavailable",
      "configuration_missing",
      "invalid_part",
      "missing_part_etag",
      "complete_failed",
      "head_failed",
      "multipart_already_initiated",
      "multipart_not_initiated",
    ]) {
      expect(src).toContain(`"${code}"`);
    }
  });

  it("the routes file never projects the storage column / S3 upload id in code", () => {
    // Strip comments so doc-strings about anti-leak don't trip
    // their own assertions.
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const body = noComments.slice(
      noComments.indexOf("export async function uploadSessionsRoutes"),
    );
    expect(body).not.toMatch(/multipart_upload_id/);
    expect(body).not.toMatch(/multipartUploadId/);
  });
});

// =============================================================================
// PART 5 — API-KEY ROUTES SOURCE CONTRACT
// =============================================================================

describe("Phase 30.8 — multipart API-key routes", () => {
  const src = readSource(
    "../../../services/api/src/routes/integrations-uploads.routes.ts",
  );

  it("declares the four canonical API-key multipart routes", () => {
    for (const p of [
      '"/v1/integrations/api/uploads/sessions/:sessionId/multipart/initiate"',
      '"/v1/integrations/api/uploads/sessions/:sessionId/parts/:partIndex/presign"',
      '"/v1/integrations/api/uploads/sessions/:sessionId/multipart/complete"',
      '"/v1/integrations/api/uploads/sessions/:sessionId/multipart/abort"',
    ]) {
      expect(src, `path ${p} missing`).toContain(p);
    }
  });

  // The API-key file has multiple "Phase 30.8" mentions (the
  // markPartUploaded etag wiring inside the existing route).
  // Anchor on the section header instead.
  const apiMultipartSectionStart = src.indexOf(
    "Phase 30.8 — API-key S3 NATIVE MULTIPART ROUTES",
  );

  it("API-key file contains the dedicated multipart routes section", () => {
    expect(apiMultipartSectionStart).toBeGreaterThan(-1);
  });

  it("every multipart route requires requireApiKey + integration.evidence.upload scope", () => {
    const block = src.slice(apiMultipartSectionStart);
    const audits = block.match(/runWithApiAudit\(req,\s*reply,\s*"multipart\.\w+"/g) ?? [];
    expect(audits.length).toBe(4);
    const apiKeyCalls = block.match(/await requireApiKey\(req, reply\)/g) ?? [];
    expect(apiKeyCalls.length).toBe(4);
    const scopeCalls = block.match(
      /requireApiScope\(req,\s*reply,\s*"integration\.evidence\.upload"\)/g,
    ) ?? [];
    expect(scopeCalls.length).toBe(4);
  });

  it("teamId always sourced from cred.teamId — never body / query / path", () => {
    const block = src.slice(apiMultipartSectionStart);
    const serviceCalls = block.match(
      /(initiateStorageMultipart|presignStorageUploadPart|completeStorageMultipart|abortStorageMultipart)\(\{[\s\S]*?\}\)/g,
    ) ?? [];
    expect(serviceCalls.length).toBe(4);
    for (const call of serviceCalls) {
      expect(call).toMatch(/teamId:\s*cred\.teamId/);
      expect(call).not.toMatch(/teamId:\s*body\./);
    }
  });

  it("API responses NEVER project storage_bucket / storage_key / multipart_upload_id", () => {
    const block = src
      .slice(apiMultipartSectionStart)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageBucket",
      "storage_bucket",
      "storageKey",
      "storage_key",
      "multipartUploadId",
      "multipart_upload_id",
    ]) {
      expect(block, `API multipart routes leak ${banned}`).not.toContain(
        banned,
      );
    }
  });

  it("every API multipart response carries requestId", () => {
    const block = src.slice(apiMultipartSectionStart);
    const requestIds = block.match(/requestId:\s*req\.id\s*\?\?\s*null/g) ?? [];
    // 4 success responses, each with requestId.
    expect(requestIds.length).toBeGreaterThanOrEqual(4);
  });
});

// =============================================================================
// PART 6 — CUSTODY & INTEGRITY INVARIANTS
// =============================================================================

describe("Phase 30.8 — custody / integrity invariants", () => {
  const serviceSrc = readSource(
    "../../../services/api/src/services/uploads/upload-session.service.ts",
  );
  const routesSrc = readSource(
    "../../../services/api/src/routes/upload-sessions.routes.ts",
  );
  const apiRoutesSrc = readSource(
    "../../../services/api/src/routes/integrations-uploads.routes.ts",
  );
  const storageSrc = readSource(
    "../../../services/api/src/services/uploads/storage-multipart.ts",
  );

  it("multipart routes NEVER emit custody events directly", () => {
    for (const [name, src] of [
      ["web routes", routesSrc],
      ["api routes", apiRoutesSrc],
      ["storage", storageSrc],
    ] as const) {
      expect(src, `${name} leaks appendCustody`).not.toMatch(/appendCustody/);
      expect(src, `${name} references CustodyEvent`).not.toMatch(
        /CustodyEventType/,
      );
    }
  });

  it("multipart routes NEVER write the authoritative Evidence.uploadedAt field", () => {
    // The legacy `clientUploadedAtUtc` audit field is permitted —
    // it captures the client's claim, NOT the authoritative server
    // clock that completeEvidence sets on the Evidence row. We
    // verify only that no multipart code path mutates the canonical
    // Evidence.uploadedAt field directly.
    for (const [name, src] of [
      ["web routes", routesSrc],
      ["api routes", apiRoutesSrc],
      ["storage", storageSrc],
    ] as const) {
      // The Evidence row's uploadedAt setter is `uploadedAtUtc: now`
      // (server clock) — that's the pattern from evidence-complete.
      // Multipart code must never emit that pattern.
      expect(src, `${name} writes Evidence uploadedAtUtc`).not.toMatch(
        /uploadedAtUtc\s*:\s*now/,
      );
      // Also never directly write an evidence.uploadedAtUtc.
      expect(src, `${name} mutates Evidence.uploadedAtUtc`).not.toMatch(
        /evidence\.uploadedAtUtc/i,
      );
    }
  });

  it("completeStorageMultipart does NOT flip session.state to COMPLETED (gate stays authoritative)", () => {
    // The function persists storage metadata only. State flip
    // belongs to completeUploadSession() → finalize gate.
    const completeBlock = serviceSrc.match(
      /completeStorageMultipart\([\s\S]*?^export /m,
    )?.[0];
    expect(completeBlock).toBeTruthy();
    // No SET "state" = 'COMPLETED' anywhere in this block.
    expect(completeBlock!).not.toMatch(
      /SET\s+"state"\s*=\s*'COMPLETED'/,
    );
  });

  it("ETag is stored as storage metadata only — never compared as hash", () => {
    // The only place ETag/SHA-256 should co-mingle is in defensive
    // comments. No `=== etag` against a sha256 var anywhere.
    expect(storageSrc).not.toMatch(
      /sha256\w*\s*===\s*\w*[Ee][Tt]ag/,
    );
    expect(storageSrc).not.toMatch(
      /\w*[Ee][Tt]ag\s*===\s*sha256/,
    );
    // ETag is also never written into a server_sha256 column.
    expect(serviceSrc).not.toMatch(
      /"server_sha256"\s*=[^,;]*etag/i,
    );
  });

  it("expected_sha256 is compared via verifyCompletedObject → sha256HexFromStream (NOT ETag)", () => {
    expect(storageSrc).toMatch(
      /verifyCompletedObject[\s\S]*?sha256HexFromStream/,
    );
  });

  it("hash mismatch refuses to mark VERIFIED + flips session to FAILED", () => {
    expect(serviceSrc).toMatch(
      /verify\.reason === "hash_mismatch"[\s\S]*?SET "state" = 'FAILED'/,
    );
  });

  it("finalize gate from Phase 30.7 still gates evidence completion", () => {
    const completeSrc = readSource(
      "../../../services/api/src/services/evidence-complete.service.ts",
    );
    expect(completeSrc).toMatch(/evaluateUploadSessionFinalizeGate/);
  });

  it("missing_part_etag refuses to call S3 CompleteMultipartUpload (no completion on partial state)", () => {
    expect(serviceSrc).toMatch(
      /missing\.length > 0[\s\S]*?reason:\s*"missing_part_etag"/,
    );
    // The S3 call site must be AFTER the missing-check.
    const block = serviceSrc.slice(serviceSrc.indexOf("completeStorageMultipart"));
    const missingIdx = block.indexOf('reason: "missing_part_etag"');
    const s3CallIdx = block.indexOf("completeMultipartUpload({");
    expect(missingIdx).toBeGreaterThan(-1);
    expect(s3CallIdx).toBeGreaterThan(-1);
    expect(missingIdx).toBeLessThan(s3CallIdx);
  });
});

// =============================================================================
// PART 7 — OBSERVABILITY CATALOGS
// =============================================================================

describe("Phase 30.8 — observability catalogs", () => {
  it("metrics catalog registers the new multipart counters", () => {
    const src = readSource(
      "../../../services/api/src/services/ops/metrics.service.ts",
    );
    for (const m of [
      "multipart_initiated_total",
      "multipart_presign_part_total",
      "multipart_part_marked_uploaded_total",
      "multipart_completed_total",
      "multipart_aborted_total",
      "multipart_abort_failed_total",
      "multipart_complete_failed_total",
      "multipart_head_failed_total",
      "multipart_verify_failed_total",
      "multipart_stale_cleanup_total",
    ]) {
      expect(src, `counter ${m} missing`).toContain(`"${m}"`);
    }
    for (const g of [
      "multipart_stale_scanned",
      "multipart_stale_aborted",
      "multipart_stale_failed",
    ]) {
      expect(src, `gauge ${g} missing`).toContain(`"${g}"`);
    }
  });

  it("SecurityEvent catalog registers the new multipart events", () => {
    const src = readSource("../../../packages/shared/src/security.ts");
    for (const e of [
      "multipart_initiate_failed",
      "multipart_complete_failed",
      "multipart_head_failed",
      "multipart_hash_mismatch",
      "multipart_abort_failed",
    ]) {
      expect(src, `event ${e} missing`).toContain(`"${e}"`);
    }
  });

  it("runtime-readiness registers multipart_storage subsystem", () => {
    const src = readSource(
      "../../../services/api/src/runtime/runtime-readiness.ts",
    );
    expect(src).toMatch(/\| "multipart_storage"/);
    expect(src).toMatch(/checkMultipartStorage/);
    expect(src).toMatch(
      /checkMultipartStorage\([\s\S]*?\)/,
    );
    // The aggregator must invoke it.
    expect(src).toMatch(
      /Promise\.all\(\[[\s\S]*?checkMultipartStorage\(prisma\)/,
    );
  });

  it("multipart_storage check reports CRITICAL when S3_BUCKET is missing", () => {
    const src = readSource(
      "../../../services/api/src/runtime/runtime-readiness.ts",
    );
    expect(src).toMatch(
      /!envPresent\("S3_BUCKET"\)[\s\S]*?status:\s*"CRITICAL"[\s\S]*?reasonCode:\s*"s3_bucket_missing"/,
    );
  });

  it("schema validation registers the new critical multipart columns", () => {
    const src = readSource(
      "../../../services/api/src/runtime/schema-validation.ts",
    );
    for (const col of [
      "multipart_upload_id",
      "storage_bucket",
      "storage_key",
      "part_etag",
    ]) {
      expect(src, `column ${col} not registered`).toMatch(
        new RegExp(`column:\\s*"${col}",\\s*severity:\\s*"critical"`),
      );
    }
    expect(src).toMatch(
      /indexName:\s*"evidence_upload_sessions_multipart_uk"/,
    );
  });
});

// =============================================================================
// PART 8 — REAPER WIRING
// =============================================================================

describe("Phase 30.8 — reaper wired into reconcile", () => {
  const opsSrc = readSource(
    "../../../services/api/src/routes/ops.routes.ts",
  );

  it("runMasterReconcile invokes reapStaleMultipartUploads", () => {
    expect(opsSrc).toMatch(/reapStaleMultipartUploads/);
  });

  it("reaper failure does NOT crash the reconcile (best-effort)", () => {
    expect(opsSrc).toMatch(
      /reapStaleMultipartUploads[\s\S]*?\}\s*catch\s*\{[\s\S]*?\}/,
    );
  });

  it("reaper publishes scanned / aborted / failed gauges", () => {
    expect(opsSrc).toMatch(
      /setGauge\(\s*"multipart_stale_scanned",/,
    );
    expect(opsSrc).toMatch(
      /setGauge\(\s*"multipart_stale_aborted",/,
    );
    expect(opsSrc).toMatch(
      /setGauge\(\s*"multipart_stale_failed",/,
    );
  });
});

// =============================================================================
// PART 9 — TYPE-LEVEL INVARIANTS
// =============================================================================

describe("Phase 30.8 — type-level invariants", () => {
  it("STORAGE_MULTIPART_LIFECYCLE_DENIAL_CODES is bounded + snake_case", () => {
    for (const code of STORAGE_MULTIPART_LIFECYCLE_DENIAL_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it("buildMultipartStorageKey accepts uppercase hex UUIDs (case-insensitive)", () => {
    const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    expect(() =>
      buildMultipartStorageKey({
        evidenceId: upper,
        sessionId: upper,
      }),
    ).not.toThrow();
  });

  it("buildMultipartStorageKey rejects empty / non-UUID inputs", () => {
    expect(() =>
      buildMultipartStorageKey({ evidenceId: "", sessionId: "" }),
    ).toThrow();
    expect(() =>
      buildMultipartStorageKey({
        evidenceId: "not-a-uuid",
        sessionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow();
  });
});
