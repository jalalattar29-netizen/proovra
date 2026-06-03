/**
 * Phase 11 — Server-side file validation.
 *
 * Wraps the shared `classifyFileValidation` + archive-limit helpers
 * with the env-driven configuration the API actually uses. Returns
 * an "outcome" the upload routes can act on:
 *
 *   - allow           — no findings worth surfacing
 *   - warn            — flag for review; upload may proceed
 *   - block           — refuse the upload
 *
 * NEVER blocks an upload purely on a sniff mismatch (those are "warn").
 * Blocks are reserved for clearly dangerous content: executables,
 * double-extensions, archive limits exceeded.
 *
 * Emits `SecurityEvent` rows so the /security UI surfaces findings.
 */
import { DEFAULT_MAX_ARCHIVE_COMPRESSION_RATIO, DEFAULT_MAX_ARCHIVE_ENTRY_COUNT, DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES, classifyFileValidation, } from "@proovra/shared";
import { safeEmitSecurityEvent } from "./security-event.service.js";
const ENV_MAX_UNCOMPRESSED = "MAX_ARCHIVE_UNCOMPRESSED_BYTES";
const ENV_MAX_ENTRIES = "MAX_ARCHIVE_ENTRY_COUNT";
const ENV_MAX_RATIO = "MAX_ARCHIVE_COMPRESSION_RATIO";
function readIntEnv(name, fallback, min) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min)
        return fallback;
    return n;
}
export function getArchiveLimits() {
    return {
        maxUncompressedBytes: readIntEnv(ENV_MAX_UNCOMPRESSED, DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES, 1024 * 1024),
        maxEntries: readIntEnv(ENV_MAX_ENTRIES, DEFAULT_MAX_ARCHIVE_ENTRY_COUNT, 1),
        maxCompressionRatio: readIntEnv(ENV_MAX_RATIO, DEFAULT_MAX_ARCHIVE_COMPRESSION_RATIO, 2),
    };
}
/**
 * Validate a single file against the shared classification rules.
 * Side-effect: emit a SecurityEvent when the outcome is "warn" or
 * "block" so the operations UI surfaces it.
 */
export function validateUploadedFile(ctx) {
    const findings = classifyFileValidation({
        claimedMime: ctx.claimedMime,
        fileName: ctx.fileName,
        head: ctx.head,
    });
    let outcome = "allow";
    if (findings.mismatch === "block")
        outcome = "block";
    else if (findings.mismatch === "warn")
        outcome = "warn";
    // Audit any non-allow outcome. INTERNAL-ONLY event; never surfaced
    // on public verify.
    if (outcome !== "allow") {
        const detail = {
            reason: findings.reason,
            claimedMime: findings.claimedMime,
            sniffedMime: findings.sniffedMime,
            sniffedLabel: findings.sniffedLabel,
            doubleExtension: findings.doubleExtension,
            dangerousExtension: findings.dangerousExtension,
            executable: findings.executable,
            fileNameLength: ctx.fileName?.length ?? 0,
            source: ctx.source ?? "authenticated",
        };
        if (findings.reason === "executable_or_dangerous_type") {
            safeEmitSecurityEvent({
                teamId: ctx.teamId ?? null,
                eventType: "executable_upload_blocked",
                severity: "HIGH",
                evidenceId: ctx.evidenceId ?? null,
                details: detail,
            });
        }
        else if (findings.reason === "double_extension") {
            safeEmitSecurityEvent({
                teamId: ctx.teamId ?? null,
                eventType: "double_extension_detected",
                severity: "HIGH",
                evidenceId: ctx.evidenceId ?? null,
                details: detail,
            });
        }
        else if (findings.reason === "mime_content_mismatch") {
            safeEmitSecurityEvent({
                teamId: ctx.teamId ?? null,
                eventType: "mime_mismatch",
                severity: "WARNING",
                evidenceId: ctx.evidenceId ?? null,
                details: detail,
            });
        }
    }
    return { outcome, findings };
}
export function checkArchiveAgainstLimits(advisory, limits = getArchiveLimits()) {
    if (advisory.entryCount > limits.maxEntries) {
        return {
            ok: false,
            reason: "too_many_entries",
            details: {
                entryCount: advisory.entryCount,
                max: limits.maxEntries,
            },
        };
    }
    if (advisory.uncompressedBytes > limits.maxUncompressedBytes) {
        return {
            ok: false,
            reason: "uncompressed_size_exceeded",
            details: {
                uncompressedBytes: advisory.uncompressedBytes,
                max: limits.maxUncompressedBytes,
            },
        };
    }
    if (advisory.compressedBytes > 0) {
        const ratio = Math.round(advisory.uncompressedBytes / Math.max(1, advisory.compressedBytes));
        if (ratio > limits.maxCompressionRatio) {
            return {
                ok: false,
                reason: "compression_ratio_exceeded",
                details: {
                    ratio,
                    max: limits.maxCompressionRatio,
                },
            };
        }
    }
    return { ok: true };
}
/**
 * Convenience wrapper that performs the limit check AND records a
 * SecurityEvent on failure. Safe to call from hot paths.
 */
export function evaluateArchiveAdvisory(input) {
    const outcome = checkArchiveAgainstLimits(input.advisory);
    if (!outcome.ok) {
        safeEmitSecurityEvent({
            teamId: input.teamId ?? null,
            eventType: outcome.reason === "compression_ratio_exceeded"
                ? "suspicious_archive"
                : "archive_limit_exceeded",
            severity: outcome.reason === "compression_ratio_exceeded" ? "HIGH" : "WARNING",
            evidenceId: input.evidenceId ?? null,
            details: { reason: outcome.reason, ...outcome.details },
        });
    }
    return outcome;
}
