"use client";

/**
 * PUBLIC VERIFY — the content-preview surface (CONTENT_PREVIEW answers).
 *
 * Shown only for what the API projected: item names, roles and safe previews
 * from `evidenceContent`. A VERIFICATION_ONLY answer is stated by the item
 * inventory table instead (VerifyRecordSections.ItemInventoryTable). An
 * original file is only ever offered when an item carries a `viewUrl` — which
 * only a reviewer grant produces.
 */
import type { JSX } from "react";
import { useMemo, useState, type CSSProperties } from "react";
import { getReviewerArtifactRoleLabel } from "@proovra/shared";

import { VERIFY_BRAND, VERIFY_TYPO } from "./_verify-theme";
import type {
  VerifyContentArtifacts,
  VerifyContentAccessPolicy,
  VerifyContentExposureDecision,
  VerifyEvidenceAsset,
  VerifyEvidenceAssetKind,
  VerifyEvidenceContentSummary,
  VerifyPreviewPolicy,
} from "./_verify-types";

function describeEvidenceAssetRole(item: VerifyEvidenceAsset): string {
  const roleLabel =
    item.artifactRoleLabel ??
    (item.artifactRole ? getReviewerArtifactRoleLabel(item.artifactRole) : null) ??
    (item.isPrimary ? "Primary evidence" : "Supporting evidence");
  const checklistLabel =
    typeof item.checklistStepLabel === "string" && item.checklistStepLabel.trim()
      ? item.checklistStepLabel.trim()
      : null;

  return checklistLabel ? `${roleLabel} • ${checklistLabel}` : roleLabel;
}


function formatDuration(durationMs?: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null;

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
      2,
      "0"
    )}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function evidenceKindLabel(kind?: VerifyEvidenceAssetKind | null): string {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    case "other":
      return "Other";
    default:
      return "Evidence";
  }
}

function previewRoleLabel(
  role?: VerifyEvidenceAsset["previewRole"]
): string | null {
  switch (role) {
    case "primary_preview":
      return "Primary reviewer preview";
    case "secondary_preview":
      return "Supporting reviewer preview";
    case "download_only":
      return "Download-only access";
    case "metadata_only":
      return "Metadata-only access";
    default:
      return null;
  }
}

