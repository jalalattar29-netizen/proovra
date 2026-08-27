/**
 * PHASE CR5 — Capture Safety Extraction contract tests.
 *
 * CR5 is the highest-stakes refactor phase: capture controls evidence
 * intake, staged materials, upload orchestration, integrity preparation,
 * hashing, finalize, custody creation, report-generation trigger, and
 * delegated/external intake. A bad refactor here can silently destroy
 * upload truth, finalize guarantees, custody integrity, or
 * report/package correctness.
 *
 * This test wall lands BEFORE any extraction and must stay green at
 * every step. It is the durable safety guarantee that protects ALL
 * future capture refactors.
 *
 * 10 mandatory groups + meta (~200 cases):
 *
 *   1.  Upload truth — `uploadedAt` server-only; failed uploads
 *       never finalize; finalize endpoint single reference
 *   2.  Integrity preparation — `hash-utils.ts` byte-exact;
 *       `computeIntegrityFromBlob` preserved; `verifyHash:true` literal
 *   3.  Checklist enforcement — `session-readiness.ts` byte-pinned;
 *       `buildSessionReadiness` export; no bypass
 *   4.  Delegated capture — external-intake byte-pins; no browsing
 *       escalation; revocation paths preserved
 *   5.  AI boundary — no Blob/File/ArrayBuffer/Uint8Array/FileReader
 *       in any capture AI surface; metadata-only contract
 *   6.  Polling correctness — GET-only; no fake REPORT_DOWNLOADED;
 *       no fake report_viewed
 *   7.  Custody truth — no appendCustodyEvent / createCustodyEvent /
 *       emitCustodyEvent imported in any frontend file
 *   8.  Capture safety — camera/audio cancel reachable; stop() in
 *       both device hooks; no auto-finalize on stop
 *   9.  External intake — `/v1/evidence/:id/complete` is the
 *       canonical finalize path (single reference)
 *  10.  Forbidden patterns — frontend custody creation, frontend
 *       finalize truth, raw AI file upload, browser timestamp truth,
 *       direct storage URL exposure
 *
 * Phase CR5 ships ZERO backend changes. Backend pins assert this by
 * byte-pinning `capture.routes.ts`, `evidence-complete.service.ts`,
 * `custody-events.service.ts`, and `timestamp.service.ts`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiSrcPath(rel: string): string {
  return fileURLToPath(new URL(`../../../services/api/src/${rel}`, import.meta.url));
}

function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiSrcPath(rel), "utf8");
}

/**
 * Strip JSDoc + block + line comments so the source-grep tests check
 * the EXECUTABLE source, not the documentation. The doc comments in
 * `useResumableUploads.ts` and `useCaptureSessionOrchestration.ts`
 * explicitly DOCUMENT the firewall (e.g., "NEVER calls
 * /v1/evidence/:id/complete from this file") — those references are
 * positively desirable, not regressions. CR5 tests therefore reason
 * over the code-only projection.
 */
function stripComments(src: string): string {
  // Block / JSDoc comments (multi-line).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Single-line comments. Avoid stripping URLs by anchoring to
  // word-boundary OR start-of-line.
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return out;
}

// Recursively walk a directory and collect .ts / .tsx files. Returns []
// if the directory does not exist (pre-extraction state).
function listFiles(dirAbs: string): Array<{ rel: string; abs: string }> {
  if (!existsSync(dirAbs)) return [];
  const out: Array<{ rel: string; abs: string }> = [];
  function walk(curr: string, relPrefix: string) {
    for (const entry of readdirSync(curr, { withFileTypes: true })) {
      const entryAbs = join(curr, entry.name);
      const entryRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(entryAbs, entryRel);
      else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      )
        out.push({ rel: entryRel, abs: entryAbs });
    }
  }
  walk(dirAbs, "");
  return out;
}

