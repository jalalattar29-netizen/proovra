/**
 * UC-4 — Derived Review tab.
 *
 * The reviewer surface for DERIVED screen intelligence: bounded keyframes → local
 * OCR → a source-linked reconstruction. It reads ONLY canonical persisted output
 * (never mock), labels everything as machine-derived review material — NOT
 * original acquisition — and gives every material block a "View Source" path back
 * to the ORIGINAL evidence (keyframe thumbnail + Open Original).
 *
 * It is deliberately NOT styled to imitate a messaging/provider UI: it is a
 * PROOVRA reviewer reconstruction. A visible label is not a verified identity and
 * a displayed timestamp is not a provider-verified time.
 *
 * Presentation is class-only (evidence-detail.css / .uc4-derived-*): the route
 * forbids inline style objects and raw hex (evidence-shell-cleanup.test).
 */

"use client";

import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";

import { type EvidenceDetailCtx } from "./_lib";
import {
  useDerivedReview,
  type DerivedReviewBlock,
} from "../../../../../lib/media-intelligence/useDerivedReview";

const PAGE_SIZE = 100;

export function EvidenceDerivedReviewTab({
  ctx,
  onGoToArtifacts,
}: {
  ctx: EvidenceDetailCtx;
  onGoToArtifacts?: () => void;
}) {
  const { evidenceId, workspace } = ctx;
  const teamId = workspace.reviewWorkflow?.teamId ?? null;
  const [offset, setOffset] = useState(0);
  const { state, generate } = useDerivedReview({ evidenceId, teamId, offset, limit: PAGE_SIZE });
  const [busy, setBusy] = useState(false);

  const data = state.data;
  const status = data?.status.status ?? "NOT_REQUESTED";
  const projection = data?.projection ?? null;
  const keyframeUrls = data?.keyframeBytesUrls ?? {};
  const inFlight = status === "PENDING" || status === "PROCESSING";

  const runGenerate = async (regenerate: boolean) => {
    setBusy(true);
    try {
      await generate(regenerate);
    } finally {
      setBusy(false);
    }
  };

  const coverageLabel = useMemo(() => {
    if (!projection) return null;
    return projection.coverage === "COMPLETE" ? "Complete" : "Partial";
  }, [projection]);

  return (
    <div className="evidence-detail-section">
      <h3 className="evidence-detail-section-title">
        <Sparkles size={16} strokeWidth={2.1} aria-hidden="true" /> Derived Review
      </h3>

      {/* Standing DERIVED disclaimer — this is not original acquisition. */}
      <p className="evidence-detail-muted uc4-derived-intro">
        Machine-derived, source-linked review material reconstructed from the
        original screen evidence. It is <strong>not</strong> original acquisition:
        a visible sender label is not a verified identity, a displayed timestamp
        is not a provider-verified time, and machine-extracted text is not
        verified truth. Every block links back to its source.
      </p>

      {/* Status + actions matrix */}
      <div className="evidence-detail-extract-card uc4-derived-card">
        <DerivedStatusRow
          status={status}
          coverageLabel={coverageLabel}
          ocrEnabled={projection?.ocrEnabled ?? null}
          lastError={data?.status.lastError ?? null}
          loading={state.loading}
          errorCode={state.error?.code ?? null}
        />
        <div className="uc4-derived-actions">
          {status === "NOT_REQUESTED" && (
            <button
              type="button"
              className="app-btn app-btn-primary"
              disabled={busy || !teamId}
              onClick={() => void runGenerate(false)}
            >
              Generate Derived Review
            </button>
          )}
          {status === "FAILED" && (
            <button
              type="button"
              className="app-btn app-btn-primary"
              disabled={busy || !teamId}
              onClick={() => void runGenerate(true)}
            >
              Retry
            </button>
          )}
          {(status === "COMPLETED" || projection) && (
            <button
              type="button"
              className="app-btn"
              disabled={busy || inFlight || !teamId}
              onClick={() => void runGenerate(true)}
            >
              Regenerate
            </button>
          )}
        </div>
      </div>

      {/* Coverage + limitations + transformation versions */}
      {projection && (
        <div className="evidence-detail-extract-card uc4-derived-card">
          <p className="evidence-detail-muted">
            Coverage <strong>{coverageLabel}</strong> · OCR{" "}
            {projection.ocrEnabled ? "enabled" : "disabled by policy"} · Acquisition{" "}
            {projection.acquisitionComplete ? "complete" : "interrupted"} ·{" "}
            {projection.stats.keyframeCount} keyframes ·{" "}
            {projection.blockTotal} reconstructed blocks
          </p>
          {projection.limitations.length > 0 && (
            <p className="evidence-detail-muted">
              Limitations: {projection.limitations.join(", ")}
            </p>
          )}
          <p className="evidence-detail-muted uc4-derived-versions">
            {projection.transformationVersions.keyframe} ·{" "}
            {projection.transformationVersions.ocr} ·{" "}
            {projection.transformationVersions.reconstruction}
          </p>
        </div>
      )}

      {/* Reconstructed blocks */}
      {projection && projection.blocks.length > 0 ? (
        <>
          <ol className="uc4-derived-block-list">
            {projection.blocks.map((b) => (
              <DerivedBlockRow
                key={b.blockId}
                block={b}
                keyframeUrls={keyframeUrls}
                onOpenOriginal={onGoToArtifacts}
              />
            ))}
          </ol>
          {projection.blockTotal > PAGE_SIZE && (
            <div className="uc4-derived-pager">
              <button
                type="button"
                className="app-btn"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </button>
              <span className="evidence-detail-muted uc4-derived-pageinfo">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, projection.blockTotal)} of{" "}
                {projection.blockTotal}
              </span>
              <button
                type="button"
                className="app-btn"
                disabled={offset + PAGE_SIZE >= projection.blockTotal}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          )}
        </>
      ) : projection && projection.blocks.length === 0 ? (
        <p className="evidence-detail-muted uc4-derived-card">
          {projection.ocrEnabled
            ? "No reconstructed text — the source produced no machine-readable content."
            : "OCR is disabled for this workspace, so no text was reconstructed. Keyframes were still derived."}
        </p>
      ) : status === "NOT_REQUESTED" ? (
        <p className="evidence-detail-muted uc4-derived-card">
          No derived review has been generated for this evidence yet.
        </p>
      ) : null}
    </div>
  );
}

