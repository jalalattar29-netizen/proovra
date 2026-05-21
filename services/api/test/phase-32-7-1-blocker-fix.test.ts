/**
 * Phase 32.7.1 — BLOCKER FIX regression tests (source-contract).
 *
 * Three production blockers closed:
 *
 *   1. PUBLIC VERIFY transaction timeout.
 *      `GET /public/verify/:id` awaited a
 *      `prisma.$transaction([evidence.update, verificationView.create])`
 *      for analytics-only writes. Under Neon connection pressure the
 *      transaction could not start within the pooler window, raising
 *      `Unable to start a transaction in the given time` and a high-
 *      priority Sentry issue. The verify response then returned 500
 *      even though the verification data had already been read
 *      successfully above.
 *
 *      Fix: the writes are now fire-and-forget (`void
 *      (async () => { ... })().catch(...)`), no `$transaction`
 *      wrapper (atomicity not required for two independent analytics
 *      signals), failures logged at WARN with bounded fields, no
 *      Sentry `captureException`.
 *
 *   2. CHECK WORKERS UNKNOWN cascade.
 *      The readiness `checkWorkers` query could fail under the same
 *      connection-pool pressure created by blocker #1. The catch arm
 *      already returned UNKNOWN with `telemetry_query_failed` (Phase
 *      32.7), but the detail did not surface the Prisma error code,
 *      making operator triage harder. The catch arm now appends the
 *      Prisma code (e.g. `P2024`) to the detail and tailors the
 *      remediation hint for the pool-exhaustion case.
 *
 *   3. ORIGINAL DOWNLOAD analytics writes.
 *      `GET /v1/evidence/:id/original` awaited a synchronous
 *      `prisma.evidence.update({ lastAccessedByUserId,
 *      lastAccessedAtUtc })` after generating the presigned URL.
 *      Under pool pressure this could break the download even
 *      though the presigned URL was ready. Same fire-and-forget
 *      treatment applied (forensic custody event remains; only the
 *      analytics column update is fire-and-forget).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

// =============================================================================
// Part 1 — Public verify route no longer awaits the analytics $transaction
// =============================================================================

describe("Phase 32.7.1 — public verify analytics writes are fire-and-forget", () => {
  const SRC = readApi("src/routes/evidence.routes.ts");
  const routeIdx = SRC.indexOf('app.get("/public/verify/:id"');
  expect(routeIdx).toBeGreaterThan(-1);
  // The route body is large; widen the window to capture the
  // entire handler.
  const routeBody = SRC.slice(routeIdx, routeIdx + 30000);

  it("the load-bearing `await prisma.$transaction([evidence.update, verificationView.create])` is gone", () => {
    // Look specifically for the SHAPE that was failing: an awaited
    // $transaction array containing both evidence.update and
    // verificationView.create. Live emission of that combination
    // must be absent. (References to the OLD shape in comments are
    // fine — they document the fix.)
    expect(routeBody).not.toMatch(
      /await\s+prisma\.\$transaction\(\[[\s\S]{0,200}prisma\.evidence\.update\(\{[\s\S]{0,400}prisma\.verificationView\.create/,
    );
  });

  it("the analytics writes happen inside a fire-and-forget IIFE wrapped in .catch", () => {
    // The new shape: `void (async () => { ... await Promise.allSettled([...]) ... })().catch(...)`.
    // Verify the `void (async () =>` opener AND the trailing
    // `.catch(` close that ensures unhandled-rejection safety.
    expect(routeBody).toMatch(/void\s+\(async\s*\(\)\s*=>\s*\{/);
    // The IIFE must include both the evidence.update and the
    // verificationView.create writes.
    const iifeIdx = routeBody.indexOf("void (async () => {");
    expect(iifeIdx).toBeGreaterThan(-1);
    const iife = routeBody.slice(iifeIdx, iifeIdx + 4000);
    expect(iife).toMatch(/prisma\.evidence\.update/);
    expect(iife).toMatch(/prisma\.verificationView\.create/);
    expect(iife).toMatch(/Promise\.allSettled/);
    // The terminating `.catch(...)` ensures unhandledRejection
    // safety for the truly pathological IIFE-itself-rejects case.
    expect(iife).toMatch(/\}\)\(\)\.catch\(/);
  });

  it("failures emit a bounded WARN log line (NOT captureException)", () => {
    const iifeIdx = routeBody.indexOf("void (async () => {");
    const iife = routeBody.slice(iifeIdx, iifeIdx + 4000);
    expect(iife).toMatch(/req\.log\.warn\(/);
    expect(iife).toMatch(/public_verify\.access_log_failed/);
    // No captureException inside the fire-and-forget body (would
    // re-create the high-priority Sentry issue we just retired).
    expect(iife).not.toMatch(/captureException\(/);
  });

  it("the response is no longer blocked by the analytics writes", () => {
    // The fix uses Promise.allSettled to keep both writes
    // independently observable, but the OUTER call site does NOT
    // await the IIFE. Verify that the `if (isFinalizedForVerify)`
    // block contains `void (async ...)` and not `await prisma.$transaction`.
    const finalIdx = routeBody.indexOf("if (isFinalizedForVerify) {");
    expect(finalIdx).toBeGreaterThan(-1);
    const finalBlock = routeBody.slice(finalIdx, finalIdx + 5000);
    expect(finalBlock).not.toMatch(/await\s+prisma\.\$transaction/);
    expect(finalBlock).toMatch(/void\s+\(async\s*\(\)\s*=>\s*\{/);
  });

  it("custody/audit semantics preserved: `auditVerificationAction` still fires after the IIFE", () => {
    // The audit log call site (already fire-and-forget) lives AFTER
    // the IIFE in the route body. Verify both exist and the audit
    // is still emitted.
    expect(routeBody).toMatch(/auditVerificationAction\(req,\s*\{/);
    expect(routeBody).toMatch(/action:\s*"verification\.page_opened"/);
  });
});

// =============================================================================
// Part 2 — Original-download GET route analytics is fire-and-forget too
// =============================================================================

describe("Phase 32.7.1 — original-presign analytics write is fire-and-forget", () => {
  const SRC = readApi("src/routes/evidence.routes.ts");
  const routeIdx = SRC.indexOf('"/v1/evidence/:id/original"');
  expect(routeIdx).toBeGreaterThan(-1);
  const routeBody = SRC.slice(routeIdx, routeIdx + 12000);

  it("`lastAccessedAtUtc` update is no longer awaited", () => {
    // The literal `await prisma.evidence.update({` followed by the
    // `lastAccessedByUserId` field must not exist in this handler.
    expect(routeBody).not.toMatch(
      /await\s+prisma\.evidence\.update\(\{[\s\S]{0,200}lastAccessedByUserId/,
    );
  });

  it("the update is wrapped in `void prisma.evidence.update(...).catch(...)`", () => {
    expect(routeBody).toMatch(
      /void\s+prisma\.evidence\s*\.\s*update\(\{[\s\S]{0,400}lastAccessedByUserId[\s\S]{0,400}\}\)\s*\.catch\(/,
    );
  });

  it("failures emit a bounded WARN log line (NOT captureException)", () => {
    expect(routeBody).toMatch(/original_presign\.access_log_failed/);
    // No new captureException added in this region for the
    // analytics failure case.
    const updateIdx = routeBody.indexOf(
      "void prisma.evidence",
    );
    expect(updateIdx).toBeGreaterThan(-1);
    const updateRegion = routeBody.slice(updateIdx, updateIdx + 1500);
    expect(updateRegion).not.toMatch(/captureException\(/);
  });

  it("forensic custody event (EVIDENCE_VIEWED) still fires", () => {
    expect(routeBody).toMatch(
      /appendCustodyEvent\(\{[\s\S]{0,400}eventType:\s*prismaPkg\.CustodyEventType\.EVIDENCE_VIEWED/,
    );
    expect(routeBody).toMatch(
      /accessMode:\s*"authenticated_original_access"/,
    );
  });
});

// =============================================================================
// Part 3 — checkWorkers surfaces Prisma error code on UNKNOWN
// =============================================================================

describe("Phase 32.7.1 — checkWorkers catch arm surfaces Prisma error code", () => {
  const SRC = readApi("src/runtime/runtime-readiness.ts");
  const fnIdx = SRC.indexOf("async function checkWorkers");
  expect(fnIdx).toBeGreaterThan(-1);
  const fnEnd = SRC.indexOf("\n}\n", fnIdx);
  const fn = SRC.slice(fnIdx, fnEnd);

  it("catch arm captures the error parameter (no anonymous catch)", () => {
    expect(fn).toMatch(/\}\s*catch\s*\(\s*err\s*\)/);
  });

  it("Prisma error code is appended to the detail when present", () => {
    expect(fn).toMatch(/prismaCode\s*=\s*\n?[\s\S]{0,200}err\s+instanceof\s+Error[\s\S]{0,200}"code"\s+in\s+err/);
    expect(fn).toMatch(/codeSuffix\s*=\s*prismaCode\s*\?\s*` \(code: \$\{prismaCode\}\)`\s*:/);
  });

  it("status is still UNKNOWN (NOT DEGRADED, NOT CRITICAL) on telemetry query failure", () => {
    const catchIdx = fn.lastIndexOf("} catch");
    const catchSlice = fn.slice(catchIdx);
    expect(catchSlice).toMatch(/status:\s*"UNKNOWN"/);
    expect(catchSlice).not.toMatch(/status:\s*"DEGRADED"/);
    expect(catchSlice).not.toMatch(/status:\s*"CRITICAL"/);
  });

  it("P2024 (connection-pool exhausted) gets a dedicated remediation hint", () => {
    const catchIdx = fn.lastIndexOf("} catch");
    const catchSlice = fn.slice(catchIdx);
    expect(catchSlice).toMatch(/prismaCode === "P2024"/);
    expect(catchSlice).toMatch(/connection pool exhausted/i);
    expect(catchSlice).toMatch(/fire-and-forget/);
  });

  it("metadata carries the Prisma code (for SRE dashboards)", () => {
    const catchIdx = fn.lastIndexOf("} catch");
    const catchSlice = fn.slice(catchIdx);
    expect(catchSlice).toMatch(/prismaCode:\s*prismaCode\s*\?\?\s*null/);
  });
});

// =============================================================================
// Part 4 — Redis ping surfaces bounded triage metadata on CRITICAL
// =============================================================================

describe("Phase 32.7.1 — Redis ping CRITICAL detail surfaces timing + error class", () => {
  const SRC = readApi("src/runtime/runtime-readiness.ts");
  const fnIdx = SRC.indexOf("async function checkRedis");
  expect(fnIdx).toBeGreaterThan(-1);
  const fnEnd = SRC.indexOf("\nfunction checkS3ObjectLock", fnIdx);
  const fn = SRC.slice(fnIdx, fnEnd);

  it("CRITICAL detail includes elapsed ms (operators can distinguish connect vs ping)", () => {
    const catchIdx = fn.indexOf("} catch (err)");
    const catchSlice = fn.slice(catchIdx);
    expect(catchSlice).toMatch(/elapsedMs\s*=\s*Date\.now\(\)\s*-\s*startedAt/);
    expect(catchSlice).toMatch(/Redis ping failed after \$\{elapsedMs\}ms/);
  });

  it("remediationHint splits on the 500ms connect window vs the 1s ping window", () => {
    const catchIdx = fn.indexOf("} catch (err)");
    const catchSlice = fn.slice(catchIdx);
    expect(catchSlice).toMatch(/elapsedMs\s*<\s*600/);
    expect(catchSlice).toMatch(/connect window/);
    expect(catchSlice).toMatch(/CPU-saturated or under memory pressure/);
  });

  it("metadata carries errClass and errCode (bounded triage fields)", () => {
    const catchIdx = fn.indexOf("} catch (err)");
    const catchSlice = fn.slice(catchIdx);
    expect(catchSlice).toMatch(/errClass:\s*errName/);
    // The shorthand property `errCode,` is followed by a trailing
    // comma (and then the closing `}` on the next line).
    expect(catchSlice).toMatch(/errCode\s*,/);
  });

  it("no raw err.message body leaks (only the bounded 120-char slice)", () => {
    const catchIdx = fn.indexOf("} catch (err)");
    const catchSlice = fn.slice(catchIdx);
    expect(catchSlice).toMatch(/err\.message\.slice\(0,\s*120\)/);
  });

  it("Phase 32.6.1 fast-fail config preserved (NOT loosened)", () => {
    expect(fn).toMatch(/connectTimeout:\s*500/);
    expect(fn).toMatch(/maxRetriesPerRequest:\s*0/);
    expect(fn).toMatch(/enableOfflineQueue:\s*false/);
    expect(fn).toMatch(/retryStrategy:\s*\(\)\s*=>\s*null/);
  });
});

// =============================================================================
// Part 5 — Custody/audit semantics preserved (no governance weakening)
// =============================================================================

describe("Phase 32.7.1 — custody/audit semantics preserved", () => {
  const SRC = readApi("src/routes/evidence.routes.ts");

  it("verification page_opened audit still emitted (fire-and-forget pre-existing)", () => {
    expect(SRC).toMatch(/action:\s*"verification\.page_opened"/);
  });

  it("EVIDENCE_VIEWED custody event still emitted on authenticated original access", () => {
    expect(SRC).toMatch(
      /prismaPkg\.CustodyEventType\.EVIDENCE_VIEWED[\s\S]{0,400}accessMode:\s*"authenticated_original_access"/,
    );
  });

  it("verification.package_accessed audit still emitted on package download", () => {
    expect(SRC).toMatch(/action:\s*"verification\.package_accessed"/);
  });

  it("EXPORT_BLOCKED_BY_POLICY custody event still emitted on governance denial", () => {
    expect(SRC).toMatch(
      /prismaPkg\.CustodyEventType\.EXPORT_BLOCKED_BY_POLICY/,
    );
  });
});
