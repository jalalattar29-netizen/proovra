/**
 * SCREEN ACQUISITION, INSIDE THE CANONICAL CAPTURE LIFECYCLE.
 *
 * ===========================================================================
 * WHAT WAS WRONG
 * ===========================================================================
 * The product had one lifecycle and two user-facing endings. `/capture` staged
 * items into a canonical DRAFT and created Evidence once, at an explicit
 * Finish & Sign. `/screen-capture` and `/continuous-capture` opened a direct
 * session, uploaded, sealed and produced Evidence on their own — no draft, no
 * staging, no review, no discard-before-commit, and their own Finalize button.
 *
 * Someone who started in Capture and chose "Screen capture" left the product
 * workflow without being told, and finished in a different one.
 *
 * ===========================================================================
 * WHAT IS UNIFIED, WHAT IS NOT, AND WHY
 * ===========================================================================
 * The PRODUCT lifecycle is unified: every acquisition method opens a canonical
 * draft, stages what it acquired, is reviewed in one place, and is finalized by
 * one Finish & Sign.
 *
 * The ACQUISITION and SEALING mechanism is deliberately NOT collapsed.
 * `acquisitionMode` is stamped on the session at open and read back by
 * `reserveDirectCaptureEvidence` to stamp the Evidence
 * (direct-capture-ingest.service.ts:251, :378). One session carries ONE mode
 * and reserves ONE record — `SESSION_ALREADY_RESERVED` enforces it.
 *
 * So a photo taken with the camera and a recording made by MediaProjection
 * cannot honestly share one Evidence record: it would have to claim a single
 * origin for two different ones. Mixing media WITHIN a mode already works and
 * is what `deriveBatchEvidenceType` is for. Mixing ACROSS modes is not a
 * feature withheld here; it is a provenance claim the product must not make,
 * and UC-0 exists precisely to stop it being made.
 *
 * One lifecycle, one finalization, one honest origin per record.
 */

import type { DraftItemInput } from "./capture-draft";

/**
 * The screen acquisition modes, in the SERVER'S vocabulary.
 *
 * These are `DIRECT_CAPTURE_SESSION_MODES` values
 * (direct-capture-ingest.service.ts:59) and the same strings the two capture
 * engines already pass to `openDirectCaptureSession`. Naming them again in a
 * native-only vocabulary would be a second authority for the one thing that
 * must not drift: what the product claims about where a record came from.
 */
export const SCREEN_ACQUISITION_MODES = [
  "DIRECT_SCREEN_CAPTURE_ANDROID",
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  "DIRECT_SCREEN_CAPTURE_IOS",
] as const;

export type ScreenAcquisitionMode = (typeof SCREEN_ACQUISITION_MODES)[number];

export function isScreenAcquisitionMode(value: unknown): value is ScreenAcquisitionMode {
  return (
    typeof value === "string" &&
    (SCREEN_ACQUISITION_MODES as readonly string[]).includes(value)
  );
}

/**
 * The completion route that seals each mode.
 *
 * Two routes and not one, because they record different things.
 * `screen-complete` takes the frame manifest; `continuous-complete` takes the
 * continuity manifest and the session's completeness, which is what says
 * whether the recording was interrupted. Collapsing them would throw away the
 * part of the record that answers that.
 *
 * UC-5 (Apple's system broadcast) seals through the CONTINUOUS pipeline —
 * `beginContinuousSession` opens it with the iOS mode and the same segment
 * transport, so it is the same sealing shape with a different origin claim.
 */
export function buildScreenCompletePath(captureSessionId: string): string {
  return `/v1/capture/direct-sessions/${encodeURIComponent(captureSessionId)}/screen-complete`;
}

export function buildContinuousCompletePath(captureSessionId: string): string {
  return `/v1/capture/direct-sessions/${encodeURIComponent(captureSessionId)}/continuous-complete`;
}

