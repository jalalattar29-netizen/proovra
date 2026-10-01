import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/api", () => ({ apiFetch: async () => ({}), ApiError: class extends Error {} }));

import {
  screenRecordingSourceLabel,
  useCaptureScreenRecorder,
} from "../../app/(app)/capture/_hooks/useCaptureScreenRecorder";
import { CaptureScreenRecorderCard } from "../../app/(app)/capture/_lib/CaptureScreenRecorderCard";

/**
 * Web screen capture (owner mandate R02 / LCH-004) — getDisplayMedia +
 * MediaRecorder stubbed. Proves: honest permission handling, active / paused /
 * stopped states, recorded limitations (browser-reported surface, audio only if
 * granted, ended-by-browser), the recording is staged through the canonical
 * addFilesToSession as ONE VIDEO item, and cancel / retry leave it reusable.
 */

class FakeTrack extends EventTarget {
  stopped = false;
  constructor(public kind: "video" | "audio", private surface?: string) {
    super();
  }
  getSettings() {
    return this.kind === "video" ? { displaySurface: this.surface } : {};
  }
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}
let lastRecorder: FakeRecorder | null = null;
class FakeRecorder {
  static isTypeSupported(m: string) {
    return m === "video/webm;codecs=vp9,opus" || m === "video/webm";
  }
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_s: unknown, opts: { mimeType: string }) {
    this.mimeType = opts.mimeType;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test observes the instance the hook created
    lastRecorder = this;
  }
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.ondataavailable?.({ data: new Blob(["frames"], { type: "video/webm" }) });
    this.state = "inactive";
    this.onstop?.();
  }
}

let getDisplayMedia: ReturnType<typeof vi.fn>;
let videoTrack: FakeTrack;

function install(opts: { audio?: boolean; surface?: string; deny?: boolean } = {}) {
  videoTrack = new FakeTrack("video", opts.surface ?? "window");
  const tracks = [videoTrack, ...(opts.audio ? [new FakeTrack("audio")] : [])];
  getDisplayMedia = vi.fn(async () => {
    if (opts.deny) throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    return new FakeStream(tracks);
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
}

beforeEach(() => {
  lastRecorder = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCaptureScreenRecorder", () => {
  it("records, pauses, stops, and stages ONE video item through addFilesToSession with its limitations", async () => {
    install({ surface: "browser", audio: false });
    const addFilesToSession = vi.fn(async () => {});
    const { result } = renderHook(() => useCaptureScreenRecorder({ addFilesToSession }));
    expect(result.current.state).toBe("idle");

    await act(async () => {
      await result.current.start();
    });
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(result.current.state).toBe("recording");

    act(() => result.current.pause());
    expect(result.current.state).toBe("paused");
    act(() => result.current.resume());
    act(() => result.current.stop());
    expect(result.current.state).toBe("stopped");
    expect(result.current.recording?.type).toBe("video/webm");
    expect(videoTrack.stopped).toBe(true);

    await act(async () => {
      await result.current.addToSession();
    });
    expect(addFilesToSession).toHaveBeenCalledTimes(1);
    const [files, options] = addFilesToSession.mock.calls[0] as unknown as [File[], { sessionEvidenceType: string; sourceLabel: string }];
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/^screen-recording-.*\.webm$/);
    expect(options.sessionEvidenceType).toBe("VIDEO");
    expect(options.sourceLabel).toBe("Browser screen recording · browser tab (browser-reported) · no audio · paused 1x");
    expect(result.current.state).toBe("idle");
  });

  it("audio is reported only when the browser granted an audio track", async () => {
    install({ audio: true, surface: "monitor" });
    const { result } = renderHook(() => useCaptureScreenRecorder({ addFilesToSession: vi.fn(async () => {}) }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.facts.audioIncluded).toBe(true);
    expect(screenRecordingSourceLabel(result.current.facts)).toContain("audio included");
    expect(screenRecordingSourceLabel(result.current.facts)).toContain("entire screen (browser-reported)");
  });

  it("the browser's own Stop sharing ends the recording and is recorded as such", async () => {
    install();
    const { result } = renderHook(() => useCaptureScreenRecorder({ addFilesToSession: vi.fn(async () => {}) }));
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      videoTrack.dispatchEvent(new Event("ended"));
    });
    expect(result.current.state).toBe("stopped");
    expect(result.current.facts.endedByBrowser).toBe(true);
    expect(screenRecordingSourceLabel(result.current.facts)).toContain("ended by browser");
  });

  it("a denied permission records nothing and stays retryable", async () => {
    install({ deny: true });
    const addFilesToSession = vi.fn(async () => {});
    const { result } = renderHook(() => useCaptureScreenRecorder({ addFilesToSession }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toMatch(/not allowed/i);
    expect(lastRecorder).toBeNull();
    expect(addFilesToSession).not.toHaveBeenCalled();
  });

  it("discard (cancel) stops sharing, keeps nothing, and the recorder can start again", async () => {
    install();
    const addFilesToSession = vi.fn(async () => {});
    const { result } = renderHook(() => useCaptureScreenRecorder({ addFilesToSession }));
    await act(async () => {
      await result.current.start();
    });
    act(() => result.current.discard());
    expect(result.current.state).toBe("idle");
    expect(result.current.recording).toBeNull();
    expect(videoTrack.stopped).toBe(true);
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");
    expect(addFilesToSession).not.toHaveBeenCalled();
  });

  it("a failed add keeps the recording so the add can be retried", async () => {
    install();
    const addFilesToSession = vi
      .fn<(f: File[], o?: unknown) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error("raw prisma text"), { statusCode: 500 }))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useCaptureScreenRecorder({ addFilesToSession }));
    await act(async () => {
      await result.current.start();
    });
    act(() => result.current.stop());
    await act(async () => {
      await result.current.addToSession();
    });
    expect(result.current.state).toBe("stopped");
    expect(result.current.recording).not.toBeNull();
    expect(result.current.error).not.toMatch(/prisma/i);
    await act(async () => {
      await result.current.addToSession();
    });
    expect(addFilesToSession).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("idle");
  });

  it("an unsupported browser reports unsupported", () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { result } = renderHook(() => useCaptureScreenRecorder({ addFilesToSession: vi.fn(async () => {}) }));
    expect(result.current.state).toBe("unsupported");
  });
});

