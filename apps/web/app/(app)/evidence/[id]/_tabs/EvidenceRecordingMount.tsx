"use client";

/**
 * Wire contract D (2026-10-29) — where the ONE screen-recording item plays on
 * the evidence page.
 *
 *   - A SEGMENTED (legacy) recording mounts THE recording player
 *     (components/evidence-recording): the DERIVED combined video, its gaps and
 *     "Download combined recording (derived)"; the original segments stay
 *     reachable as technical files.
 *   - A SINGLE_FILE recording is one complete video: it plays its own
 *     original (part 0) and downloads it as the recording.
 */
import React from "react";

import { RecordingPlayer } from "../../../../../components/evidence-recording";

export type EvidenceRecordingMountProps = {
  evidenceId: string;
  teamId: string | null;
  layout: "SINGLE_FILE" | "SEGMENTED";
  /** The recording's own original URL (SINGLE_FILE only). */
  singleFileUrl: string | null;
  label: string;
  onShowOriginalFiles: () => void;
  onDownloadRecording: () => void;
  /** Owner with intelligence.run: may start preparing a historical record. */
  canPrepare?: boolean;
};

export function EvidenceRecordingMount(props: EvidenceRecordingMountProps) {
  if (props.layout === "SEGMENTED") {
    return (
      <div data-evidence-recording-mount="segmented">
        <RecordingPlayer
          evidenceId={props.evidenceId}
          teamId={props.teamId}
          onShowOriginalFiles={props.onShowOriginalFiles}
          canPrepare={props.canPrepare}
        />
      </div>
    );
  }
  if (!props.singleFileUrl) {
    return (
      <div className="evidence-detail-preview-placeholder" data-evidence-recording-mount="single-file">
        <strong>{props.label}</strong>
        <p>Playback is not available in the current response. Use Download to save the recording.</p>
      </div>
    );
  }
  // The one recording file: its own download, beside the player.
  return (
    <div data-evidence-recording-mount="single-file">
      <video
        key={props.singleFileUrl}
        controls
        preload="metadata"
        className="evidence-detail-preview-media"
        src={props.singleFileUrl}
      >
        Your browser could not load this recording.
      </video>
      <button type="button" className="app-secondary-action" onClick={props.onDownloadRecording}>
        Download recording
      </button>
    </div>
  );
}
