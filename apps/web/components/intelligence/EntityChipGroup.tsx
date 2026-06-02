"use client";

/**
 * PROOVRA Phase 12 — EntityChipGroup display component.
 *
 * Display-only component for the operator-facing entity surface on
 * the evidence detail page. Reads the already-extracted entities the
 * Phase 11 wiring writes to `evidence_entities` and groups them by
 * kind so an operator can scan PERSON / LOCATION / ORG / DATE / URL /
 * EMAIL / PHONE / OTHER at a glance.
 *
 * Hard rules:
 *   - Display only. No mutations, no callbacks beyond a bounded
 *     onSelect for future deep-link wiring.
 *   - Operator-safe wording. Confidence is rendered as
 *     "advisory" when null, and as a bounded percentage when present.
 *   - Source badge is the EXISTING `source` field from
 *     `evidence_entities` (OCR / TRANSCRIPT). No new vocabulary.
 *   - Never displays raw env-var names, raw storage URLs, or any
 *     reviewer-private text. The `value` field is what the OCR /
 *     transcript already extracted — bounded by the existing entity
 *     extraction service.
 */

import { useMemo } from "react";
import Link from "next/link";

import {
  groupEntitiesByKind,
  type IntelligenceEntity,
} from "../../lib/api/intelligence";

type Props = {
  entities: ReadonlyArray<IntelligenceEntity>;
  /** Optional empty-state copy override. */
  emptyMessage?: string;
};

const KIND_LABELS: Record<string, string> = {
  PERSON: "People",
  LOCATION: "Locations",
  ORG: "Organizations",
  ORGANIZATION: "Organizations",
  DATE: "Dates",
  URL: "Links",
  EMAIL: "Email addresses",
  PHONE: "Phone numbers",
  OTHER: "Other",
};

const SOURCE_LABELS: Record<string, string> = {
  OCR: "OCR",
  TRANSCRIPT: "Transcript",
  MANUAL: "Manual",
  SYSTEM: "System",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ").toLowerCase();
}

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.toLowerCase();
}

function formatConfidence(confidence: number | null): string {
  if (confidence == null || !Number.isFinite(confidence)) return "advisory";
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  return `${pct}% confidence`;
}

export function EntityChipGroup({ entities, emptyMessage }: Props) {
  const grouped = useMemo(() => groupEntitiesByKind(entities), [entities]);

  if (grouped.size === 0) {
    return (
      <p style={emptyStyle}>
        {emptyMessage ??
          "No entities have been extracted from OCR or transcript text for this record yet."}
      </p>
    );
  }

  // Stable ordering so the surface doesn't flicker between renders.
  const orderedKinds = Array.from(grouped.keys()).sort();

  return (
    <div style={groupStyle}>
      {orderedKinds.map((kind) => {
        const bucket = grouped.get(kind) ?? [];
        return (
          <section key={kind} style={kindSectionStyle}>
            <div style={kindHeadingStyle}>
              <span>{kindLabel(kind)}</span>
              <span style={kindCountStyle}>{bucket.length}</span>
            </div>
            <ul style={chipListStyle}>
              {bucket.map((entity) => {
                // Phase 14 — deep-link each entity chip into the
                // canonical /search surface so operators can pivot from
                // an entity observation to the workspace-wide query
                // for that value. The visible chip text is unchanged.
                const queryValue = entity.normalizedValue ?? entity.value;
                return (
                  <li key={entity.id} style={chipListItemStyle}>
                    <Link
                      href={`/search?q=${encodeURIComponent(queryValue)}`}
                      style={chipStyle}
                      title={`Search workspace for "${queryValue}"`}
                    >
                      <span style={chipValueStyle}>{queryValue}</span>
                      <span style={chipSourceStyle}>
                        {sourceLabel(entity.source)}
                      </span>
                      <span style={chipConfidenceStyle}>
                        {formatConfidence(entity.confidence)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p style={disclaimerStyle}>
        Extracted entities are advisory observations from OCR and
        transcript text. They do not classify the recorded material
        and they do not establish legal weight.
      </p>
    </div>
  );
}

const groupStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const kindSectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const kindHeadingStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  fontSize: 11,
  fontWeight: 700,
  color: "#334155",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const kindCountStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#94a3b8",
  fontWeight: 600,
  letterSpacing: 0.3,
};

const chipListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const chipListItemStyle: React.CSSProperties = {
  display: "inline-flex",
};

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  fontSize: 12,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 999,
  color: "#0f172a",
  maxWidth: 360,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textDecoration: "none",
};

const chipValueStyle: React.CSSProperties = {
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 220,
};

const chipSourceStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: "#475569",
  background: "#eef2f7",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  padding: "1px 6px",
  textTransform: "uppercase",
  letterSpacing: 0.3,
};

const chipConfidenceStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#64748b",
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  padding: 14,
  fontSize: 12,
  color: "#64748b",
  fontStyle: "italic",
  background: "#f8fafc",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  lineHeight: 1.5,
};

const disclaimerStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: "#64748b",
  lineHeight: 1.5,
};

export default EntityChipGroup;
