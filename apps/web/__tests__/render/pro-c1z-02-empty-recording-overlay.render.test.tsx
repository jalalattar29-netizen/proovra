/**
 * PRO-C1Z-02 — an empty camera recording returns the Video overlay to Record.
 *
 * The real `useCaptureCamera` hook over a fake MediaRecorder:
 *   - an empty recording: the error is said, nothing is staged, and the hook
 *     leaves the recording state (it was stuck in REC before);
 *   - control: a non-empty recording is staged and also leaves the recording state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { useCaptureCamera } from "../../app/(app)/capture/_hooks/useCaptureCamera";

let chunk: Blob = new Blob([]);

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
    this.ondataavailable?.({ data: chunk });
    void this.onstop?.();
  }
}

const fakeStream = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;

function stubDevices() {
  const getUserMedia = vi.fn(async () => fakeStream);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
}

async function recordAndStop() {
  const added = vi.fn(async () => {});
  const { result } = renderHook(() => useCaptureCamera({ addFilesToSessionRef: { current: added }, addToast: () => {} }));
  await act(async () => {
    await result.current.openCamera("VIDEO");
  });
  act(() => result.current.startVideoRecording());
  expect(result.current.isRecording).toBe(true);
  await act(async () => {
    result.current.stopVideoRecording();
    await Promise.resolve();
  });
  return { result, added };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PRO-C1Z-02 — empty recording", () => {
  it("an empty recording stages nothing, says so, and leaves the recording state", async () => {
    stubDevices();
    chunk = new Blob([], { type: "video/webm" });
    const { result, added } = await recordAndStop();
    await vi.waitFor(() => expect(result.current.cameraError).toBe("Recorded video is empty."));
    expect(added).not.toHaveBeenCalled();
    expect(result.current.isRecording).toBe(false);
  });

  it("control: a non-empty recording is staged and leaves the recording state", async () => {
    stubDevices();
    chunk = new Blob(["frames"], { type: "video/webm" });
    const { result, added } = await recordAndStop();
    await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(result.current.isRecording).toBe(false));
  });
});
