/**
 * Free-user audit (2026-11-13), web Capture half — read through the REAL
 * apiFetch over a stubbed fetch, so refusals reach the hook exactly as the API
 * answers them.
 *
 *   F-03 — Finish & Sign declares its files (name, type, staged digest) so the
 *          server resumes a draft's reserved record only for the files it was
 *          made for; a refusal that makes the reservation unusable is
 *          forgotten, so the next Finish asks the server again.
 *   F-04 — Resume adopts the draft: autosave patches THAT draft (keeping its
 *          saved file details until files are re-attached) and Finish sends it.
 *   F-09 — EVIDENCE_RESERVATION_EXPIRED has product copy.
 *   F-12 — known record/storage blockers are said before upload, and every
 *          remedy link opens in a new tab (staged files survive).
 *   F-24 — a material over a staging limit is refused visibly, with the limit
 *          named, and nothing already staged is lost; within the limit it is
 *          staged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
const addToast = vi.fn();
vi.mock("../../components/ui", () => ({ useToast: () => ({ addToast }) }));
vi.mock("../../lib/platform-context", () => ({
  useActiveSpace: () => ({ id: "team-1", type: "PERSONAL" }),
  useTenantGuard: () => ({ stamp: () => 1, isStale: () => false }),
}));
// The staged-digest worker is not under test (and its hashing dependency is
// not installed in every checkout): a fixed digest stands in.
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
import { buildResumeManifest, reservationUnusable } from "../../app/(app)/capture/_hooks/capture-refusal";
import { useCaptureDraftPersistence } from "../../app/(app)/capture/_hooks/useCaptureDraftPersistence";
import {
  CaptureStagingLimitError,
  captureFailureToast,
  describeStagingFailure,
} from "../../app/(app)/capture/_lib/capture-errors";
import { allowanceFactsFromProjection, captureAllowanceNotices } from "../../app/(app)/capture/_lib/capture-allowance";
import { CaptureAllowanceNotice } from "../../app/(app)/capture/_lib/CaptureAllowanceNotice";
import { ProovraToast } from "../../components/feedback/ProovraToast";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { apiFetch } from "../../lib/api";
import type { SessionItem } from "../../app/(app)/capture/_lib/types";

type Route = (url: string, init: RequestInit) => { status: number; body: unknown } | undefined;
const requests: Array<{ url: string; method: string; body: unknown }> = [];
let route: Route = () => undefined;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : null;
      requests.push({ url, method, body });
      const answer = route(url, { ...init, method }) ?? { status: 200, body: {} };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

/** Storage PUT answers, consumed in order (200 once exhausted). */
let putStatuses: number[] = [];
const putUrls: string[] = [];
class FakeXhr {
  status = 200;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(_m?: string, url?: string) {
    if (url) putUrls.push(url);
  }
  setRequestHeader() {}
  send() {
    this.status = putStatuses.shift() ?? 200;
    queueMicrotask(() => this.onload?.());
  }
}

const HINT_A = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=";
function item(id: string, name: string, hint?: string): SessionItem {
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
    ...(hint ? { clientSignals: { clientHintSha256Base64: hint } } : {}),
  } as SessionItem;
}

function orchestration(draftId: string | null = "draft-1") {
  return renderHook(() =>
    useCaptureSessionOrchestration({
      internalNotes: "",
      onCloseCaptureDevices: () => {},
      onResetAudioRecorder: () => {},
      planMode: "FLEXIBLE",
      selectedCollectionPlan: undefined,
      useLocation: false,
      getCaptureSessionDraftId: () => draftId,
    }),
  );
}

const path = (url: string) => new URL(url, "https://x.invalid").pathname;
const creates = () => requests.filter((r) => path(r.url) === "/v1/evidence" && r.method === "POST");

