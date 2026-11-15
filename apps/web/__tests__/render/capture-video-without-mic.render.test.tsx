/**
 * F-P1-09 parity (Free-user audit of 4d9b78963) — a web video recorded after
 * the microphone permission was refused says so on its part, exactly as the
 * native recorder does: clientSignals `{ audioTracks: [],
 * audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" }`. The web recorded
 * video-only with a warning and sent nothing, so the record could not tell a
 * silent scene from a recording that never had a microphone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const presigns: Array<Record<string, unknown>> = [];
vi.mock("../../lib/api", () => ({
  apiFetch: async (_path: string, init?: RequestInit) => {
    presigns.push(JSON.parse(String(init?.body)));
    return { part: { id: "p-0" }, upload: { putUrl: "https://s3.test/put" } };
  },
  readApiToken: () => null,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../app/(app)/capture/_lib/hash-utils", () => ({
  computeIntegrityFromBlob: async () => ({
    checksumSha256Base64: "c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2hhMjU2c2g=",
    contentMd5Base64: "bWQ1bWQ1bWQ1bWQ1bWQ1bQ==",
  }),
}));

import { useCaptureCamera } from "../../app/(app)/capture/_hooks/useCaptureCamera";
import { uploadLegacyPart } from "../../app/(app)/capture/_hooks/legacy-part-upload";
import type { SessionItem } from "../../app/(app)/capture/_lib/types";

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

const fakeStream = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;

function stubDevices(microphone: "denied" | "granted") {
  const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
    if (c.audio && microphone === "denied") throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    return fakeStream;
  });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
}

async function recordOneVideo() {
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
  return added.mock.calls[0] as unknown as [File[], Record<string, unknown>];
}

beforeEach(() => {
  presigns.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("F-P1-09 — web video without microphone, as native", () => {
  it("a recording after the microphone was refused is staged with the native audio facts", async () => {
    stubDevices("denied");
    const [, options] = await recordOneVideo();
    expect(options).toMatchObject({
      sessionEvidenceType: "VIDEO",
      audioSignals: { audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" },
    });
  });

  it("a recording with the microphone carries no audio facts", async () => {
    stubDevices("granted");
    const [, options] = await recordOneVideo();
    expect(options).not.toHaveProperty("audioSignals");
  });

  it("the part presign forwards the two keys (and only for such a video)", async () => {
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        status = 200;
        upload = { onprogress: null };
        onload: (() => void) | null = null;
        open() {}
        setRequestHeader() {}
        send() {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const base = {
      id: "1",
      file: new File(["v"], "clip.webm", { type: "video/webm" }),
      previewUrl: null,
      mimeType: "video/webm",
      relativePath: null,
      uploadProgress: 0,
      uploading: false,
      error: null,
    };
    const signals = { captureTimeUtc: "2026-11-15T00:00:00.000Z", browserMediaCaptureAvailable: true, folderPathPresent: false, locationIncluded: false };
    const run = (item: SessionItem) => uploadLegacyPart({ evidenceId: "ev-1", index: 0, item, locationIncluded: false, onProgress: () => {} });
    await run({ ...base, clientSignals: { ...signals, audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" } } as SessionItem);
    await run({ ...base, clientSignals: signals } as SessionItem);
    expect(presigns[0]!.clientSignals).toMatchObject({ audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" });
    expect(presigns[1]!.clientSignals).not.toHaveProperty("audioNotCapturedReason");
    expect(presigns[1]!.clientSignals).not.toHaveProperty("audioTracks");
  });
});
