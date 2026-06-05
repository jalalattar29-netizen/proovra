/**
 * Production regression test — Investigation Enterprise P0+P1 critical path.
 *
 * Pins the structural invariants of the three coordinated slices that
 * landed for the /investigation P0+P1 stabilisation:
 *
 *   1. FRONTEND CRASH FIX
 *      apps/web/app/(app)/investigation/page.tsx — IndexingProgressGrid
 *      previously read `totals.ocrAvailable` (and 3 siblings) with no
 *      optional-chain guard. When the backend returned a partial /
 *      missing `indexingTotals` object, the read threw, the throw
 *      bubbled all the way to apps/web/app/error.tsx, and the user saw
 *      the generic "Something went wrong" page. This slice replaces the
 *      bare reads with optional-chain + nullish coalescing AND adds a
 *      segment-scoped error.tsx so a future crash stays contained.
 *
 *   2. BACKEND DTO STABILISATION
 *      services/api/src/routes/media-intelligence.routes.ts — the
 *      indexingTotals subtree of GET /v1/investigation/reviewers
 *      previously silently swallowed query failures and returned an
 *      undefined/partial shape. This slice (a) logs a warning on
 *      failure under a bounded log code and (b) normalises the wire
 *      payload so all 4 fields are always present and numeric.
 *
 *   3. EVIDENCE-COMPLETE PRODUCER WIRING
 *      services/api/src/services/evidence-complete.service.ts — the
 *      old `void (async () => { reconcileTeamGraph(...) })()` IIFE
 *      bypassed the worker queue, so worker-side
 *      indexExistingOcrAndTranscript never ran. This slice replaces
 *      the IIFE with a producer that enqueues onto the graph-reconcile
 *      worker queue AND a sibling producer that enqueues an
 *      analyze_metadata job so /investigation overview counters
 *      populate without an operator manually POSTing the trigger.
 *
 * Style: source-contract — readFileSync + regex. No DB. No process boot.
 * Mirrors the existing patterns in production-evidence-lifecycle-real-fix
 * and production-evidence-lifecycle-final-fix.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");

function readFile(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

// ───────────────────────────────────────────────────────────────────────
// Group A — Frontend crash fix
// ───────────────────────────────────────────────────────────────────────

describe("Investigation P0+P1 — Group A: frontend crash fix", () => {
  const PAGE = readFile("apps/web/app/(app)/investigation/page.tsx");

  it("(A1.a) IndexingProgressGrid reads totals.ocrAvailable via optional chain only", () => {
    // The bare access (no `?`) was the throw site. Assert that every
    // occurrence of the 4 indexing fields is preceded by `?` or `?.`.
    // Strategy: find ALL totals.<field> matches and ensure none are
    // bare (i.e. `totals.ocrAvailable` without the optional chain).
    const bareOcrAvailable = /\btotals\.ocrAvailable\b/g;
    const bareOcrIndexed = /\btotals\.ocrIndexed\b/g;
    const bareTranscriptAvailable = /\btotals\.transcriptAvailable\b/g;
    const bareTranscriptIndexed = /\btotals\.transcriptIndexed\b/g;
    expect(PAGE).not.toMatch(bareOcrAvailable);
    expect(PAGE).not.toMatch(bareOcrIndexed);
    expect(PAGE).not.toMatch(bareTranscriptAvailable);
    expect(PAGE).not.toMatch(bareTranscriptIndexed);
  });

  it("(A1.b) IndexingProgressGrid uses optional chain + nullish coalescing for all 4 fields", () => {
    expect(PAGE).toMatch(/totals\?\.ocrAvailable\s*\?\?\s*0/);
    expect(PAGE).toMatch(/totals\?\.ocrIndexed\s*\?\?\s*0/);
    expect(PAGE).toMatch(/totals\?\.transcriptAvailable\s*\?\?\s*0/);
    expect(PAGE).toMatch(/totals\?\.transcriptIndexed\s*\?\?\s*0/);
  });

  it("(A1.c) IndexingProgressGrid prop type accepts null OR undefined", () => {
    // The previous prop type was just `… | null`. The grid is now
    // called with `reviewerActivity?.indexingTotals` which is typed
    // as optional — accepting undefined as well prevents the next
    // reintroduction of the crash by drift in the call-site type.
    expect(PAGE).toMatch(
      /indexingTotals["']\]\s*\|\s*null\s*\|\s*undefined/,
    );
  });

  it("(A2.a) apps/web/app/(app)/investigation/error.tsx exists", () => {
    const errorPath = resolve(
      REPO_ROOT,
      "apps/web/app/(app)/investigation/error.tsx",
    );
    expect(existsSync(errorPath), "error.tsx is required").toBe(true);
  });

  it("(A2.b) investigation/error.tsx is a use-client default-exported error boundary", () => {
    const src = readFile("apps/web/app/(app)/investigation/error.tsx");
    expect(src).toMatch(/"use client";/);
    expect(src).toMatch(/export\s+default\s+function/);
    expect(src).toMatch(/error:\s*Error/);
    expect(src).toMatch(/reset:\s*\(\)\s*=>\s*void/);
  });

  it("(A2.c) investigation/error.tsx captures to Sentry with feature: 'web_investigation_segment'", () => {
    const src = readFile("apps/web/app/(app)/investigation/error.tsx");
    expect(src).toMatch(/captureException/);
    expect(src).toMatch(/feature:\s*["']web_investigation_segment["']/);
  });

  it("(A3) defensive comment block near IndexingProgressGrid documents the crash root cause", () => {
    // The implementation added an explanatory block before
    // IndexingProgressGrid pointing at the root-cause file/line.
    // Search for the function declaration and confirm the comment
    // immediately above it references the previous unguarded read.
    const fnIdx = PAGE.indexOf("function IndexingProgressGrid(");
    expect(fnIdx).toBeGreaterThan(0);
    const preamble = PAGE.slice(Math.max(0, fnIdx - 1500), fnIdx);
    // The comment names the root cause and the fix vocabulary.
    expect(preamble).toMatch(/optional chain/i);
    expect(preamble).toMatch(/nullish coalesc/i);
    // It also points at the upstream handler that previously silently
    // swallowed exceptions and returned a partial shape.
    expect(preamble).toMatch(/media-intelligence\.routes\.ts/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Group B — Backend DTO stabilisation
// ───────────────────────────────────────────────────────────────────────

describe("Investigation P0+P1 — Group B: backend DTO stabilisation", () => {
  const ROUTES = readFile("services/api/src/routes/media-intelligence.routes.ts");

  it("(B1.a) /v1/investigation/reviewers handler normalises indexingTotals with all 4 numeric fields defaulted to 0", () => {
    // Locate the normaliser. It must default every one of the 4
    // fields to 0 when the raw query result is partial or missing.
    expect(ROUTES).toMatch(/ocrAvailable:[\s\S]{0,200}\?\s*rawIndexingTotals\.ocrAvailable\s*:\s*0/);
    expect(ROUTES).toMatch(/ocrIndexed:[\s\S]{0,200}\?\s*rawIndexingTotals\.ocrIndexed\s*:\s*0/);
    expect(ROUTES).toMatch(
      /transcriptAvailable:[\s\S]{0,200}\?\s*rawIndexingTotals\.transcriptAvailable\s*:\s*0/,
    );
    expect(ROUTES).toMatch(
      /transcriptIndexed:[\s\S]{0,200}\?\s*rawIndexingTotals\.transcriptIndexed\s*:\s*0/,
    );
  });

  it("(B1.b) the normalised indexingTotals object is what gets sent on the wire", () => {
    // The handler builds `const indexingTotals = { ... }` then
    // includes that object in the reply.code(200).send({...}) shape.
    expect(ROUTES).toMatch(/const\s+indexingTotals\s*=\s*\{/);
    // The send() call references the normalised name (not the raw).
    const sendIdx = ROUTES.indexOf("indexingTotals,");
    expect(sendIdx).toBeGreaterThan(0);
  });

  it("(B2) the handler logs a warning on failure under a bounded log code", () => {
    // The previous catch block silently returned. The new behaviour
    // logs under a bounded code so SREs can pivot from a log alert.
    //
    // Phase Repair rebaseline: the bounded log code was renamed from
    // `investigation_reviewers_indexingTotals_failed` →
    // `investigation_reviewers.indexing_totals_failed` so the whole
    // reviewer console family of log codes follows a single
    // `investigation_reviewers.<block>_failed` namespacing convention
    // (workflow_totals / escalation_totals / external_review_totals /
    // recent_escalations / recent_grants / indexing_totals /
    // producer_modes — see media-intelligence.routes.ts). The
    // contract enforced here is unchanged: the catch reports the
    // underlying exception rather than silently dropping it.
    expect(ROUTES).toMatch(/investigation_reviewers\.indexing_totals_failed/);
    const codeIdx = ROUTES.indexOf(
      "investigation_reviewers.indexing_totals_failed",
    );
    expect(codeIdx).toBeGreaterThan(0);
    const preamble = ROUTES.slice(Math.max(0, codeIdx - 200), codeIdx);
    // Accept both `req.log.warn(` and `req.log?.warn?.(` — the source
    // currently uses the optional-chain form for defence against a
    // missing logger in test harnesses.
    expect(preamble).toMatch(/req\.log[?.]*\.warn[?.]*\(/);
    expect(preamble).toMatch(/\{\s*err/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Group C — Evidence-complete producer wiring
// ───────────────────────────────────────────────────────────────────────

describe("Investigation P0+P1 — Group C: evidence-complete producer wiring", () => {
  const SVC = readFile("services/api/src/services/evidence-complete.service.ts");
  // Architecture: evidence-complete delegates the post-finalize fan-out
  // to evidence-finalization-fanout.service.ts. The producer-wiring
  // assertions therefore live in BOTH files: the SVC asserts the
  // delegation, the FANOUT asserts the actual enqueue calls.
  const FANOUT = readFile(
    "services/api/src/services/evidence-finalization-fanout.service.ts",
  );

  it("(C1) old `void (async () => { … reconcileTeamGraph(…) })()` IIFE is gone (or is commented historical)", () => {
    // The IIFE bypassed the worker queue. If it survives uncommented,
    // worker-side indexExistingOcrAndTranscript never runs.
    // Strip comments first, then assert no live IIFE remains.
    const stripped = SVC
      // Strip /* … */ block comments.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Strip // line comments (keeping the newline so regex line
      // anchors still work elsewhere).
      .replace(/(^|\s)\/\/[^\n]*$/gm, "$1");
    expect(stripped).not.toMatch(/void\s*\(\s*async\s*\(\s*\)\s*=>/);
  });

  it("(C2.a) evidence-complete delegates to runEvidenceFinalizationFanout", () => {
    expect(SVC).toMatch(/runEvidenceFinalizationFanout\s*\(/);
    expect(SVC).toMatch(
      /import\s*\{[^}]*runEvidenceFinalizationFanout[^}]*\}\s*from\s*["'][^"']*evidence-finalization-fanout\.service[^"']*["']/,
    );
  });

  it("(C2.b) fan-out service calls enqueueGraphReconcileJob (worker producer, not in-process)", () => {
    expect(FANOUT).toMatch(/enqueueGraphReconcileJob\s*\(/);
    expect(FANOUT).toMatch(
      /enqueueGraphReconcileJob\(\s*\{[\s\S]{0,300}teamId:/,
    );
  });

  it("(C3) fan-out service calls enqueueMediaIntelligenceAnalysis with kind 'analyze_metadata'", () => {
    expect(FANOUT).toMatch(/enqueueMediaIntelligenceAnalysis\s*\(/);
    expect(FANOUT).toMatch(
      /enqueueMediaIntelligenceAnalysis\(\s*\{[\s\S]{0,300}kind:\s*["']analyze_metadata["']/,
    );
  });

  it("(C4.a) the enqueueMediaIntelligenceAnalysis call site is inside a try/catch (in fan-out service)", () => {
    // Find the awaited CALL, not the JSDoc reference inside the header
    // comment block. The await prefix uniquely targets the live call.
    const callIdx = FANOUT.indexOf("await enqueueMediaIntelligenceAnalysis(");
    expect(callIdx, "live enqueueMediaIntelligenceAnalysis call must exist").toBeGreaterThan(0);
    const before = FANOUT.slice(Math.max(0, callIdx - 1500), callIdx);
    const after = FANOUT.slice(callIdx, callIdx + 1500);
    expect(before).toMatch(/try\s*\{/);
    expect(after).toMatch(/\}\s*catch/);
  });

  it("(C4.b) the enqueueGraphReconcileJob call site is inside a try/catch (in fan-out service)", () => {
    const callIdx = FANOUT.indexOf("await enqueueGraphReconcileJob(");
    expect(callIdx, "live enqueueGraphReconcileJob call must exist").toBeGreaterThan(0);
    const before = FANOUT.slice(Math.max(0, callIdx - 1500), callIdx);
    const after = FANOUT.slice(callIdx, callIdx + 1500);
    expect(before).toMatch(/try\s*\{/);
    expect(after).toMatch(/\}\s*catch/);
  });

  it("(C4.c) evidence-complete wraps the fan-out call itself in try/catch", () => {
    const callIdx = SVC.indexOf("runEvidenceFinalizationFanout(");
    expect(callIdx).toBeGreaterThan(0);
    const before = SVC.slice(Math.max(0, callIdx - 1500), callIdx);
    const after = SVC.slice(callIdx, callIdx + 1500);
    expect(before).toMatch(/try\s*\{/);
    expect(after).toMatch(/\}\s*catch/);
  });

  it("(C5) the fan-out file marks itself as the post-finalize fan-out owner", () => {
    expect(FANOUT).toMatch(/Evidence finalization fan-out service/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Group D — Invariants preserved
// ───────────────────────────────────────────────────────────────────────

describe("Investigation P0+P1 — Group D: invariants preserved", () => {
  const PAGE = readFile("apps/web/app/(app)/investigation/page.tsx");

  it("(D1.a) /investigation page still uses GET /v1/investigation/overview (no v2)", () => {
    expect(PAGE).toMatch(/\/v1\/investigation\/overview/);
    expect(PAGE).not.toMatch(/\/v2\/investigation/);
  });

  it("(D1.b) /investigation page still uses GET /v1/investigation/reviewers (no v2)", () => {
    expect(PAGE).toMatch(/\/v1\/investigation\/reviewers/);
  });

  it("(D2) error.tsx is segment-scoped under /investigation, NOT promoted to global", () => {
    // The segment-scoped boundary lives in the investigation subtree.
    const segmentErrorPath = resolve(
      REPO_ROOT,
      "apps/web/app/(app)/investigation/error.tsx",
    );
    expect(existsSync(segmentErrorPath)).toBe(true);
    // The GLOBAL boundary at apps/web/app/error.tsx remains as the
    // last-resort root boundary, but it must NOT have been replaced
    // with an investigation-specific implementation.
    const globalErrorPath = resolve(REPO_ROOT, "apps/web/app/error.tsx");
    expect(existsSync(globalErrorPath)).toBe(true);
    const globalSrc = readFileSync(globalErrorPath, "utf8");
    expect(globalSrc).not.toMatch(/web_investigation_segment/);
    expect(globalSrc).not.toMatch(/data-investigation-error/);
  });

  it("(D3.a) reconcileTeamGraph is still exported by the canonical graph-builder source", () => {
    // The slice replaced the CALL SITE only. The function itself must
    // remain importable because the worker processor and the operator
    // manual-trigger ops route still call it.
    //
    // Phase 31.22 moved the canonical implementation into
    // packages/shared-runtime/src/graph/graph-builder.service.ts; the
    // services/api/src/services/graph/graph-builder.service.js is now
    // a re-export shim. Pin the canonical source so the export survives
    // future refactors regardless of where the shim points.
    const canonical = readFile(
      "packages/shared-runtime/src/graph/graph-builder.service.ts",
    );
    expect(canonical).toMatch(/export\s+async\s+function\s+reconcileTeamGraph\s*\(/);
  });

  it("(D3.b) reconcileTeamGraph remains importable from at least one production consumer", () => {
    // Confirms the function is still wired into a live caller. The
    // worker queue processor or ops route is the canonical place.
    const opsPath = resolve(REPO_ROOT, "services/api/src/routes/ops.routes.ts");
    const workerPath = resolve(
      REPO_ROOT,
      "services/worker/src/queue/subsystem-queue-processors.ts",
    );
    const opsImports = existsSync(opsPath)
      ? readFileSync(opsPath, "utf8").includes("reconcileTeamGraph")
      : false;
    const workerImports = existsSync(workerPath)
      ? readFileSync(workerPath, "utf8").includes("reconcileTeamGraph")
      : false;
    expect(
      opsImports || workerImports,
      "reconcileTeamGraph must still be consumed by ops route or worker processor",
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Group E — Graph reconcile queue helper (extracted file)
// ───────────────────────────────────────────────────────────────────────

describe("Investigation P0+P1 — Group E: graph reconcile queue helper (extracted)", () => {
  const HELPER_REL = "services/api/src/queue/graph-reconcile-queue.ts";
  const HELPER_PATH = resolve(REPO_ROOT, HELPER_REL);

  it("(E1) services/api/src/queue/graph-reconcile-queue.ts exists", () => {
    // The Part 1 extraction moved the inlined BullMQ producer out of
    // evidence-complete.service.ts into a dedicated per-queue helper
    // (mirrors search-queue.ts / media-intelligence-queue.ts). This
    // assertion locks in the file's existence so a future regression
    // that re-inlines the producer is caught immediately.
    expect(existsSync(HELPER_PATH), `${HELPER_REL} must exist`).toBe(true);
  });

  it("(E2) helper exports enqueueGraphReconcileJob function", () => {
    const src = readFile(HELPER_REL);
    // Accept either `export async function …` or `export const … =`.
    expect(src).toMatch(
      /export\s+(?:async\s+)?function\s+enqueueGraphReconcileJob\s*\(/,
    );
  });

  it("(E3) helper defines GraphReconcileJobPayload with 5 fields (2 required, 3 optional)", () => {
    const src = readFile(HELPER_REL);
    // Locate the payload type/interface declaration.
    expect(src).toMatch(
      /export\s+(?:interface|type)\s+GraphReconcileJobPayload\b/,
    );
    // Extract the declaration body so subsequent field assertions only
    // search inside the payload shape (not unrelated regions).
    const bodyMatch = src.match(
      /GraphReconcileJobPayload[\s\S]{0,40}\{([\s\S]*?)\}/,
    );
    expect(bodyMatch, "GraphReconcileJobPayload body must be readable").not.toBeNull();
    const body = bodyMatch?.[1] ?? "";
    // Required fields (no `?:` between name and colon).
    expect(body).toMatch(/\bteamId\s*:/);
    expect(body).not.toMatch(/\bteamId\?\s*:/);
    expect(body).toMatch(/\breason\s*:/);
    expect(body).not.toMatch(/\breason\?\s*:/);
    // Optional fields (the `?:` is the contract).
    expect(body).toMatch(/\bevidenceId\?\s*:/);
    expect(body).toMatch(/\brequestedByUserId\?\s*:/);
    expect(body).toMatch(/\brequestId\?\s*:/);
  });

  it("(E4) helper builds deterministic jobId `graph-reconcile:${teamId}:${reason}:${evidenceId ?? \"workspace\"}`", () => {
    const src = readFile(HELPER_REL);
    // Locate the template literal. Allow the `evidenceId ?? "workspace"`
    // fallback to be applied either inline in the template or in a
    // local variable assigned just above it.
    expect(src).toMatch(/graph-reconcile:\$\{[\s\S]{0,80}teamId[\s\S]{0,80}\}/);
    // Confirm the "workspace" fallback string is the chosen sentinel
    // for the no-evidence case.
    expect(src).toMatch(/evidenceId[\s\S]{0,40}\?\?[\s\S]{0,20}["']workspace["']/);
  });

  it("(E5) helper wraps the enqueue in try/catch and returns { queued: false } on failure (never throws)", () => {
    const src = readFile(HELPER_REL);
    // There must be a try/catch around the queue interaction.
    expect(src).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
    // The failure path must produce a `queued: false` result (the
    // brief-specified shape) rather than rethrowing.
    expect(src).toMatch(/queued\s*:\s*false/);
    // And the missing-REDIS_URL branch must also return rather than
    // throw — assert there is no `throw new` inside the exported
    // enqueue function body.
    const fnMatch = src.match(
      /export\s+(?:async\s+)?function\s+enqueueGraphReconcileJob[\s\S]*$/,
    );
    expect(fnMatch, "enqueueGraphReconcileJob body must be readable").not.toBeNull();
    const body = fnMatch?.[0] ?? "";
    expect(body).not.toMatch(/\bthrow\s+new\s+/);
  });

  it("(E6) helper uses queue name 'graph-reconcile' and job name 'ReconcileTeamGraph'", () => {
    const src = readFile(HELPER_REL);
    // Queue name — the BullMQ Queue constructor or a const it reads.
    expect(src).toMatch(/["']graph-reconcile["']/);
    // Job name passed to queue.add(…) — matches the worker-side
    // processor registration name.
    expect(src).toMatch(/["']ReconcileTeamGraph["']/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Group F — Byte-pin compliance preserved
// ───────────────────────────────────────────────────────────────────────

describe("Investigation P0+P1 — Group F: byte-pin compliance preserved", () => {
  // The canonical byte-pin for evidence-complete.service.ts lives in
  // services/api/test/phase-r8-enterprise-identity-security.test.ts
  // (Part 10 — canonical capture/custody/TSA/report files unchanged):
  //   { rel: "src/services/evidence-complete.service.ts",
  //     expectedBytes: 41849 }  // pinned at ±10%  → cap 46034
  // Hard-coded here so this regression test fails loudly if the file
  // grows past the documented cap, regardless of whether the upstream
  // pin file is reachable from this test context.
  const PIN_BASELINE_BYTES = 41849;
  const PIN_TOLERANCE = 0.1;
  const CAP_BYTES = Math.floor(PIN_BASELINE_BYTES * (1 + PIN_TOLERANCE));

  it("(F1) evidence-complete.service.ts is below the documented byte-pin cap", () => {
    const svcPath = resolve(
      REPO_ROOT,
      "services/api/src/services/evidence-complete.service.ts",
    );
    const sizeBytes = readFileSync(svcPath, "utf8").length;
    expect(
      sizeBytes,
      `evidence-complete.service.ts is ${sizeBytes} bytes; ` +
        `must be ≤ ${CAP_BYTES} (baseline ${PIN_BASELINE_BYTES} ± ${PIN_TOLERANCE * 100}%)`,
    ).toBeLessThanOrEqual(CAP_BYTES);
  });
});
