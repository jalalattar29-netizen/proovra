/**
 * F-P1-09 — VIDEO WITHOUT A MICROPHONE (product decision, 2026-11-15).
 *
 * "Where native recording supports it safely, allow silent video after
 * microphone denial with a clear pre-recording notice and truthful metadata."
 *
 * Native support: expo-camera's `mute` prop records with no audio input on both
 * targets (Android CameraX: no RECORD_AUDIO check and no `withAudioEnabled()`
 * when muted; iOS: the audio device input is removed from the session). Camera
 * permission is still required, and the microphone is still REQUESTED through
 * the OS prompt every time the video camera opens — the person's answer decides
 * whether the clip has sound, nothing else.
 *
 * The record says so: the part's `clientSignals` (the existing per-part client
 * metadata contract, `CreatePartBody.clientSignals`) carry `audioTracks: []` —
 * the vocabulary of the continuous-recording manifest ("the audio tracks
 * actually written; empty ⇒ silent") — and the reason. No server schema change.
 */

export type VideoAudioMode = "WITH_AUDIO" | "WITHOUT_AUDIO";

/** Said BEFORE recording, while the camera is open and the microphone is off. */
export const VIDEO_WITHOUT_AUDIO_NOTICE =
  "Microphone access is off, so this video will be recorded without sound. The evidence record will state that no audio was recorded. To record sound, allow microphone access in Settings.";

/** The short toast when the video camera opens without the microphone. */
export const VIDEO_WITHOUT_AUDIO_TOAST = "Microphone denied: video will be recorded without sound";

/** PURE — the recording mode the microphone answer allows. */
export function videoAudioModeFor(micGranted: boolean): VideoAudioMode {
  return micGranted ? "WITH_AUDIO" : "WITHOUT_AUDIO";
}

export type SilentVideoClientSignals = {
  audioTracks: [];
  audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED";
};

/**
 * PURE — the part metadata for one staged item. Only a clip KNOWN to be
 * recorded muted states anything: an ordinary clip claims no audio track it
 * has not verified, and a picked file or photo states nothing about audio.
 */
export function videoAudioClientSignals(audioRecorded: boolean | undefined): SilentVideoClientSignals | undefined {
  return audioRecorded === false
    ? { audioTracks: [], audioNotCapturedReason: "MICROPHONE_PERMISSION_DENIED" }
    : undefined;
}
