/**
 * PROOVRA Phase 3A Closure — AWS Rekognition client wrapper.
 *
 * Real `@aws-sdk/client-rekognition` integration. The platform
 * already ships AWS S3 + KMS + Secrets Manager clients; Rekognition
 * is the bound add for face / text / label detection.
 *
 * Hard rules:
 *   * Bounded probe — returns READY only when credentials AND a
 *     region are present. NEVER swallows a missing-credential
 *     condition silently.
 *   * NEVER logs raw image bytes or raw API responses. Captures the
 *     error type + provider category only.
 *   * Sentry capture on UNEXPECTED errors (auth / quota are mapped
 *     to bounded provider states instead).
 *   * Lazy client construction — the SDK is only required when the
 *     workspace actually invokes a Rekognition detection run.
 */

import {
  DetectFacesCommand,
  DetectLabelsCommand,
  DetectTextCommand,
  RekognitionClient,
} from "@aws-sdk/client-rekognition";

import type {
  BboxNormalized,
  RedactionConfidenceBand,
  RedactionDetectionKind,
  RedactionDetectionProviderState,
  RedactionMethod,
  RedactionRegionKind,
} from "@proovra/shared";
import { classifyConfidence } from "@proovra/shared";

import { getSecret } from "../../../config/runtime-secrets.js";
import { captureException } from "../../../observability/sentry.js";

// ---------------------------------------------------------------------------
// Bounded probe + types
// ---------------------------------------------------------------------------

export type RekognitionProbe = {
  state: RedactionDetectionProviderState;
  reason: string | null;
  region: string | null;
};

export type RekognitionDetectionRow = {
  kind: RedactionDetectionKind;
  rawConfidence: number;
  confidenceBand: RedactionConfidenceBand;
  suggestedRegionKind: RedactionRegionKind;
  suggestedRegionGeometry: Record<string, unknown>;
  suggestedMethod: RedactionMethod;
  previewLabel: string | null;
};

export type RekognitionImageInput = {
  imageBytes: Uint8Array | null;
  /**
   * S3 source for the image when bytes are not supplied inline.
   * Bounded — both fields are required when used.
   */
  s3Object?: { bucket: string; key: string } | null;
};

// ---------------------------------------------------------------------------
// Singleton client construction (lazy)
// ---------------------------------------------------------------------------

let cachedClient: RekognitionClient | null = null;
let cachedRegion: string | null = null;

/**
 * Returns the configured region or null when one cannot be resolved.
 * The platform's S3 client uses the same `AWS_REGION` env, so we
 * inherit that for consistency.
 */
function resolveRegion(): string | null {
  const fromSecret = getSecret("AWS_REGION");
  if (fromSecret) return fromSecret;
  const fromEnv = (process.env.AWS_REGION ?? "").trim();
  return fromEnv.length > 0 ? fromEnv : null;
}

/**
 * Returns `true` when at least one credential channel is present.
 * The SDK auto-resolves credentials from a chain (IAM role, env,
 * shared profile, etc.) so we accept any of those as "ready".
 */
function credentialsPresent(): boolean {
  if (
    (process.env.AWS_ACCESS_KEY_ID ?? "").trim().length > 0 &&
    (process.env.AWS_SECRET_ACCESS_KEY ?? "").trim().length > 0
  ) {
    return true;
  }
  if ((process.env.AWS_PROFILE ?? "").trim().length > 0) return true;
  if (
    (process.env.AWS_WEB_IDENTITY_TOKEN_FILE ?? "").trim().length > 0 ||
    (process.env.AWS_ROLE_ARN ?? "").trim().length > 0
  ) {
    return true;
  }
  return false;
}

export function probeRekognition(): RekognitionProbe {
  const region = resolveRegion();
  if (!region) {
    return {
      state: "NOT_CONFIGURED",
      reason: "AWS_REGION is not bound for this workspace",
      region: null,
    };
  }
  if (!credentialsPresent()) {
    return {
      state: "NOT_CONFIGURED",
      reason:
        "AWS credentials not bound (set IAM role, AWS_ACCESS_KEY_ID, or AWS_PROFILE)",
      region,
    };
  }
  return { state: "READY", reason: null, region };
}

