/**
 * CAPTURE SESSION ACTIVITY (T-14 CaptureActivityDisclosure) — the local log
 * of what happened in this staging session, newest first, in the web's words
 * (`recordTimelineEvent` in useCaptureSessionOrchestration).
 *
 * Local by design, as on the web: it describes the device's staging session,
 * not the server's custody record, and is never sent anywhere.
 *
 * Pure: no React, no react-native.
 */

export type CaptureActivityTone = "info" | "warning" | "danger";

export interface CaptureActivityEvent {
  id: string;
  atUtc: string;
  title: string;
  detail: string;
  tone: CaptureActivityTone;
}

export type CaptureActivityInput = Omit<CaptureActivityEvent, "id" | "atUtc">;

/** Newest first, as the web records it. */
export function appendCaptureActivity(
  events: ReadonlyArray<CaptureActivityEvent>,
  input: CaptureActivityInput,
  now: Date = new Date(),
): CaptureActivityEvent[] {
  return [
    { id: `${now.getTime()}-${Math.random().toString(16).slice(2)}`, atUtc: now.toISOString(), ...input },
    ...events,
  ];
}

/** The evidence type a camera capture stages, or null for picked materials. */
function capturedType(mimeType: string, source: string): string | null {
  if (source !== "CAMERA") return null;
  if (mimeType.startsWith("image/")) return "PHOTO";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  return null;
}

export function stagedActivity(input: { mimeType: string; source: string }): CaptureActivityInput {
  const type = capturedType(input.mimeType, input.source);
  return type
    ? { title: `${type} captured`, detail: `A ${type.toLowerCase()} item was added to the session.`, tone: "info" }
    : { title: "Materials staged", detail: "1 item added to this session.", tone: "info" };
}

export function removedActivity(name: string | null | undefined): CaptureActivityInput {
  return {
    title: "Material removed",
    detail: name ? `${name} was removed from the local staging session.` : "A staged material was removed from the local session.",
    tone: "info",
  };
}

export const FINALIZATION_STARTED: CaptureActivityInput = {
  title: "Finalization started",
  detail: "Finish & Sign process started for the current session.",
  tone: "info",
};

/** Native asks for Balanced accuracy — the web's reduced-precision wording. */
export const LOCATION_RECORDED: CaptureActivityInput = {
  title: "Location recorded",
  detail: "Reduced-precision device location metadata was attached with user consent.",
  tone: "info",
};

export const LOCATION_UNAVAILABLE: CaptureActivityInput = {
  title: "Location unavailable",
  detail: "The device denied or failed to provide location metadata.",
  tone: "warning",
};

export function captureActivityCountLabel(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}
