"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { logCaptureClientError } from "../_lib/capture-errors";
import type { CaptureSessionAddFiles } from "./useCaptureSessionOrchestration";

/**
 * WEB SCREEN CAPTURE (owner mandate R02 / LCH-004) — browser screen recording
 * on the Capture page through `getDisplayMedia`.
 *
 * NOT A PARALLEL PIPELINE. The recording becomes ONE staged video item through
 * the same `addFilesToSession` every other material uses, and is finalized by
 * the same Finish & Sign path (POST /v1/evidence → parts → complete). The
 * server assigns the acquisition mode it assigns to any web upload; nothing
 * here claims device or operating-system attestation.
 *
 * HONEST LIMITATIONS, RECORDED WITH THE ITEM
 *   * the capture surface (screen / window / tab) is what the BROWSER reports
 *     (`track.getSettings().displaySurface`) — PROOVRA does not verify it;
 *   * audio is included only if the user granted audio in the browser's own
 *     dialog — the label says which;
 *   * a recording the browser ended (user clicked "Stop sharing", tab closed)
 *     is marked as ended by the browser;
 *   * pauses are recorded (the recording does not cover paused time).
 */

export type ScreenRecorderState =
  | "unsupported"
  | "idle"
  | "requesting"
  | "recording"
  | "paused"
  | "stopped"
  | "adding"
  | "failed";

export type ScreenRecordingFacts = {
  displaySurface: string | null;
  audioIncluded: boolean;
  endedByBrowser: boolean;
  pauseCount: number;
  startedAtUtc: string | null;
  stoppedAtUtc: string | null;
  durationMs: number;
};

const EMPTY_FACTS: ScreenRecordingFacts = {
  displaySurface: null,
  audioIncluded: false,
  endedByBrowser: false,
  pauseCount: 0,
  startedAtUtc: null,
  stoppedAtUtc: null,
  durationMs: 0,
};

export function isScreenRecordingSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const md = navigator.mediaDevices as (MediaDevices & { getDisplayMedia?: unknown }) | undefined;
  return Boolean(md && typeof md.getDisplayMedia === "function" && typeof window.MediaRecorder === "function");
}

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export function pickScreenRecordingMimeType(): string {
  const MR = typeof window !== "undefined" ? window.MediaRecorder : undefined;
  if (!MR || typeof MR.isTypeSupported !== "function") return "video/webm";
  return MIME_CANDIDATES.find((m) => MR.isTypeSupported(m)) ?? "video/webm";
}

const SURFACE_LABEL: Record<string, string> = {
  monitor: "entire screen",
  window: "window",
  browser: "browser tab",
};

/** The source label stored on the part (server bound: 120 chars). */
export function screenRecordingSourceLabel(facts: ScreenRecordingFacts): string {
  const surface = facts.displaySurface
    ? SURFACE_LABEL[facts.displaySurface] ?? "unknown surface"
    : "surface not reported";
  const parts = [
    "Browser screen recording",
    `${surface} (browser-reported)`,
    facts.audioIncluded ? "audio included" : "no audio",
  ];
  if (facts.endedByBrowser) parts.push("ended by browser");
  if (facts.pauseCount > 0) parts.push(`paused ${facts.pauseCount}x`);
  return parts.join(" · ").slice(0, 120);
}