function DerivedStatusRow({
  status,
  coverageLabel,
  ocrEnabled,
  lastError,
  loading,
  errorCode,
}: {
  status: string;
  coverageLabel: string | null;
  ocrEnabled: boolean | null;
  lastError: string | null;
  loading: boolean;
  errorCode: string | null;
}) {
  const label =
    status === "PROCESSING" || status === "PENDING"
      ? "Processing…"
      : status === "COMPLETED"
        ? coverageLabel === "Partial"
          ? "Complete (partial coverage)"
          : "Complete"
        : status === "FAILED"
          ? "Failed"
          : status === "DISMISSED"
            ? "Dismissed"
            : "Not requested";
  return (
    <div>
      <span className="evidence-detail-muted">
        Status: <strong>{label}</strong>
        {loading ? " · refreshing…" : ""}
        {ocrEnabled === false ? " · OCR disabled" : ""}
      </span>
      {status === "FAILED" && lastError && (
        <p className="evidence-detail-muted uc4-derived-error">{lastError}</p>
      )}
      {errorCode && (
        <p className="evidence-detail-muted uc4-derived-error">
          Could not load derived review ({errorCode}).
        </p>
      )}
    </div>
  );
}

function DerivedBlockRow({
  block,
  keyframeUrls,
  onOpenOriginal,
}: {
  block: DerivedReviewBlock;
  keyframeUrls: Record<string, string | null>;
  onOpenOriginal?: () => void;
}) {
  const [showSource, setShowSource] = useState(false);
  const kfUrls = block.sources
    .flatMap((s) => s.keyframeIds)
    .map((id) => keyframeUrls[id])
    .filter((u): u is string => !!u);

  return (
    <li className="evidence-detail-extract-card uc4-derived-block">
      <div className="uc4-derived-block-head">
        <span className="app-status-text uc4-derived-block-kind">{block.kind}</span>
        <span className="uc4-derived-block-text">{block.text || "—"}</span>
      </div>
      <div className="evidence-detail-muted uc4-derived-block-meta">
        Observed in {block.observedInFrames} frame(s) · overlap {block.confidence}
        {" · "}
        <button
          type="button"
          className="uc4-derived-linkbtn"
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource ? "Hide source" : "View source"}
        </button>
      </div>
      {showSource && (
        <div className="uc4-derived-source">
          {block.sources.map((s, i) => (
            <div key={`${s.evidencePartId}-${i}`} className="evidence-detail-muted uc4-derived-source-line">
              Source part <code>{s.evidencePartId.slice(0, 8)}…</code> ·{" "}
              {(s.offsetMsRange[0] / 1000).toFixed(1)}s–{(s.offsetMsRange[1] / 1000).toFixed(1)}s
            </div>
          ))}
          {kfUrls.length > 0 && (
            <div className="uc4-derived-thumbs">
              {kfUrls.slice(0, 6).map((u) => (
                <img
                  key={u}
                  src={u}
                  alt="Derived source keyframe"
                  loading="lazy"
                  className="uc4-derived-thumb"
                />
              ))}
            </div>
          )}
          {onOpenOriginal && (
            <button
              type="button"
              className="app-btn uc4-derived-open-original"
              onClick={onOpenOriginal}
            >
              Open Original
            </button>
          )}
        </div>
      )}
    </li>
  );
}
