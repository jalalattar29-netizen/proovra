/**
 * PROOVRA Phase 3B — Provider Adapter abstraction.
 *
 * Single canonical contract every cloud provider implements. The
 * rest of the platform NEVER imports vendor SDK types — it imports
 * `ProviderAdapter` and `IntelligenceProviderResult` from this
 * file. New vendors are added by writing a new adapter — no other
 * surface changes.
 *
 * Hard rules:
 *   * Every adapter call returns the bounded
 *     `IntelligenceProviderResult` shape (operation outcome +
 *     usage event for cost controls + bounded record rows for the
 *     media-intelligence ingest pipeline).
 *   * Adapters NEVER persist anything themselves; they return data
 *     for the orchestrator to ingest.
 *   * Adapters honestly report `NOT_CONFIGURED` instead of
 *     throwing when credentials are absent.
 *   * Bounded operations from `PROVIDER_ADAPTER_OPERATIONS` —
 *     anything else is a code error.
 */

import type {
  IntelligenceConfidenceBand,
  MediaIntelligenceModality,
  MediaIntelligenceProvider,
  MediaIntelligenceRecordKind,
  ProviderAdapterOperation,
  ProviderAdapterProbe,
  ProviderAdapterState,
  ProviderCostUnit,
} from "@proovra/shared";

// ---------------------------------------------------------------------------
// Bounded request inputs — one per operation
// ---------------------------------------------------------------------------

export type AdapterByteSource = {
  bytes?: Uint8Array | null;
  /** Bounded URL when bytes are not supplied inline. */
  url?: string | null;
  /** Bounded MIME type to help the SDK. */
  contentType?: string | null;
};

export type OcrDocumentInput = AdapterByteSource;
export type OcrImageInput = AdapterByteSource;
export type TranscribeAudioInput = AdapterByteSource;
export type DetectFacesInput = AdapterByteSource;
export type DetectObjectsInput = AdapterByteSource;
export type DetectTextInImageInput = AdapterByteSource;
export type ExtractEntitiesInput = {
  /** Bounded text the provider scans. */
  text: string;
};
export type SummariseDocumentInput = {
  text: string;
  /** Bounded summary length cap in characters. */
  maxChars?: number;
};

// ---------------------------------------------------------------------------
// Bounded result shapes
// ---------------------------------------------------------------------------

export type AdapterRecordRow = {
  kind: MediaIntelligenceRecordKind;
  modality: MediaIntelligenceModality;
  providerConfidence: number;
  providerConfidenceBand: IntelligenceConfidenceBand;
  /** Bounded operator-facing label (≤ 120 chars). NEVER full text. */
  label: string | null;
  /** Bounded source anchor (shape depends on kind). */
  anchor: Record<string, unknown> | null;
  /** Provider raw payload (kept; the platform re-projects it later). */
  payload: Record<string, unknown>;
  /** Bounded provider record key so re-runs de-dupe. */
  providerRecordKey: string;
};

export type AdapterEntityRow = {
  kind: string; // Bounded by REDACTION_DETECTION_KINDS
  /** Bounded preview label (≤ 80 chars). NEVER full PII. */
  previewLabel: string | null;
  /** SHA-256 hex of the canonical value — never the raw value. */
  valueHash: string;
  rawConfidence: number;
  confidenceBand: IntelligenceConfidenceBand;
  anchor: Record<string, unknown> | null;
};

export type IntelligenceProviderUsage = {
  provider: MediaIntelligenceProvider;
  operation: ProviderAdapterOperation;
  unit: ProviderCostUnit;
  units: number;
  /** Bounded USD-micros estimate (1 USD = 1_000_000 micros). */
  estimatedCostUsdMicros: number;
};

export type IntelligenceProviderResult =
  | {
      ok: true;
      records: ReadonlyArray<AdapterRecordRow>;
      entities: ReadonlyArray<AdapterEntityRow>;
      usage: IntelligenceProviderUsage;
      /**
       * Bounded transcript text (or extracted document text) the
       * orchestrator may hand to the REGEX_PII entity pipeline.
       */
      extractedText: string | null;
    }
  | {
      ok: false;
      state: ProviderAdapterState;
      reason: string | null;
      usage: IntelligenceProviderUsage | null;
    };

// ---------------------------------------------------------------------------
// Provider adapter interface — every provider implements this.
// ---------------------------------------------------------------------------

export type ProviderAdapter = {
  readonly provider: MediaIntelligenceProvider;
  readonly supportedOperations: ReadonlyArray<ProviderAdapterOperation>;

  /**
   * Cheap credential probe — no provider call. Used by the
   * provider-health endpoint + the orchestrator's bounded
   * fallback path.
   */
  probe(): ProviderAdapterProbe;

  // Operations — each returns the bounded IntelligenceProviderResult.
  ocrDocument?(input: OcrDocumentInput): Promise<IntelligenceProviderResult>;
  ocrImage?(input: OcrImageInput): Promise<IntelligenceProviderResult>;
  transcribeAudio?(
    input: TranscribeAudioInput,
  ): Promise<IntelligenceProviderResult>;
  detectFaces?(input: DetectFacesInput): Promise<IntelligenceProviderResult>;
  detectObjects?(
    input: DetectObjectsInput,
  ): Promise<IntelligenceProviderResult>;
  detectTextInImage?(
    input: DetectTextInImageInput,
  ): Promise<IntelligenceProviderResult>;
  extractEntities?(
    input: ExtractEntitiesInput,
  ): Promise<IntelligenceProviderResult>;
  summariseDocument?(
    input: SummariseDocumentInput,
  ): Promise<IntelligenceProviderResult>;
};

// ---------------------------------------------------------------------------
// Adapter registry — bounded set of bound providers
// ---------------------------------------------------------------------------

const REGISTRY: Map<MediaIntelligenceProvider, ProviderAdapter> = new Map();

export function registerAdapter(adapter: ProviderAdapter): void {
  REGISTRY.set(adapter.provider, adapter);
}

export function getAdapter(
  provider: MediaIntelligenceProvider,
): ProviderAdapter | null {
  return REGISTRY.get(provider) ?? null;
}

export function listAdapters(): ReadonlyArray<ProviderAdapter> {
  return Array.from(REGISTRY.values());
}

export function listAdapterProbes(): ReadonlyArray<ProviderAdapterProbe> {
  return Array.from(REGISTRY.values()).map((a) => a.probe());
}

// Test hook — bounded reset for closure tests.
export function __clearAdapterRegistryForTests(): void {
  REGISTRY.clear();
}