/**
 * ONE BUILDER PER ROUTE, and this picks between them.
 *
 * It used to assemble both from one template with a runtime suffix. That is
 * the shape `evidence-detail.ts` already records a lesson about: "neither a
 * reader nor the capability analyzer could tell which endpoint a given button
 * called". It showed up immediately — the architecture map could attribute
 * `screen-complete` and lost `continuous-complete` entirely, reporting a route
 * the product calls every time a recording is finished as having no consumer.
 *
 * A measurement that cannot see a call is not a small problem in a repository
 * whose release gate counts consumed routes.
 */
export function screenSealPath(
  mode: ScreenAcquisitionMode,
  captureSessionId: string,
): string {
  return mode === "DIRECT_SCREEN_CAPTURE_ANDROID"
    ? buildScreenCompletePath(captureSessionId)
    : buildContinuousCompletePath(captureSessionId);
}

/** The label an operator reads for a staged screen acquisition. */
export function screenAcquisitionLabel(mode: ScreenAcquisitionMode): string {
  switch (mode) {
    case "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS":
      return "Continuous screen recording";
    case "DIRECT_SCREEN_CAPTURE_IOS":
      // Apple's system broadcast records continuously, so it reads as a
      // recording rather than as the frame-by-frame Android capture.
      return "Screen recording";
    default:
      return "Screen capture";
  }
}

/** Frames for the single-shot mode, segments for the continuous ones. */
export function screenPartUnit(mode: ScreenAcquisitionMode): "frame" | "segment" {
  return mode === "DIRECT_SCREEN_CAPTURE_ANDROID" ? "frame" : "segment";
}

/**
 * One staged item standing for a whole screen acquisition.
 *
 * ONE item, not one per frame. The draft's `itemsSnapshot` is the operator's
 * plan — what is in this session and why — and fifty rows reading
 * "screen-frame-31.png" would bury the photo staged beside them while saying
 * nothing the operator did not already know. The frames still become
 * individual PARTS of the record at finalize, which is where file-level detail
 * belongs and where the server verifies each digest.
 *
 * `sourceLabel` carries the acquisition mode, which is how the app already
 * reports where an item came from — client-reported, and recorded as such.
 */
export function toScreenDraftItem(input: {
  mode: ScreenAcquisitionMode;
  clientItemId: string;
  /** How many frames or segments the acquisition produced. */
  partCount: number;
  /** Total bytes across the acquired parts, as far as the client knows. */
  sizeBytes: number;
  durationMs?: number | null;
  /** The operator's own note, when the surface collected one. */
  privateNote?: string | null;
}): DraftItemInput {
  const unit = screenPartUnit(input.mode);
  const count = Math.max(0, Math.trunc(input.partCount || 0));
  return {
    clientItemId: input.clientItemId,
    fileName: `${screenAcquisitionLabel(input.mode)} (${count} ${count === 1 ? unit : `${unit}s`})`,
    // The record's parts are PNG frames or MP4 segments; the staged row stands
    // for the recording as a whole and carries the part media type rather than
    // inventing a container type the session does not produce.
    mimeType: unit === "segment" ? "video/mp4" : "image/png",
    sizeBytes: Math.max(0, Math.trunc(input.sizeBytes || 0)),
    durationMs: input.durationMs ?? null,
    sourceLabel: input.mode,
    role: null,
    privateNote: input.privateNote ?? null,
    checklistStepId: null,
    uploadState: "pending",
  };
}

/**
 * The screen mode a staged draft item carries, or null for an ordinary item.
 *
 * Read back from `sourceLabel`, which is the value the stager wrote — so the
 * answer comes from the draft itself rather than from a second record two
 * surfaces would have to keep in step.
 */
export function screenModeOfDraftItem(item: {
  sourceLabel?: string | null;
}): ScreenAcquisitionMode | null {
  return isScreenAcquisitionMode(item.sourceLabel) ? item.sourceLabel : null;
}

export type DraftAcquisition =
  | { kind: "EMPTY" }
  | { kind: "MOBILE_APP" }
  | { kind: "SCREEN"; mode: ScreenAcquisitionMode }
  | { kind: "MIXED_ORIGIN"; modes: string[] };

