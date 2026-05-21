/**
 * Phase 32.6.1 — Verification package state-machine fix + Redis
 * observability hardening: regression tests.
 *
 * Root cause being closed:
 *   When createVerificationPackage threw PackageGateDeniedError, the
 *   processor catch arm called captureException + log.error but did
 *   NOT write any state back to the evidence row. Downstream the
 *   `/v1/evidence/:id/verification-package` route returned a flat
 *   404 "not found" — operators couldn't distinguish:
 *     * blocked by governance (legal hold, destruction review)
 *     * still being generated
 *     * unavailable for personal workspace
 *     * actually missing
 *
 *   Every gate denial fired a Sentry "high" alert even though the
 *   denial was expected fail-closed behavior.
 *
 * Tests enforce:
 *   1. Worker catch arm distinguishes PackageGateDeniedError from
 *      real bugs (bumps the `_blocked` counter, NO captureException).
 *   2. Worker persists bounded `{ blocked, outcome, reason, label,
 *      blockedAtUtc }` to evidence.verificationPackageMetadata.
 *   3. Artifact-status helper exposes `blocked + blockedOutcome +
 *      blockedReason + blockedAtUtc` on the package projection.
 *   4. Download route returns structured 409 / 410 / 202 / 404
 *      based on the bounded state — never flat 404 for blocked or
 *      pending cases.
 *   5. Live Redis ping in runtime-readiness with bounded timeout.
 *   6. Sentry beforeSend filters transient Redis ECONNREFUSED on
 *      BOTH api + worker.
 *   7. Redis connection observability: ready/error/close event
 *      listeners with bounded log throttle.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

// =============================================================================
// PART 1 — Worker distinguishes gate denial from real bugs
// =============================================================================

describe("Phase 32.6.1 — worker catch arm distinguishes gate denial", () => {
  const PROC_SRC = readSource("../../worker/src/processor.ts");

  it("imports PackageGateDeniedError so the catch arm can type-test it", () => {
    expect(PROC_SRC).toMatch(
      /import \{ createVerificationPackage, PackageGateDeniedError \} from "\.\/verification-package\.js"/,
    );
  });

  it("catch arm branches on PackageGateDeniedError via `instanceof`", () => {
    expect(PROC_SRC).toMatch(
      /if \(verificationError instanceof PackageGateDeniedError\)/,
    );
  });

  it("gate-denial branch does NOT call captureException (it's expected behavior, not a bug)", () => {
    const code = stripComments(PROC_SRC);
    const idx = code.indexOf("verificationError instanceof PackageGateDeniedError");
    expect(idx).toBeGreaterThan(0);
    // The denial branch spans until the matching `} else {`. We
    // grab a generous slice and assert captureException is NOT
    // present inside the gate-denial branch.
    const branchEnd = code.indexOf("} else {", idx);
    expect(branchEnd).toBeGreaterThan(idx);
    const branchBody = code.slice(idx, branchEnd);
    expect(branchBody).not.toMatch(/captureException/);
  });

  it("non-denial branch keeps captureException + logger.error + failed counter", () => {
    const code = stripComments(PROC_SRC);
    const idx = code.indexOf("verificationError instanceof PackageGateDeniedError");
    const elseIdx = code.indexOf("} else {", idx);
    const branchEnd = code.indexOf("}\n    }", elseIdx);
    const elseBody = code.slice(elseIdx, branchEnd);
    expect(elseBody).toMatch(/captureException/);
    expect(elseBody).toMatch(/bump\("package_generation_failed_total"\)/);
  });

  it("gate-denial branch persists bounded metadata to evidence.verificationPackageMetadata", () => {
    expect(PROC_SRC).toMatch(
      /prisma\.evidence\.update\(\{[\s\S]{0,400}verificationPackageMetadata:\s*\{[\s\S]{0,400}blocked: true/,
    );
    // The persisted shape carries the bounded gate fields ONLY —
    // no raw error stacks, no storage keys.
    expect(PROC_SRC).toMatch(/outcome: verificationError\.outcome/);
    expect(PROC_SRC).toMatch(/reason: verificationError\.reason/);
    expect(PROC_SRC).toMatch(/label: verificationError\.label/);
    expect(PROC_SRC).toMatch(/blockedAtUtc: new Date\(\)\.toISOString\(\)/);
  });

  it("gate-denial bumps `package_generation_blocked_total` (separate from failed_total)", () => {
    const code = stripComments(PROC_SRC);
    const idx = code.indexOf("verificationError instanceof PackageGateDeniedError");
    const elseIdx = code.indexOf("} else {", idx);
    const branchBody = code.slice(idx, elseIdx);
    expect(branchBody).toMatch(
      /bump\("package_generation_blocked_total"\)/,
    );
  });
});

// =============================================================================
// PART 2 — Artifact status helper exposes blocked state
// =============================================================================

describe("Phase 32.6.1 — artifact status `blocked` projection", () => {
  const SERVICE_SRC = readSource(
    "../src/services/evidence-artifact-status.service.ts",
  );

  it("VerificationPackage projection carries blocked + blockedOutcome + blockedReason + blockedAtUtc", () => {
    expect(SERVICE_SRC).toMatch(/blocked: false;\s*blockedOutcome: null;\s*blockedReason: null;\s*blockedAtUtc: null;/);
    expect(SERVICE_SRC).toMatch(/blocked: boolean;\s*blockedOutcome: string \| null;\s*blockedReason: string \| null;\s*blockedAtUtc: string \| null;/);
  });

  it("helper accepts `evidenceVerificationPackageMetadata` parameter", () => {
    expect(SERVICE_SRC).toMatch(
      /evidenceVerificationPackageMetadata\?:\s*prismaPkg\.Prisma\.JsonValue \| null/,
    );
  });

  it("helper reads the bounded blocked-metadata shape (NEVER throws on malformed input)", () => {
    expect(SERVICE_SRC).toMatch(/function readBlockedMetadata/);
    // Defensive: malformed inputs return null.
    expect(SERVICE_SRC).toMatch(
      /if \(raw == null \|\| typeof raw !== "object" \|\| Array\.isArray\(raw\)\) return null/,
    );
    // Requires `blocked === true` AND `outcome` AND `reason`.
    expect(SERVICE_SRC).toMatch(/if \(obj\.blocked !== true\) return null/);
    expect(SERVICE_SRC).toMatch(/if \(!outcome \|\| !reason\) return null/);
  });

  it("package is `blocked: true, pending: false` when metadata shows a gate denial AND no package row", () => {
    const code = stripComments(SERVICE_SRC);
    expect(code).toMatch(
      /packageBlocked = finalized && !latestPackage && blockedMeta !== null/,
    );
    expect(code).toMatch(
      /packagePending\s*=\s*finalized &&\s*!latestPackage &&\s*!packageUnavailableForPersonalWorkspace &&\s*!packageBlocked/,
    );
  });

  it("when a package row EXISTS, blocked is forced to false regardless of metadata", () => {
    const code = stripComments(SERVICE_SRC);
    // The latestPackage branch always returns blocked: false.
    expect(code).toMatch(
      /latestPackage\s*\?\s*\{[\s\S]{0,400}blocked: false,[\s\S]{0,200}blockedOutcome: null,/,
    );
  });
});

// =============================================================================
// PART 3 — Download route returns structured 409 / 410 / 202 / 404
// =============================================================================

describe("Phase 32.6.1 — verification-package download route structured response", () => {
  const ROUTES_SRC = readSource("../src/routes/evidence.routes.ts");

  it("returns 409 + bounded blocked payload when evidence.verificationPackageMetadata.blocked is true", () => {
    expect(ROUTES_SRC).toMatch(/return reply\.code\(409\)\.send\(\{[\s\S]{0,400}code:\s*"verification_package_blocked"/);
    expect(ROUTES_SRC).toMatch(/outcome:\s*typeof meta\?\.outcome === "string"/);
    expect(ROUTES_SRC).toMatch(/reason:\s*typeof meta\?\.reason === "string"/);
  });

  it("Phase 32.6.6 — the personal-workspace 410 branch is retired (personal evidence now generates a BASIC package)", () => {
    // Historical behavior (now removed): the route returned 410 with
    // `verification_package_unavailable` + reason
    // `personal_workspace_no_team_governance_context` for any
    // finalized evidence without a teamId. That was incorrect
    // product semantics — personal evidence MUST be able to produce
    // and download a verification package (BASIC mode).
    //
    // The 410 live emit is gone; personal evidence falls through to
    // 202 pending while the worker builds the BASIC package, then
    // 200 download.
    expect(ROUTES_SRC).not.toMatch(
      /return reply\.code\(410\)\.send\(\{[\s\S]{0,400}code:\s*"verification_package_unavailable"/,
    );
    // No live `reason: "personal_workspace_..."` key in any reply.send().
    expect(ROUTES_SRC).not.toMatch(
      /^\s*reason:\s*"personal_workspace_no_team_governance_context"/m,
    );
  });

  it("returns 202 + Retry-After when finalized but package is still pending", () => {
    expect(ROUTES_SRC).toMatch(/reply\.header\("retry-after", "5"\)/);
    expect(ROUTES_SRC).toMatch(/return reply\.code\(202\)\.send\(\{[\s\S]{0,400}code:\s*"verification_package_pending"/);
    // The pending body points the client at the side-effect-free
    // status endpoint, NOT the report-latest download route.
    expect(ROUTES_SRC).toMatch(/\/v1\/evidence\/:id\/artifacts\/status/);
  });

  it("returns flat 404 ONLY when evidence is not finalized AND not blocked AND not unavailable", () => {
    expect(ROUTES_SRC).toMatch(/return reply\s*\.code\(404\)\s*\.send\(\{[\s\S]{0,200}code:\s*"verification_package_not_found"/);
  });

  it("structured response NEVER leaks storage keys / bucket / signed URLs", () => {
    // Slice the route body and confirm no storage_key / storage_bucket
    // references in the responses (those are only used internally
    // for the actual download path).
    const idx = ROUTES_SRC.indexOf('"/v1/evidence/:id/verification-package"');
    expect(idx).toBeGreaterThan(0);
    // Phase 32.6.6 — bump the slice window to 12000 (route body has
    // grown over time; the 6000 ceiling no longer reaches the 404
    // response).
    const slice = ROUTES_SRC.slice(idx, idx + 12000);
    // Specifically the response objects we just added must NOT
    // include any of these fields. Phase 32.6.6 — the "unavailable"
    // 410 branch has been retired, so the bounded enum is now
    // blocked | pending | not_found.
    const lookAtResponses = slice.match(
      /return reply[\s\S]{0,800}code:\s*"verification_package_(blocked|pending|not_found)"[\s\S]{0,400}\}\)/g,
    );
    expect(lookAtResponses).toBeTruthy();
    for (const r of lookAtResponses!) {
      expect(r).not.toMatch(/storageKey|storage_key|storageBucket|storage_bucket|signedUrl|signed_url/);
    }
  });
});

// =============================================================================
// PART 4 — Live Redis ping in runtime-readiness
// =============================================================================

describe("Phase 32.6.1 — runtime-readiness Redis live ping", () => {
  const SRC = readSource("../src/runtime/runtime-readiness.ts");

  it("checkRedis is async and dynamic-imports ioredis (avoids cold-import on every request)", () => {
    expect(SRC).toMatch(/async function checkRedis\(\): Promise<SubsystemReadiness>/);
    expect(SRC).toMatch(/await import\("ioredis"\)/);
  });

  it("ping client is bounded: connectTimeout 500ms, maxRetriesPerRequest 0, retryStrategy returns null", () => {
    const idx = SRC.indexOf("async function checkRedis");
    const slice = SRC.slice(idx, idx + 3000);
    expect(slice).toMatch(/connectTimeout: 500/);
    expect(slice).toMatch(/maxRetriesPerRequest: 0/);
    expect(slice).toMatch(/retryStrategy: \(\) => null/);
    expect(slice).toMatch(/enableOfflineQueue: false/);
  });

  it("ping uses bounded 1s timeout via withTimeout helper", () => {
    const idx = SRC.indexOf("async function checkRedis");
    const slice = SRC.slice(idx, idx + 3000);
    expect(slice).toMatch(/withTimeout\(pingClient\.ping\(\), null, 1000\)/);
  });

  it("REDIS_URL missing → DEGRADED (not CRITICAL — env may legitimately be unset in dev)", () => {
    const idx = SRC.indexOf("async function checkRedis");
    const slice = SRC.slice(idx, idx + 3000);
    expect(slice).toMatch(/reasonCode: "redis_not_configured"/);
    expect(slice).toMatch(/status: "DEGRADED",[\s\S]{0,200}reasonCode: "redis_not_configured"/);
  });

  it("ping success → HEALTHY with measured latency", () => {
    const idx = SRC.indexOf("async function checkRedis");
    const slice = SRC.slice(idx, idx + 3000);
    expect(slice).toMatch(/status: "HEALTHY",[\s\S]{0,400}latencyMs/);
  });

  it("ping failure → CRITICAL with bounded error message slice", () => {
    const idx = SRC.indexOf("async function checkRedis");
    // Phase 32.7.3 — function body widened with the
    // explicit-connect race-fix comment; the previous 3000-char
    // window no longer reaches the CRITICAL branch. Widen to 5000
    // (consistent with the sibling `finally` test below).
    const slice = SRC.slice(idx, idx + 5000);
    expect(slice).toMatch(/status: "CRITICAL",[\s\S]{0,400}reasonCode: "redis_unreachable"/);
    expect(slice).toMatch(/err\.message\.slice\(0, 120\)/);
  });

  it("ping client is always disconnected in a finally block (no socket leak)", () => {
    const idx = SRC.indexOf("async function checkRedis");
    // Phase 32.7.1 — function body widened to surface triage
    // metadata; the previous 3000-char window no longer reaches
    // the `} finally {` block. Widen to 5000.
    const slice = SRC.slice(idx, idx + 5000);
    expect(slice).toMatch(/} finally \{[\s\S]{0,400}pingClient\.disconnect\(\)/);
  });
});

// =============================================================================
// PART 5 — Sentry beforeSend filters transient ECONNREFUSED
// =============================================================================

describe("Phase 32.6.1 — Sentry suppresses transient Redis errors", () => {
  const WORKER_SENTRY = readSource("../../worker/src/sentry.ts");
  const API_SENTRY = readSource("../src/observability/sentry.ts");

  it("worker Sentry init has a beforeSend that filters ECONNREFUSED / Connection is closed / Connection lost", () => {
    expect(WORKER_SENTRY).toMatch(/beforeSend\(event, hint\)/);
    expect(WORKER_SENTRY).toMatch(/message\.includes\("ECONNREFUSED"\)/);
    expect(WORKER_SENTRY).toMatch(/message\.includes\("Connection is closed"\)/);
    expect(WORKER_SENTRY).toMatch(/message\.includes\("Connection lost"\)/);
    expect(WORKER_SENTRY).toMatch(/return null/);
  });

  it("api Sentry init mirrors the worker's beforeSend (consistent vocabulary)", () => {
    expect(API_SENTRY).toMatch(/beforeSend\(event, hint\)/);
    expect(API_SENTRY).toMatch(/message\.includes\("ECONNREFUSED"\)/);
    expect(API_SENTRY).toMatch(/message\.includes\("Connection is closed"\)/);
    expect(API_SENTRY).toMatch(/message\.includes\("Connection lost"\)/);
  });

  it("beforeSend ONLY suppresses bounded transient signatures (does NOT swallow general errors)", () => {
    // The filter checks specific strings. Any other Error returns the
    // event unchanged.
    expect(WORKER_SENTRY).toMatch(/return event;/);
    expect(API_SENTRY).toMatch(/return event;/);
  });
});

// =============================================================================
// PART 6 — Redis connection observability (queue.ts event listeners)
// =============================================================================

describe("Phase 32.6.1 — Redis connection event observability", () => {
  const QUEUE_SRC = readSource("../../worker/src/queue.ts");

  it("redisConnection attaches `ready` listener that logs a bounded reconnect line", () => {
    expect(QUEUE_SRC).toMatch(
      /redisConnection\.on\("ready"[\s\S]{0,400}event: "redis\.connection\.ready"/,
    );
  });

  it("redisConnection attaches `error` listener with bounded log throttle (5s)", () => {
    expect(QUEUE_SRC).toMatch(/REDIS_ERROR_LOG_THROTTLE_MS = 5_000/);
    expect(QUEUE_SRC).toMatch(
      /redisConnection\.on\("error"[\s\S]{0,800}event: "redis\.connection\.error"/,
    );
    // Throttle logic uses a per-event timestamp guard.
    expect(QUEUE_SRC).toMatch(/now - redisLastErrorLoggedAtMs < REDIS_ERROR_LOG_THROTTLE_MS/);
  });

  it("redisConnection attaches `close` listener that logs the previous-ready timestamp", () => {
    expect(QUEUE_SRC).toMatch(
      /redisConnection\.on\("close"[\s\S]{0,400}event: "redis\.connection\.close"/,
    );
    expect(QUEUE_SRC).toMatch(/lastReadyAtMs: redisLastReadyAtMs/);
  });

  it("error log includes the bounded NodeJS errno code (e.g. ECONNREFUSED)", () => {
    expect(QUEUE_SRC).toMatch(
      /code:\s*\(err as NodeJS\.ErrnoException\)\.code/,
    );
  });

  it("logger import is lazy (avoids circular import during queue construction)", () => {
    expect(QUEUE_SRC).toMatch(/void import\("\.\/logger\.js"\)\.then\(\(\{ logger \}\) =>/);
  });
});