beforeEach(() => {
  requests.length = 0;
  putStatuses = [];
  putUrls.length = 0;
  route = () => undefined;
  addToast.mockReset();
  push.mockReset();
  stubFetch();
  vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --- F-03 / F-09 -------------------------------------------------------------

describe("F-03: Finish & Sign declares its files and never resumes blindly", () => {
  it("the create carries the file manifest (name, type, staged digest) in part order", async () => {
    route = (url, init) => {
      if (path(url) === "/v1/evidence" && init.method === "POST") return { status: 201, body: { id: "ev-1", teamId: "team-1" } };
      if (/\/parts$/.test(path(url))) return { status: 201, body: { part: { id: "p" }, upload: { putUrl: "https://s3.test/put" } } };
      if (/artifacts\/status$/.test(path(url))) return { status: 200, body: { outputs: { report: { state: "READY" }, pollIntervalMs: null } } };
      return undefined;
    };
    const { result } = orchestration();
    act(() => result.current.setSessionItems(() => [item("1", "a.pdf", HINT_A), item("2", "b.pdf")]));
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.body).toMatchObject({
      captureSessionId: "draft-1",
      parts: [
        { originalFileName: "a.pdf", mimeType: "application/pdf", sha256Base64: HINT_A },
        { originalFileName: "b.pdf", mimeType: "application/pdf" },
      ],
    });
    expect(buildResumeManifest([item("9", "z.pdf")])).toEqual([{ originalFileName: "z.pdf", mimeType: "application/pdf" }]);
  });

  it("after PART_INDEX_TAKEN the reservation is forgotten: the next Finish asks the server again", async () => {
    let partAttempts = 0;
    route = (url, init) => {
      if (path(url) === "/v1/evidence" && init.method === "POST") return { status: 201, body: { id: `ev-${creates().length}`, teamId: "team-1" } };
      if (/\/parts$/.test(path(url))) {
        partAttempts += 1;
        if (partAttempts === 1) return { status: 409, body: { code: "PART_INDEX_TAKEN", message: "This part index already holds a different file." } };
        return { status: 201, body: { part: { id: "p" }, upload: { putUrl: "https://s3.test/put" } } };
      }
      if (/artifacts\/status$/.test(path(url))) return { status: 200, body: { outputs: { report: { state: "READY" }, pollIntervalMs: null } } };
      return undefined;
    };
    const { result } = orchestration();
    act(() => result.current.setSessionItems(() => [item("1", "a.pdf", HINT_A)]));
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(result.current.error).toMatch(/not the ones this record was started with/);
    expect(result.current.sessionItems).toHaveLength(1);
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates(), "a second create, not a blind resume").toHaveLength(2);
    expect(push).toHaveBeenCalledWith("/evidence/ev-2");
  });

  it("EVIDENCE_RESERVATION_EXPIRED is explained, and the next Finish reserves afresh", async () => {
    let completes = 0;
    route = (url, init) => {
      if (path(url) === "/v1/evidence" && init.method === "POST") return { status: 201, body: { id: `ev-${creates().length}`, teamId: "team-1" } };
      if (/\/parts$/.test(path(url))) return { status: 201, body: { part: { id: "p" }, upload: { putUrl: "https://s3.test/put" } } };
      if (/\/complete$/.test(path(url))) {
        completes += 1;
        if (completes === 1) return { status: 409, body: { code: "EVIDENCE_RESERVATION_EXPIRED", message: "This capture's reservation expired before it was finalized. Start the capture again." } };
        return { status: 200, body: {} };
      }
      if (/artifacts\/status$/.test(path(url))) return { status: 200, body: { outputs: { report: { state: "READY" }, pollIntervalMs: null } } };
      return undefined;
    };
    const { result } = orchestration();
    act(() => result.current.setSessionItems(() => [item("1", "a.pdf", HINT_A)]));
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(result.current.error).toMatch(/not finished within 24 hours/);
    expect(result.current.error).not.toMatch(/review your input/i);
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(2);
  });

  it("only refusals that make the reservation unusable drop it", () => {
    expect(reservationUnusable({ code: "PART_DIGEST_MISMATCH" })).toBe(true);
    expect(reservationUnusable({ code: "STORAGE_LIMIT_REACHED" })).toBe(false);
    expect(reservationUnusable(null)).toBe(false);
  });
});

// --- F-04 ------------------------------------------------------------------

