/**
 * Free-user audit 0ea0 — WEB-C2A-CAPTURE, the web rows beside the resumable
 * bridge (capture-resumable-bridge.render.test.tsx).
 *
 *   B4-F-302  the capture allowance notice is re-read after a seal / discard;
 *   B4-F-303  a silent recording is marked from its stream (no microphone at
 *             all, screen without audio); Close while recording stages nothing;
 *   B4-F-304  "Finish without location" goes through Review & Sign and is not
 *             offered while Review & Sign is blocked;
 *   B4-F-305  the Folder action no longer promises a kept folder structure;
 *   B4-F-307  drafts are started in, and listed for, the active workspace; a
 *             failed delete is said; deleting the adopted draft resets it;
 *   B4-F-309  a suggestion's action pill acts;
 *   B4-F-207  Clear Session states a reserved record truthfully;
 *   B4-F-206  the record page states a part recorded without audio;
 *   B4-F-102  the provenance view never prints a fragment or credential param.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const billingReads: string[] = [];
vi.mock("../../lib/api/billing-accounts", () => ({
  listBillingAccounts: async () => {
    billingReads.push("list");
    return [{ type: "PERSONAL", id: "acct-1" }];
  },
  readBillingAccount: async () => {
    billingReads.push("read");
    return {
      evidenceAdmission: { effectiveLifetimeCap: 3, next: { allowed: billingReads.filter((r) => r === "read").length < 2 } },
      usage: { storage: { state: "MEASURED", usedBytes: "0", limitBytes: "262144000" } },
    };
  },
}));
const apiCalls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    apiCalls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/v1/capture/sessions" && init?.method === "POST") return { session: { id: "draft-1" } };
    return {};
  },
  readApiToken: () => null,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { useCaptureAllowance } from "../../app/(app)/capture/_hooks/useCaptureAllowance";
import { useCaptureCamera } from "../../app/(app)/capture/_hooks/useCaptureCamera";
import { useCaptureDraftPersistence } from "../../app/(app)/capture/_hooks/useCaptureDraftPersistence";
import { draftBelongsToSpace } from "../../app/(app)/capture/_hooks/useCaptureDraftList";
import { CaptureLocationStatus } from "../../app/(app)/capture/_lib/CaptureLocationStatus";
import { CaptureClearConfirmDialog, clearSessionConsequence } from "../../app/(app)/capture/_lib/CaptureClearConfirmDialog";
import { CaptureDropzone } from "../../components/capture-v2/CaptureDropzone";
import { partAudioStatement } from "../../lib/evidence/part-audio-statement";
import { capturedPageAddress } from "../../lib/evidence/captured-page-url";
import { captureManifestItems } from "../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection";

const PAGE = readFileSync(resolve(__dirname, "../../app/(app)/capture/page.tsx"), "utf8");

beforeEach(() => {
  billingReads.length = 0;
  apiCalls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------- B4-F-302 -- */

describe("B4-F-302 — the allowance notice refreshes without a reload", () => {
  it("a new refresh key re-reads the account projection", async () => {
    const { result, rerender } = renderHook(({ key }) => useCaptureAllowance("personal-1", key), { initialProps: { key: 0 } });
    await vi.waitFor(() => expect(result.current?.nextRecordAllowed).toBe(true));
    rerender({ key: 1 });
    await vi.waitFor(() => expect(result.current?.nextRecordAllowed).toBe(false));
    expect(billingReads.filter((r) => r === "read")).toHaveLength(2);
  });

  it("the page bumps it after a seal and after a discard", () => {
    expect(PAGE).toMatch(/useCaptureAllowance\(\s*activeSpace\?\.type === "PERSONAL"[^)]*,\s*allowanceRefresh,\s*\)/);
    const finalized = PAGE.slice(PAGE.indexOf("onSessionFinalized: () => {"), PAGE.indexOf("onSessionDiscarded:"));
    expect(finalized).toMatch(/setAllowanceRefresh\(\(n\) => n \+ 1\)/);
    const discarded = PAGE.slice(PAGE.indexOf("onSessionDiscarded:"), PAGE.indexOf("resumable,\n  });"));
    expect(discarded).toMatch(/setAllowanceRefresh\(\(n\) => n \+ 1\)/);
  });
});

/* ------------------------------------------------------------- B4-F-303 -- */

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "video/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => Promise<void> | void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["frames"], { type: "video/webm" }) });
    void this.onstop?.();
  }
}

function stubNoMicrophone() {
  const silent = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
    if (c.audio) throw Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
    return silent;
  });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
}

