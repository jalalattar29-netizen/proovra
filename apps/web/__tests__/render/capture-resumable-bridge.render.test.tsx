import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

/**
 * B4-F-300 / B4-F-301 (Free-user audit 0ea0) — the web resumable bridge.
 *
 *   B4-F-300  a large item sent through the resumable door carries the SAME
 *             per-file contract as the ordinary door: the silent-video marker
 *             (F-P1-09 clientSignals), note, source, checklist step, a
 *             basename-only file name — and the bridged part's metadata is
 *             restated through the ordinary door's idempotent re-presign, so
 *             the checklist gate sees the step. An older API that refuses the
 *             new session fields (strict schema, 400) is sent the old body.
 *   B4-F-301  after a resumable failure the settled uploader is forgotten (and
 *             aborted server-side), so its snapshot no longer blocks Review &
 *             Sign; the retry starts a fresh session into the same record
 *             without a reload. Recovery entries of another record never block.
 */

const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
let apiHandler: (path: string, init?: RequestInit) => unknown;
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    return apiHandler(path, init);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
  isApiResponseError: () => false,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
const addToast = vi.fn();
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast }) }));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpace: () => ({ id: "team-1", type: "ORGANIZATION" }),
  useTenantGuard: () => ({ stamp: () => 1, isStale: () => false }),
}));

/** The hook's uploader, faked: each instance emits the state the test scripts. */
const uploaderScript: { next: Array<"ok" | "fail"> } = { next: [] };
const cancelled: string[] = [];
vi.mock("../../lib/uploads/multipart-uploader", () => ({
  MultipartUploader: class {
    private listeners: Array<(s: unknown) => void> = [];
    constructor(private cfg: { sessionId: string }) {}
    subscribe(fn: (s: unknown) => void) {
      this.listeners.push(fn);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== fn);
      };
    }
    emit(state: string, failureReason: string | null) {
      const snap = {
        sessionId: this.cfg.sessionId,
        state,
        verifiedBytes: 0,
        uploadedBytes: 1,
        totalBytes: 1,
        parts: [],
        failureReason,
        isOnline: true,
        safeToClose: true,
        lastServerContactMs: null,
      };
      for (const l of [...this.listeners]) l(snap);
    }
    async start() {
      const outcome = uploaderScript.next.shift() ?? "ok";
      await Promise.resolve();
      if (outcome === "ok") this.emit("VERIFYING", null);
      else this.emit("FAILED_TERMINAL", "hash_mismatch");
    }
    pause() {}
    async resume() {}
    cancel() {
      cancelled.push(this.cfg.sessionId);
      this.emit("CANCELLED", null);
    }
  },
}));

import { useCaptureSessionOrchestration } from "../../app/(app)/capture/_hooks/useCaptureSessionOrchestration";
import { computeBlockingReasons, useResumableUploads } from "../../app/(app)/capture/_hooks/useResumableUploads";
import type { SessionItem } from "../../app/(app)/capture/_lib/types";

const BIG = 150 * 1024 * 1024;
const HINT = "c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2g=";

function bigMutedClip(): SessionItem {
  const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
  Object.defineProperty(file, "size", { value: BIG });
  return {
    id: "i1",
    file,
    previewUrl: null,
    mimeType: "video/mp4",
    relativePath: "Trip/day 1/clip.mp4",
    uploadProgress: 0,
    uploading: false,
    error: null,
    checklistStepId: "primary_evidence",
    role: "Primary evidence",
    privateNote: "Filmed at the gate",
    sourceLabel: "Browser camera",
    clientSignals: {
      captureTimeUtc: "2026-11-15T09:00:00.000Z",
      browserMediaCaptureAvailable: true,
      folderPathPresent: true,
      duplicateStatus: "UNIQUE",
      screenshotLike: false,
      genericMime: false,
      oldLastModified: false,
      clientHintSha256Base64: HINT,
      audioTracks: [],
      audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED",
    },
  } as unknown as SessionItem;
}

