/**
 * B4-F-206 (Free-user audit 0ea0, web record page) — F-P1-09: a video recorded
 * without audio states it on the record.
 *
 * The capture clients (native video-audio.ts, web camera and screen recorder)
 * store `clientSignals.audioNotCapturedReason` on the part, and the Capture
 * notice promises "the evidence record will state that no audio was
 * recorded". Nothing read it. The review workspace already carries each
 * part's clientSignals (workspace-internal), so the record page now says it,
 * per file. PURE.
 */
const STATEMENTS: Record<string, string> = {
  MICROPHONE_PERMISSION_DENIED: "No audio was recorded: the microphone permission was denied when this video was captured.",
  MICROPHONE_UNAVAILABLE: "No audio was recorded: no microphone could be used when this video was captured.",
  AUDIO_NOT_SHARED: "No audio was recorded: the shared screen's audio was not included in this recording.",
};

export const PART_AUDIO_NOT_RECORDED_FALLBACK = "No audio was recorded with this video (stated by the capture client).";

/** PRO-C1-10 — audio captured at the start, then ended or muted mid-recording. */
const INTERRUPTED: Record<string, string> = {
  TRACK_ENDED: "Audio may be missing from part of this video: the microphone stopped during the recording (permission revoked or device disconnected).",
  TRACK_MUTED: "Audio may be missing from part of this video: the microphone was muted during the recording.",
};
export const PART_AUDIO_INTERRUPTED_FALLBACK = "Audio may be missing from part of this video: the audio stopped during the recording (stated by the capture client).";

export function partAudioStatement(clientSignals: unknown): string | null {
  if (!clientSignals || typeof clientSignals !== "object" || Array.isArray(clientSignals)) return null;
  const reason = (clientSignals as { audioNotCapturedReason?: unknown }).audioNotCapturedReason;
  if (typeof reason !== "string" || !reason.trim()) {
    const signals = clientSignals as { audioInterrupted?: unknown; audioInterruptedReason?: unknown };
    if (signals.audioInterrupted !== true) return null;
    const why = typeof signals.audioInterruptedReason === "string" ? signals.audioInterruptedReason.trim().toUpperCase() : "";
    return INTERRUPTED[why] ?? PART_AUDIO_INTERRUPTED_FALLBACK;
  }
  return STATEMENTS[reason.trim().toUpperCase()] ?? PART_AUDIO_NOT_RECORDED_FALLBACK;
}
