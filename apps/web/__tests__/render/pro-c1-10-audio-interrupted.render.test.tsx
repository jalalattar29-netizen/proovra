/**
 * PRO-C1-10 — a microphone that ends or is muted mid-recording leaves a marker
 * that reaches the server, and the record page states it.
 *
 * The real `useCaptureCamera` hook over a fake MediaRecorder and a fake audio
 * track, then the real part upload (`uploadLegacyPart`) through the real
 * apiFetch over a stubbed fetch, reading the presign body the API receives:
 *   - allowed: the track ends mid-recording -> the presign body carries
 *     audioInterrupted + audioInterruptedReason, and the record states it;
 *   - refused: an uninterrupted recording carries no marker and states nothing.
 * (Before the fix the hook set the marker locally and partClientSignals
 * dropped it, so the record never learned of the interruption.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

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
import { partAudioStatement } from "../../lib/evidence/part-audio-statement";

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

function audioTrack() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    kind: "audio",
    addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    fire: (type: string) => (listeners.get(type) ?? []).forEach((fn) => fn()),
  };
}

async function record(interrupt: "ended" | "mute" | null) {
  const track = audioTrack();
  const stream = { getTracks: () => [], getAudioTracks: () => [track], getVideoTracks: () => [] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn(async () => stream) }, configurable: true });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  const added = vi.fn(async () => {});
  const { result } = renderHook(() => useCaptureCamera({ addFilesToSessionRef: { current: added }, addToast: () => {} }));
  await act(async () => {
    await result.current.openCamera("VIDEO");
  });
  act(() => result.current.startVideoRecording());
  if (interrupt) track.fire(interrupt);
  await act(async () => {
    result.current.stopVideoRecording();
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(1));
  const [files, options] = added.mock.calls[0] as unknown as [File[], { audioSignals?: Record<string, unknown> }];
  return { file: files[0]!, audioSignals: options.audioSignals };
}

/** Upload the staged recording through the real apiFetch; return the presign body the API received. */
async function presignBodyFor(file: File, audioSignals: Record<string, unknown> | undefined) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ part: { id: "p-0" }, upload: { putUrl: "https://s3.test/put" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      status = 200;
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      getResponseHeader() {
        return null;
      }
      send() {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  const item = {
    id: "1",
    file,
    previewUrl: null,
    mimeType: "video/webm",
    relativePath: null,
    uploadProgress: 0,
    uploading: false,
    error: null,
    clientSignals: {
      captureTimeUtc: "2026-11-21T00:00:00.000Z",
      browserMediaCaptureAvailable: true,
      folderPathPresent: false,
      locationIncluded: false,
      ...(audioSignals ?? {}),
    },
  } as unknown as SessionItem;
  await uploadLegacyPart({ evidenceId: "ev-1", index: 0, item, locationIncluded: false, onProgress: () => {} });
  const presign = bodies.find((b) => b && typeof b === "object" && "clientSignals" in b);
  expect(presign, JSON.stringify(bodies)).toBeTruthy();
  return presign as { clientSignals: Record<string, unknown> };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PRO-C1-10 — an interrupted microphone reaches the record", () => {
  it("allowed: a microphone that ENDED mid-recording is sent with the part and stated on the record", async () => {
    const { file, audioSignals } = await record("ended");
    const body = await presignBodyFor(file, audioSignals);
    expect(body.clientSignals).toMatchObject({ audioInterrupted: true, audioInterruptedReason: "TRACK_ENDED" });
    expect(partAudioStatement(body.clientSignals)).toMatch(/^Audio may be missing from part of this video: the microphone stopped/);
  });

  it("allowed: a microphone MUTED mid-recording is sent as TRACK_MUTED", async () => {
    const { file, audioSignals } = await record("mute");
    const body = await presignBodyFor(file, audioSignals);
    expect(body.clientSignals).toMatchObject({ audioInterrupted: true, audioInterruptedReason: "TRACK_MUTED" });
    expect(partAudioStatement(body.clientSignals)).toMatch(/muted during the recording/);
  });

  it("refused: an uninterrupted recording carries no marker and the record states nothing", async () => {
    const { file, audioSignals } = await record(null);
    const body = await presignBodyFor(file, audioSignals);
    expect(body.clientSignals).not.toHaveProperty("audioInterrupted");
    expect(body.clientSignals).not.toHaveProperty("audioInterruptedReason");
    expect(partAudioStatement(body.clientSignals)).toBeNull();
  });
});