describe("B4-F-303 — silent recordings are marked; Close while recording discards", () => {
  it("a video recorded with no microphone device is staged with MICROPHONE_UNAVAILABLE", async () => {
    stubNoMicrophone();
    const added = vi.fn(async () => {});
    const { result } = renderHook(() => useCaptureCamera({ addFilesToSessionRef: { current: added }, addToast: () => {} }));
    await act(async () => {
      await result.current.openCamera("VIDEO");
    });
    act(() => result.current.startVideoRecording());
    await act(async () => {
      result.current.stopVideoRecording();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    expect((added.mock.calls[0] as unknown as [File[], Record<string, unknown>])[1]).toMatchObject({
      audioSignals: { audioTracks: [], audioNotCapturedReason: "MICROPHONE_UNAVAILABLE" },
    });
  });

  it("closing the camera while recording stages nothing", async () => {
    stubNoMicrophone();
    const added = vi.fn(async () => {});
    const { result } = renderHook(() => useCaptureCamera({ addFilesToSessionRef: { current: added }, addToast: () => {} }));
    await act(async () => {
      await result.current.openCamera("VIDEO");
    });
    act(() => result.current.startVideoRecording());
    await act(async () => {
      result.current.closeCamera();
      await Promise.resolve();
    });
    expect(added).not.toHaveBeenCalled();
    expect(result.current.isRecording).toBe(false);
  });

  it("a screen recording without audio carries the no-audio marker", () => {
    const src = readFileSync(resolve(__dirname, "../../app/(app)/capture/_hooks/useCaptureScreenRecorder.ts"), "utf8");
    expect(src).toMatch(/factsRef\.current\.audioIncluded === false \? \{ audioSignals: videoWithoutAudioSignals\("AUDIO_NOT_SHARED"\) \}/);
  });
});

/* ------------------------------------------------------------- B4-F-304 -- */

describe("B4-F-304 — Finish without location goes through Review & Sign", () => {
  const location = {
    failure: "TIMEOUT",
    check: { status: "idle" },
    required: false,
    checkNow: async () => {},
  } as never;

  it("the button is disabled while Review & Sign is blocked", () => {
    const onFinish = vi.fn();
    render(<CaptureLocationStatus useLocation location={location} busy={false} finishDisabled onFinishWithoutLocation={onFinish} />);
    const button = screen.getByRole("button", { name: "Finish without location" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("the page opens the review dialog (accepting the location failure) instead of sealing", () => {
    const handler = PAGE.slice(PAGE.indexOf("onFinishWithoutLocation={() => {"), PAGE.indexOf("onFinishWithoutLocation={() => {") + 400);
    expect(handler).toMatch(/if \(finishDisabled\) return;\s*setReviewAcceptsLocationFailure\(true\);\s*setReviewOpen\(true\);/);
    expect(handler).not.toMatch(/finalizeWithoutLocation\(\)/);
    expect(PAGE).toMatch(/void \(acceptLocationFailure \? finalizeWithoutLocation\(\) : finalizeSession\(\)\);/);
  });
});

/* ------------------------------------------------------------- B4-F-305 -- */

describe("B4-F-305 — the Folder action says what it does", () => {
  it("no longer claims to keep the folder structure", () => {
    const noop = () => {};
    render(
      <CaptureDropzone
        busy={false}
        itemCount={0}
        onOpenFilePicker={noop}
        onOpenFolderPicker={noop}
        onOpenCamera={noop}
        onOpenAudioRecorder={noop}
        onDropFiles={async () => {}}
      />,
    );
    expect(screen.queryByText(/keeps folder structure/i)).toBeNull();
    expect(screen.getByText("Adds every file in a folder")).toBeTruthy();
  });
});

/* ------------------------------------------------------------- B4-F-307 -- */

describe("B4-F-307 — drafts belong to the workspace they were started in", () => {
  it("a new draft is created with the active workspace", async () => {
    const { result } = renderHook(() => useCaptureDraftPersistence({ enabled: true, teamId: "team-9" }));
    await act(async () => {
      result.current.scheduleSave({
        templateId: null,
        planMode: "FLEXIBLE",
        internalNotes: "Started on site",
        useLocation: false,
        items: [],
      } as never);
      await result.current.ensureDraft();
    });
    const create = apiCalls.find((c) => c.path === "/v1/capture/sessions");
    expect(create?.body?.teamId).toBe("team-9");
  });

  it("the list shows only the active workspace's drafts", () => {
    const personal = { id: "p1", type: "PERSONAL", shared: false };
    const team = { id: "team-9", type: "ORGANIZATION" };
    expect(draftBelongsToSpace({ teamId: "team-9" }, team)).toBe(true);
    expect(draftBelongsToSpace({ teamId: "team-9" }, personal)).toBe(false);
    expect(draftBelongsToSpace({ teamId: null }, personal)).toBe(true);
    expect(draftBelongsToSpace({ teamId: null }, team)).toBe(false);
    expect(draftBelongsToSpace({ teamId: "p1" }, personal)).toBe(true);
  });

  it("the page lists visible drafts, says a failed delete, resets an adopted draft it deletes, and refreshes after adopt/finalize", () => {
    expect(PAGE).toMatch(/useCaptureDraftPersistence\(\{ enabled: true, teamId: activeSpace\?\.id \|\| null \}\)/);
    expect(PAGE).toMatch(/draftList\.drafts\.filter\(\(draft\) => draftBelongsToSpace\(draft, activeSpace\)\)/);
    expect(PAGE).toMatch(/\{visibleDrafts\.map\(\(draft\) =>/);
    expect(PAGE).toMatch(/if \(draft\.id === draftPersistence\.draftId\) \{\s*await draftPersistence\.discardDraft\(\);/);
    expect(PAGE).toMatch(/The draft could not be deleted\. Try again\./);
    expect(PAGE).toMatch(/draftPersistence\.adoptDraft\(draft\.id\);\s*void draftList\.refresh\(\);/);
    const finalized = PAGE.slice(PAGE.indexOf("onSessionFinalized: () => {"), PAGE.indexOf("onSessionDiscarded:"));
    expect(finalized).toMatch(/void draftList\.refresh\(\);/);
  });
});

/* ------------------------------------------------------------- B4-F-309 -- */

describe("B4-F-309 — suggestion action pills act", () => {
  it("the page wires onActionClick to a handler that opens the template selector", () => {
    expect(PAGE).toMatch(/<CaptureSuggestionsPanel[\s\S]*?onActionClick=\{onSuggestionAction\}/);
    const handler = PAGE.slice(PAGE.indexOf("const onSuggestionAction = useCallback("), PAGE.indexOf("const openAssignmentFor = useCallback("));
    expect(handler).toMatch(/targetId === "template-selector"[\s\S]*setSetupOpen\(true\);[\s\S]*focusById\(setupPanelId, "\[data-capture-template-select\]"\)/);
  });
});

/* ------------------------------------------------------------- B4-F-207 -- */

describe("B4-F-207 — Clear Session states a reserved record truthfully", () => {
  it("the consequence differs when a record was reserved", () => {
    expect(clearSessionConsequence(null)).toMatch(/No evidence record has been created yet\./);
    expect(clearSessionConsequence("released")).toMatch(/already reserved for this session; clearing releases it/);
    expect(clearSessionConsequence("expires")).toMatch(/released automatically within 24 hours/);
    expect(clearSessionConsequence("released")).not.toMatch(/No evidence record has been created/);
    render(<CaptureClearConfirmDialog open reservedRecord="released" onKeep={() => {}} onClear={() => {}} />);
    expect(screen.getByText(/clearing releases it/)).toBeTruthy();
  });

  it("the page passes the reservation state", () => {
    expect(PAGE).toMatch(/reservedRecord=\{reservedEvidenceId \? \(draftPersistence\.draftId \? "released" : "expires"\) : null\}/);
  });
});

/* ------------------------------------------------------------- B4-F-206 -- */

describe("B4-F-206 — the record page states a video recorded without audio", () => {
  it("states each reason; nothing for a part with audio", () => {
    expect(partAudioStatement({ audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" })).toMatch(/microphone permission was denied/);
    expect(partAudioStatement({ audioNotCapturedReason: "MICROPHONE_UNAVAILABLE" })).toMatch(/no microphone could be used/);
    expect(partAudioStatement({ audioNotCapturedReason: "AUDIO_NOT_SHARED" })).toMatch(/shared screen's audio/);
    expect(partAudioStatement({ audioNotCapturedReason: "SOMETHING_NEW" })).toMatch(/No audio was recorded/);
    expect(partAudioStatement({ audioTracks: ["a"] })).toBeNull();
    expect(partAudioStatement(null)).toBeNull();
  });

  it("the file cards render it", () => {
    const lib = readFileSync(resolve(__dirname, "../../app/(app)/evidence/[id]/_tabs/_lib.tsx"), "utf8");
    expect(lib).toMatch(/const audioStatement = partAudioStatement\(itemWithMeta\.clientSignals\);/);
    expect(lib).toMatch(/data-content-item-audio-statement/);
  });
});

/* ------------------------------------------------------------- B4-F-102 -- */

describe("B4-F-102 — the captured page address is printed without secrets", () => {
  it("drops the fragment and redacts credential parameters (legacy raw manifests too)", () => {
    expect(capturedPageAddress("https://x.test/y?token=abc&q=1#access_token=z")).toBe("https://x.test/y?token=REDACTED&q=1");
    expect(capturedPageAddress("https://x.test/y#frag")).toBe("https://x.test/y");
    expect(capturedPageAddress("https://x.test/y?X-Amz-Signature=s")).toBe("https://x.test/y?X-Amz-Signature=REDACTED");
    const items = captureManifestItems(
      {
        web: { sourceUrlPrivate: "https://x.test/y?sig=abc#access_token=z", titlePrivate: null, pageMutatedDuringCapture: false },
        clientCaptureWindow: null,
        client: null,
        limitations: [],
        completeness: "CAPTURED",
      } as never,
      (iso) => iso,
    ).slice(0, 1);
    expect(items.find((i) => i.label.startsWith("Captured page"))?.value).toBe("https://x.test/y?sig=REDACTED");
  });
});
