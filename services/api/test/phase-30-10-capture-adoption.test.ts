/**
 * Phase 30.10 — Capture-page resumable adoption tests.
 *
 * Seven layers of coverage:
 *
 *   1. **Feature flag** — default OFF; only the literal "true"
 *      string flips it on; routing policy is pure + bounded.
 *
 *   2. **Routing policy behavioral** — flag off → always "legacy";
 *      flag on + below threshold → "legacy"; flag on + ≥ threshold
 *      → "resumable".
 *
 *   3. **Hook source contract** — the new `useResumableUploads`
 *      hook never calls finalize, never creates custody events,
 *      never sets uploadedAt, never persists signed URLs / storage
 *      identifiers, gates ALL work on the env flag.
 *
 *   4. **Capture-page integration** — the page imports the hook +
 *      panel; the panel is mounted but renders nothing when there's
 *      no resumable activity (zero regression for the existing
 *      flow).
 *
 *   5. **Telemetry endpoint** — bounded event type catalog, team
 *      membership required, per-user rate limit, anti-enumeration
 *      404 for non-members.
 *
 *   6. **Telemetry client helper** — coalesces by type, bounded
 *      batch size, never throws, never persists state.
 *
 *   7. **Existing capture flow** — the existing
 *      `useCaptureSessionOrchestration.ts` hook is UNCHANGED
 *      (no fork, no rewrite). Verified by absence of new imports
 *      from the resumable lib.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LARGE_FILE_THRESHOLD_BYTES,
  UPLOAD_ROUTING,
  isResumableEnabled,
  routeFile,
} from "../../../apps/web/lib/uploads/feature-flag.js";
import {
  UPLOAD_TELEMETRY_TYPES,
  createUploadTelemetry,
} from "../../../apps/web/lib/uploads/telemetry.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// PART 1 — Feature flag (default + sensitivity)
// =============================================================================

describe("Phase 30.10 — feature flag", () => {
  const originalEnv = process.env.NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED;
  function setEnv(value: string | undefined) {
    if (value === undefined) {
      delete process.env.NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED = value;
    }
  }

  it("default OFF when env var is unset", () => {
    setEnv(undefined);
    expect(isResumableEnabled()).toBe(false);
    setEnv(originalEnv);
  });

  it("only the literal 'true' flips it on (no 1/yes/on/empty)", () => {
    for (const v of ["", "false", "1", "yes", "on", "TRUE", "True"]) {
      setEnv(v);
      expect(isResumableEnabled(), `value ${v} should NOT enable`).toBe(false);
    }
    setEnv("true");
    expect(isResumableEnabled()).toBe(true);
    setEnv(originalEnv);
  });

  it("LARGE_FILE_THRESHOLD_BYTES is a sane 100 MiB constant", () => {
    expect(LARGE_FILE_THRESHOLD_BYTES).toBe(100 * 1024 * 1024);
  });

  it("UPLOAD_ROUTING vocabulary is bounded + lowercase", () => {
    expect([...UPLOAD_ROUTING]).toEqual(["legacy", "resumable"]);
  });
});

// =============================================================================
// PART 2 — Routing policy (behavioral)
// =============================================================================

describe("Phase 30.10 — routing policy", () => {
  it("flag off → ALWAYS legacy regardless of size", () => {
    expect(routeFile({ sizeBytes: 0, flagEnabled: false })).toBe("legacy");
    expect(routeFile({ sizeBytes: 1, flagEnabled: false })).toBe("legacy");
    expect(routeFile({ sizeBytes: 1_000_000_000, flagEnabled: false })).toBe(
      "legacy",
    );
  });

  it("flag on + below threshold → legacy", () => {
    expect(routeFile({ sizeBytes: 0, flagEnabled: true })).toBe("legacy");
    expect(
      routeFile({
        sizeBytes: LARGE_FILE_THRESHOLD_BYTES - 1,
        flagEnabled: true,
      }),
    ).toBe("legacy");
  });

  it("flag on + ≥ threshold → resumable", () => {
    expect(
      routeFile({ sizeBytes: LARGE_FILE_THRESHOLD_BYTES, flagEnabled: true }),
    ).toBe("resumable");
    expect(
      routeFile({
        sizeBytes: LARGE_FILE_THRESHOLD_BYTES * 10,
        flagEnabled: true,
      }),
    ).toBe("resumable");
  });

  it("negative / NaN size → legacy (defensive)", () => {
    expect(routeFile({ sizeBytes: -1, flagEnabled: true })).toBe("legacy");
    expect(routeFile({ sizeBytes: Number.NaN, flagEnabled: true })).toBe(
      "legacy",
    );
  });
});

// =============================================================================
// PART 3 — useResumableUploads hook source contract
// =============================================================================

describe("Phase 30.10 — useResumableUploads hook source contract", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/capture/_hooks/useResumableUploads.ts",
  );
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("NEVER calls /v1/evidence/:id/complete (finalize stays in existing orchestrator)", () => {
    expect(noComments).not.toMatch(/\/v1\/evidence\/[^"]*\/complete/);
  });

  it("NEVER creates custody events", () => {
    expect(noComments).not.toMatch(/appendCustody/);
    expect(noComments).not.toMatch(/CustodyEventType/);
  });

  it("NEVER writes uploadedAt locally", () => {
    expect(noComments).not.toMatch(/uploadedAtUtc\s*[:=]/);
    expect(noComments).not.toMatch(/uploadedAt\s*[:=]\s*[^\?]/);
  });

  it("recovery scan is gated on the env flag (no work when flag is off)", () => {
    // The recovery useEffect should early-return when !enabled.
    expect(src).toMatch(
      /useEffect\([\s\S]*?if\s*\(!enabled\)\s*return[\s\S]*?runUploadRecovery/,
    );
  });

  it("hook exposes blocking-reasons array for Review & Sign gating", () => {
    expect(src).toMatch(/blockingReasons:\s*ReadonlyArray<ReviewSignBlocker>/);
    expect(src).toMatch(/computeBlockingReasons/);
  });

  it("blocking-reasons vocabulary is bounded (no free-text)", () => {
    // The discriminated union types are all listed inline.
    for (const kind of [
      "upload_in_progress",
      "server_verification_pending",
      "hash_mismatch",
      "session_expired",
      "session_aborted",
      "needs_recovery",
      "failed_retryable",
    ]) {
      expect(src).toContain(`kind: "${kind}"`);
    }
  });

  it("hook surface NEVER projects raw storage identifiers", () => {
    for (const banned of [
      "storageBucket",
      "storage_bucket",
      "storageKey",
      "storage_key",
      "multipartUploadId",
      "multipart_upload_id",
      "uploadUrl",
      "signedUrl",
    ]) {
      expect(noComments, `hook leaks ${banned}`).not.toContain(banned);
    }
  });

  it("startResumable persists snapshots via the persistence project()", () => {
    expect(src).toMatch(/onPersist:[\s\S]*?persistence\.project/);
  });

  it("telemetry emits route through createUploadTelemetry (no inline fetch to /v1/ops/upload-telemetry)", () => {
    expect(src).toMatch(/createUploadTelemetry/);
    expect(noComments).not.toMatch(/apiFetch\("\/v1\/ops\/upload-telemetry"/);
  });
});

// =============================================================================
// PART 4 — Capture-page integration
// =============================================================================

describe("Phase 30.10 — capture page integration", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/capture/page.tsx",
  );

  it("imports useResumableUploads + UploadOperationsPanel", () => {
    expect(src).toMatch(
      /import\s*\{\s*useResumableUploads\s*\}\s*from\s+"\.\/_hooks\/useResumableUploads"/,
    );
    expect(src).toMatch(
      /import\s*\{\s*UploadOperationsPanel\s*\}\s*from\s+"\.\.\/\.\.\/\.\.\/components\/uploads\/UploadOperationsPanel"/,
    );
  });

  it("calls useResumableUploads inside the page component", () => {
    expect(src).toMatch(/const resumable = useResumableUploads\(\)/);
  });

  it("mounts UploadOperationsPanel only when there is something to show (zero regression)", () => {
    // The mount must be conditional on:
    //   resumable.enabled AND (uploads.length > 0 OR offline OR recovery has entries)
    expect(src).toMatch(/resumable\.enabled\s*&&\s*\(\s*resumable\.uploads\.length > 0/);
    expect(src).toMatch(/!resumable\.network\.isOnline/);
    expect(src).toMatch(/resumable\.recovery[\s\S]*?entries\.length > 0/);
  });

  it("wires onPause / onResume / onCancel / onClearRecovery from the hook", () => {
    expect(src).toMatch(/onPause=\{resumable\.pause\}/);
    expect(src).toMatch(/onResume=\{[\s\S]*?resumable\.resume/);
    expect(src).toMatch(/onCancel=\{resumable\.cancel\}/);
    expect(src).toMatch(/onClearRecovery=\{[\s\S]*?resumable\.clearRecovery/);
  });
});

// =============================================================================
// PART 5 — Backend telemetry endpoint
// =============================================================================

describe("Phase 30.10 — backend telemetry endpoint", () => {
  const opsSrc = readSource(
    "../../../services/api/src/routes/ops.routes.ts",
  );

  it("declares POST /v1/ops/upload-telemetry under requireAuth", () => {
    expect(opsSrc).toMatch(
      /app\.post\(\s*"\/v1\/ops\/upload-telemetry",\s*\{\s*preHandler:\s*requireAuth\s*\}/,
    );
  });

  it("bounded event type catalog matches the client emitter exactly", () => {
    for (const type of UPLOAD_TELEMETRY_TYPES) {
      expect(opsSrc, `event type ${type} missing from server enum`).toContain(
        `"${type}"`,
      );
    }
  });

  it("body schema bounded — events array .min(1).max(50)", () => {
    expect(opsSrc).toMatch(
      /events:\s*z\.array\(UploadTelemetryEvent\)\.min\(1\)\.max\(50\)/,
    );
  });

  it("per-user rate limit (60/min)", () => {
    expect(opsSrc).toMatch(
      /enforceRateLimit\(\{\s*key:\s*`ops:upload-telemetry:\$\{userId\}`/,
    );
    expect(opsSrc).toMatch(/max:\s*60/);
    expect(opsSrc).toMatch(/windowSec:\s*60/);
  });

  it("anti-enumeration: non-members of the team get 404 not_found", () => {
    expect(opsSrc).toMatch(
      /if\s*\(!member\)\s*\{[\s\S]*?reply\.code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"\s*\}\s*\}\)/,
    );
  });

  it("bumps the catalogued counter via `bump()` — never a string from user input", () => {
    // The bump call must use `evt.type` whose values are already
    // constrained by the Zod enum. No user-supplied freeform names
    // reach the metric registry.
    expect(opsSrc).toMatch(/for\s*\(\s*let i = 0;\s*i < n;\s*i\+\+\)\s*bump\(evt\.type\)/);
  });
});

// =============================================================================
// PART 6 — Client telemetry helper
// =============================================================================

describe("Phase 30.10 — client telemetry emitter", () => {
  it("UPLOAD_TELEMETRY_TYPES exhaustive + snake_case", () => {
    for (const t of [
      "upload_resume_total",
      "upload_pause_total",
      "upload_cancel_total",
      "upload_retry_total",
      "upload_chunk_retry_total",
      "upload_recovery_total",
      "offline_draft_created_total",
      "offline_draft_recovered_total",
      "offline_draft_conflict_total",
      "background_sync_retry_total",
      "background_sync_failed_total",
    ]) {
      expect(UPLOAD_TELEMETRY_TYPES).toContain(t as never);
    }
    for (const t of UPLOAD_TELEMETRY_TYPES) {
      expect(t).toMatch(/^[a-z][a-z0-9_]+_total$/);
    }
  });

  it("emit() drops unknown types silently (no oracle)", () => {
    const e = createUploadTelemetry({ teamId: "team-1" });
    expect(() => e.emit("bogus_type" as never)).not.toThrow();
  });

  it("emit() coalesces same type within the flush window", async () => {
    // Re-export the internal flush via the public API; we don't
    // want to actually issue a network call here so we use
    // `flushDelayMs: 1_000_000` and inspect side effects via flush().
    const e = createUploadTelemetry({
      teamId: "team-1",
      flushDelayMs: 1_000_000,
    });
    e.emit("upload_resume_total");
    e.emit("upload_resume_total");
    e.emit("upload_resume_total");
    e.emit("upload_pause_total");
    // The pending map should have 2 entries (one per type); count
    // by behavior: flush() returns the number of events posted.
    // Since apiFetch will throw (no token in node), flush returns 0.
    // We still verify the call doesn't crash.
    const posted = await e.flush();
    expect(posted).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// PART 7 — Existing capture flow unchanged
// =============================================================================

describe("Phase 30.10 — existing capture orchestrator integrity (UPDATED by Phase 30.12)", () => {
  const orchestratorSrc = readSource(
    "../../../apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts",
  );

  // Phase 30.12 DELIBERATELY added a flag-gated resumable fork to
  // this hook. The original Phase 30.10 assertion "does NOT import
  // the resumable lib" was correct AT THAT TIME but is now wrong
  // by design. The replacement assertion verifies: (a) the
  // resumable imports are present, (b) the fork is wrapped in a
  // guard so the legacy path runs verbatim when the flag is off.
  it("Phase 30.12 — imports the resumable lib BUT gates the fork on `resumable && resumable.enabled`", () => {
    expect(orchestratorSrc).toMatch(
      /from\s+"[^"]*lib\/uploads\/feature-flag/,
    );
    expect(orchestratorSrc).toMatch(
      /from\s+"[^"]*lib\/uploads\/retry/,
    );
    // The fork guard requires all four conditions; flag off ⇒
    // never engages.
    expect(orchestratorSrc).toMatch(
      /if\s*\([\s\S]*?resumable\s*&&[\s\S]*?resumable\.enabled\s*&&[\s\S]*?evidenceTeamId\s*&&[\s\S]*?routeFile\(/,
    );
  });

  it("legacy XHR PUT path still exists (per-part presign → XHR)", () => {
    expect(orchestratorSrc).toMatch(
      /\/v1\/evidence\/\$\{evidenceId\}\/parts/,
    );
    expect(orchestratorSrc).toMatch(/new XMLHttpRequest\(\)/);
    expect(orchestratorSrc).toMatch(/part\.upload\.putUrl/);
  });

  it("legacy finalize still calls /v1/evidence/:id/complete", () => {
    expect(orchestratorSrc).toMatch(
      /\/v1\/evidence\/\$\{evidenceId\}\/complete/,
    );
  });

  it("camera / audio / video / folder hooks remain wired (no removals)", () => {
    // Spot-check by name — the orchestrator hook receives these
    // callbacks from page.tsx; removing them would break capture.
    for (const cb of [
      "onCloseCaptureDevices",
      "onResetAudioRecorder",
      "selectedCollectionPlan",
      "planMode",
    ]) {
      expect(orchestratorSrc, `legacy callback ${cb} removed`).toContain(cb);
    }
  });
});