let sessionCounter = 0;
let strictOldApi = false;
/** An API whose multipart/complete schema predates the bridge contract. */
let strictOldComplete = false;
function handler(path: string, init?: RequestInit): unknown {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (path === "/v1/evidence" && init?.method === "POST") return { id: "ev-1", teamId: "team-1" };
  if (/\/multipart\/complete$/.test(path) && (strictOldApi || strictOldComplete) && body && ("privateNote" in body || "clientSignals" in body)) {
    throw Object.assign(new Error("Request validation failed"), { statusCode: 400, code: "VALIDATION_ERROR" });
  }
  if (path === "/v1/uploads/sessions") {
    if (strictOldApi && body && ("privateNote" in body || "clientSignals" in body)) {
      throw Object.assign(new Error("Request validation failed"), { statusCode: 400, code: "VALIDATION_ERROR" });
    }
    sessionCounter += 1;
    return { session: { id: `us-${sessionCounter}` } };
  }
  if (/\/v1\/evidence\/ev-1\/parts$/.test(path)) return { part: { id: "p0" }, upload: { putUrl: "https://s3.test/x" } };
  if (/\/artifacts\/status$/.test(path)) return { report: { available: true }, outputs: { report: { state: "READY" }, pollIntervalMs: null } };
  return {};
}

function setup() {
  return renderHook(() => {
    const resumable = useResumableUploads();
    const orchestration = useCaptureSessionOrchestration({
      internalNotes: "",
      onCloseCaptureDevices: () => {},
      onResetAudioRecorder: () => {},
      planMode: "FREEFORM" as never,
      selectedCollectionPlan: undefined,
      useLocation: false,
      resumable,
    });
    return { resumable, orchestration };
  });
}

const sessionCreates = () => calls.filter((c) => c.path === "/v1/uploads/sessions");
const restates = () => calls.filter((c) => c.path === "/v1/evidence/ev-1/parts");
const multipartCompletes = () => calls.filter((c) => /\/multipart\/complete$/.test(c.path));