describe("CaptureScreenRecorderCard", () => {
  const noop = () => {};
  const base = {
    error: null,
    facts: {
      displaySurface: "window",
      audioIncluded: false,
      endedByBrowser: false,
      pauseCount: 0,
      startedAtUtc: null,
      stoppedAtUtc: null,
      durationMs: 0,
    },
    hasRecording: false,
    onStart: noop,
    onPause: noop,
    onResume: noop,
    onStop: noop,
    onDiscard: noop,
    onAdd: noop,
    onClose: noop,
  };

  it("states its limitations and claims no attestation", () => {
    render(<CaptureScreenRecorderCard {...base} state="idle" />);
    const text = document.querySelector("[data-screen-recorder-limitations]")!.textContent ?? "";
    expect(text).toMatch(/browser reports/i);
    expect(text).toMatch(/audio is included only if you allow it/i);
    expect(text).toMatch(/No device or operating-system attestation/);
    expect(document.body.textContent).not.toMatch(/tamper-proof|court-ready|verified device/i);
  });

  it("active state offers Pause and Stop; stopped offers Add and Discard", () => {
    const onPause = vi.fn();
    const { rerender } = render(<CaptureScreenRecorderCard {...base} state="recording" onPause={onPause} />);
    fireEvent.click(screen.getByText(/Pause/));
    expect(onPause).toHaveBeenCalled();
    expect(screen.getByText(/Stop/)).toBeTruthy();
    rerender(<CaptureScreenRecorderCard {...base} state="stopped" hasRecording />);
    expect(screen.getByText("Add recording to session")).toBeTruthy();
    expect(screen.getByText(/Discard/)).toBeTruthy();
  });

  it("offline disables adding and says why", async () => {
    render(<CaptureScreenRecorderCard {...base} state="stopped" hasRecording offline />);
    await waitFor(() => expect(screen.getByText(/You are offline/)).toBeTruthy());
    expect((screen.getByText("Add recording to session") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the capture page wires the recorder through the canonical session path", () => {
    const page = readFileSync(resolve(__dirname, "../../app/(app)/capture/page.tsx"), "utf8");
    expect(page).toMatch(/useCaptureScreenRecorder\(\{ addFilesToSession \}\)/);
    expect(page).toMatch(/<CaptureScreenRecorderCard/);
  });
});
