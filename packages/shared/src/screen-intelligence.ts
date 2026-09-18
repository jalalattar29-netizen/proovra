/**
 * UC-4 — the media-free ORCHESTRATOR that composes the derived-intelligence pipeline
 * and the canonical local-OCR PROVIDER interface.
 *
 *   ORIGINAL parts → bounded keyframe selection → local OCR (injected provider)
 *   → source-linked observations → conservative reconstruction.
 *
 * The orchestrator is PURE and deterministic: media decoding and OCR execution are
 * INJECTED (an ffmpeg keyframe extractor supplies candidate change-scored frames; an
 * OcrProvider extracts text regions from a keyframe image reference). This lets the
 * entire logical pipeline — and the mandatory source-lineage chain — be verified
 * without ffmpeg or a Tesseract binary. The real worker wires the same interfaces to
 * ffmpeg + a local Tesseract provider (execution deferred to the worker runtime).
 *
 * Every produced observation carries its ORIGINAL lineage (sourcePartIndex +
 * sourceOffsetMs + keyframeId), so every reconstructed block traces to the ORIGINAL
 * EvidencePart it was observed in. Nothing here is ORIGINAL; all output is DERIVED.
 */
import {
  reconstructScreenConversation,
  type ReconstructionBlockKind,
  type ScreenObservation,
  type ScreenReconstructionResult,
} from "./screen-reconstruction.js";
import {
  selectKeyframes,
  KEYFRAME_SELECTION_BOUNDS,
  type KeyframeCandidate,
  type KeyframeSelectionBounds,
  type SelectedKeyframe,
} from "./screen-keyframes.js";

export const SCREEN_OCR_TRANSFORMATION = "screen-ocr/v1" as const;

/** A text region an OCR provider detected in ONE keyframe image. */
export type OcrRegion = {
  text: string;
  kind: ReconstructionBlockKind;
  /** Vertical position within the frame (0 = top) — the reconstruction row order. */
  rowOrder: number;
  /** Optional geometry; PROOVRA does not require or persist it unless available. */
  bbox?: { top: number; left: number; width: number; height: number } | null;
  fingerprint?: string | null;
  /** Provider confidence, ADVISORY only — never treated as truth. Present iff real. */
  confidence?: number | null;
};

export type OcrExtractResult = { regions: OcrRegion[]; language?: string | null };

/**
 * THE canonical local-OCR provider interface. Implementations MUST be local /
 * self-hosted / deterministic (no customer evidence to a new external service, no
 * training on evidence). `extract` reads ONE bounded keyframe image reference and
 * returns detected text regions; a deterministic failure throws.
 */
export type OcrProvider = {
  /** e.g. "tesseract", "noop". */
  name: string;
  version: string;
  /** True when the provider runs locally with no external network processor. */
  local: boolean;
  extract(input: { imageRef: string }): Promise<OcrExtractResult>;
};

/** A source part with the change-scored candidate frames media analysis produced. */
export type KeyframeSourcePart = {
  partIndex: number;
  candidates: KeyframeCandidate[];
};

export type ScreenIntelligenceInput = {
  parts: KeyframeSourcePart[];
  ocr: OcrProvider;
  /** Resolve the OCR image reference (e.g. the derived keyframe's storage key). */
  imageRefForKeyframe: (partIndex: number, keyframe: SelectedKeyframe) => string;
  keyframeBounds?: KeyframeSelectionBounds;
};

export type ScreenIntelligenceResult = {
  keyframesByPart: Array<{ partIndex: number; keyframes: SelectedKeyframe[]; boundsReached: boolean }>;
  observations: ScreenObservation[];
  reconstruction: ScreenReconstructionResult;
  ocrProvider: { name: string; version: string; local: boolean };
  stats: {
    keyframeCount: number;
    ocrRegionCount: number;
    ocrFailedKeyframes: number;
  };
};

/**
 * Run the derived-intelligence pipeline. Deterministic given a deterministic OCR
 * provider. Keyframes are ordered globally (by part, then offset) so `frameOrder`
 * reflects true temporal order across segments — the basis for scroll-overlap
 * reconstruction. An OCR failure on one keyframe degrades that frame (no
 * observations) but never fails the whole pipeline and never affects ORIGINAL
 * evidence.
 */
export async function runScreenIntelligence(
  input: ScreenIntelligenceInput,
): Promise<ScreenIntelligenceResult> {
  const bounds = input.keyframeBounds ?? KEYFRAME_SELECTION_BOUNDS;

  const keyframesByPart = [...input.parts]
    .sort((a, b) => a.partIndex - b.partIndex)
    .map((p) => {
      const sel = selectKeyframes(p.candidates, bounds);
      return { partIndex: p.partIndex, keyframes: sel.keyframes, boundsReached: sel.boundsReached };
    });

  // Global temporal order of keyframes across all parts → frameOrder.
  const orderedKeyframes: Array<{ partIndex: number; keyframe: SelectedKeyframe }> = [];
  for (const part of keyframesByPart) {
    for (const keyframe of part.keyframes) orderedKeyframes.push({ partIndex: part.partIndex, keyframe });
  }
  orderedKeyframes.sort((a, b) =>
    a.partIndex !== b.partIndex ? a.partIndex - b.partIndex : a.keyframe.offsetMs - b.keyframe.offsetMs,
  );

  const observations: ScreenObservation[] = [];
  let ocrRegionCount = 0;
  let ocrFailedKeyframes = 0;
  let obsCounter = 0;

  for (let frameOrder = 0; frameOrder < orderedKeyframes.length; frameOrder += 1) {
    const { partIndex, keyframe } = orderedKeyframes[frameOrder];
    const keyframeId = `p${partIndex}-${keyframe.variantKey}`;
    const imageRef = input.imageRefForKeyframe(partIndex, keyframe);
    let regions: OcrRegion[] = [];
    try {
      const res = await input.ocr.extract({ imageRef });
      regions = res.regions;
    } catch {
      ocrFailedKeyframes += 1;
      continue; // degrade this frame; ORIGINAL evidence + other frames unaffected
    }
    ocrRegionCount += regions.length;
    for (const region of [...regions].sort((a, b) => a.rowOrder - b.rowOrder)) {
      observations.push({
        id: `obs-${obsCounter++}`,
        keyframeId,
        sourcePartIndex: partIndex,
        sourceOffsetMs: keyframe.offsetMs,
        frameOrder,
        rowOrder: region.rowOrder,
        text: region.text,
        kind: region.kind,
        fingerprint: region.fingerprint ?? keyframe.fingerprint ?? null,
      });
    }
  }

  const reconstruction = reconstructScreenConversation(observations);

  return {
    keyframesByPart,
    observations,
    reconstruction,
    ocrProvider: { name: input.ocr.name, version: input.ocr.version, local: input.ocr.local },
    stats: {
      keyframeCount: orderedKeyframes.length,
      ocrRegionCount,
      ocrFailedKeyframes,
    },
  };
}
