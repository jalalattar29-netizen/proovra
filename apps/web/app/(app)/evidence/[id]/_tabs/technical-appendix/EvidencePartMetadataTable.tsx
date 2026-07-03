/**
 * EvidencePartMetadataTable — per-part technical metadata (Section 8).
 *
 * Compact, responsive card list (one block per evidence part) that supports
 * multipart evidence cleanly. Shows file name, role badge + reviewer mapping
 * label, MIME, size, SHA-256 (copyable), and any available duration /
 * dimensions / page count / codec. Never renders a hollow row.
 */

"use client";

import { FileDigit } from "lucide-react";
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
  return (
    <div className="ta-parts" data-testid="ta-part-table">
      {parts.map((p) => (
        <article className="ta-part" key={`${p.partIndex}-${p.sha256 ?? p.filename ?? ""}`}>
          <header className="ta-part-head">
            <span className="ta-part-icon" aria-hidden>
              <FileDigit size={15} />
            </span>
            <span className="ta-part-name" title={p.filename ?? undefined}>
              {p.filename ?? `Part ${p.partIndex + 1}`}
            </span>
            <AppendixBadge tone={roleTone(p.role)}>{p.role}</AppendixBadge>
          </header>
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
        </article>
      ))}
    </div>
  );
}
