/**
 * PROOVRA Phase 3A — Report section: Redaction Summary.
 *
 * Adds a bounded "Redaction Summary" page to the evidence report.
 * The section is rendered ONLY when the report view-model carries
 * one or more PUBLISHED redaction versions for the evidence.
 *
 * Hard rules:
 *   * NEVER renders region geometry, raw detection text, or
 *     rationale verbatim. Counts + bounded provider tags + approval
 *     timestamps only.
 *   * Explicit "ORIGINAL preserved · DERIVATIVE generated"
 *     boundary statement — the report's reader must always be able
 *     to tell the original from the redacted derivative.
 */

import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

export type RedactionSummaryRow = {
  projectId: string;
  versionOrdinal: number;
  publishedAtUtc: string;
  artifactKind: "IMAGE" | "PDF" | "VIDEO" | "AUDIO";
  regionCount: number;
  approvals: ReadonlyArray<{
    approverUserId: string;
    decidedAtUtc: string;
    verdict: "APPROVE" | "REJECT" | "REQUEST_CHANGES" | "DEFER";
  }>;
  derivative: {
    kind: string;
    state: string;
    fileSha256: string | null;
    byteSize: number | null;
  } | null;
};

export type RedactionSummarySection = {
  rows: ReadonlyArray<RedactionSummaryRow>;
};

export function renderRedactionSummarySection(
  section: RedactionSummarySection,
): string {
  if (section.rows.length === 0) return "";

  const intro = renderCallout({
    tone: "neutral",
    title: "Original preserved · Derivative generated",
    body:
      "PROOVRA never modifies the original evidence. The rows below " +
      "describe redacted derivatives generated from the original, with " +
      "their bounded approval history. The derivative bytes are " +
      "addressable by the SHA-256 in the table; the original remains " +
      "byte-for-byte unchanged at its custody storage key.",
  });

  const rows = section.rows
    .map((r) => {
      const approvalsHtml =
        r.approvals.length === 0
          ? `<span class="muted">—</span>`
          : r.approvals
              .map(
                (a) =>
                  `<div class="redaction-approval-row">` +
                  `<code>${escapeHtml(a.verdict)}</code>` +
                  ` &middot; ` +
                  `${escapeHtml(a.decidedAtUtc)}` +
                  `</div>`,
              )
              .join("");
      const derivativeHtml = r.derivative
        ? `<div><strong>${escapeHtml(r.derivative.kind)}</strong></div>` +
          `<div class="muted">state: ${escapeHtml(r.derivative.state)}</div>` +
          (r.derivative.fileSha256
            ? `<div class="mono">sha256: ${escapeHtml(
                r.derivative.fileSha256.slice(0, 16),
              )}…</div>`
            : `<div class="muted">no derivative bytes yet</div>`) +
          (r.derivative.byteSize !== null
            ? `<div class="muted">bytes: ${r.derivative.byteSize}</div>`
            : "")
        : `<span class="muted">no derivative recorded</span>`;
      return `
        <tr data-redaction-row="${escapeHtml(r.projectId)}">
          <td>v${r.versionOrdinal}</td>
          <td>${escapeHtml(r.artifactKind)}</td>
          <td>${r.regionCount}</td>
          <td>${escapeHtml(r.publishedAtUtc)}</td>
          <td>${approvalsHtml}</td>
          <td>${derivativeHtml}</td>
        </tr>
      `;
    })
    .join("");

  const body = `
    ${intro}
    <table class="redaction-summary-table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Artifact</th>
          <th>Regions</th>
          <th>Published (UTC)</th>
          <th>Approvals</th>
          <th>Derivative</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted small">
      Reviewers and approvers are identified internally by user id.
      The verification package carries the full bounded approval
      audit so the redactions can be reproduced offline.
    </p>
  `;

  return renderPageSection("Redaction Summary", body);
}