describe("F-04: Resume adopts the draft", () => {
  it("autosave patches the adopted draft (keeping its saved files until re-attached) and discard deletes it", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCaptureDraftPersistence({ enabled: true }));
    act(() => result.current.adoptDraft("draft-9"));
    expect(result.current.draftId).toBe("draft-9");

    act(() =>
      result.current.scheduleSave({ templateId: null, planMode: "FLEXIBLE", internalNotes: "", useLocation: false, items: [] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    act(() =>
      result.current.scheduleSave({
        templateId: null,
        planMode: "FLEXIBLE",
        internalNotes: "",
        useLocation: false,
        items: [item("1", "a.pdf")],
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    const saves = requests.filter((r) => path(r.url).startsWith("/v1/capture/sessions"));
    expect(saves.map((r) => [r.method, path(r.url)])).toEqual([
      ["PATCH", "/v1/capture/sessions/draft-9"],
      ["PATCH", "/v1/capture/sessions/draft-9"],
    ]);
    expect(saves[0]!.body).not.toHaveProperty("items");
    expect((saves[1]!.body as { items: unknown[] }).items).toHaveLength(1);

    await act(async () => {
      await result.current.discardDraft();
    });
    expect(requests.at(-1)).toMatchObject({ method: "DELETE" });
    expect(path(requests.at(-1)!.url)).toBe("/v1/capture/sessions/draft-9");
  });
});

// --- F-24 ------------------------------------------------------------------

describe("F-24: a material over a staging limit is refused visibly", () => {
  it("within the limit: staged, with a success notice", async () => {
    const { result } = orchestration(null);
    await act(async () => {
      await result.current.addFilesToSession([new File(["ok"], "ok.pdf", { type: "application/pdf" })]);
    });
    expect(result.current.sessionItems).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(addToast).toHaveBeenCalledWith("1 item added to session", "success");
  });

  it("over the per-file limit: refused with the limit named, nothing staged is lost, no success", async () => {
    const { result } = orchestration(null);
    act(() => result.current.setSessionItems(() => [item("1", "kept.pdf")]));
    const big = new File(["x"], "screen.webm", { type: "video/webm" });
    Object.defineProperty(big, "size", { value: 600 * 1024 * 1024 });
    let thrown: unknown = null;
    await act(async () => {
      await result.current.addFilesToSession([big]).catch((err) => {
        thrown = err;
      });
    });
    expect(thrown).toBeInstanceOf(CaptureStagingLimitError);
    expect(result.current.error).toMatch(/screen\.webm is too large\. Maximum single file size is/);
    expect(result.current.sessionItems.map((i) => i.file.name)).toEqual(["kept.pdf"]);
    expect(addToast.mock.calls.some((c) => c[1] === "success")).toBe(false);
    // A recorder shows the limit itself, never "could not be added — retry".
    expect(describeStagingFailure(thrown, "generic fallback")).toBe(result.current.error);
  });

  it("over the per-session count: refused with the count named", async () => {
    const { result } = orchestration(null);
    act(() => result.current.setSessionItems(() => Array.from({ length: 50 }, (_, i) => item(String(i), `f${i}.pdf`))));
    await act(async () => {
      await result.current.addFilesToSession([new File(["x"], "one-more.pdf", { type: "application/pdf" })]).catch(() => {});
    });
    expect(result.current.error).toMatch(/Too many files\. Add up to 50 items/);
    expect(result.current.sessionItems).toHaveLength(50);
  });
});

// --- F-12 ------------------------------------------------------------------

describe("F-12: plan limits are said before upload; remedies keep the page", () => {
  it("the projection's refusal of the next record, and too little storage, become notices", () => {
    const facts = allowanceFactsFromProjection({
      evidenceAdmission: { effectiveLifetimeCap: 3, next: { allowed: false } },
      usage: { storage: { state: "MEASURED", usedBytes: String(200 * 1024 * 1024), limitBytes: String(250 * 1024 * 1024) } },
    });
    const notices = captureAllowanceNotices(facts, 80 * 1024 * 1024);
    expect(notices.map((n) => n.code)).toEqual(["capture_records_exhausted", "capture_storage_insufficient"]);
    expect(notices[0]!.detail).toMatch(/All 3 records your plan includes are in use/);
    expect(notices[1]!.detail).toMatch(/80\.00 MB/);
    // Room left and nothing over: no notice.
    const ok = allowanceFactsFromProjection({
      evidenceAdmission: { effectiveLifetimeCap: 3, next: { allowed: true } },
      usage: { storage: { state: "MEASURED", usedBytes: "0", limitBytes: String(250 * 1024 * 1024) } },
    });
    expect(captureAllowanceNotices(ok, 1024)).toEqual([]);
    // An unavailable meter is never turned into a figure.
    const unknown = allowanceFactsFromProjection({ usage: { storage: { state: "UNAVAILABLE" } } });
    expect(captureAllowanceNotices(unknown, 10 ** 12)).toEqual([]);
  });

  it("the notice links to plans in a new tab", () => {
    render(
      <CaptureAllowanceNotice
        notices={[{ code: "capture_records_exhausted", title: "No record left on your plan", detail: "All 3 records are in use." }]}
      />,
    );
    const link = screen.getByRole("link", { name: /View plans/ });
    expect(link.getAttribute("href")).toBe("/billing");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("the FREE_LIMIT_REACHED toast's View plans opens in a new tab", async () => {
    route = () => ({ status: 409, body: { code: "FREE_LIMIT_REACHED", message: "You have reached the record limit." } });
    let err: unknown = null;
    await apiFetch("/v1/evidence", { method: "POST", body: "{}" }).catch((e) => {
      err = e;
    });
    const toast = captureFailureToast(toSafeUserError(err), { explained: true });
    expect(toast.options.action).toMatchObject({ label: "View plans", href: "/billing", newTab: true });
    render(
      <ProovraToast
        toast={{ id: "t", message: "m", severity: "warning", duration: 0, action: toast.options.action }}
        onClose={() => {}}
      />,
    );
    const link = screen.getByRole("link", { name: "View plans" });
    expect(link.getAttribute("target")).toBe("_blank");
  });
});

// --- Audit of 4d9b78963 (round 3): C-05, C-10, F-P1-08, F-04 copy ----------

import { restoreDraftItemMetadata, newDraftRestoreState } from "../../app/(app)/capture/_lib/draft-item-restore";

const isParts = (r: { url: string }) => /\/parts$/.test(path(r.url));
const isComplete = (r: { url: string }) => /\/complete$/.test(path(r.url));

function standardRoute(completeAnswers: Array<{ status: number; body: unknown }> = []): Route {
  let parts = 0;
  return (url, init) => {
    if (path(url) === "/v1/evidence" && init.method === "POST") return { status: 201, body: { id: `ev-${creates().length}`, teamId: "team-1" } };
    if (/\/parts$/.test(path(url))) {
      parts += 1;
      return { status: 201, body: { part: { id: `p-${parts}` }, upload: { putUrl: `https://s3.test/put-${parts}` } } };
    }
    if (/\/complete$/.test(path(url))) return completeAnswers.shift() ?? { status: 200, body: {} };
    if (/artifacts\/status$/.test(path(url))) return { status: 200, body: { outputs: { report: { state: "READY" }, pollIntervalMs: null } } };
    return undefined;
  };
}

const inputsChanged = {
  status: 409,
  body: { code: "EVIDENCE_COMPLETION_INPUTS_CHANGED", message: "EVIDENCE_COMPLETION_INPUTS_CHANGED" },
};

describe("F-04 copy + C-05: a seal refused because its files changed keeps the record; edits made meanwhile reach the parts", () => {
  it("EVIDENCE_COMPLETION_INPUTS_CHANGED is explained; the retry resumes, restates the edited note (no PUT) and seals", async () => {
    route = standardRoute([inputsChanged]);
    const { result } = orchestration();
    act(() =>
      result.current.setSessionItems(() => [{ ...item("1", "a.pdf", HINT_A), privateNote: "first" }, item("2", "b.pdf")]),
    );
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(result.current.error).toMatch(/changed while it was being sealed/);
    expect(result.current.error).not.toMatch(/review your input/i);
    expect(result.current.sessionItems).toHaveLength(2);
    expect(putUrls).toHaveLength(2);

    act(() =>
      result.current.setSessionItems((prev) =>
        prev.map((i) => (i.id === "1" ? { ...i, privateNote: "edited note", role: "Primary" } : i)),
      ),
    );
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates(), "the reserved record is resumed").toHaveLength(1);
    const partPosts = requests.filter(isParts);
    expect(partPosts).toHaveLength(3);
    expect(partPosts[2]!.body).toMatchObject({
      partIndex: 0,
      originalFileName: "a.pdf",
      sizeBytes: 10,
      privateNote: "edited note",
      privateRole: "Primary",
      clientSignals: { clientHintSha256Base64: HINT_A },
    });
    expect(putUrls, "metadata restate never re-sends bytes").toHaveLength(2);
    const order = requests.filter((r) => isParts(r) || isComplete(r)).map((r) => (isParts(r) ? "parts" : "complete"));
    expect(order).toEqual(["parts", "parts", "complete", "parts", "complete"]);
    expect(push).toHaveBeenCalledWith("/evidence/ev-1");
  });

  it("a note cleared before the retry is restated as null; an unchanged item is not restated", async () => {
    route = standardRoute([inputsChanged]);
    const { result } = orchestration();
    act(() =>
      result.current.setSessionItems(() => [{ ...item("1", "a.pdf", HINT_A), privateNote: "first" }, item("2", "b.pdf")]),
    );
    await act(async () => {
      await result.current.finalizeSession();
    });
    act(() => result.current.setSessionItems((prev) => prev.map((i) => (i.id === "1" ? { ...i, privateNote: "" } : i))));
    await act(async () => {
      await result.current.finalizeSession();
    });
    const partPosts = requests.filter(isParts);
    expect(partPosts).toHaveLength(3);
    expect(partPosts[2]!.body).toMatchObject({ partIndex: 0, privateNote: null });
    expect(partPosts[2]!.body).not.toHaveProperty("privateRole");
  });
});

describe("C-05: a resumed draft gives its saved metadata back to re-attached files", () => {
  it("each saved entry is claimed once by name, size and type; only saved values apply; an item is looked at once", () => {
    const saved = [
      { fileName: "a.pdf", sizeBytes: 10, mimeType: "application/pdf", privateNote: "note A", checklistStepId: "step-1", role: null },
      { fileName: "a.pdf", sizeBytes: 10, mimeType: "application/pdf", privateNote: "note A2", sourceLabel: "Phone" },
      { fileName: "b.pdf", sizeBytes: 99, mimeType: "application/pdf", privateNote: "other size" },
    ];
    const state = newDraftRestoreState();
    const first = restoreDraftItemMetadata([item("1", "a.pdf"), item("2", "a.pdf"), item("3", "b.pdf")], saved, state);
    expect([...first.entries()]).toEqual([
      ["1", { privateNote: "note A", checklistStepId: "step-1" }],
      ["2", { privateNote: "note A2", sourceLabel: "Phone" }],
    ]);
    expect(restoreDraftItemMetadata([item("1", "a.pdf"), item("4", "a.pdf")], saved, state).size).toBe(0);
  });
});

describe("C-10: Finish binds the record it reserves to a draft", () => {
  function withEnsure(ensure: () => Promise<string | null>) {
    let draft: string | null = null;
    return renderHook(() =>
      useCaptureSessionOrchestration({
        internalNotes: "",
        onCloseCaptureDevices: () => {},
        onResetAudioRecorder: () => {},
        planMode: "FLEXIBLE",
        selectedCollectionPlan: undefined,
        useLocation: false,
        getCaptureSessionDraftId: () => draft,
        ensureCaptureSessionDraftId: async () => (draft = await ensure()),
      }),
    );
  }

  it("with no draft id yet, the draft is saved first and the create carries it with the manifest", async () => {
    route = standardRoute();
    const ensure = vi.fn(async () => "draft-new");
    const { result } = withEnsure(ensure);
    act(() => result.current.setSessionItems(() => [item("1", "a.pdf", HINT_A)]));
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(creates()[0]!.body).toMatchObject({
      captureSessionId: "draft-new",
      parts: [{ originalFileName: "a.pdf", mimeType: "application/pdf", sha256Base64: HINT_A }],
    });
  });

  it("after a failed upload and a removed item, the next create names the same draft (the server releases the stale record)", async () => {
    route = standardRoute();
    putStatuses = [200, 400];
    const { result } = withEnsure(async () => "draft-new");
    act(() => result.current.setSessionItems(() => [item("1", "a.pdf", HINT_A), item("2", "b.pdf")]));
    await act(async () => {
      await result.current.finalizeSession();
    });
    act(() => result.current.removeSessionItem("2"));
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(creates()).toHaveLength(2);
    expect(creates().map((c) => (c.body as { captureSessionId?: string }).captureSessionId)).toEqual(["draft-new", "draft-new"]);
  });

  it("ensureDraft saves at once and never creates a second draft while one is in flight", async () => {
    route = (url, init) =>
      path(url) === "/v1/capture/sessions" && init.method === "POST" ? { status: 201, body: { session: { id: "draft-7" } } } : undefined;
    const { result } = renderHook(() => useCaptureDraftPersistence({ enabled: true }));
    act(() =>
      result.current.scheduleSave({ templateId: null, planMode: "FLEXIBLE", internalNotes: "", useLocation: false, items: [item("1", "a.pdf")] }),
    );
    let ids: Array<string | null> = [];
    await act(async () => {
      ids = await Promise.all([result.current.ensureDraft(), result.current.ensureDraft()]);
    });
    expect(ids).toEqual(["draft-7", "draft-7"]);
    expect(requests.filter((r) => path(r.url) === "/v1/capture/sessions" && r.method === "POST")).toHaveLength(1);
  });
});

describe("F-P1-08: the Finish upload follows the shared storage-PUT rule", () => {
  it("a 403 (expired URL) presigns the part again and the capture seals", async () => {
    route = standardRoute();
    putStatuses = [403];
    const { result } = orchestration();
    act(() => result.current.setSessionItems(() => [item("1", "a.pdf", HINT_A)]));
    await act(async () => {
      await result.current.finalizeSession();
    });
    expect(result.current.error).toBeNull();
    expect(requests.filter(isParts)).toHaveLength(2);
    expect(putUrls).toEqual(["https://s3.test/put-1", "https://s3.test/put-2"]);
    expect(requests.filter(isComplete)).toHaveLength(1);
  });
});
