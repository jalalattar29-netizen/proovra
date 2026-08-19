/**
 * EvidencePartMetadataTable — per-part technical metadata (Section 8).
 *
 * Compact, responsive card list (one block per evidence part) that supports
 * multipart evidence cleanly. Shows file name, role badge + reviewer mapping
 * label, MIME, size, SHA-256 (copyable), and any available duration /
 * dimensions / page count / codec. Never renders a hollow row.
 */

"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { AppendixBadge, AppendixEmpty, CopyButton } from "./MetadataRow";
import { fmtBytes, fmtDimensions, fmtDurationMs } from "./sections-model";
import type { TechnicalMetadataPerPart } from "./types";

function roleTone(role: TechnicalMetadataPerPart["role"]) {
  return role === "Primary" ? "success" : role === "Supporting" ? "info" : "neutral";
}

function PartMeta({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="ta-part-meta">
      <span className="ta-part-meta-label">{label}</span>
      <span className="ta-part-meta-value">{value}</span>
    </div>
  );
}

export function EvidencePartMetadataTable({
  parts,
}: {
  parts: TechnicalMetadataPerPart[] | null | undefined;
}) {
  if (!parts || parts.length === 0) {
    return (
      <AppendixEmpty>
        No per-part technical metadata is available for this record.
      </AppendixEmpty>
    );
  }
  return <PartList parts={parts} />;
}

/** How many parts are shown before the reader asks for the rest. */
const INITIAL_PARTS = 8;

/**
 * PROGRESSIVE DISCLOSURE.
 *
 * Every part used to render as a full card with its whole metadata grid and
 * its full SHA-256 open — 23 of them on a real multipart record, which buried
 * the rest of the appendix. Nothing is discarded, summarised away or
 * fabricated: the same fields are still rendered, one interaction deeper, and
 * the list beyond `INITIAL_PARTS` is behind an explicit control that names the
 * real total.
 */
function PartList({ parts }: { parts: TechnicalMetadataPerPart[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? parts : parts.slice(0, INITIAL_PARTS);
  const hidden = parts.length - visible.length;

  return (
    <div className="ta-parts" data-testid="ta-part-table" data-ta-parts-total={parts.length}>
      {visible.map((p) => (
        <PartRow key={`${p.partIndex}-${p.sha256 ?? p.filename ?? ""}`} part={p} />
      ))}

      {parts.length > INITIAL_PARTS ? (
        <button
          type="button"
          className="app-secondary-action ta-parts-toggle"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          data-ta-parts-toggle
        >
          {showAll ? "Collapse parts" : `Show all ${parts.length} parts`}
          {!showAll && hidden > 0 ? ` (${hidden} more)` : ""}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One row anatomy for every part, whatever its kind: image, video and PDF all
 * collapse to filename / role / type / size, and everything kind-specific is
 * inside the disclosure.
 */
function PartRow({ part: p }: { part: TechnicalMetadataPerPart }) {
  const [open, setOpen] = useState(false);
  const panelId = `ta-part-${p.partIndex}`;
  const name = p.filename ?? `Part ${p.partIndex + 1}`;

  return (
    <article className="ta-part" data-ta-part={p.partIndex}>
      <h4 className="ta-part-headline">
        <button
          type="button"
          className="ta-part-summary"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          data-ta-part-toggle
        >
          {/* No leading file glyph. Every row IS a file, so the icon carried no
              information, had no tooltip and no semantic purpose — it only read
              as an unexplained control. The filename is the identity and takes
              the primary slot; the role is secondary metadata beside it. */}
          <span className="ta-part-name" title={name}>
            {name}
          </span>
          <span className="ta-part-role">
            <AppendixBadge tone={roleTone(p.role)}>{p.role}</AppendixBadge>
          </span>
          <span className="ta-part-compact">{p.mimeType ?? "—"}</span>
          <span className="ta-part-compact ta-part-compact--size">{fmtBytes(p.sizeBytes) ?? "—"}</span>
          <ChevronDown
            size={16}
            strokeWidth={2}
            aria-hidden="true"
            className="ta-part-chevron"
          />
        </button>
      </h4>

      <div
        id={panelId}
        role="region"
        aria-label={name}
        className="ta-part-body"
        hidden={!open}
      >
        <p className="ta-part-mapping">{p.mappingLabel}</p>
        <div className="ta-part-grid">
          <PartMeta label="Type" value={p.mimeType} />
          <PartMeta label="Size" value={fmtBytes(p.sizeBytes)} />
          <PartMeta label="Dimensions" value={fmtDimensions(p.width, p.height)} />
          <PartMeta label="Duration" value={fmtDurationMs(p.durationMs)} />
          <PartMeta
            label="Pages"
            value={p.pageCount != null && p.pageCount > 0 ? String(p.pageCount) : null}
          />
          <PartMeta label="Codec" value={p.codec} />
          <PartMeta label="Container" value={p.container} />
          <PartMeta label="Metadata" value={p.metadataStatusLabel} />
        </div>
        {p.sha256 ? (
          <div className="ta-part-hash" data-testid="ta-part-sha256">
            <span className="ta-part-meta-label">SHA-256</span>
            <code className="ta-mono ta-part-hash-value">{p.sha256}</code>
            <CopyButton value={p.sha256} label="Copy SHA-256" />
          </div>
        ) : null}
      </div>
    </article>
  );
}
