import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * UC-WEB-001 (client half) — Finish & Sign is RESUMABLE:
 *   * a failed upload leaves no item stuck "uploading" and marks the failing
 *     item with an error;
 *   * a second finalize after a part failure reuses the SAME evidence record
 *     (no second POST /v1/evidence) and re-uploads only what is missing;
 *   * a failed /complete retries ONLY /complete;
 *   * changing the staged set abandons the reservation (never re-binds a part
 *     index to a different file).
 * UC-WEB-005 — after seal, a FAILED / BLOCKED report is reported as such, not
 * as "still generating".
 */

const calls: Array<{ path: string; init?: RequestInit }> = [];
let apiHandler: (path: string, init?: RequestInit) => unknown;
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return apiHandler(path, init);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
const addToast = vi.fn();
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast }) }));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpaceId: () => "team-1",
  useTenantGuard: () => ({ stamp: () => 1, isStale: () => false }),
}));
vi.mock("../../app/(app)/capture/_lib/hash-utils", () => ({
  computeIntegrityFromBlob: async () => ({
    checksumSha256Base64: "c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2g=",
    contentMd5Base64: "bWQ1bWQ1bWQ1bWQ1bWQ1bQ==",
  }),
}));

import { useCaptureSessionOrchestration } from "../../app/(app)/capture/_hooks/useCaptureSessionOrchestration";
import type { SessionItem } from "../../app/(app)/capture/_lib/types";

/** XHR stub: PUT to a URL containing "fail" answers 403 (non-transient). */
let failPutFor = new Set<string>();
class FakeXhr {
  status = 0;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = "";
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    this.status = [...failPutFor].some((k) => this.url.includes(k)) ? 403 : 200;
    queueMicrotask(() => this.onload?.());
  }
}

function item(id: string, name: string): SessionItem {
  return {
    id,
    file: new File(["x".repeat(10)], name, { type: "image/png" }),
    previewUrl: null,
    mimeType: "image/png",
    relativePath: null,
    uploadProgress: 0,
    uploading: false,
    error: null,
    checklistStepId: null,
  } as SessionItem;
}

let evidenceCounter = 0;
let completeFails = false;
let artifactStatus: unknown = { report: { available: true }, outputs: { report: { state: "READY" }, pollIntervalMs: null } };

function defaultHandler(path: string, init?: RequestInit): unknown {
  if (path === "/v1/evidence" && init?.method === "POST") {
    evidenceCounter += 1;
    return { id: `ev-${evidenceCounter}`, teamId: "team-1" };
  }
  const part = path.match(/^\/v1\/evidence\/(ev-\d+)\/parts$/);
  if (part) {
    const body = JSON.parse(String(init?.body));
    return { part: { id: `p-${body.partIndex}` }, upload: { putUrl: `https://s3.test/${part[1]}/${body.originalFileName}` } };
  }
  if (/\/complete$/.test(path)) {
    if (completeFails) throw Object.assign(new Error("boom"), { statusCode: 503 });
    return {};
  }
  if (/\/artifacts\/status$/.test(path)) return artifactStatus;
  return {};
}

function setup(items: SessionItem[]) {
  const hook = renderHook(() =>
    useCaptureSessionOrchestration({
      internalNotes: "",
      onCloseCaptureDevices: () => {},
      onResetAudioRecorder: () => {},
      planMode: "FREEFORM" as never,
      selectedCollectionPlan: undefined,
      useLocation: false,
    }),
  );
  act(() => hook.result.current.setSessionItems(() => items));
  return hook;
}

const creates = () => calls.filter((c) => c.path === "/v1/evidence" && c.init?.method === "POST");
const partCalls = () => calls.filter((c) => /\/parts$/.test(c.path));
const completes = () => calls.filter((c) => /\/v1\/evidence\/[^/]+\/complete$/.test(c.path));