/**
 * What one draft can honestly be sealed as.
 *
 * A draft holding BOTH a screen acquisition and an ordinary item — or two
 * different screen modes — is reported as MIXED_ORIGIN rather than silently
 * sealed as one of them. One Evidence record carries one origin, and guessing
 * which claim to make is exactly what this module exists to prevent. Nothing
 * is discarded: the caller says so, and the operator finishes them separately.
 */
export function resolveDraftAcquisition(
  items: ReadonlyArray<{ sourceLabel?: string | null }>,
): DraftAcquisition {
  if (items.length === 0) return { kind: "EMPTY" };

  const screenModes = new Set<ScreenAcquisitionMode>();
  let ordinary = 0;
  for (const item of items) {
    const mode = screenModeOfDraftItem(item);
    if (mode) screenModes.add(mode);
    else ordinary += 1;
  }

  if (screenModes.size === 0) return { kind: "MOBILE_APP" };
  if (screenModes.size === 1 && ordinary === 0) {
    return { kind: "SCREEN", mode: [...screenModes][0]! };
  }
  return {
    kind: "MIXED_ORIGIN",
    modes: [
      ...[...screenModes],
      ...(ordinary > 0 ? (["PROOVRA_MOBILE_APP"] as const) : []),
    ].sort(),
  };
}

/**
 * What the operator is told when a session mixes origins.
 *
 * It names the actual reason rather than "unsupported": the record would have
 * to claim one origin for things that had two, and the product will not sign
 * that. Nothing is lost — the items are still staged, and finishing them
 * separately produces two records that each say truthfully how they were made.
 */
export const MIXED_ORIGIN_REFUSAL =
  "This session mixes a screen recording with items captured another way. One " +
  "evidence record states one origin, so these are finished separately — each " +
  "record then says truthfully how it was captured.";

/**
 * WHAT THE PRODUCT OFFERS WHEN TWO ORIGINS MEET.
 *
 * `resolveDraftAcquisition` decides that a draft cannot honestly be sealed.
 * This decides what to SAY and what to offer, and it lives here — beside the
 * decision — so the words and the actions are testable without a screen.
 *
 * The refusal is real and stays: one Evidence record states one origin, the
 * server stamps that origin from the session it issued, and
 * `SESSION_ALREADY_RESERVED` allows exactly one record per session. What was
 * missing is everything after the refusal. A person who has just recorded
 * their screen and then reaches for the camera was told nothing at all — the
 * guard existed in this module and no surface consulted it.
 *
 * The actions are ones the product can actually perform. Finishing the
 * current capture produces its record and leaves the next acquisition free to
 * open its own session; nothing is discarded, and each record then says
 * truthfully how it was made.
 */
export interface MixedOriginPrompt {
  title: string;
  message: string;
  /** The primary action: finalize what is staged, then start the other one. */
  finishLabel: string;
  /** Leave everything exactly as it is. */
  cancelLabel: string;
}

export function mixedOriginPrompt(staged: DraftAcquisition): MixedOriginPrompt {
  const recording =
    staged.kind === "SCREEN" || (staged.kind === "MIXED_ORIGIN" && staged.modes.length > 0);
  return {
    title: "These need separate evidence records",
    message: recording
      ? "This session already holds a screen recording. A record states one origin, " +
        "so a photo or file captured another way is kept as its own record. " +
        "Finish this one first — nothing you have staged is lost — and the next " +
        "capture opens its own session."
      : MIXED_ORIGIN_REFUSAL,
    finishLabel: "Finish this capture first",
    cancelLabel: "Not now",
  };
}

/**
 * Would adding an item of this origin make the draft unsealable?
 *
 * Asked BEFORE the item is staged, so the answer arrives while the person is
 * still holding the camera rather than at the end of an upload.
 */
export function wouldMixOrigins(
  staged: ReadonlyArray<{ sourceLabel?: string | null }>,
  incomingSourceLabel: string | null | undefined,
): boolean {
  if (staged.length === 0) return false;
  const next = resolveDraftAcquisition([...staged, { sourceLabel: incomingSourceLabel ?? null }]);
  return next.kind === "MIXED_ORIGIN";
}
