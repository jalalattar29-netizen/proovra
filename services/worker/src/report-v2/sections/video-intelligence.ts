/**
 * PROOVRA Phase 3A Elite Closure — Report section: Video Intelligence.
 *
 * Bounded report-section module. Surfaces per-evidence tracking
 * summary + bounded approval / rejection counts. Never renders
 * track geometry or detection text verbatim.
 */

import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

export type VideoIntelligenceSummaryRow = {
  evidenceId: string;
  versionOrdinal: number | null;
  totalFrames: number;
  totalTracks: number;
  acceptedTracks: number;
  rejectedTracks: number;
  perTrackKind: ReadonlyArray<{ kind: string; count: number }>;
};

export type VideoIntelligenceSection = {
  rows: ReadonlyArray<VideoIntelligenceSummaryRow>;
};

export function renderVideoIntelligenceSection(
  section: VideoIntelligenceSection,
): string {
  if (section.rows.length === 0) return "";
  const intro = renderCallout({
    tone: "neutral",
    title: "Tracking-assisted redaction · provenance only",
    body:
      "Video evidence below was processed through PROOVRA's tracking " +
      "pipeline. Bounded counts of tracks and reviewer decisions are " +
      "shown — track geometry and per-frame bytes remain in the " +
      "platform and are NEVER published in this report.",
  });
  const rows = section.rows
    .map((r) => {
      const perKindHtml =
        r.perTrackKind.length === 0
          ? "—"
          : r.perTrackKind
              .map(
                (k) =>
                  `<span class="redaction-chip">${escapeHtml(k.kind)}: ${k.count}</span>`,
              )
              .join(" ");
      return `
        <tr data-video-intel-row="${escapeHtml(r.evidenceId)}">
          <td><code>${escapeHtml(r.evidenceId.slice(0, 8))}…</code></td>
          <td>${r.versionOrdinal === null ? "—" : `v${r.versionOrdinal}`}</td>
          <td>${r.totalFrames}</td>
          <td>${r.totalTracks}</td>
          <td>${r.acceptedTracks}</td>
          <td>${r.rejectedTracks}</td>
          <td>${perKindHtml}</td>
        </tr>
      `;
    })
    .join("");
  const body = `
    ${intro}
    <table class="redaction-summary-table">
      <thead>
        <tr>
          <th>Evidence</th>
          <th>Version</th>
          <th>Frames</th>
          <th>Tracks</th>
          <th>Accepted</th>
          <th>Rejected</th>
          <th>Per kind</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted small">
      Track decisions never modify the original video bytes. The
      derivative pipeline reads the bounded track decisions to render
      the redacted derivative under a separate storage key.
    </p>
  `;
  return renderPageSection("Video Intelligence Summary", body);
}