beforeEach(() => {
  calls.length = 0;
  evidenceCounter = 0;
  completeFails = false;
  failPutFor = new Set();
  artifactStatus = { report: { available: true }, outputs: { report: { state: "READY" }, pollIntervalMs: null } };
  apiHandler = defaultHandler;
  addToast.mockReset();
  push.mockReset();
  vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UC-WEB-001 — resumable Finish & Sign", () => {
  it("a failed part upload leaves no item stuck uploading and marks the failing item", async () => {
    failPutFor = new Set(["b.png"]);
    const { result } = setup([item("1", "a.png"), item("2", "b.png"), item("3", "c.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    const items = result.current.sessionItems;
    expect(items.map((i) => i.uploading)).toEqual([false, false, false]);
    expect(items[0].uploadProgress).toBe(100);
    expect(items[1].error).toBeTruthy();
    expect(result.current.busy).toBe(false);
  });

  it("retry after a part failure reuses the same evidence record and uploads only the missing parts", async () => {
    failPutFor = new Set(["b.png"]);
    const { result } = setup([item("1", "a.png"), item("2", "b.png"), item("3", "c.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(1);
    const partsAfterFirst = partCalls().length;

    failPutFor = new Set();
    await act(async () => {
      await result.current.finalizeSession();
    });
    // No second record.
    expect(creates()).toHaveLength(1);
    // Every part call on retry targets the SAME record, and part 0 is not re-sent.
    const retryParts = partCalls().slice(partsAfterFirst);
    expect(retryParts.every((c) => c.path === "/v1/evidence/ev-1/parts")).toBe(true);
    expect(retryParts.map((c) => JSON.parse(String(c.init?.body)).partIndex)).toEqual([1, 2]);
    expect(completes().map((c) => c.path)).toEqual(["/v1/evidence/ev-1/complete"]);
    expect(push).toHaveBeenCalledWith("/evidence/ev-1");
  });

  it("a failed /complete retries only /complete into the same record", async () => {
    completeFails = true;
    const { result } = setup([item("1", "a.png"), item("2", "b.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    const partsAfterFirst = partCalls().length;
    completeFails = false;
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(1);
    expect(partCalls().length).toBe(partsAfterFirst);
    expect(completes().map((c) => c.path)).toEqual([
      "/v1/evidence/ev-1/complete",
      "/v1/evidence/ev-1/complete",
    ]);
  });

  it("a changed staged set abandons the reservation instead of re-binding part indexes", async () => {
    failPutFor = new Set(["b.png"]);
    const { result } = setup([item("1", "a.png"), item("2", "b.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    failPutFor = new Set();
    act(() => result.current.setSessionItems(() => [item("1", "a.png"), item("9", "z.png")]));
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(2);
  });

  it("a lost create response is retried with the same durable draft id and no non-CORS header", async () => {
    apiHandler = (path, init) => {
      if (path === "/v1/evidence" && init?.method === "POST" && creates().length === 1) {
        throw Object.assign(new Error("network"), { statusCode: 0, code: "NETWORK_ERROR" });
      }
      return defaultHandler(path, init);
    };
    const hook = renderHook(() =>
      useCaptureSessionOrchestration({
        internalNotes: "",
        onCloseCaptureDevices: () => {},
        onResetAudioRecorder: () => {},
        planMode: "FREEFORM" as never,
        selectedCollectionPlan: undefined,
        useLocation: false,
        getCaptureSessionDraftId: () => "draft-1",
      }),
    );
    act(() => hook.result.current.setSessionItems(() => [item("1", "a.png")]));
    await act(async () => {
      await hook.result.current.finalizeSession();
    });
    await act(async () => {
      await hook.result.current.finalizeSession();
    });
    const bodies = creates().map((c) => JSON.parse(String(c.init?.body)));
    expect(bodies.map((b) => b.captureSessionId)).toEqual(["draft-1", "draft-1"]);
    // The API's CORS allow-list has no Idempotency-Key; sending it would make
    // the browser refuse the cross-origin create.
    for (const c of creates()) expect(new Headers(c.init?.headers).get("Idempotency-Key")).toBeNull();
  });
});

describe("UC-WEB-005 — honest post-seal artifact state", () => {
  it("a FAILED report is reported as failed, not as still generating", async () => {
    artifactStatus = {
      report: { available: false, pending: false },
      outputs: { report: { state: "TERMINAL_FAILURE" }, pollIntervalMs: null },
    };
    const { result } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    const messages = addToast.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /still generating/i.test(m))).toBe(false);
    expect(messages.some((m) => /report generation failed/i.test(m))).toBe(true);
    // One status read: a terminal state stops the poll.
    expect(calls.filter((c) => /artifacts\/status/.test(c.path))).toHaveLength(1);
  });

  it("a BLOCKED report is reported as blocked", async () => {
    artifactStatus = {
      report: { available: false, pending: false },
      outputs: { report: { state: "BLOCKED" }, pollIntervalMs: null },
    };
    const { result } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    const messages = addToast.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /blocked/i.test(m))).toBe(true);
    expect(messages.some((m) => /still generating/i.test(m))).toBe(false);
  });

  it("a NOT_INCLUDED report does not claim anything is generating", async () => {
    artifactStatus = {
      report: { available: false, pending: false },
      outputs: { report: { state: "NOT_INCLUDED" }, pollIntervalMs: null },
    };
    const { result } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    const messages = addToast.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /still generating/i.test(m))).toBe(false);
  });
});