function renderVerifyEvidenceMedia(
  item: VerifyEvidenceAsset | null
): JSX.Element {
  const wrapperStyle: CSSProperties = {
    overflow: "hidden",
    borderRadius: 22,
    border: "1px solid #D0D5DD",
    background:
      item?.kind === "image" || item?.kind === "pdf"
        ? "#FFFFFF"
        : "linear-gradient(180deg, #101828 0%, #0F172A 100%)",
    minHeight: 340,
  };

  if (!item || !item.viewUrl) {
    if (item?.previewDataUrl) {
      return (
        <div style={wrapperStyle}>
          <img
            src={item.previewDataUrl}
            alt={item.previewCaption ?? item.label}
            style={{
              display: "block",
              width: "100%",
              maxHeight: 560,
              objectFit: "contain",
              background: "#F8FAFC",
            }}
          />
        </div>
      );
    }

    if (item?.previewTextExcerpt) {
      return (
        <div
          style={{
            ...wrapperStyle,
            background: "#F8FAFC",
            padding: 28,
            display: "grid",
            gap: 14,
          }}
        >
          <div style={{ fontSize: 14, color: "#475467", lineHeight: 1.8 }}>
            {item.previewTextExcerpt}
          </div>
        </div>
      );
    }

    return (
      <div
        style={{
          ...wrapperStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          background: "#F8FAFC",
        }}
      >
        <div style={{ maxWidth: 560, textAlign: "center" }}>
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: "#101828",
              marginBottom: 10,
            }}
          >
            Evidence content is not directly exposed here
          </div>
          <div style={{ fontSize: 14, color: "#667085", lineHeight: 1.7 }}>
            This verification flow can still validate the recorded integrity state,
            chain of custody, timestamps, and publication details even when direct
            evidence viewing is intentionally restricted.
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "image") {
    return (
      <div style={wrapperStyle}>
        <img
          src={item.viewUrl}
          alt={item.label}
          style={{
            display: "block",
            width: "100%",
            maxHeight: 560,
            objectFit: "contain",
            background: "#F8FAFC",
          }}
        />
      </div>
    );
  }

  if (item.kind === "video") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        {item.previewDataUrl ? (
          <div style={wrapperStyle}>
            <img
              src={item.previewDataUrl}
              alt={item.previewCaption ?? `${item.label} poster`}
              style={{
                display: "block",
                width: "100%",
                maxHeight: 420,
                objectFit: "contain",
                background: "#F8FAFC",
              }}
            />
          </div>
        ) : null}
        <div style={wrapperStyle}>
          <video
            src={item.viewUrl}
            controls
            preload="metadata"
            style={{ display: "block", width: "100%", maxHeight: 560 }}
          />
        </div>
      </div>
    );
  }

  if (item.kind === "audio") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        {item.previewDataUrl ? (
          <div
            style={{
              overflow: "hidden",
              borderRadius: 22,
              border: "1px solid #D0D5DD",
              background: "#FFFFFF",
            }}
          >
            <img
              src={item.previewDataUrl}
              alt={item.previewCaption ?? `${item.label} waveform`}
              style={{
                display: "block",
                width: "100%",
                maxHeight: 260,
                objectFit: "contain",
                background: "#F8FAFC",
              }}
            />
          </div>
        ) : null}
        <div
          style={{
            ...wrapperStyle,
            padding: 28,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 18,
          }}
        >
          <div style={{ color: "#EAECF0", fontSize: 14, lineHeight: 1.7 }}>
            Listen to the preserved audio item through controlled verification
            access. Original evidence remains separately preserved with the recorded
            integrity state.
          </div>
          <audio src={item.viewUrl} controls preload="metadata" style={{ width: "100%" }} />
        </div>
      </div>
    );
  }

  if (item.kind === "pdf") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        {item.previewDataUrl ? (
          <div style={wrapperStyle}>
            <img
              src={item.previewDataUrl}
              alt={item.previewCaption ?? `${item.label} first page`}
              style={{
                display: "block",
                width: "100%",
                maxHeight: 480,
                objectFit: "contain",
                background: "#F8FAFC",
              }}
            />
          </div>
        ) : null}
        <div style={wrapperStyle}>
          {/* AUD-48 (2026-10-20) — the presigned URL never leaks as a Referer,
              and the frame is reachable only because CSP frame-src names the
              storage origin. No sandbox attribute: browsers refuse to render a
              PDF inside a sandboxed frame, and the frame is cross-origin
              (storage), so it cannot reach this page either way. */}
          <iframe
            src={item.viewUrl}
            title={item.label}
            referrerPolicy="no-referrer"
            style={{ width: "100%", height: 720, border: 0 }}
          />
        </div>
      </div>
    );
  }

  if (item.kind === "text") {
    return (
      <div
        style={{
          ...wrapperStyle,
          padding: 28,
          background: "#F8FAFC",
          color: "#475467",
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ fontSize: 14, lineHeight: 1.7 }}>
          Text-based evidence is best opened in a dedicated tab so reviewers can
          inspect the original preserved file directly.
        </div>
        <a
          href={item.viewUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "10px 14px",
            borderRadius: 12,
            border: "1px solid #D0D5DD",
            background: "#FFFFFF",
            color: "#344054",
            fontSize: 13,
            fontWeight: 700,
            textDecoration: "none",
            width: "fit-content",
          }}
        >
          Open text evidence
        </a>
      </div>
    );
  }

  return (
    <div
      style={{
        ...wrapperStyle,
        padding: 28,
        background: "#F8FAFC",
        display: "grid",
        gap: 12,
        alignContent: "center",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 800, color: "#101828" }}>
        Preview is not available inline for this file type
      </div>
      <div style={{ fontSize: 14, color: "#667085", lineHeight: 1.7 }}>
        The verification record still exposes the preserved file reference and
        integrity materials for controlled review.
      </div>
      <a
        href={item.viewUrl}
        target="_blank"
        rel="noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "10px 14px",
          borderRadius: 12,
          border: "1px solid #D0D5DD",
          background: "#FFFFFF",
          color: "#344054",
          fontSize: 13,
          fontWeight: 700,
          textDecoration: "none",
          width: "fit-content",
        }}
      >
        Open preserved file
      </a>
    </div>
  );
}


const PANEL: CSSProperties = {
  border: `1px solid ${VERIFY_BRAND.softLine}`,
  background: "linear-gradient(180deg, rgba(255,255,255,0.88) 0%, rgba(248,249,247,0.82) 100%)",
  borderRadius: 18,
  padding: 16,
  display: "grid",
  gap: 8,
  minWidth: 0,
};

/**
 * Wire contract D (2026-10-29) — ONE card per user item: a continuous screen
 * recording is one item ("Screen recording"); its stored parts and any
 * system-generated capture record are technical parts, listed separately with
 * their digests and never presented as text evidence. An older API sends no
 * presentation: every part stays its own item.
 */