beforeEach(() => {
  calls.length = 0;
  cancelled.length = 0;
  sessionCounter = 0;
  strictOldApi = false;
  strictOldComplete = false;
  uploaderScript.next = [];
  apiHandler = handler;
  addToast.mockReset();
  vi.stubEnv("NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED", "true");
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("B4-F-300 — the resumable door carries the part contract", () => {
  it("sends the silent-video marker, note, source, step and a basename; restates the bridged part's metadata", async () => {
    const hook = setup();
    act(() => hook.result.current.orchestration.setSessionItems(() => [bigMutedClip()]));
    await act(async () => {
      await hook.result.current.orchestration.finalizeSession();
    });

    const create = sessionCreates()[0]?.body as Record<string, unknown>;
    expect(create.originalFileName).toBe("clip.mp4");
    expect(create.privateNote).toBe("Filmed at the gate");
    expect(create.privateRole).toBe("Primary evidence");
    expect(create.checklistStepId).toBe("primary_evidence");
    expect(create.sourceLabel).toBe("Browser camera");
    expect((create.clientSignals as Record<string, unknown>).audioNotCapturedReason).toBe("MICROPHONE_PERMISSION_DENIED");
    expect((create.clientSignals as Record<string, unknown>).audioTracks).toEqual([]);

    // After the bridge: the ordinary door's idempotent re-presign of the SAME file.
    const restate = restates()[0]?.body as Record<string, unknown>;
    expect(restate).toBeTruthy();
    expect(restate.partIndex).toBe(0);
    expect(restate.checklistStepId).toBe("primary_evidence");
    expect(restate.privateNote).toBe("Filmed at the gate");
    expect(restate.checksumSha256Base64).toBe(HINT);
    const order = calls.map((c) => c.path);
    expect(order.indexOf("/v1/uploads/sessions/us-1/complete")).toBeLessThan(order.indexOf("/v1/evidence/ev-1/parts"));
    expect(calls.some((c) => c.path === "/v1/evidence/ev-1/complete")).toBe(true);
    // The settled upload no longer blocks anything.
    expect(hook.result.current.resumable.uploads).toHaveLength(0);
  });

  it("an API whose session schema is strict (400) is sent the old body; the metadata still reaches the part", async () => {
    strictOldApi = true;
    const hook = setup();
    act(() => hook.result.current.orchestration.setSessionItems(() => [bigMutedClip()]));
    await act(async () => {
      await hook.result.current.orchestration.finalizeSession();
    });
    expect(sessionCreates()).toHaveLength(2);
    expect(sessionCreates()[1]?.body).not.toHaveProperty("privateNote");
    expect(sessionCreates()[1]?.body?.originalFileName).toBe("clip.mp4");
    expect(restates()[0]?.body?.checklistStepId).toBe("primary_evidence");
    expect(calls.some((c) => c.path === "/v1/evidence/ev-1/complete")).toBe(true);
    // An API that refused the contract at create is not sent it at complete.
    expect(multipartCompletes()).toHaveLength(1);
    expect(multipartCompletes()[0]?.body).not.toHaveProperty("privateNote");
    expect(multipartCompletes()[0]?.body).not.toHaveProperty("clientSignals");
  });

  /*
   * Integration fix-up (2026-11-16) — the API-X half of B4-F-300: the upload
   * session table has no column for the contract (no schema change), so the
   * bridge writes what `multipart/complete` states. The web client must send
   * the same per-file fields there.
   */
  it("states the per-file contract on multipart/complete, where the bridge stores it", async () => {
    const hook = setup();
    act(() => hook.result.current.orchestration.setSessionItems(() => [bigMutedClip()]));
    await act(async () => {
      await hook.result.current.orchestration.finalizeSession();
    });
    expect(multipartCompletes()).toHaveLength(1);
    const complete = multipartCompletes()[0]?.body as Record<string, unknown>;
    expect(complete.teamId).toBe("team-1");
    expect(complete.verifyHash).toBe(true);
    expect(complete.privateNote).toBe("Filmed at the gate");
    expect(complete.privateRole).toBe("Primary evidence");
    expect(complete.checklistStepId).toBe("primary_evidence");
    expect(complete.sourceLabel).toBe("Browser camera");
    expect((complete.clientSignals as Record<string, unknown>).audioNotCapturedReason).toBe("MICROPHONE_PERMISSION_DENIED");
    expect(calls.some((c) => c.path === "/v1/evidence/ev-1/complete")).toBe(true);
  });

  it("an API whose multipart/complete schema is strict (400) is sent the old complete body; the record still seals", async () => {
    strictOldComplete = true;
    const hook = setup();
    act(() => hook.result.current.orchestration.setSessionItems(() => [bigMutedClip()]));
    await act(async () => {
      await hook.result.current.orchestration.finalizeSession();
    });
    expect(multipartCompletes()).toHaveLength(2);
    expect(multipartCompletes()[0]?.body).toHaveProperty("privateNote");
    expect(multipartCompletes()[1]?.body).toEqual({ teamId: "team-1", verifyHash: true });
    // C-05 — the metadata still reaches the part through the restatement.
    expect(restates()[0]?.body?.checklistStepId).toBe("primary_evidence");
    expect(calls.some((c) => c.path === "/v1/evidence/ev-1/complete")).toBe(true);
  });
});

describe("B4-F-301 — Review & Sign recovers from a resumable failure without a reload", () => {
  it("a failed upload is forgotten and aborted; nothing blocks; the retry seals into the same record", async () => {
    uploaderScript.next = ["fail", "ok"];
    const hook = setup();
    act(() => hook.result.current.orchestration.setSessionItems(() => [bigMutedClip()]));
    await act(async () => {
      await hook.result.current.orchestration.finalizeSession();
    });

    expect(cancelled).toEqual(["us-1"]);
    expect(hook.result.current.resumable.uploads).toHaveLength(0);
    expect(hook.result.current.resumable.blockingReasonsFor(hook.result.current.orchestration.reservedEvidenceId)).toEqual([]);
    expect(hook.result.current.orchestration.reservedEvidenceId).toBe("ev-1");
    expect(calls.some((c) => c.path === "/v1/evidence/ev-1/complete")).toBe(false);

    await act(async () => {
      await hook.result.current.orchestration.finalizeSession();
    });
    expect(calls.filter((c) => c.path === "/v1/evidence")).toHaveLength(1);
    expect(sessionCreates().map((c) => c.body?.idempotencyKey)).toEqual(["capture:ev-1:0", "capture:ev-1:0"]);
    expect(calls.some((c) => c.path === "/v1/uploads/sessions/us-2/multipart/complete")).toBe(true);
    expect(calls.some((c) => c.path === "/v1/evidence/ev-1/complete")).toBe(true);
  });

  it("a recovery entry blocks only for the record the capture reserves", () => {
    const entry = (evidenceId: string) => ({
      sessionId: `s-${evidenceId}`,
      evidenceId,
      teamId: "team-1",
      classification: "failed",
      needsAttention: true,
    });
    const recovery = { ranAtMs: 0, entries: [entry("ev-old"), entry("ev-1")], counts: {} } as never;
    expect(computeBlockingReasons([], recovery, null)).toEqual([]);
    expect(computeBlockingReasons([], recovery, "ev-2")).toEqual([]);
    expect(computeBlockingReasons([], recovery, "ev-1")).toEqual([{ kind: "needs_recovery", sessionId: "s-ev-1" }]);
  });
});
