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
 * Remediation (UC-DER-001/002/004/006/008/010/012):
 *   * every settled state has an action — Retry after FAILED or DISMISSED,
 *     Regenerate after COMPLETED — and each starts a NEW generation server-side;
 *   * the reconstructed text is shown only when the byte-release gate would
 *     release the material to this viewer; otherwise the tab says why;
 *   * OCR "disabled by workspace policy" and "OCR engine unavailable" are
 *     different facts and are shown as such;
 *   * a Personal record (no workspace on the record) is addressed through the
 *     active personal workspace, which the server binds or refuses;
 *   * keyframe thumbnails load with credentials (the bytes route is
 *     authenticated and cross-origin) and fail visibly;
 *   * an unproven repeat of an adjacent block is labelled, never merged.
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
  type DerivedReviewProjection,
} from "../../../../../lib/media-intelligence/useDerivedReview";
import { usePlatformContext } from "../../../../../lib/platform-context/PlatformContextProvider";
import { formatUserDateTime } from "../../../../../lib/date";

const PAGE_SIZE = 100;

/** Fields the API now projects beyond the hook's declared shape. */
type OcrStatus = "ENABLED" | "DISABLED_BY_POLICY" | "RUNTIME_UNAVAILABLE";
type ProjectionExtras = {
  ocrStatus?: OcrStatus;
  ocrLanguage?: string | null;
  generation?: {
    generation: number;
    toolVersions: { ffmpeg: string | null; tesseract: string | null };
    parametersSha256: string;
    supersedesGeneration: number | null;
    sourceTruncated: boolean;
  } | null;
};
type BlockExtras = { possibleDuplicateOf?: string | null };
type ReleaseState = { allowed: boolean; code?: string; message?: string | null };

/** Plain-language labels for the reconstruction's limitation codes. */
const LIMITATION_LABELS: Record<string, string> = {
  RECONSTRUCTION_POSSIBLE_GAP:
    "continuity between some keyframes could not be proven — content may be missing",
  RECONSTRUCTION_BOUNDS_REACHED: "a processing bound was reached — not every frame was reviewed",
  RECONSTRUCTION_AMBIGUOUS_OVERLAP: "some overlaps were ambiguous",
  RECONSTRUCTION_POSSIBLE_DUPLICATE:
    "some blocks may repeat an adjacent block — they are labelled, not merged",
  RECONSTRUCTION_SOURCE_TRUNCATED: "a source part was larger than the processing bound — only its beginning was read",
  RECONSTRUCTION_OCR_RUNTIME_UNAVAILABLE: "the OCR engine was unavailable on the processing server",
};

function ocrStatusOf(projection: (DerivedReviewProjection & ProjectionExtras) | null): OcrStatus | null {
  if (!projection) return null;
  if (projection.ocrStatus) return projection.ocrStatus;
  return projection.ocrEnabled ? "ENABLED" : null;
}

function ocrLabel(status: OcrStatus | null): string {
  switch (status) {
    case "ENABLED":
      return "enabled";
    case "DISABLED_BY_POLICY":
      return "disabled by workspace policy";
    case "RUNTIME_UNAVAILABLE":
      return "engine unavailable";
    default:
      return "not run";
  }
}

