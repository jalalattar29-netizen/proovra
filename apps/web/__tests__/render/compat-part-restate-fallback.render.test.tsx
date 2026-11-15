/**
 * COMPAT (round 3, 2026-11-15) — C-05 restates an uploaded part's edited
 * note/role/step/label before the seal, and clears a value it sent before with
 * `null`. This web build reaches production before the API it was written for;
 * the older API's part schema takes those fields as optional strings only, so a
 * `null` is refused 400 INVALID_INPUT, and the Finish could never complete.
 *
 * The restatement is sent again without the cleared keys (the older API keeps
 * the part as it was, which is all it ever did), and the record seals. Against
 * the current API nothing changes: the null goes once and is accepted.
 *
 * Real apiFetch over a stubbed fetch, through the real orchestration hook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpace: () => ({ id: "team-1", type: "PERSONAL" }),
  useTenantGuard: () => ({ stamp: () => 1, isStale: () => false }),
}));
vi.mock("../../lib/uploads/streaming-sha256", () => ({
  sha256Base64OfBlob: async () => "c3RhZ2VkLWRpZ2VzdC1zdGFnZWQtZGlnZXN0LXN0YWc=",
}));
vi.mock("../../app/(app)/capture/_lib/hash-utils", () => ({
  computeIntegrityFromBlob: async () => ({
    checksumSha256Base64: "c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2g=",
    contentMd5Base64: "bWQ1bWQ1bWQ1bWQ1bWQ1bQ==",
  }),
}));

import { useCaptureSessionOrchestration } from "../../app/(app)/capture/_hooks/useCaptureSessionOrchestration";
import type { SessionItem } from "../../app/(app)/capture/_lib/types";

const METADATA_KEYS = ["privateRole", "privateNote", "checklistStepId", "sourceLabel"] as const;
const HINT_A = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=";

let api: "old" | "new" = "new";
let completeAnswers: Array<{ status: number; body: unknown }> = [];
const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null; status: number }> = [];

class FakeXhr {
  status = 200;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  send() {
    queueMicrotask(() => this.onload?.());
  }
}

function answer(path: string, method: string, body: Record<string, unknown> | null): { status: number; body: unknown } {
  if (path === "/v1/evidence" && method === "POST") return { status: 201, body: { id: "ev-1", teamId: "team-1" } };
  if (/\/parts$/.test(path)) {
    // The older API's CreatePartBody: the four fields are optional strings, not nullable.
    if (api === "old" && body && METADATA_KEYS.some((k) => body[k] === null)) {
      return {
        status: 400,
        body: {
          error: {
            code: "INVALID_INPUT",
            message: "Invalid input: privateNote — Expected string, received null",
            fields: [{ path: "privateNote", code: "invalid_type", message: "Expected string, received null" }],
            requestId: "req-1",
          },
        },
      };
    }
    return { status: 201, body: { part: { id: "p-1" }, upload: { putUrl: "https://s3.test/put" } } };
  }
  if (/\/complete$/.test(path)) return completeAnswers.shift() ?? { status: 200, body: {} };
  if (/artifacts\/status$/.test(path)) return { status: 200, body: { outputs: { report: { state: "READY" }, pollIntervalMs: null } } };
  return { status: 200, body: {} };
}

beforeEach(() => {
  requests.length = 0;
  api = "new";
  completeAnswers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), "https://x.invalid").pathname;
      const method = (init.method ?? "GET").toUpperCase();
      const body = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const a = answer(path, method, body);
      requests.push({ path, method, body, status: a.status });
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }),
  );
  vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function item(id: string, name: string, extra: Partial<SessionItem> = {}): SessionItem {
  return {
    id,
    file: new File(["x".repeat(10)], name, { type: "application/pdf" }),
    previewUrl: null,
    mimeType: "application/pdf",
    relativePath: null,
    uploadProgress: 0,
    uploading: false,
    error: null,
    checklistStepId: null,
    clientSignals: { clientHintSha256Base64: HINT_A },
    ...extra,
  } as SessionItem;
}

const isParts = (r: { path: string }) => /\/parts$/.test(r.path);
const isComplete = (r: { path: string }) => /\/complete$/.test(r.path);
/** A refusal of the seal that keeps the reserved record (the older API sends this kind too). */
const sealInterrupted = { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "Try again." } } };

async function sealRefusedThenClearNoteAndRetry() {
  completeAnswers = [sealInterrupted];
  const { result } = renderHook(() =>
    useCaptureSessionOrchestration({
      internalNotes: "",
      onCloseCaptureDevices: () => {},
      onResetAudioRecorder: () => {},
      planMode: "FLEXIBLE",
      selectedCollectionPlan: undefined,
      useLocation: false,
      getCaptureSessionDraftId: () => "draft-1",
    }),
  );
  act(() => result.current.setSessionItems(() => [item("1", "a.pdf", { privateNote: "first" })]));
  await act(async () => {
    await result.current.finalizeSession();
  });
  expect(requests.filter(isComplete)).toHaveLength(1);
  act(() => result.current.setSessionItems((prev) => prev.map((i) => ({ ...i, privateNote: "" }))));
  await act(async () => {
    await result.current.finalizeSession();
  });
  return result;
}

describe("C-05 restatement against both APIs", () => {
  it("older API: the cleared note's null is refused, the restatement goes again without it, and the record seals", async () => {
    api = "old";
    const result = await sealRefusedThenClearNoteAndRetry();
    const parts = requests.filter(isParts);
    expect(parts.map((p) => p.status)).toEqual([201, 400, 201]);
    expect(parts[1]!.body).toMatchObject({ partIndex: 0, privateNote: null });
    expect(parts[2]!.body).not.toHaveProperty("privateNote");
    expect(parts[2]!.body).toMatchObject({ partIndex: 0, originalFileName: "a.pdf", sizeBytes: 10 });
    const order = requests.filter((r) => isParts(r) || isComplete(r)).map((r) => (isParts(r) ? "parts" : "complete"));
    expect(order).toEqual(["parts", "complete", "parts", "parts", "complete"]);
    expect(requests.filter(isComplete).at(-1)!.status).toBe(200);
    expect(result.current.error ?? null).toBeNull();
  });

  it("current API: the null is sent once and accepted; nothing is retried", async () => {
    await sealRefusedThenClearNoteAndRetry();
    const parts = requests.filter(isParts);
    expect(parts.map((p) => p.status)).toEqual([201, 201]);
    expect(parts[1]!.body).toMatchObject({ partIndex: 0, privateNote: null });
    expect(requests.filter(isComplete).at(-1)!.status).toBe(200);
  });
});
