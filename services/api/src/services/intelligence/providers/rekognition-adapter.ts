/**
 * PROOVRA Phase 3B — AWS Rekognition adapter.
 *
 * Bounded adapter on top of the Phase 3A Closure
 * `rekognition-client.ts`. Maps face / text / label detections
 * into bounded `IMAGE_FACE` / `IMAGE_TEXT_BLOCK` /
 * `IMAGE_OBJECT_LABEL` records the media-intelligence pipeline
 * persists. Bills usage in images (one image per call).
 */

import { createHash } from "node:crypto";
import {
  classifyIntelligenceConfidence,
  type MediaIntelligenceProvider,
  type ProviderAdapterOperation,
  type ProviderAdapterProbe,
} from "@proovra/shared";

import {
  detectFaces,
  detectLabels,
  detectText,
  probeRekognition,
} from "../../redaction/providers/rekognition-client.js";
import {
  registerAdapter,
  type AdapterRecordRow,
  type IntelligenceProviderResult,
  type ProviderAdapter,
} from "./provider-adapter.js";

const PROVIDER_FACES: MediaIntelligenceProvider = "AWS_REKOGNITION_FACES";
const PROVIDER_TEXT: MediaIntelligenceProvider = "AWS_REKOGNITION_TEXT";
const PROVIDER_LABELS: MediaIntelligenceProvider = "AWS_REKOGNITION_LABELS";

/**
 * Bounded Rekognition pricing — face / text / label all bill the
 * first 1M images at $1.00 per 1000 images at retail.
 */
const COST_PER_IMAGE_USD_MICROS = 1000;

function buildFacesAdapter(): ProviderAdapter {
  const SUPPORTED: ReadonlyArray<ProviderAdapterOperation> = ["DETECT_FACES"];
  return {
    provider: PROVIDER_FACES,
    supportedOperations: SUPPORTED,
    probe(): ProviderAdapterProbe {
      const p = probeRekognition();
      return {
        provider: PROVIDER_FACES,
        state: p.state,
        operations: SUPPORTED,
        reason: p.reason,
      };
    },
    async detectFaces(input): Promise<IntelligenceProviderResult> {
      const res = await detectFaces({ imageBytes: input.bytes ?? null });
      if (res.state !== "READY") {
        return {
          ok: false,
          state: res.state,
          reason: res.reason,
          usage: zeroUsage(PROVIDER_FACES, "DETECT_FACES"),
        };
      }
      return projectImageRekognition(res.rows, "IMAGE_FACE", PROVIDER_FACES, "DETECT_FACES");
    },
  };
}

function buildTextAdapter(): ProviderAdapter {
  const SUPPORTED: ReadonlyArray<ProviderAdapterOperation> = [
    "DETECT_TEXT_IN_IMAGE",
  ];
  return {
    provider: PROVIDER_TEXT,
    supportedOperations: SUPPORTED,
    probe(): ProviderAdapterProbe {
      const p = probeRekognition();
      return {
        provider: PROVIDER_TEXT,
        state: p.state,
        operations: SUPPORTED,
        reason: p.reason,
      };
    },
    async detectTextInImage(input): Promise<IntelligenceProviderResult> {
      const res = await detectText({ imageBytes: input.bytes ?? null });
      if (res.state !== "READY") {
        return {
          ok: false,
          state: res.state,
          reason: res.reason,
          usage: zeroUsage(PROVIDER_TEXT, "DETECT_TEXT_IN_IMAGE"),
        };
      }
      return projectImageRekognition(
        res.rows,
        "IMAGE_TEXT_BLOCK",
        PROVIDER_TEXT,
        "DETECT_TEXT_IN_IMAGE",
      );
    },
  };
}

function buildLabelsAdapter(): ProviderAdapter {
  const SUPPORTED: ReadonlyArray<ProviderAdapterOperation> = [
    "DETECT_OBJECTS",
  ];
  return {
    provider: PROVIDER_LABELS,
    supportedOperations: SUPPORTED,
    probe(): ProviderAdapterProbe {
      const p = probeRekognition();
      return {
        provider: PROVIDER_LABELS,
        state: p.state,
        operations: SUPPORTED,
        reason: p.reason,
      };
    },
    async detectObjects(input): Promise<IntelligenceProviderResult> {
      const res = await detectLabels({ imageBytes: input.bytes ?? null });
      if (res.state !== "READY") {
        return {
          ok: false,
          state: res.state,
          reason: res.reason,
          usage: zeroUsage(PROVIDER_LABELS, "DETECT_OBJECTS"),
        };
      }
      return projectImageRekognition(
        res.rows,
        "IMAGE_OBJECT_LABEL",
        PROVIDER_LABELS,
        "DETECT_OBJECTS",
      );
    },
  };
}

export const rekognitionFacesAdapter = buildFacesAdapter();
export const rekognitionTextAdapter = buildTextAdapter();
export const rekognitionLabelsAdapter = buildLabelsAdapter();

registerAdapter(rekognitionFacesAdapter);
registerAdapter(rekognitionTextAdapter);
registerAdapter(rekognitionLabelsAdapter);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function projectImageRekognition(
  rows: ReadonlyArray<{
    kind: string;
    rawConfidence: number;
    suggestedRegionGeometry: Record<string, unknown>;
    previewLabel: string | null;
  }>,
  recordKind:
    | "IMAGE_FACE"
    | "IMAGE_TEXT_BLOCK"
    | "IMAGE_OBJECT_LABEL",
  provider: MediaIntelligenceProvider,
  operation: ProviderAdapterOperation,
): IntelligenceProviderResult {
  const records: AdapterRecordRow[] = rows.map((r) => ({
    kind: recordKind,
    modality: "IMAGE",
    providerConfidence: r.rawConfidence,
    providerConfidenceBand: classifyIntelligenceConfidence(r.rawConfidence),
    label: r.previewLabel,
    anchor: r.suggestedRegionGeometry,
    payload: {
      kind: r.kind,
      previewLabel: r.previewLabel,
    },
    providerRecordKey: hashKey([
      provider,
      recordKind,
      JSON.stringify(r.suggestedRegionGeometry ?? {}),
    ]),
  }));
  return {
    ok: true,
    records,
    entities: [],
    extractedText: null,
    usage: {
      provider,
      operation,
      unit: "IMAGE",
      units: 1,
      estimatedCostUsdMicros: COST_PER_IMAGE_USD_MICROS,
    },
  };
}

function zeroUsage(
  provider: MediaIntelligenceProvider,
  operation: ProviderAdapterOperation,
) {
  return {
    provider,
    operation,
    unit: "IMAGE" as const,
    units: 0,
    estimatedCostUsdMicros: 0,
  };
}

function hashKey(parts: ReadonlyArray<string>): string {
  return createHash("sha256")
    .update(parts.join("|"), "utf8")
    .digest("hex")
    .slice(0, 64);
}
