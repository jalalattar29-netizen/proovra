import { OTS_STATE_LABELS, type OtsState } from "./ots-anchoring.js";

/**
 * THE ANCHOR SUMMARY (2026-10-13) — the anchor.json / manifest projection of
 * the ONE OpenTimestamps state (`resolveOtsAnchoring`). It derives nothing
 * itself: a transaction id, an anchored-at time or a status string never
 * decides whether a record is anchored.
 */
export type AnchorSemanticsInput = {
  transactionId?: string | null;
  /** The canonical state (ots-anchoring.ts). */
  otsState: OtsState;
};

export type AnchorSemantics = {
  transactionId: string | null;
  hasTransactionId: boolean;
  otsState: OtsState;
  anchoringLabel: string;
  anchorMode: "anchored" | "bitcoin_anchoring_pending" | "failed" | "unavailable" | "not_configured";
};

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const MODE: Readonly<Record<OtsState, AnchorSemantics["anchorMode"]>> = {
  ANCHORED: "anchored",
  PENDING: "bitcoin_anchoring_pending",
  FAILED: "failed",
  UNAVAILABLE: "unavailable",
  NOT_REQUESTED: "not_configured",
};

export function deriveAnchorSemantics(input: AnchorSemanticsInput): AnchorSemantics {
  const transactionId = normalizeString(input.transactionId);
  return {
    transactionId,
    hasTransactionId: Boolean(transactionId),
    otsState: input.otsState,
    anchoringLabel: OTS_STATE_LABELS[input.otsState],
    anchorMode: MODE[input.otsState],
  };
}
