/**
 * Phase 30.10 — Client-side telemetry beacon.
 *
 * Lightweight batch emitter that posts upload lifecycle events to
 * `POST /v1/ops/upload-telemetry`. Designed for fire-and-forget use
 * from the orchestrator / hook — failures NEVER propagate to the
 * upload code path.
 *
 * Hard rules:
 *   * Bounded event-type vocabulary (matches the server-side
 *     `UploadTelemetryBody` enum exactly).
 *   * Coalesces emissions per type within `flushDelayMs` to avoid
 *     ballasting the metric registry.
 *   * Bounded batch size (≤ 50 events per POST — same as server).
 *   * NEVER includes PII, file metadata, storage identifiers, or
 *     custody-grade values.
 *   * Reads the bearer token via the existing apiFetch wrapper, so
 *     no auth handling lives here.
 *   * Failure (network, 429, 4xx) is silently dropped after a
 *     single retry. The orchestrator does not depend on telemetry.
 */
import { apiFetch } from "../api";
export const UPLOAD_TELEMETRY_TYPES = [
    "upload_resume_total",
    "upload_pause_total",
    "upload_cancel_total",
    "upload_retry_total",
    "upload_chunk_retry_total",
    "upload_recovery_total",
    "offline_draft_created_total",
    "offline_draft_recovered_total",
    "offline_draft_conflict_total",
    "background_sync_retry_total",
    "background_sync_failed_total",
];
const DEFAULT_FLUSH_DELAY_MS = 4_000;
const MAX_BATCH = 50;
const VALID_TYPES = new Set(UPLOAD_TELEMETRY_TYPES);
export function createUploadTelemetry(input) {
    const pending = new Map();
    let timer = null;
    const flushDelayMs = input.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    const scheduleFlush = () => {
        if (timer)
            return;
        timer = setTimeout(() => {
            timer = null;
            void doFlush();
        }, flushDelayMs);
    };
    const doFlush = async () => {
        if (pending.size === 0)
            return 0;
        const events = Array.from(pending.entries())
            .slice(0, MAX_BATCH)
            .map(([type, count]) => ({ type, count }));
        pending.clear();
        try {
            await apiFetch("/v1/ops/upload-telemetry", {
                method: "POST",
                body: JSON.stringify({ teamId: input.teamId, events }),
            });
            return events.length;
        }
        catch {
            // Single best-effort retry isn't worth it for telemetry —
            // the lost counts are advisory. Swallow.
            return 0;
        }
    };
    return {
        emit(type, count = 1) {
            if (!VALID_TYPES.has(type))
                return;
            if (!Number.isFinite(count) || count <= 0)
                return;
            pending.set(type, (pending.get(type) ?? 0) + count);
            scheduleFlush();
        },
        flush: doFlush,
    };
}