export function screenRecordingFileName(startedAtUtc: string | null, mimeType: string): string {
  const stamp = (startedAtUtc ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const ext = mimeType.includes("mp4") ? "mp4" : "webm";
  return `screen-recording-${stamp}.${ext}`;
}

type Params = {
  addFilesToSession: CaptureSessionAddFiles;
  /** The page's timeline, so the limitations are part of the session record. */
  onRecorded?: (facts: ScreenRecordingFacts, label: string) => void;
};

export function useCaptureScreenRecorder({ addFilesToSession, onRecorded }: Params) {
  const [state, setState] = useState<ScreenRecorderState>(() =>
    isScreenRecordingSupported() ? "idle" : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const [facts, setFacts] = useState<ScreenRecordingFacts>(EMPTY_FACTS);
  const [recording, setRecording] = useState<File | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const factsRef = useRef<ScreenRecordingFacts>(EMPTY_FACTS);
  const startedMsRef = useRef<number>(0);
  const discardRef = useRef(false);

  const updateFacts = (patch: Partial<ScreenRecordingFacts>) => {
    factsRef.current = { ...factsRef.current, ...patch };
    setFacts(factsRef.current);
  };

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* already stopped */
      }
    });
    streamRef.current = null;
  };

  // Never leave the browser sharing a screen after the page goes away.
  useEffect(
    () => () => {
      discardRef.current = true;
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      } catch {
        /* ignore */
      }
      releaseStream();
    },
    [],
  );

  const start = useCallback(async () => {
    if (!isScreenRecordingSupported()) {
      setState("unsupported");
      return;
    }
    setError(null);
    setRecording(null);
    discardRef.current = false;
    chunksRef.current = [];
    factsRef.current = { ...EMPTY_FACTS };
    setFacts(factsRef.current);
    setState("requesting");
    let stream: MediaStream;
    try {
      // `audio: true` lets the browser OFFER audio; whether it is included is
      // the user's choice in the browser dialog, read back from the tracks.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      setState(name === "NotAllowedError" || name === "AbortError" ? "idle" : "failed");
      setError(
        name === "NotAllowedError" || name === "AbortError"
          ? "Screen sharing was not allowed. Nothing was recorded."
          : toSafeUserError(err, { message: "The browser could not start screen recording." }).message,
      );
      return;
    }
    streamRef.current = stream;
    const [video] = stream.getVideoTracks();
    const settings = (video?.getSettings?.() ?? {}) as MediaTrackSettings & { displaySurface?: string };
    startedMsRef.current = Date.now();
    updateFacts({
      displaySurface: typeof settings.displaySurface === "string" ? settings.displaySurface : null,
      audioIncluded: stream.getAudioTracks().length > 0,
      startedAtUtc: new Date().toISOString(),
    });

    const mimeType = pickScreenRecordingMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (err) {
      releaseStream();
      setState("failed");
      setError(toSafeUserError(err, { message: "The browser could not start screen recording." }).message);
      return;
    }
    recorderRef.current = recorder;
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      releaseStream();
      updateFacts({
        stoppedAtUtc: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedMsRef.current),
      });
      if (discardRef.current) {
        chunksRef.current = [];
        setState("idle");
        return;
      }
      const type = recorder.mimeType || mimeType;
      const blob = new Blob(chunksRef.current, { type: type.split(";")[0] });
      chunksRef.current = [];
      if (blob.size === 0) {
        setState("failed");
        setError("The recording is empty. Nothing was added to the session.");
        return;
      }
      setRecording(
        new File([blob], screenRecordingFileName(factsRef.current.startedAtUtc, type), {
          type: type.split(";")[0],
          lastModified: Date.now(),
        }),
      );
      setState("stopped");
    };
    // The browser's own "Stop sharing" (or a closed tab) ends the track.
    if (video) {
      video.addEventListener("ended", () => {
        if (recorder.state !== "inactive") {
          updateFacts({ endedByBrowser: true });
          recorder.stop();
        }
      });
    }
    recorder.start(1000);
    setState("recording");
  }, []);

  const pause = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state === "recording") {
      r.pause();
      updateFacts({ pauseCount: factsRef.current.pauseCount + 1 });
      setState("paused");
    }
  }, []);

  const resume = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state === "paused") {
      r.resume();
      setState("recording");
    }
  }, []);

  const stop = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") r.stop();
  }, []);

  /** Cancel: stop sharing, keep nothing. Always leaves the recorder reusable. */
  const discard = useCallback(() => {
    discardRef.current = true;
    const r = recorderRef.current;
    if (r && r.state !== "inactive") {
      r.stop();
    } else {
      releaseStream();
      setState(isScreenRecordingSupported() ? "idle" : "unsupported");
    }
    setRecording(null);
    setError(null);
  }, []);

  /** Stage the recording through the canonical session path. */
  const addToSession = useCallback(async () => {
    if (!recording) return;
    setState("adding");
    setError(null);
    const label = screenRecordingSourceLabel(factsRef.current);
    try {
      await addFilesToSession([recording], { sessionEvidenceType: "VIDEO", sourceLabel: label });
      onRecorded?.(factsRef.current, label);
      setRecording(null);
      setState("idle");
    } catch (err) {
      logCaptureClientError("web_capture_add_screen_recording", err, {});
      // The recording is kept so "Add to session" can be retried.
      setState("stopped");
      setError(
        toSafeUserError(err, {
          message: "The screen recording could not be added to the session. Retry to add it.",
        }).message,
      );
    }
  }, [recording, addFilesToSession, onRecorded]);

  return { state, error, facts, recording, start, pause, resume, stop, discard, addToSession };
}
