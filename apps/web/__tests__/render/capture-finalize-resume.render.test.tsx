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
  isApiResponseError: () => false,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
const addToast = vi.fn();
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast }) }));
let activeSpace: { id: string | null; type: "ORGANIZATION" | "PERSONAL" } | null = { id: "team-1", type: "ORGANIZATION" };
vi.mock("../../lib/platform-context", () => ({
  useActiveSpace: () => activeSpace,
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

/**
 * XHR stub: PUT to a URL containing "fail" answers 400 (non-transient: storage
 * refused the bytes). F-P1-08 — a 403 now means "the URL expired" and is
 * presigned again under the shared storage-PUT rule, so it no longer fails.
 */
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
    this.status = [...failPutFor].some((k) => this.url.includes(k)) ? 400 : 200;
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
  activeSpace = { id: "team-1", type: "ORGANIZATION" };
  addToast.mockReset();
  push.mockReset();
  vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("INGEST-009 — a record is never filed into a workspace nobody confirmed", () => {
  it("refuses a new record while the workspace is unknown, and keeps the staged items", async () => {
    activeSpace = null;
    const { result } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(0);
    expect(result.current.sessionItems).toHaveLength(1);
    expect(result.current.error).toContain("could not confirm which workspace");
  });

  it("names the organization workspace once it is known", async () => {
    const { result } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(JSON.parse(String(creates()[0]?.init?.body)).teamId).toBe("team-1");
  });

  it("a confirmed Personal Space with no id still goes through, unnamed", async () => {
    activeSpace = { id: null, type: "PERSONAL" };
    const { result } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(1);
    expect(JSON.parse(String(creates()[0]?.init?.body)).teamId).toBeUndefined();
  });

  it("a retry into a reserved record is not refused if the context drops meanwhile", async () => {
    failPutFor = new Set(["a.png"]);
    const { result, rerender } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(1);
    activeSpace = null;
    rerender();
    failPutFor = new Set();
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(1);
    expect(completes().map((c) => c.path)).toEqual(["/v1/evidence/ev-1/complete"]);
  });
});

describe("PRO-C1-01 — a retried Finish after a workspace switch never seals into the workspace that was left", () => {
  it("drops the reservation of workspace A and asks POST /v1/evidence again for workspace B", async () => {
    failPutFor = new Set(["a.png"]);
    const draftHook = renderHook(() =>
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
    act(() => draftHook.result.current.setSessionItems(() => [item("1", "a.png")]));
    await act(async () => {
      await draftHook.result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(1);
    expect(completes()).toHaveLength(0);

    // The person confirms "Switch anyway" to workspace B; /capture stays mounted.
    activeSpace = { id: "team-2", type: "ORGANIZATION" };
    apiHandler = (path, init) => {
      if (path === "/v1/evidence" && init?.method === "POST") {
        evidenceCounter += 1;
        return { id: `ev-${evidenceCounter}`, teamId: "team-2" };
      }
      return defaultHandler(path, init);
    };
    draftHook.rerender();
    failPutFor = new Set();
    await act(async () => {
      await draftHook.result.current.finalizeSession();
    });

    // The retry went through the server's C-08 authority, naming B and the draft.
    expect(creates()).toHaveLength(2);
    const retryBody = JSON.parse(String(creates()[1]?.init?.body));
    expect(retryBody.teamId).toBe("team-2");
    expect(retryBody.captureSessionId).toBe("draft-1");
    // Nothing was written to, or sealed in, A's record after the switch.
    expect(completes().map((c) => c.path)).toEqual(["/v1/evidence/ev-2/complete"]);
    expect(push).toHaveBeenCalledWith("/evidence/ev-2");
    expect(push).not.toHaveBeenCalledWith("/evidence/ev-1");
  });

  it("the same workspace still resumes the same record", async () => {
    failPutFor = new Set(["a.png"]);
    const { result, rerender } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    activeSpace = { id: "team-1", type: "ORGANIZATION" };
    rerender();
    failPutFor = new Set();
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(1);
    expect(completes().map((c) => c.path)).toEqual(["/v1/evidence/ev-1/complete"]);
  });

  it("review gap 1: a record reserved in a team is not resumed from a Personal Space that carries no id", async () => {
    failPutFor = new Set(["a.png"]);
    const { result, rerender } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(1);

    // "Switch anyway" to the caller's Personal Space, whose id the server has
    // not resolved: no id to compare, and no workspace header is sent.
    activeSpace = { id: null, type: "PERSONAL" };
    apiHandler = (path, init) => {
      if (path === "/v1/evidence" && init?.method === "POST") {
        evidenceCounter += 1;
        return { id: `ev-${evidenceCounter}`, teamId: "personal-9" };
      }
      return defaultHandler(path, init);
    };
    rerender();
    failPutFor = new Set();
    await act(async () => {
      await result.current.finalizeSession();
    });

    expect(creates()).toHaveLength(2);
    expect(JSON.parse(String(creates()[1]?.init?.body)).teamId).toBeUndefined();
    expect(completes().map((c) => c.path)).toEqual(["/v1/evidence/ev-2/complete"]);
    expect(push).not.toHaveBeenCalledWith("/evidence/ev-1");
  });

  it("review gap 1: an id-less Personal Space still resumes the record it reserved itself, and a team is another workspace for it", async () => {
    activeSpace = { id: null, type: "PERSONAL" };
    apiHandler = (path, init) => {
      if (path === "/v1/evidence" && init?.method === "POST") {
        evidenceCounter += 1;
        return { id: `ev-${evidenceCounter}`, teamId: evidenceCounter === 1 ? "personal-9" : "team-1" };
      }
      return defaultHandler(path, init);
    };
    failPutFor = new Set(["a.png"]);
    const { result, rerender } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    rerender();
    await act(async () => {
      await result.current.finalizeSession();
    });
    // Same id-less Personal Space: the same record, no second reservation.
    expect(creates()).toHaveLength(1);

    activeSpace = { id: "team-1", type: "ORGANIZATION" };
    rerender();
    failPutFor = new Set();
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(2);
    expect(JSON.parse(String(creates()[1]?.init?.body)).teamId).toBe("team-1");
    expect(completes().map((c) => c.path)).toEqual(["/v1/evidence/ev-2/complete"]);
  });

  it("review gap 3: a switch DURING a running finalize is refused 409 by the server — nothing is sealed in the workspace left, and the next Finish reserves in the new one", async () => {
    // The header follows the switch at once, so the server refuses the next
    // record write of the running finalize (CAPTURE_WORKSPACE_CHANGED).
    let switched = false;
    apiHandler = (path, init) => {
      const part = path.match(/^\/v1\/evidence\/(ev-\d+)\/parts$/);
      if (part && part[1] === "ev-1") {
        const body = JSON.parse(String(init?.body));
        if (body.partIndex === 1) {
          // The person confirms the switch while the first file is uploading.
          switched = true;
          activeSpace = { id: "team-2", type: "ORGANIZATION" };
        }
        if (switched) throw Object.assign(new Error("moved"), { statusCode: 409, code: "CAPTURE_WORKSPACE_CHANGED" });
      }
      if (/^\/v1\/evidence\/ev-1\/complete$/.test(path) && switched) {
        throw Object.assign(new Error("moved"), { statusCode: 409, code: "CAPTURE_WORKSPACE_CHANGED" });
      }
      if (path === "/v1/evidence" && init?.method === "POST") {
        evidenceCounter += 1;
        return { id: `ev-${evidenceCounter}`, teamId: switched ? "team-2" : "team-1" };
      }
      return defaultHandler(path, init);
    };
    const { result, rerender } = setup([item("1", "a.png"), item("2", "b.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });

    expect(switched).toBe(true);
    // Nothing was sealed in workspace A, nothing opened, and no success was claimed.
    expect(completes()).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
    expect(result.current.busy).toBe(false);
    expect(result.current.sessionItems).toHaveLength(2);

    // The next Finish, under the dialog that names B, reserves in B.
    rerender();
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(2);
    expect(JSON.parse(String(creates()[1]?.init?.body)).teamId).toBe("team-2");
    expect(completes().map((c) => c.path)).toEqual(["/v1/evidence/ev-2/complete"]);
    expect(push).toHaveBeenCalledWith("/evidence/ev-2");
    expect(push).not.toHaveBeenCalledWith("/evidence/ev-1");
  });

  it("a CAPTURE_WORKSPACE_CHANGED refusal forgets the reservation", async () => {

    apiHandler = (path, init) => {
      if (/\/v1\/evidence\/ev-1\/complete$/.test(path)) {
        throw Object.assign(new Error("moved"), { statusCode: 409, code: "CAPTURE_WORKSPACE_CHANGED" });
      }
      return defaultHandler(path, init);
    };
    const { result } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    apiHandler = defaultHandler;
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(2);
  });
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

describe("AUD-21 — the browser clock at Finish is not a device capture time", () => {
  it("the create request carries no deviceTimeIso", async () => {
    const { result } = setup([item("1", "a.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    const bodies = creates().map((c) => JSON.parse(String(c.init?.body)));
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toHaveProperty("deviceTimeIso");
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

describe("C-04 — material added while Finish runs is not wiped by the successful seal", () => {
  it("clears only the items Finish sealed; an item dropped meanwhile stays staged and the page does not navigate away", async () => {
    const { result } = setup([item("1", "a.png"), item("2", "b.png")]);
    apiHandler = (path, init) => {
      // The operator drops a file while the record is being sealed.
      if (/\/complete$/.test(path)) {
        result.current.setSessionItems((prev) => [...prev, item("3", "late.png")]);
      }
      return defaultHandler(path, init);
    };
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(completes().map((c) => c.path)).toEqual(["/v1/evidence/ev-1/complete"]);
    expect(result.current.sessionItems.map((i) => i.id)).toEqual(["3"]);
    expect(push).not.toHaveBeenCalled();
    const messages = addToast.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /still staged/i.test(m))).toBe(true);

    // The next Finish seals the late item as a NEW record.
    apiHandler = defaultHandler;
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(2);
    expect(result.current.sessionItems).toHaveLength(0);
    expect(push).toHaveBeenCalledWith("/evidence/ev-2");
  });

  it("with nothing added meanwhile, every item is cleared and the page opens the record", async () => {
    const { result } = setup([item("1", "a.png"), item("2", "b.png")]);
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(result.current.sessionItems).toHaveLength(0);
    expect(push).toHaveBeenCalledWith("/evidence/ev-1");
  });
});