export function EvidenceDerivedReviewTab({
  ctx,
  onGoToArtifacts,
}: {
  ctx: EvidenceDetailCtx;
  onGoToArtifacts?: () => void;
}) {
  const { evidenceId, workspace } = ctx;
  const { activeWorkspaceId } = usePlatformContext();
  // The record's workspace. The review-workflow row names it when one exists;
  // otherwise (a Personal record, or a record with no workflow row yet) the
  // active workspace is offered and the SERVER binds it to the record or
  // answers 404 — the client never decides tenancy (UC-DER-010).
  const teamId = workspace.reviewWorkflow?.teamId ?? activeWorkspaceId ?? null;
  const [offset, setOffset] = useState(0);
  const { state, generate } = useDerivedReview({ evidenceId, teamId, offset, limit: PAGE_SIZE });
  const [busy, setBusy] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const data = state.data;
  const status = data?.status.status ?? "NOT_REQUESTED";
  const projection = (data?.projection ?? null) as (DerivedReviewProjection & ProjectionExtras) | null;
  const release: ReleaseState | null = data?.release ?? null;
  const keyframeUrls = data?.keyframeBytesUrls ?? {};
  const inFlight = status === "PENDING" || status === "PROCESSING";
  const ocrStatus = ocrStatusOf(projection);

  const runGenerate = async (regenerate: boolean) => {
    setBusy(true);
    setActionNote(null);
    try {
      const res = await generate(regenerate);
      if (!res.ok) {
        setActionNote("The request could not be sent. Try again.");
      } else if (!res.queued) {
        setActionNote("Nothing new was started — the current derived review is up to date.");
      }
    } finally {
      setBusy(false);
    }
  };

  const coverageLabel = useMemo(() => {
    if (!projection) return null;
    return projection.coverage === "COMPLETE" ? "Complete" : "Partial";
  }, [projection]);

  if (!teamId) {
    return (
      <div className="evidence-detail-section">
        <h3 className="evidence-detail-section-title">
          <Sparkles size={16} strokeWidth={2.1} aria-hidden="true" /> Derived Review
        </h3>
        <p className="evidence-detail-muted uc4-derived-card">
          Derived Review runs in the workspace a record belongs to. This record&apos;s
          workspace could not be determined from the current session — switch to the
          workspace that holds it to generate or read its derived review.
        </p>
      </div>
    );
  }

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
          ocrStatus={ocrStatus}
          lastError={data?.status.lastError ?? null}
          loading={state.loading}
          errorCode={state.error?.code ?? null}
        />
        <div className="uc4-derived-actions">
          {status === "NOT_REQUESTED" && (
            <button
              type="button"
              className="app-btn app-btn-primary"
              disabled={busy}
              onClick={() => void runGenerate(false)}
            >
              Generate Derived Review
            </button>
          )}
          {(status === "FAILED" || status === "DISMISSED") && (
            <button
              type="button"
              className="app-btn app-btn-primary"
              disabled={busy}
              onClick={() => void runGenerate(true)}
            >
              Retry
            </button>
          )}
          {(status === "COMPLETED" || (projection && !inFlight && status !== "FAILED" && status !== "DISMISSED")) && (
            <button
              type="button"
              className="app-btn"
              disabled={busy || inFlight}
              onClick={() => void runGenerate(true)}
            >
              Regenerate
            </button>
          )}
        </div>
        {actionNote && <p className="evidence-detail-muted">{actionNote}</p>}
      </div>

      {/* UC-DER-002 — the reconstructed text is the screen content itself. */}
      {release && !release.allowed && (
        <p className="evidence-detail-muted uc4-derived-card" role="status">
          The derived review content is not available to you for this record
          {release.code === "ACCESS_DENIED"
            ? " — your role in this workspace does not include access to the original content."
            : release.code === "PERSONAL_OWNER_REQUIRED"
              ? " — it is available only to the owner of this personal record."
              : release.code === "BLOCKED_BY_HOLD"
                ? " — the record is under a legal hold."
                : release.code === "BLOCKED_BY_LIFECYCLE"
                  ? " — the record is in the trash or bound for destruction."
                  : " — its release is blocked by workspace policy."}{" "}
          The run status above is still shown.
        </p>
      )}

      {/* Coverage + limitations + transformation versions */}
      {projection && (
        <div className="evidence-detail-extract-card uc4-derived-card">
          <p className="evidence-detail-muted">
            Coverage <strong>{coverageLabel}</strong> · OCR {ocrLabel(ocrStatus)}
            {ocrStatus === "ENABLED" && projection.ocrLanguage ? ` (${projection.ocrLanguage})` : ""} ·
            Acquisition {projection.acquisitionComplete ? "complete" : "interrupted"} ·{" "}
            {projection.stats.keyframeCount} keyframes ·{" "}
            {projection.blockTotal} reconstructed blocks
          </p>
          {projection.generation && (
            <p className="evidence-detail-muted">
              Generation {projection.generation.generation}
              {projection.generation.supersedesGeneration
                ? ` (replaces generation ${projection.generation.supersedesGeneration}, which is kept)`
                : ""}{" "}
              · generated {formatUserDateTime(projection.generatedAtUtc)}
              {projection.generation.toolVersions.ffmpeg
                ? ` · ffmpeg ${projection.generation.toolVersions.ffmpeg}`
                : ""}
              {projection.generation.toolVersions.tesseract
                ? ` · tesseract ${projection.generation.toolVersions.tesseract}`
                : ""}
            </p>
          )}
          {projection.limitations.length > 0 && (
            <ul className="evidence-detail-muted">
              {projection.limitations.map((l) => (
                <li key={l}>{LIMITATION_LABELS[l] ?? l}</li>
              ))}
            </ul>
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
                block={b as DerivedReviewBlock & BlockExtras}
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
          {ocrStatus === "ENABLED"
            ? "No reconstructed text — the source produced no machine-readable content."
            : ocrStatus === "RUNTIME_UNAVAILABLE"
              ? "No text was reconstructed because the OCR engine was unavailable on the processing server. Keyframes were still derived; regenerate once OCR is available."
              : ocrStatus === "DISABLED_BY_POLICY"
                ? "OCR is disabled by this workspace's policy, so no text was reconstructed. Keyframes were still derived."
                : "No text was reconstructed. Keyframes were still derived."}
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
  ocrStatus,
  lastError,
  loading,
  errorCode,
}: {
  status: string;
  coverageLabel: string | null;
  ocrStatus: OcrStatus | null;
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
            ? "Dismissed — retry to generate a new review"
            : "Not requested";
  return (
    <div>
      <span className="evidence-detail-muted">
        Status: <strong>{label}</strong>
        {loading ? " · refreshing…" : ""}
        {ocrStatus === "DISABLED_BY_POLICY" ? " · OCR disabled by workspace policy" : ""}
        {ocrStatus === "RUNTIME_UNAVAILABLE" ? " · OCR engine unavailable" : ""}
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
  block: DerivedReviewBlock & BlockExtras;
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
        {block.possibleDuplicateOf ? " · possible repeat of the block above (unproven)" : ""}
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
                <DerivedKeyframeThumb key={u} url={u} />
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

/**
 * UC-DER-012 — the keyframe bytes route is authenticated and cross-origin;
 * without `crossOrigin="use-credentials"` the browser omits the session cookie
 * and the image 401s (the same fix the Technical Appendix panel carries). A
 * failed load says so instead of leaving a broken image.
 */
function DerivedKeyframeThumb({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className="evidence-detail-muted uc4-derived-thumb">Keyframe unavailable</span>;
  }
  return (
    <img
      src={url}
      alt="Derived source keyframe"
      loading="lazy"
      crossOrigin="use-credentials"
      className="uc4-derived-thumb"
      onError={() => setFailed(true)}
    />
  );
}