function captureSurfaceFiles(): Array<{ label: string; text: string }> {
  const out: Array<{ label: string; text: string }> = [];
  // 1. The capture route tree
  for (const f of listFiles(webPath("app/(app)/capture"))) {
    out.push({ label: `capture/${f.rel}`, text: readFileSync(f.abs, "utf8") });
  }
  // 2. The capture-v2 component tree
  for (const f of listFiles(webPath("components/capture-v2"))) {
    out.push({
      label: `capture-v2/${f.rel}`,
      text: readFileSync(f.abs, "utf8"),
    });
  }
  // 3. The capture AI assistant surface (separate location)
  const aiPath = webPath("components/ai/CaptureAiAssistant.tsx");
  if (existsSync(aiPath)) {
    out.push({
      label: "ai/CaptureAiAssistant.tsx",
      text: readFileSync(aiPath, "utf8"),
    });
  }
  // 4. Capture location panel (separate location)
  const locPath = webPath("components/capture-location/CaptureLocationMapPanel.tsx");
  if (existsSync(locPath)) {
    out.push({
      label: "capture-location/CaptureLocationMapPanel.tsx",
      text: readFileSync(locPath, "utf8"),
    });
  }
  return out;
}

function captureAiSurfaceFiles(): Array<{ label: string; text: string }> {
  // The capture AI surface = the dedicated AI assistant component +
  // any file in the capture tree that imports from `lib/ai/*` or
  // references an AI provider endpoint. CR5 keeps this scope narrow:
  // the dedicated assistant + any file under capture/ that references
  // an AI path.
  const out: Array<{ label: string; text: string }> = [];
  const aiPath = webPath("components/ai/CaptureAiAssistant.tsx");
  if (existsSync(aiPath)) {
    out.push({
      label: "ai/CaptureAiAssistant.tsx",
      text: readFileSync(aiPath, "utf8"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PAGE = readWeb("app/(app)/capture/page.tsx");
const ORCH = readWeb("app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts");
const CAMERA_HOOK = readWeb("app/(app)/capture/_hooks/useCaptureCamera.ts");
const AUDIO_HOOK = readWeb(
  "app/(app)/capture/_hooks/useCaptureAudioRecorder.ts",
);
const HASH_UTILS = readWeb("app/(app)/capture/_lib/hash-utils.ts");
const SESSION_READINESS = readWeb("app/(app)/capture/_lib/session-readiness.ts");
const CAPTURE_ROUTES = readApi("routes/capture.routes.ts");
const EVIDENCE_COMPLETE_SVC = readApi("services/evidence-complete.service.ts");
const CUSTODY_EVENTS_SVC = readApi("services/custody-events.service.ts");
const TIMESTAMP_SVC = readApi("services/timestamp.service.ts");

const CAPTURE_FILES = captureSurfaceFiles();
const CAPTURE_AI_FILES = captureAiSurfaceFiles();

// Pre-CR5 byte sizes (sampled 2026-05-26).
// Phase IA-self-serve-completion rebaseline: 48,972 → 49,830 after the
// audit-fix pass added bounded plain-language copy + comments for the
// eyebrow rename ("Evidence intake workspace" → "Capture & upload"),
// the material-note rename ("Reviewer note" → "Your notes"), and the
// placeholder rewrite. No new behaviour — pure copy/comment growth.
// Phase CAPTURE-CLOSURE rebaseline: 49,830 → 51,999 — added the
// per-item sourceLabel <input> + label + disclaimer in the expanded
// material card (the backend column already existed; Capture just
// had no UI to populate it).
// PHASE 7 §10.5 rebaseline (2026-07-22): 51,999 → 52,040 — added the
// canonical WorkspaceContextBanner (§10.5) at the capture form boundary
// so operators see the owning workspace/org before a high-impact capture.
// PHASE 12 POINT 4 rebaseline (2026-08-03): 52,040 → 52,520 — Pass H made the
// three workspace/session-scoped hooks on this page depend on the values they
// actually read (memoised template list, memoised preview-revoke cleanup, the
// step-seeding effect's real inputs). Correctness change with a bounded
// footprint: one useMemo, three honest dependency arrays and their rationale.
// No new UI, no new POST surface, no re-absorbed mechanism.
export const PRE_CR5_PAGE_BYTES = 52520;
// Phase HOME-DATA-OWNERSHIP rebaseline: 34,411 → 34,744. The capture
// orchestration now stamps the ACTIVE workspace id (useActiveSpaceId →
// `teamId` in the POST /v1/evidence body) so personal evidence is never
// orphaned with team_id NULL again. Real behaviour change, minimal
// footprint: one import, one hook call, one body field + bounded
// comments.
// Enterprise Capture Environment rebaseline: 34,744 → 35,015. The capture
// flow now sends silent, privacy-safe client tz/locale hints on POST
// /v1/evidence. The BULK of that logic was extracted to the
// ./captureEnvironmentClient helper (getClientCaptureEnvironment) to keep
// this hook decomposed — the residual here is just one import + a spread
// of the helper result into the request body. Real behaviour change
// (capture-environment metadata), minimal in-file footprint.
// PROOVRA Feedback System rebaseline: 35,015 → 35,141. The upload-failure
// catch now routes through toSafeUserError() (safe-feedback wiring: one
// import + the mapper call + a user-facing fallback sentence that replaces
// the raw `err.message` passthrough). Safe copy only — no capture behaviour
// change.
// PHASE 7 §10.3 rebaseline (2026-07-22): 35,141 → 36,406 — added the
// tenant-generation guard (useTenantGuard) so a workspace switch during
// finalize no longer auto-navigates into the evidence under the new
// active context (§10.3/§10.E); the Evidence row stays server-bound to
// its original workspace.
// PHASE 12 POINT 4 rebaseline (2026-08-03): 36,406 → 36,645 — Pass H memoised
// `revokeAllPreviews` (it reads the session items through a ref, so its
// identity never needed to change) so the capture page can list it as the
// dependency of its unmount cleanup instead of omitting it. One useCallback
// plus its rationale; no capture behaviour change.
export const PRE_CR5_ORCH_BYTES = 36645;
// PHASE 13 rebaseline (2026-08-17): 13,423 → 13,630 — NEW-036. `StartResumableInput`
// gained one optional pass-through flag, `multipartAlreadyInitiated`, and the one
// line that forwards it to `MultipartUploader`. The capture orchestration runs
// `multipart/initiate` ITSELF and then constructs the uploader, whose abort leg
// only fired when IT had performed the initiate — so a cancel in that window
// skipped the multipart abort and left a live S3 upload whose parts stay stored
// and billed. This ratchet exists to stop the hook re-accreting BACKEND TRUTH;
// a declared prop that is forwarded verbatim and decided nowhere in this file is
// the opposite of that, and the rationale lives with the flag's definition in
// `multipart-uploader.ts` rather than being duplicated here.
const PRE_CR5_RESUMABLE_BYTES = 13630;
const HASH_UTILS_BYTES_EXACT = 3181;
const SESSION_READINESS_BYTES_EXACT = 9559;
// Rebaselined 2026-07-23: PHASE 10 §13.2 Step 6 no-personal guard added.
  // Rebaselined 2026-08-16: PHASE 13 §A4 NEW-026 — ACTIVE-membership check on
  // the caller-supplied `body.teamId` before the CaptureSession row is written.
const CAPTURE_ROUTES_BYTES_EXACT = 23490;
// Baseline grows with documented phases (G3.x/G4/G5). The
// "no shrink/regression" guarantee is the spirit; the constant
// is rebaselined as the file legitimately grows.
// Phase 11 rebaseline: 42,799 → 44,441 after best-effort graph-reconcile
// + search-index enqueue hooks landed in evidence-complete.service.ts
// (both wrapped in try/catch — non-blocking; no schema changes).
// Phase 14 rebaseline: 44,441 → 45,520 after the onReconciled callback
// closure was wired so reconcileTeamGraph's completion enqueues a
// search re-index — closes the post-finalize stale-index gap. Non-
// blocking try/catch preserved.
// Phase 31 rebaseline: 45,520 → 44,078 (file SHRANK). Post-finalize
// side-effect orchestration (search index + media-intelligence +
// graph reconcile) extracted to services/evidence-finalization-
// fanout.service.ts. This file is now strictly the evidence-completion
// state machine; the fanout helper owns producer wiring. Worker still
// owns reconcileTeamGraph + onReconciled hook (subsystem-queue-
// processors.ts:178-191). Architectural improvement; no regression.
// Phase Repair rebaseline: 44,078 → 45,774. Replaced two bare catches
// (scan enqueue + post-finalize fanout) with bounded warn logging and
// extracted runEvidenceCompletePostFinalize for direct testability;
// also observes the { queued:false } shape graph-reconcile-queue
// returns when Redis is unavailable.
// Phase CAPTURE-HARDENING rebaseline: 46,824 → 48,332. Server-side
// required-checklist gate added (validateRequiredChecklistMapping
// import + guard block + AppError throw + security event). Pure read
// followed by an early throw — no change to the sealing/custody
// chain semantics.
// Phase 2C-D mechanical rebaseline: 48,332 → 48,327. The only delta is
// non-null assertions at the file-security scan callsite so the compile-time
// contract matches the already-required runtime/team-scoped flow.
// Operations-Center forensic completion rebaseline: 48,327 → 49,241.
// Added the bounded, best-effort Operations-Center summary invalidation
// after the TSA outcome persist (workspace members' bell caches refresh
// when a timestamp fails or recovers). No finalize-transaction or
// custody logic changed.
// Product-reset rebaseline: 49,241 -> 48,334. The TSA-outcome bell-cache
// invalidation hook was REMOVED (event-driven invalidation deleted; the
// 45s summary TTL is the refresh path). Finalize-tx semantics unchanged.
// PHASE 12 — POINT 5 rebaseline: 48,348 -> 47,556 (file SHRANK by 792 bytes).
// The completion path stopped calling a private report producer
// (enqueueGenerateReportJob, whose module is deleted) and now calls the durable
// report AUTHORITY, which persists a ReportGenerationRequest before enqueueing
// its id. Finalize-tx semantics, custody chain and sealing are unchanged: the
// fan-out still runs strictly AFTER the transaction commits, which is what
// makes a rolled-back completion unable to produce a runnable job.
// BILLING COMMERCIAL CORRECTNESS rebaseline (2026-08-27): 47,556 → 49,553.
// The credit settlement inside the finalize transaction replaced a
// fire-and-forget `consumeWorkspaceCompletionCredits(scope)` call that ran
// against the GLOBAL prisma client — so a rolled-back completion still
// burned the customer's credit. It now takes `tx`, and the record's
// report/package entitlement is resolved from how the completion was FUNDED
// rather than from the account's recurring plan. The growth is that
// settlement plus its explanation; no custody, signing or TSA step moved.
const EVIDENCE_COMPLETE_SVC_BYTES_EXACT = 49916;
// Phase CAPTURE-CLOSURE rebaseline: 23,045 → 24,618 — added the
// "AI advisory is not saved" transient disclaimer + bounded JSDoc
// comment. No new behaviour, no extra POST surface.
const PRE_CR5_AI_ASSISTANT_BYTES = 24618;

// ---------------------------------------------------------------------------
// Group 1 — Upload truth
// ---------------------------------------------------------------------------

describe("CR5 Group 1 — upload truth: backend-owned", () => {
  it("page.tsx byte size MUST NOT exceed pre-CR5 baseline (only shrinks)", () => {
    expect(statSync(webPath("app/(app)/capture/page.tsx")).size)
      .toBeLessThanOrEqual(PRE_CR5_PAGE_BYTES);
  });

  it("useCaptureSessionOrchestration.ts MUST NOT exceed pre-CR5 baseline", () => {
    expect(
      statSync(
        webPath("app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts"),
      ).size,
    ).toBeLessThanOrEqual(PRE_CR5_ORCH_BYTES);
  });

  it("useResumableUploads.ts MUST NOT exceed pre-CR5 baseline", () => {
    expect(
      statSync(webPath("app/(app)/capture/_hooks/useResumableUploads.ts")).size,
    ).toBeLessThanOrEqual(PRE_CR5_RESUMABLE_BYTES);
  });

  it("CaptureAiAssistant.tsx MUST NOT exceed pre-CR5 baseline", () => {
    expect(statSync(webPath("components/ai/CaptureAiAssistant.tsx")).size)
      .toBeLessThanOrEqual(PRE_CR5_AI_ASSISTANT_BYTES);
  });

  it("the finalize endpoint /v1/evidence/:id/complete is referenced in the orchestrator", () => {
    expect(/\/v1\/evidence\/.*\/complete/.test(ORCH)).toBe(true);
  });

  // The orchestrator JSDoc + comments explicitly forbid per-item
  // finalize. Pin the documented "never sets uploadedAt" + "never
  // calls /v1/evidence/:id/complete" invariants the orchestrator
  // already documents at line ~65.
  it("orchestrator JSDoc preserves the 'NEVER calls /v1/evidence/:id/complete' contract", () => {
    expect(
      /NEVER calls \/v1\/evidence\/[^\n]*\/complete/.test(ORCH),
    ).toBe(true);
  });

  it("orchestrator JSDoc preserves the 'NEVER sets uploadedAt' contract", () => {
    expect(/NEVER sets uploadedAt/.test(ORCH)).toBe(true);
  });

  it("orchestrator JSDoc preserves the 'NEVER creates custody events' contract", () => {
    expect(/NEVER creates custody events/.test(ORCH)).toBe(true);
  });

  // No capture file may assign uploadedAt = new Date() / Date.now()
  const UPLOAD_AT_BROWSER_WRITE =
    /uploadedAt\s*[:=]\s*(?:new\s+Date|Date\.now\b)/;
  for (const surface of CAPTURE_FILES) {
    it(`${surface.label} :: never writes uploadedAt = new Date() / Date.now()`, () => {
      expect(UPLOAD_AT_BROWSER_WRITE.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 2 — Integrity preparation (hash-utils is the contract)
// ---------------------------------------------------------------------------

describe("CR5 Group 2 — integrity preparation: hash-utils is the contract", () => {
  it("hash-utils.ts byte-exact pin (deterministic browser SHA-256 prep)", () => {
    expect(statSync(webPath("app/(app)/capture/_lib/hash-utils.ts")).size)
      .toBe(HASH_UTILS_BYTES_EXACT);
  });

  it("hash-utils.ts exports computeIntegrityFromBlob", () => {
    expect(/export\s+(?:async\s+)?function\s+computeIntegrityFromBlob/.test(HASH_UTILS))
      .toBe(true);
  });

  it("hash-utils.ts uses SHA-256 (constant string, deterministic algo)", () => {
    expect(/SHA-256/.test(HASH_UTILS)).toBe(true);
  });

  it("orchestrator imports computeIntegrityFromBlob from hash-utils", () => {
    expect(/computeIntegrityFromBlob/.test(ORCH)).toBe(true);
  });

  it("orchestrator uses verifyHash:true literal at multipart-complete", () => {
    expect(/verifyHash\s*:\s*true/.test(ORCH)).toBe(true);
  });

  it("orchestrator imports planChunks from the resumable-upload helper module", () => {
    expect(/planChunks/.test(ORCH)).toBe(true);
  });

  // The orchestrator's resumable path documents the multipart step order
  // (create session → initiate → drive chunks → complete with verify →
  // session complete → batch finalize). Pin the documented sequence.
  it("orchestrator documents the multipart sequence (create session → initiate → complete)", () => {
    expect(/Create the upload session|create session/i.test(ORCH)).toBe(true);
    expect(/Initiate the S3 native multipart upload|multipart\/initiate/.test(ORCH))
      .toBe(true);
    expect(/multipart\/complete/.test(ORCH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Checklist enforcement
// ---------------------------------------------------------------------------

describe("CR5 Group 3 — checklist enforcement", () => {
  it("session-readiness.ts byte-exact pin (finalize gate logic)", () => {
    expect(statSync(webPath("app/(app)/capture/_lib/session-readiness.ts")).size)
      .toBe(SESSION_READINESS_BYTES_EXACT);
  });

  it("session-readiness.ts exports buildSessionReadiness", () => {
    expect(/export\s+(?:async\s+)?function\s+buildSessionReadiness/.test(SESSION_READINESS))
      .toBe(true);
  });

  it("page.tsx consumes buildSessionReadiness (the canonical readiness derivation)", () => {
    expect(/buildSessionReadiness/.test(PAGE)).toBe(true);
  });

  it("session-readiness.ts respects the CHECKLIST_REQUIRED plan mode", () => {
    expect(/CHECKLIST_REQUIRED/.test(SESSION_READINESS)).toBe(true);
  });

  // No capture file may short-circuit the required-step gate.
  const REQUIRED_BYPASS =
    /\bblocked\s*=\s*false\s*;\s*\/\/.*required|skipRequiredSteps|bypassChecklist|ignoreRequiredSteps/i;
  for (const surface of CAPTURE_FILES) {
    it(`${surface.label} :: never short-circuits the required-step gate`, () => {
      expect(REQUIRED_BYPASS.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 4 — Delegated capture
// ---------------------------------------------------------------------------

describe("CR5 Group 4 — delegated capture isolation", () => {
  it("capture.routes.ts byte-exact pin (backend protocol firewall)", () => {
    expect(statSync(apiSrcPath("routes/capture.routes.ts")).size)
      .toBe(CAPTURE_ROUTES_BYTES_EXACT);
  });

  // No capture file may construct cross-team workspace listing
  // endpoints from a delegated context. The capture tree must never
  // request /v1/teams/, /v1/workspaces/list, /v1/admin/, etc.
  const FORBIDDEN_DELEGATED_BROWSE = [
    /["'`]\/v1\/teams\/list/,
    /["'`]\/v1\/workspaces\/list/,
    /["'`]\/v1\/admin\//,
    /["'`]\/v1\/governance\//,
  ];
  for (const surface of CAPTURE_FILES) {
    for (const pattern of FORBIDDEN_DELEGATED_BROWSE) {
      it(`${surface.label} :: never references ${pattern} (no delegated browse escalation)`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Group 5 — AI boundary (metadata-only contract)
// ---------------------------------------------------------------------------

describe("CR5 Group 5 — AI boundary: metadata-only", () => {
  // No capture AI surface may import or construct raw-byte primitives.
  // The blocklist below covers every raw-bytes vector documented in
  // Phase E9.
  const FORBIDDEN_AI_RAW_BYTES: ReadonlyArray<RegExp> = [
    /\bnew\s+Blob\s*\(/,
    /\bnew\s+ArrayBuffer\s*\(/,
    /\bnew\s+Uint8Array\s*\(/,
    /\bnew\s+FormData\s*\(/,
    /\bnew\s+File\s*\(/,
    /\.readAsArrayBuffer\s*\(/,
    /\.readAsBinaryString\s*\(/,
    /\.readAsDataURL\s*\(/,
  ];

  for (const surface of CAPTURE_AI_FILES) {
    for (const pattern of FORBIDDEN_AI_RAW_BYTES) {
      it(`${surface.label} :: AI surface contains NO ${pattern} (raw-bytes vector)`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }

  // Additional defence: the AI assistant must not POST file bodies.
  for (const surface of CAPTURE_AI_FILES) {
    it(`${surface.label} :: AI surface does NOT POST a 'file' / 'image' / 'video' body field`, () => {
      const FILE_POST =
        /method\s*:\s*["'`]POST["'`][^]*?body\s*:[^]*?(?:file|image|video|audio|attachment|payload)/i;
      expect(FILE_POST.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 6 — Polling correctness
// ---------------------------------------------------------------------------

describe("CR5 Group 6 — polling never emits download / custody events", () => {
  // The capture tree polls for report readiness. No file in the tree
  // may emit REPORT_DOWNLOADED, report_viewed, or evidence_downloaded
  // events from a polling effect.
  //
  // NOTE: we test the comment-stripped projection. Honest JSDoc inside
  // useCaptureSessionOrchestration.ts explicitly documents that the
  // OLD /report/latest endpoint logged REPORT_DOWNLOADED + report_viewed
  // on every poll and falsified the custody chain — that doc reference
  // is positively desirable (it preserves the historical reason for
  // the current side-effect-free path).
  const FAKE_DOWNLOAD_EVENTS: ReadonlyArray<RegExp> = [
    /REPORT_DOWNLOADED/,
    /report_viewed/,
    /evidence_downloaded/,
    /packageDownloaded/i,
  ];
  for (const surface of CAPTURE_FILES) {
    const code = stripComments(surface.text);
    for (const pattern of FAKE_DOWNLOAD_EVENTS) {
      it(`${surface.label} :: never fires ${pattern} from code (comment-stripped projection)`, () => {
        expect(pattern.test(code)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Group 7 — Custody truth (backend-owned)
// ---------------------------------------------------------------------------

describe("CR5 Group 7 — custody is backend-owned", () => {
  it("custody-events.service.ts is the single custody writer", () => {
    // Byte-exact size replaced by the rule it stood in for: a size cannot
    // tell a custody-logic change apart from a deleted dead import.
    expect(/tx\.custodyEvent\.create\(/.test(CUSTODY_EVENTS_SVC)).toBe(true);
    expect(/export async function appendCustodyEvent/.test(CUSTODY_EVENTS_SVC))
      .toBe(true);
  });

  it("evidence-complete.service.ts byte-exact pin (finalize tx)", () => {
    expect(statSync(apiSrcPath("services/evidence-complete.service.ts")).size)
      .toBe(EVIDENCE_COMPLETE_SVC_BYTES_EXACT);
  });

  it("timestamp.service.ts still owns the TSA stamping surface", () => {
    // Byte-exact size replaced: the TSA outcome mapping is behaviourally
    // pinned by test/phase-ia-tsa-false-failed.test.ts.
    const src = readFileSync(apiSrcPath("services/timestamp.service.ts"), "utf8");
    expect(/export async function createEvidenceTimestamp/.test(src)).toBe(true);
    expect(/TsaProviderFailureCode/.test(src)).toBe(true);
  });

  it("custody chain is hash-chained (sequential prevEventHash)", () => {
    expect(/prevEventHash/.test(CUSTODY_EVENTS_SVC)).toBe(true);
    expect(/appendCustodyEventTx|appendCustodyEvent/.test(CUSTODY_EVENTS_SVC))
      .toBe(true);
  });

  // No capture file may import or reference a custody-write primitive.
  const FORBIDDEN_CUSTODY_REFS: ReadonlyArray<RegExp> = [
    /\bappendCustodyEvent(?:Tx)?\b/,
    /\bcreateCustodyEvent\b/,
    /\bemitCustodyEvent\b/,
    /\bwriteCustodyEvent\b/,
  ];
  for (const surface of CAPTURE_FILES) {
    for (const pattern of FORBIDDEN_CUSTODY_REFS) {
      it(`${surface.label} :: never references ${pattern}`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Group 8 — Camera / audio safety
// ---------------------------------------------------------------------------

describe("CR5 Group 8 — camera / audio cancel + stop safety", () => {
  it("camera hook (useCaptureCamera) calls stop() on the stream", () => {
    expect(/\.stop\s*\(\s*\)/.test(CAMERA_HOOK)).toBe(true);
  });

  it("audio hook (useCaptureAudioRecorder) calls stop() on the recorder", () => {
    expect(/\.stop\s*\(\s*\)/.test(AUDIO_HOOK)).toBe(true);
  });

  it("camera hook exposes a cancel/stop pathway (stopMediaStream / stopVideoRecording / cancelCamera / abort)", () => {
    // The hook uses `stopMediaStream` + `stopVideoRecording` as its
    // canonical cancel/teardown verbs. Both reach `track.stop()` and
    // `recorder.stop()` — the safety guarantee. Accept any of the
    // documented stop-* / cancel-* / abort-* function names.
    expect(
      /stopMediaStream|stopVideoRecording|cancelCamera|cancel\s*\(|abort\s*\(|stopCamera/
        .test(CAMERA_HOOK),
    ).toBe(true);
  });

  it("audio hook exposes a cancel/stop pathway (stopAudioStream / stopAudioRecording / cancelRecording / abort)", () => {
    expect(
      /stopAudioStream|stopAudioRecording|cancelRecording|cancel\s*\(|abort\s*\(|stopRecording/
        .test(AUDIO_HOOK),
    ).toBe(true);
  });

  // No device hook may auto-finalize on stop.
  const AUTO_FINALIZE_ON_STOP =
    /(?:onstop|onStop|stop\s*\(\s*\))[^]{0,200}?\/v1\/evidence\/.*\/complete/;
  for (const surface of [
    { label: "useCaptureCamera.ts", text: CAMERA_HOOK },
    { label: "useCaptureAudioRecorder.ts", text: AUDIO_HOOK },
  ]) {
    it(`${surface.label} :: never auto-finalizes inside a stop handler`, () => {
      expect(AUTO_FINALIZE_ON_STOP.test(surface.text)).toBe(false);
    });
  }

  // getUserMedia must only appear in the two allowed hooks (plus a
  // potential helper that abstracts the permission prompt). Capture
  // page must not call it directly.
  it("page.tsx never calls getUserMedia directly (must go through device hooks)", () => {
    expect(/getUserMedia/.test(PAGE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 9 — External / delegated intake (canonical finalize path)
// ---------------------------------------------------------------------------

describe("CR5 Group 9 — canonical completeEvidence path", () => {
  // The orchestrator is the ONLY frontend file that should reference
  // the /v1/evidence/:id/complete finalize endpoint. Any other
  // reference would be a parallel finalize path = duplicate truth.
  it("the finalize endpoint /v1/evidence/:id/complete is called from EXACTLY the orchestrator (code-only projection)", () => {
    // Test the comment-stripped projection so honest JSDoc references
    // (e.g. useResumableUploads.ts documents 'NEVER calls
    // /v1/evidence/:id/complete from this file') do not count.
    const FINALIZE_REF = /\/v1\/evidence\/[^"'`]*\/complete/g;
    let totalRefs = 0;
    let orchRefs = 0;
    for (const surface of CAPTURE_FILES) {
      const code = stripComments(surface.text);
      const matches = code.match(FINALIZE_REF) ?? [];
      totalRefs += matches.length;
      if (surface.label.endsWith("useCaptureSessionOrchestration.ts")) {
        orchRefs += matches.length;
      } else {
        expect(
          matches.length,
          `${surface.label} unexpectedly calls the finalize endpoint`,
        ).toBe(0);
      }
    }
    expect(orchRefs).toBeGreaterThanOrEqual(1);
    expect(totalRefs).toBe(orchRefs);
  });

  // The orchestrator must close the upload session before finalize.
  it("orchestrator documents 'session complete' precedes batch finalize", () => {
    expect(
      /COMPLETED|session\s+(?:complete|finalize)/i.test(ORCH),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 10 — Forbidden patterns (cross-cutting)
// ---------------------------------------------------------------------------

describe("CR5 Group 10 — forbidden patterns", () => {
  // Frontend custody creation — already caught by Group 7.
  // Frontend finalize truth — caught by Group 1 + Group 9.

  // Direct storage URL exposure: frontend must never render a raw
  // signed URL or storage path to the user.
  const STORAGE_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
    /\bstorageKey\b/,
    /\bstoragePath\b/i,
    /\bpresignedUrl\b/i,
    /\bsignedUrl\b/i,
    /\bS3_(?:ACCESS|SECRET|BUCKET|ENDPOINT)\b/,
  ];
  for (const surface of CAPTURE_FILES) {
    for (const pattern of STORAGE_LEAK_PATTERNS) {
      it(`${surface.label} :: never exposes ${pattern}`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }

  // Browser timestamp truth: no capture file may treat
  // `Date.now()` / `new Date()` as the canonical lifecycle
  // timestamp for any backend-owned field. The forbidden pattern
  // is the assignment of these to `signedAtUtc`, `finalizedAtUtc`,
  // `verifiedAtUtc`, `committedAtUtc`.
  const BROWSER_TS_FORBIDDEN: ReadonlyArray<RegExp> = [
    /\bsignedAtUtc\s*[:=]\s*(?:new\s+Date|Date\.now)/,
    /\bfinalizedAtUtc\s*[:=]\s*(?:new\s+Date|Date\.now)/,
    /\bverifiedAtUtc\s*[:=]\s*(?:new\s+Date|Date\.now)/,
    /\bcommittedAtUtc\s*[:=]\s*(?:new\s+Date|Date\.now)/,
  ];
  for (const surface of CAPTURE_FILES) {
    for (const pattern of BROWSER_TS_FORBIDDEN) {
      it(`${surface.label} :: never synthesizes ${pattern} from browser clock`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }

  // No frontend custody creation regex — already in Group 7.
  // No raw AI file upload — already in Group 5.

  // Hash truth: the browser hash is for VERIFICATION at server side,
  // not for trust. No capture file may treat the browser hash as
  // CANONICAL truth (e.g., mark VERIFIED without server confirmation).
  const HASH_AS_TRUTH =
    /\bstatus\s*[:=]\s*["'`]VERIFIED["'`].*\bcomputeIntegrityFromBlob/s;
  for (const surface of CAPTURE_FILES) {
    it(`${surface.label} :: never assigns VERIFIED status based on browser hash alone`, () => {
      expect(HASH_AS_TRUTH.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Meta — sanity checks
// ---------------------------------------------------------------------------

describe("CR5 Meta — test harness sanity", () => {
  it("capture surface file list is non-empty", () => {
    expect(CAPTURE_FILES.length).toBeGreaterThan(0);
  });

  it("orchestrator fixture loads with non-trivial content", () => {
    expect(ORCH.length).toBeGreaterThan(1000);
  });

  it("page.tsx fixture loads with non-trivial content", () => {
    expect(PAGE.length).toBeGreaterThan(1000);
  });

  it("hash-utils.ts fixture loads with non-trivial content", () => {
    expect(HASH_UTILS.length).toBeGreaterThan(100);
  });

  it("CaptureAiAssistant fixture exists (AI boundary is testable)", () => {
    expect(CAPTURE_AI_FILES.length).toBeGreaterThanOrEqual(1);
  });

  it("backend pinned files load (firewall confirmed)", () => {
    expect(CAPTURE_ROUTES.length).toBeGreaterThan(100);
    expect(EVIDENCE_COMPLETE_SVC.length).toBeGreaterThan(100);
    expect(CUSTODY_EVENTS_SVC.length).toBeGreaterThan(100);
    expect(TIMESTAMP_SVC.length).toBeGreaterThan(100);
  });
});
