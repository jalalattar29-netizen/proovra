/**
 * Phase 12 — Large-file env limits.
 *
 * Pure helpers: read environment, clamp to safe bounds, hand back
 * canonical configuration. Routes / services call these instead of
 * reading env vars directly so the same values reach the UI and the
 * upload validators.
 */
import { DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES, DEFAULT_MULTIPART_PART_SIZE_BYTES, DEFAULT_MULTIPART_THRESHOLD_BYTES, DEFAULT_UPLOAD_ABANDONED_HOURS, DEFAULT_UPLOAD_STALLED_MINUTES, MULTIPART_PART_SIZE_MAX_BYTES, MULTIPART_PART_SIZE_MIN_BYTES, UPLOAD_ABANDONED_HOURS_MAX, UPLOAD_ABANDONED_HOURS_MIN, UPLOAD_STALLED_MINUTES_MAX, UPLOAD_STALLED_MINUTES_MIN, } from "@proovra/shared";
function readIntEnv(name, fallback, min, max) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n))
        return fallback;
    if (n < min)
        return min;
    if (n > max)
        return max;
    return n;
}
export function getUploadSizeLimits() {
    return {
        maxUploadFileSizeBytes: readIntEnv("MAX_UPLOAD_FILE_SIZE_BYTES", DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES, 
        // floor at 1 MiB so the platform can never end up rejecting
        // every meaningful upload because of a typo.
        1024 * 1024, 
        // ceiling at 5 TiB — S3 maximum single-object size.
        5 * 1024 * 1024 * 1024 * 1024),
        multipartThresholdBytes: readIntEnv("MULTIPART_THRESHOLD_BYTES", DEFAULT_MULTIPART_THRESHOLD_BYTES, MULTIPART_PART_SIZE_MIN_BYTES, 
        // multipart threshold should never exceed the max object size.
        5 * 1024 * 1024 * 1024),
        multipartPartSizeBytes: readIntEnv("MULTIPART_PART_SIZE_BYTES", DEFAULT_MULTIPART_PART_SIZE_BYTES, MULTIPART_PART_SIZE_MIN_BYTES, MULTIPART_PART_SIZE_MAX_BYTES),
    };
}
export function getStaleThresholds() {
    return {
        stalledMinutes: readIntEnv("UPLOAD_STALLED_MINUTES", DEFAULT_UPLOAD_STALLED_MINUTES, UPLOAD_STALLED_MINUTES_MIN, UPLOAD_STALLED_MINUTES_MAX),
        abandonedHours: readIntEnv("UPLOAD_ABANDONED_HOURS", DEFAULT_UPLOAD_ABANDONED_HOURS, UPLOAD_ABANDONED_HOURS_MIN, UPLOAD_ABANDONED_HOURS_MAX),
    };
}
/**
 * Decide whether a claimed upload size is acceptable + whether the
 * client should prefer multipart. We accept BigInt or number; sub-zero
 * inputs are treated as 0 (unknown size at presign time).
 */
export function checkUploadSize(sizeBytes, limits = getUploadSizeLimits()) {
    const n = typeof sizeBytes === "bigint"
        ? Number(sizeBytes)
        : typeof sizeBytes === "number"
            ? sizeBytes
            : 0;
    const size = Number.isFinite(n) && n > 0 ? n : 0;
    if (size > limits.maxUploadFileSizeBytes) {
        return {
            ok: false,
            reason: "file_too_large",
            details: { sizeBytes: size, maxBytes: limits.maxUploadFileSizeBytes },
        };
    }
    return {
        ok: true,
        recommendMultipart: size >= limits.multipartThresholdBytes,
    };
}