export function splitVerifyItems(
  items: VerifyEvidenceAsset[],
  artifacts: VerifyContentArtifacts | null | undefined,
): {
  cards: VerifyEvidenceAsset[];
  technical: VerifyEvidenceAsset[];
  recording: { leadId: string; label: string; layout: "SINGLE_FILE" | "SEGMENTED"; partCount: number } | null;
} {
  const presentationOf = (item: VerifyEvidenceAsset) => item.partPresentation ?? "user_item";
  const rec = artifacts?.userItems.find((u) => u.kind === "recording") ?? null;
  const ordered = [...items].sort((a, b) => a.index - b.index);
  const lead = rec
    ? ordered.find((i) => i.index === rec.primaryPartIndex) ??
      ordered.find((i) => presentationOf(i) === "recording_part") ??
      null
    : null;
  const cards = [
    ...(lead ? [lead] : []),
    ...items.filter((i) => presentationOf(i) === "user_item"),
  ];
  return {
    cards,
    technical: ordered.filter((i) => presentationOf(i) !== "user_item"),
    recording:
      rec && lead
        ? {
            leadId: lead.id,
            label: rec.label ?? "Screen recording",
            layout: rec.layout ?? (rec.partIndexes.length > 1 ? "SEGMENTED" : "SINGLE_FILE"),
            partCount: rec.partIndexes.length,
          }
        : null,
  };
}

function technicalPartLabel(item: VerifyEvidenceAsset): string {
  return item.partPresentation === "capture_record"
    ? "Capture record (system-generated)"
    : "Recording part (technical)";
}

