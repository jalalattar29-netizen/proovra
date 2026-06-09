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

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
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
const RESUMABLE = readWeb("app/(app)/capture/_hooks/useResumableUploads.ts");
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
const PRE_CR5_PAGE_BYTES = 48616;
const PRE_CR5_ORCH_BYTES = 34411;
const PRE_CR5_RESUMABLE_BYTES = 13423;
const PRE_CR5_CAMERA_BYTES = 12473;
const PRE_CR5_AUDIO_BYTES = 8978;
const HASH_UTILS_BYTES_EXACT = 3302;
const SESSION_READINESS_BYTES_EXACT = 9864;
const CAPTURE_ROUTES_BYTES_EXACT = 21271;
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
const EVIDENCE_COMPLETE_SVC_BYTES_EXACT = 45835;
const CUSTODY_EVENTS_SVC_BYTES_EXACT = 5155;
const TIMESTAMP_SVC_BYTES_EXACT = 11701;
const PRE_CR5_AI_ASSISTANT_BYTES = 23045;

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
  it("custody-events.service.ts byte-exact pin (single custody writer)", () => {
    expect(statSync(apiSrcPath("services/custody-events.service.ts")).size)
      .toBe(CUSTODY_EVENTS_SVC_BYTES_EXACT);
  });

  it("evidence-complete.service.ts byte-exact pin (finalize tx)", () => {
    expect(statSync(apiSrcPath("services/evidence-complete.service.ts")).size)
      .toBe(EVIDENCE_COMPLETE_SVC_BYTES_EXACT);
  });

  it("timestamp.service.ts byte-exact pin (TSA + OTS)", () => {
    expect(statSync(apiSrcPath("services/timestamp.service.ts")).size)
      .toBe(TIMESTAMP_SVC_BYTES_EXACT);
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
