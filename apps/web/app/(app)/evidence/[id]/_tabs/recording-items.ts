/**
 * Wire contract D (2026-10-29) — the Evidence Preview's item list, from the
 * API's projection: ONE card per user item (a continuous screen recording is
 * one card however many parts it was stored as) and the recording's parts and
 * any capture record as TECHNICAL parts, listed separately and labelled so.
 * An older API sends no projection: every part stays its own card.
 */
import {
  CAPTURE_RECORD_SYSTEM_LABEL,
  RECORDING_TECHNICAL_PART_LABEL,
  SCREEN_RECORDING_ITEM_LABEL,
} from "@proovra/shared";

import type {
  EvidenceContentArtifacts,
  EvidenceContentItem,
} from "../../lib/evidence-library-types";

export type PreviewRecording = {
  layout: "SINGLE_FILE" | "SEGMENTED";
  label: string;
  /** The recording's ORIGINAL parts (segments, or the one file). */
  partCount: number;
};

export type PreviewCard<T extends EvidenceContentItem> = {
  item: T;
  /** Set on the ONE card a continuous screen recording is. */
  recording: PreviewRecording | null;
};

export type TechnicalPartRow<T extends EvidenceContentItem> = {
  item: T;
  label: string;
};

export function groupEvidencePreviewItems<T extends EvidenceContentItem>(
  contentItems: readonly T[],
  artifacts: EvidenceContentArtifacts | null | undefined,
): { cards: PreviewCard<T>[]; technical: TechnicalPartRow<T>[]; recording: PreviewRecording | null } {
  const recordingItem = artifacts?.userItems.find((u) => u.kind === "recording") ?? null;
  const presentationOf = (item: T) => item.partPresentation ?? "user_item";
  const recording: PreviewRecording | null = recordingItem
    ? {
        layout: recordingItem.layout ?? (recordingItem.partIndexes.length > 1 ? "SEGMENTED" : "SINGLE_FILE"),
        label: recordingItem.label ?? SCREEN_RECORDING_ITEM_LABEL,
        partCount: recordingItem.partIndexes.length,
      }
    : null;

  const cards: PreviewCard<T>[] = [];
  const ordered = [...contentItems].sort((a, b) => a.index - b.index);
  const recordingLead =
    recordingItem
      ? ordered.find((i) => i.index === recordingItem.primaryPartIndex) ??
        ordered.find((i) => presentationOf(i) === "recording_part") ??
        null
      : null;
  if (recordingLead && recording) cards.push({ item: recordingLead, recording });
  for (const item of contentItems) {
    if (presentationOf(item) === "user_item") cards.push({ item, recording: null });
  }

  const technical: TechnicalPartRow<T>[] = ordered
    .filter((item) => presentationOf(item) !== "user_item")
    .map((item) => ({
      item,
      label:
        presentationOf(item) === "capture_record"
          ? CAPTURE_RECORD_SYSTEM_LABEL
          : RECORDING_TECHNICAL_PART_LABEL,
    }));

  return { cards, technical, recording };
}