function buildClient(): RekognitionClient | null {
  const probe = probeRekognition();
  if (probe.state !== "READY") return null;
  if (cachedClient && cachedRegion === probe.region) return cachedClient;
  cachedRegion = probe.region;
  cachedClient = new RekognitionClient({ region: probe.region ?? undefined });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Real detection paths
// ---------------------------------------------------------------------------

type SdkImage = {
  Bytes?: Uint8Array;
  S3Object?: { Bucket: string; Name: string };
};

function buildImagePayload(input: RekognitionImageInput): SdkImage | null {
  if (input.imageBytes && input.imageBytes.length > 0) {
    return { Bytes: input.imageBytes };
  }
  if (input.s3Object && input.s3Object.bucket && input.s3Object.key) {
    return { S3Object: { Bucket: input.s3Object.bucket, Name: input.s3Object.key } };
  }
  return null;
}

function boundingBoxToBbox(
  b:
    | {
        Left?: number;
        Top?: number;
        Width?: number;
        Height?: number;
      }
    | undefined,
): BboxNormalized | null {
  if (!b) return null;
  const x = clamp01(b.Left ?? 0);
  const y = clamp01(b.Top ?? 0);
  const width = clamp01(b.Width ?? 0);
  const height = clamp01(b.Height ?? 0);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function previewLabel(kind: RedactionDetectionKind, hint?: string): string {
  const base = kind.toLowerCase();
  if (!hint) return base;
  return `${base} · ${hint.replace(/\s+/g, " ").slice(0, 60)}`;
}

// ---------------------------------------------------------------------------
// detectFaces
// ---------------------------------------------------------------------------

export type DetectFacesInput = RekognitionImageInput & {
  /** Bounded confidence floor; raw % from Rekognition. Default 70. */
  minConfidence?: number;
};

export type RekognitionRunResult = {
  state: RedactionDetectionProviderState;
  reason: string | null;
  rows: RekognitionDetectionRow[];
};

export async function detectFaces(
  input: DetectFacesInput,
  client: RekognitionClient | null = buildClient(),
): Promise<RekognitionRunResult> {
  const image = buildImagePayload(input);
  if (!image) {
    return {
      state: "NOT_CONFIGURED",
      reason: "rekognition_detect_faces_requires_image_bytes_or_s3_object",
      rows: [],
    };
  }
  if (!client) {
    return {
      state: "NOT_CONFIGURED",
      reason: probeRekognition().reason,
      rows: [],
    };
  }
  try {
    const res = await client.send(
      new DetectFacesCommand({ Image: image, Attributes: ["DEFAULT"] }),
    );
    const minConf = input.minConfidence ?? 70;
    const rows: RekognitionDetectionRow[] = [];
    for (const f of res.FaceDetails ?? []) {
      const c = f.Confidence ?? 0;
      if (c < minConf) continue;
      const bbox = boundingBoxToBbox(f.BoundingBox);
      if (!bbox) continue;
      const raw = c / 100;
      rows.push({
        kind: "FACE",
        rawConfidence: raw,
        confidenceBand: classifyConfidence(raw),
        suggestedRegionKind: "BBOX_NORMALIZED",
        suggestedRegionGeometry: bbox as unknown as Record<string, unknown>,
        suggestedMethod: "BLUR",
        previewLabel: previewLabel("FACE"),
      });
    }
    return { state: "READY", reason: null, rows };
  } catch (err) {
    return providerError("rekognition_detect_faces", err);
  }
}

// ---------------------------------------------------------------------------
// detectText
// ---------------------------------------------------------------------------

export async function detectText(
  input: RekognitionImageInput,
  client: RekognitionClient | null = buildClient(),
): Promise<RekognitionRunResult> {
  const image = buildImagePayload(input);
  if (!image) {
    return {
      state: "NOT_CONFIGURED",
      reason: "rekognition_detect_text_requires_image_bytes_or_s3_object",
      rows: [],
    };
  }
  if (!client) {
    return {
      state: "NOT_CONFIGURED",
      reason: probeRekognition().reason,
      rows: [],
    };
  }
  try {
    const res = await client.send(new DetectTextCommand({ Image: image }));
    const rows: RekognitionDetectionRow[] = [];
    for (const t of res.TextDetections ?? []) {
      // Use bounded LINE detections only — WORD-level inflates the
      // reviewer queue without adding precision.
      if (t.Type !== "LINE") continue;
      const c = t.Confidence ?? 0;
      const bbox = boundingBoxToBbox(t.Geometry?.BoundingBox);
      if (!bbox) continue;
      const raw = c / 100;
      const label = t.DetectedText ?? null;
      rows.push({
        kind: "TEXT_BLOCK",
        rawConfidence: raw,
        confidenceBand: classifyConfidence(raw),
        suggestedRegionKind: "BBOX_NORMALIZED",
        suggestedRegionGeometry: bbox as unknown as Record<string, unknown>,
        suggestedMethod: "BLACKOUT",
        previewLabel: maskPreviewText(label),
      });
    }
    return { state: "READY", reason: null, rows };
  } catch (err) {
    return providerError("rekognition_detect_text", err);
  }
}

// ---------------------------------------------------------------------------
// detectLabels (objects)
// ---------------------------------------------------------------------------

export type DetectLabelsInput = RekognitionImageInput & {
  /** Bounded set of label names that map to a detection kind. */
  sensitiveLabelNames?: ReadonlyArray<string>;
};

export async function detectLabels(
  input: DetectLabelsInput,
  client: RekognitionClient | null = buildClient(),
): Promise<RekognitionRunResult> {
  const image = buildImagePayload(input);
  if (!image) {
    return {
      state: "NOT_CONFIGURED",
      reason: "rekognition_detect_labels_requires_image_bytes_or_s3_object",
      rows: [],
    };
  }
  if (!client) {
    return {
      state: "NOT_CONFIGURED",
      reason: probeRekognition().reason,
      rows: [],
    };
  }
  try {
    const res = await client.send(
      new DetectLabelsCommand({ Image: image, MaxLabels: 50 }),
    );
    const sensitive = new Set(
      (input.sensitiveLabelNames ?? [
        "License Plate",
        "Document",
        "Identification Card",
        "Driving License",
        "Passport",
        "Credit Card",
        "Phone",
      ]).map((s) => s.toLowerCase()),
    );
    const rows: RekognitionDetectionRow[] = [];
    for (const l of res.Labels ?? []) {
      const lname = (l.Name ?? "").trim();
      if (!lname) continue;
      // Only flag bounded sensitive labels — generic "Car", "Tree"
      // would pollute the reviewer queue.
      if (!sensitive.has(lname.toLowerCase())) continue;
      const c = l.Confidence ?? 0;
      const raw = c / 100;
      // Use the first bounded instance as the suggested region; if
      // no instance bbox is reported, the platform requires manual
      // placement.
      const instance = (l.Instances ?? [])[0];
      const bbox = boundingBoxToBbox(instance?.BoundingBox);
      if (!bbox) continue;
      const kind: RedactionDetectionKind =
        lname.toLowerCase().includes("license plate")
          ? "LICENSE_PLATE"
          : lname.toLowerCase().includes("credit card")
          ? "CREDIT_CARD"
          : "TEXT_BLOCK";
      rows.push({
        kind,
        rawConfidence: raw,
        confidenceBand: classifyConfidence(raw),
        suggestedRegionKind: "BBOX_NORMALIZED",
        suggestedRegionGeometry: bbox as unknown as Record<string, unknown>,
        suggestedMethod: "BLUR",
        previewLabel: previewLabel(kind, lname),
      });
    }
    return { state: "READY", reason: null, rows };
  } catch (err) {
    return providerError("rekognition_detect_labels", err);
  }
}

// ---------------------------------------------------------------------------
// Error mapper
// ---------------------------------------------------------------------------

function providerError(
  operation: string,
  err: unknown,
): RekognitionRunResult {
  const name = err instanceof Error ? err.name : "UnknownError";
  // Bounded error categorisation — never log the raw error.
  if (/ProvisionedThroughputExceeded|ThrottlingException|LimitExceeded/i.test(name)) {
    return {
      state: "RATE_LIMITED",
      reason: `rekognition_${operation}_rate_limited`,
      rows: [],
    };
  }
  if (/AccessDenied|InvalidSignature|UnrecognizedClient|TokenError/i.test(name)) {
    return {
      state: "NOT_CONFIGURED",
      reason: `rekognition_${operation}_credentials_rejected`,
      rows: [],
    };
  }
  if (/Validation|InvalidImage|InvalidParameter/i.test(name)) {
    return {
      state: "ERROR",
      reason: `rekognition_${operation}_invalid_input`,
      rows: [],
    };
  }
  captureException(err, { operation });
  return {
    state: "ERROR",
    reason: `rekognition_${operation}_unexpected`,
    rows: [],
  };
}

function maskPreviewText(value: string | null): string | null {
  if (!value) return null;
  const t = value.replace(/\s+/g, " ").trim();
  if (t.length <= 6) return t;
  return `${t.slice(0, 2)}***${t.slice(-2)}`.slice(0, 80);
}

// ---------------------------------------------------------------------------
// Test helpers — bounded dependency injection for closure tests.
// ---------------------------------------------------------------------------

export function __setTestClient(client: RekognitionClient | null): void {
  cachedClient = client;
  cachedRegion = client ? "test-region" : null;
}