export function ContentPreviewSurface({
  items: allItems,
  artifacts,
  summary,
  primaryItem,
  defaultPreviewItemId,
  previewPolicy,
  contentAccessPolicy,
  contentExposureDecision,
}: {
  items: VerifyEvidenceAsset[];
  /** Wire contract D — the API's projection (absent: older API). */
  artifacts?: VerifyContentArtifacts | null;
  summary: VerifyEvidenceContentSummary;
  primaryItem: VerifyEvidenceAsset | null;
  defaultPreviewItemId: string | null;
  previewPolicy: VerifyPreviewPolicy;
  contentAccessPolicy: VerifyContentAccessPolicy;
  contentExposureDecision: VerifyContentExposureDecision;
}) {
  const split = useMemo(() => splitVerifyItems(allItems, artifacts), [allItems, artifacts]);
  const items = split.cards;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () =>
      items.find((item) => item.id === selectedId) ??
      items.find((item) => item.id === defaultPreviewItemId) ??
      items.find((item) => item.id === primaryItem?.id) ??
      items[0] ??
      null,
    [items, selectedId, defaultPreviewItemId, primaryItem],
  );
  const selectedIsRecording = Boolean(split.recording && selected?.id === split.recording.leadId);
  const selectedLabel = selectedIsRecording ? split.recording!.label : selected?.label;
  const itemCount = summary?.itemCount ?? items.length;
  const description = [
    itemCount > 1 ? "Multipart evidence package" : items.length > 0 ? "Single evidence item" : null,
    summary?.totalSizeDisplay ?? null,
    `${itemCount} item${itemCount === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <section
      aria-labelledby="verify-content-preview"
      data-testid="verify-content-preview"
      data-verify-card
      style={{
        border: `1px solid ${VERIFY_BRAND.line}`,
        background: "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(250,251,249,0.90) 100%)",
        borderRadius: 22,
        padding: "clamp(16px, 4vw, 24px)",
        display: "grid",
        gap: 16,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 320px" }}>
          <div style={{ ...VERIFY_TYPO.kicker, fontSize: 11, marginBottom: 6 }}>Evidence Content Review</div>
          <h2 id="verify-content-preview" style={{ ...VERIFY_TYPO.h3, fontSize: 20, margin: "0 0 6px" }}>
            {selected ? `${evidenceKindLabel(selected.kind)} review surface` : "Evidence review surface"}
          </h2>
          {previewPolicy?.rationale ? <div style={{ ...VERIFY_TYPO.body, maxWidth: 860 }}>{previewPolicy.rationale}</div> : null}
        </div>
        <div style={{ ...VERIFY_TYPO.small, fontSize: 12, fontWeight: 800, color: VERIFY_BRAND.ink }}>{description}</div>
      </div>

      {contentExposureDecision?.rationale || previewPolicy?.privacyNotice ? (
        <div style={{ ...PANEL, borderLeft: `5px solid ${VERIFY_BRAND.bronze}` }}>
          <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>Reviewer access note</div>
          {contentExposureDecision?.rationale ? (
            <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>{contentExposureDecision.rationale}</div>
          ) : null}
          {previewPolicy?.privacyNotice ? <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>{previewPolicy.privacyNotice}</div> : null}
          {contentAccessPolicy?.allowDownload ? null : (
            <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>Original files are not offered on this page.</div>
          )}
        </div>
      ) : null}

      {items.length > 1 ? (
        <ul
          aria-label="Evidence items"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 220px), 1fr))",
            gap: 10,
          }}
        >
          {items.map((item) => {
            const active = selected?.id === item.id;
            return (
              <li key={item.id} style={{ minWidth: 0 }}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedId(item.id)}
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: 16,
                    border: active ? `2px solid ${VERIFY_BRAND.accent}` : `1px solid ${VERIFY_BRAND.line}`,
                    background: active ? "rgba(11,46,39,0.10)" : "rgba(255,255,255,0.54)",
                    color: VERIFY_BRAND.ink,
                    fontSize: 13,
                    fontWeight: 800,
                    cursor: "pointer",
                    textAlign: "left",
                    minWidth: 0,
                  }}
                >
                  <div style={{ marginBottom: 4, overflowWrap: "anywhere" }}>
                    {split.recording?.leadId === item.id ? split.recording.label : item.label}
                  </div>
                  <div style={{ ...VERIFY_TYPO.small, fontSize: 12 }}>
                    {split.recording?.leadId === item.id
                      ? "Screen recording • Primary evidence"
                      : `${evidenceKindLabel(item.kind)} • ${describeEvidenceAssetRole(item)}`}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 16 }}>
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>{renderVerifyEvidenceMedia(selected)}</div>
        <div style={{ ...PANEL, alignContent: "start" }}>
          <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>Selected Evidence Item</div>
          <div style={{ ...VERIFY_TYPO.h3, fontSize: 18, overflowWrap: "anywhere" }}>{selectedLabel ?? "No item selected"}</div>
          <div style={{ display: "grid", gap: 8, ...VERIFY_TYPO.small, color: VERIFY_BRAND.ink }}>
            {selected ? (
              <div>
                <strong>Role:</strong> {describeEvidenceAssetRole(selected)}
              </div>
            ) : null}
            <div>
              <strong>Kind:</strong> {evidenceKindLabel(selected?.kind)}
            </div>
            {selected?.displaySizeLabel ? (
              <div>
                <strong>Size:</strong> {selected.displaySizeLabel}
              </div>
            ) : null}
            {formatDuration(selected?.durationMs) ? (
              <div>
                <strong>Duration:</strong> {formatDuration(selected?.durationMs)}
              </div>
            ) : null}
            {previewRoleLabel(selected?.previewRole) ? (
              <div>
                <strong>Access role:</strong> {previewRoleLabel(selected?.previewRole)}
              </div>
            ) : null}
            {selectedIsRecording && split.recording!.layout === "SEGMENTED" ? (
              <div>
                <strong>Stored as:</strong> {split.recording!.partCount} technical parts (digests listed under Technical parts)
              </div>
            ) : selected?.sha256 ? (
              <div style={VERIFY_TYPO.hash}>
                <strong>SHA-256:</strong> {selected.sha256}
              </div>
            ) : null}
            {selectedIsRecording && artifacts?.recording ? (
              <div data-verify-recording-statement>
                {artifacts.recording.statement}
                {artifacts.recording.audioStatement ? ` ${artifacts.recording.audioStatement}` : ""}
              </div>
            ) : null}
            {selected?.originalPreservationNote ? (
              <div>
                <strong>Original:</strong> {selected.originalPreservationNote}
              </div>
            ) : null}
          </div>
          {selected?.viewUrl ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <a href={selected.viewUrl} target="_blank" rel="noreferrer" style={{ color: VERIFY_BRAND.accent, fontWeight: 900 }}>
                Open preserved evidence
              </a>
              {selected.downloadable ? (
                <a href={selected.viewUrl} download={selected.originalFileName ?? true} style={{ color: VERIFY_BRAND.accent, fontWeight: 900 }}>
                  Download evidence
                </a>
              ) : null}
            </div>
          ) : null}
          {selected?.reviewerRepresentationNote ? (
            <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>{selected.reviewerRepresentationNote}</div>
          ) : null}
        </div>
      </div>

      {split.technical.length > 0 ? (
        <div style={PANEL} data-testid="verify-technical-parts">
          <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>Technical parts ({split.technical.length})</div>
          <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>
            Stored files that make up the record. They are technical material, not separate evidence items; each keeps its own SHA-256.
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {split.technical.map((item) => (
              <li key={item.id} data-verify-technical-part={item.index} style={{ ...VERIFY_TYPO.small, color: VERIFY_BRAND.ink, minWidth: 0 }}>
                <strong>{technicalPartLabel(item)}</strong> — stored part {item.index + 1}
                {item.displaySizeLabel ? ` · ${item.displaySizeLabel}` : ""}
                <div style={{ ...VERIFY_TYPO.hash, overflowWrap: "anywhere" }}>SHA-256: {item.sha256 ?? "Not recorded"}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
