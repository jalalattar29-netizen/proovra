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
import { DetectFacesCommand, DetectLabelsCommand, DetectTextCommand, RekognitionClient, } from "@aws-sdk/client-rekognition";
import { classifyConfidence } from "@proovra/shared";
import { getSecret } from "../../../config/runtime-secrets.js";
import { captureException } from "../../../observability/sentry.js";
// ---------------------------------------------------------------------------
// Singleton client construction (lazy)
// ---------------------------------------------------------------------------
let cachedClient = null;
let cachedRegion = null;
/**
 * Returns the configured region or null when one cannot be resolved.
 * The platform's S3 client uses the same `AWS_REGION` env, so we
 * inherit that for consistency.
 */
function resolveRegion() {
    const fromSecret = getSecret("AWS_REGION");
    if (fromSecret)
        return fromSecret;
    const fromEnv = (process.env.AWS_REGION ?? "").trim();
    return fromEnv.length > 0 ? fromEnv : null;
}
/**
 * Returns `true` when at least one credential channel is present.
 * The SDK auto-resolves credentials from a chain (IAM role, env,
 * shared profile, etc.) so we accept any of those as "ready".
 */
function credentialsPresent() {
    if ((process.env.AWS_ACCESS_KEY_ID ?? "").trim().length > 0 &&
        (process.env.AWS_SECRET_ACCESS_KEY ?? "").trim().length > 0) {
        return true;
    }
    if ((process.env.AWS_PROFILE ?? "").trim().length > 0)
        return true;
    if ((process.env.AWS_WEB_IDENTITY_TOKEN_FILE ?? "").trim().length > 0 ||
        (process.env.AWS_ROLE_ARN ?? "").trim().length > 0) {
        return true;
    }
    return false;
}
export function probeRekognition() {
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
            reason: "AWS credentials not bound (set IAM role, AWS_ACCESS_KEY_ID, or AWS_PROFILE)",
            region,
        };
    }
    return { state: "READY", reason: null, region };
}
function buildClient() {
    const probe = probeRekognition();
    if (probe.state !== "READY")
        return null;
    if (cachedClient && cachedRegion === probe.region)
        return cachedClient;
    cachedRegion = probe.region;
    cachedClient = new RekognitionClient({ region: probe.region ?? undefined });
    return cachedClient;
}
function buildImagePayload(input) {
    if (input.imageBytes && input.imageBytes.length > 0) {
        return { Bytes: input.imageBytes };
    }
    if (input.s3Object && input.s3Object.bucket && input.s3Object.key) {
        return { S3Object: { Bucket: input.s3Object.bucket, Name: input.s3Object.key } };
    }
    return null;
}
function boundingBoxToBbox(b) {
    if (!b)
        return null;
    const x = clamp01(b.Left ?? 0);
    const y = clamp01(b.Top ?? 0);
    const width = clamp01(b.Width ?? 0);
    const height = clamp01(b.Height ?? 0);
    if (width <= 0 || height <= 0)
        return null;
    return { x, y, width, height };
}
function clamp01(n) {
    if (!Number.isFinite(n))
        return 0;
    if (n < 0)
        return 0;
    if (n > 1)
        return 1;
    return n;
}
function previewLabel(kind, hint) {
    const base = kind.toLowerCase();
    if (!hint)
        return base;
    return `${base} · ${hint.replace(/\s+/g, " ").slice(0, 60)}`;
}
export async function detectFaces(input, client = buildClient()) {
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
        const res = await client.send(new DetectFacesCommand({ Image: image, Attributes: ["DEFAULT"] }));
        const minConf = input.minConfidence ?? 70;
        const rows = [];
        for (const f of res.FaceDetails ?? []) {
            const c = f.Confidence ?? 0;
            if (c < minConf)
                continue;
            const bbox = boundingBoxToBbox(f.BoundingBox);
            if (!bbox)
                continue;
            const raw = c / 100;
            rows.push({
                kind: "FACE",
                rawConfidence: raw,
                confidenceBand: classifyConfidence(raw),
                suggestedRegionKind: "BBOX_NORMALIZED",
                suggestedRegionGeometry: bbox,
                suggestedMethod: "BLUR",
                previewLabel: previewLabel("FACE"),
            });
        }
        return { state: "READY", reason: null, rows };
    }
    catch (err) {
        return providerError("rekognition_detect_faces", err);
    }
}
// ---------------------------------------------------------------------------
// detectText
// ---------------------------------------------------------------------------
export async function detectText(input, client = buildClient()) {
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
        const rows = [];
        for (const t of res.TextDetections ?? []) {
            // Use bounded LINE detections only — WORD-level inflates the
            // reviewer queue without adding precision.
            if (t.Type !== "LINE")
                continue;
            const c = t.Confidence ?? 0;
            const bbox = boundingBoxToBbox(t.Geometry?.BoundingBox);
            if (!bbox)
                continue;
            const raw = c / 100;
            const label = t.DetectedText ?? null;
            rows.push({
                kind: "TEXT_BLOCK",
                rawConfidence: raw,
                confidenceBand: classifyConfidence(raw),
                suggestedRegionKind: "BBOX_NORMALIZED",
                suggestedRegionGeometry: bbox,
                suggestedMethod: "BLACKOUT",
                previewLabel: maskPreviewText(label),
            });
        }
        return { state: "READY", reason: null, rows };
    }
    catch (err) {
        return providerError("rekognition_detect_text", err);
    }
}
export async function detectLabels(input, client = buildClient()) {
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
        const res = await client.send(new DetectLabelsCommand({ Image: image, MaxLabels: 50 }));
        const sensitive = new Set((input.sensitiveLabelNames ?? [
            "License Plate",
            "Document",
            "Identification Card",
            "Driving License",
            "Passport",
            "Credit Card",
            "Phone",
        ]).map((s) => s.toLowerCase()));
        const rows = [];
        for (const l of res.Labels ?? []) {
            const lname = (l.Name ?? "").trim();
            if (!lname)
                continue;
            // Only flag bounded sensitive labels — generic "Car", "Tree"
            // would pollute the reviewer queue.
            if (!sensitive.has(lname.toLowerCase()))
                continue;
            const c = l.Confidence ?? 0;
            const raw = c / 100;
            // Use the first bounded instance as the suggested region; if
            // no instance bbox is reported, the platform requires manual
            // placement.
            const instance = (l.Instances ?? [])[0];
            const bbox = boundingBoxToBbox(instance?.BoundingBox);
            if (!bbox)
                continue;
            const kind = lname.toLowerCase().includes("license plate")
                ? "LICENSE_PLATE"
                : lname.toLowerCase().includes("credit card")
                    ? "CREDIT_CARD"
                    : "TEXT_BLOCK";
            rows.push({
                kind,
                rawConfidence: raw,
                confidenceBand: classifyConfidence(raw),
                suggestedRegionKind: "BBOX_NORMALIZED",
                suggestedRegionGeometry: bbox,
                suggestedMethod: "BLUR",
                previewLabel: previewLabel(kind, lname),
            });
        }
        return { state: "READY", reason: null, rows };
    }
    catch (err) {
        return providerError("rekognition_detect_labels", err);
    }
}
// ---------------------------------------------------------------------------
// Error mapper
// ---------------------------------------------------------------------------
function providerError(operation, err) {
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
function maskPreviewText(value) {
    if (!value)
        return null;
    const t = value.replace(/\s+/g, " ").trim();
    if (t.length <= 6)
        return t;
    return `${t.slice(0, 2)}***${t.slice(-2)}`.slice(0, 80);
}
// ---------------------------------------------------------------------------
// Test helpers — bounded dependency injection for closure tests.
// ---------------------------------------------------------------------------
export function __setTestClient(client) {
    cachedClient = client;
    cachedRegion = client ? "test-region" : null;
}
