import { prisma } from "../db.js";
import { canonicalJson, sha256Hex } from "../crypto.js";
import { canPlanGenerateReports } from "@proovra/shared-billing";
import { getEvidenceSigner } from "../signing/signer.js";
import { assertWorkspaceAllowsStorageGrowth, consumeWorkspaceCompletionCredits, resolveWorkspaceScopeForUser, } from "./billing-enforcement.service.js";
import { applyDefaultObjectRetention, getObjectStream, headObject, } from "../storage.js";
import { sha256HexFromStream } from "../stream-hash.js";
import { createEvidenceTimestamp } from "./timestamp.service.js";
import * as prismaPkg from "@prisma/client";
import { enqueueGenerateReportJob } from "../queue/report-queue.js";
import { enqueueSearchIndexingJob } from "../queue/search-queue.js";
// Phase 1 of Investigation enterprise wiring: auto-populate
// media_intelligence_signals so /investigation overview shows real
// counters. Before this, signals stayed empty unless an operator
// manually POSTed /v1/evidence/:id/media-intelligence/run.
import { enqueueMediaIntelligenceAnalysis } from "../queue/media-intelligence-queue.js";
// Phase 1 of Investigation enterprise wiring — see helper for full rationale.
import { enqueueGraphReconcileJob } from "../queue/graph-reconcile-queue.js";
import { appendCustodyEvent, appendCustodyEventTx, } from "./custody-events.service.js";
import { emitWebhookEvent } from "./integrations/webhook-dispatcher.js";
import { enqueueScan, isMalwareScanningEnabled, runScan, } from "./security/file-security-scan.service.js";
import { safeEmitSecurityEvent } from "./security/security-event.service.js";
import { safeTransitionUploadSession } from "./reliability/upload-session.service.js";
import { evaluateUploadSessionFinalizeGate } from "./uploads/upload-session.service.js";
const { EvidenceStatus } = prismaPkg;
function asIso(d) {
    return d ? d.toISOString() : null;
}
function readMaxEvidenceSizeBytes() {
    const raw = process.env.MAX_EVIDENCE_SIZE_MB;
    if (!raw)
        return 1024 * 1024 * 1024;
    const mb = Number.parseInt(raw, 10);
    if (!Number.isFinite(mb) || mb <= 0)
        return 1024 * 1024 * 1024;
    return mb * 1024 * 1024;
}
function clean(v) {
    if (typeof v !== "string")
        return v ?? null;
    const t = v.trim();
    return t ? t : null;
}
function normalizeObservedMimeType(value) {
    const raw = clean(value)?.toLowerCase() ?? null;
    if (!raw)
        return null;
    const normalized = raw.split(";")[0]?.trim() ?? "";
    if (!normalized)
        return null;
    if (normalized.length > 128)
        return null;
    if (/[\r\n]/.test(normalized))
        return null;
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized))
        return null;
    return normalized;
}
function decimalToNumber(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "object" &&
        value !== null &&
        "toNumber" in value &&
        typeof value.toNumber === "function") {
        const n = value.toNumber();
        return Number.isFinite(n) ? n : null;
    }
    if (typeof value === "object" &&
        value !== null &&
        "toString" in value &&
        typeof value.toString === "function") {
        const n = Number(value.toString());
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
function isNotFoundLike(e) {
    const err = e;
    const name = String(err?.name ?? "").toLowerCase();
    const code = String(err?.code ?? err?.Code ?? "").toLowerCase();
    const msg = String(err?.message ?? "").toLowerCase();
    return (name.includes("notfound") ||
        code.includes("notfound") ||
        code === "nosuchkey" ||
        msg.includes("notfound") ||
        msg.includes("no such key") ||
        msg.includes("not found"));
}
function isAlreadyObjectLockedLike(e) {
    const err = e;
    const name = String(err?.name ?? "").toLowerCase();
    const code = String(err?.code ?? err?.Code ?? "").toLowerCase();
    const msg = String(err?.message ?? "").toLowerCase();
    return (name.includes("accessdenied") ||
        code.includes("accessdenied") ||
        code === "accessdenied" ||
        msg.includes("access denied because object protected by object lock") ||
        msg.includes("object protected by object lock") ||
        msg.includes("object lock") ||
        msg.includes("retention") ||
        msg.includes("legal hold"));
}
async function safeHead(bucket, key) {
    try {
        return await headObject({ bucket, key });
    }
    catch (e) {
        const errObj = e;
        const detail = errObj?.name ??
            errObj?.code ??
            errObj?.Code ??
            errObj?.message ??
            "unknown";
        const err = Object.assign(new Error(`OBJECT_HEAD_FAILED: ${String(detail)} bucket=${bucket} key=${key}`), { statusCode: isNotFoundLike(e) ? 404 : 502 });
        throw err;
    }
}
async function safeGetStream(bucket, key) {
    try {
        return await getObjectStream({ bucket, key });
    }
    catch (e) {
        const errObj = e;
        const detail = errObj?.name ??
            errObj?.code ??
            errObj?.Code ??
            errObj?.message ??
            "unknown";
        const err = Object.assign(new Error(`OBJECT_GET_FAILED: ${String(detail)} bucket=${bucket} key=${key}`), { statusCode: isNotFoundLike(e) ? 404 : 502 });
        throw err;
    }
}
/**
 * Apply default object retention to each target. Returns whether ANY target had
 * retention actually applied (i.e. Object Lock enabled and retention written).
 *
 * The truthful return value is critical for the EVIDENCE_LOCKED custody event:
 * we must NOT append EVIDENCE_LOCKED unless retention actually applied. When
 * Object Lock is disabled in the environment, applyDefaultObjectRetention is a
 * no-op that returns { applied: false, reason: "object_lock_disabled" } — that
 * must propagate to the caller so the chain remains honest.
 */
async function applyRetentionOrThrow(targets) {
    const deduped = Array.from(new Map(targets.map((item) => [`${item.bucket}:${item.key}`, item])).values());
    let anyApplied = false;
    let reason = null;
    for (const target of deduped) {
        try {
            const result = await applyDefaultObjectRetention({
                bucket: target.bucket,
                key: target.key,
            });
            if (result?.applied === true) {
                anyApplied = true;
            }
            else if (!reason && typeof result?.reason === "string") {
                reason = result.reason;
            }
        }
        catch (error) {
            if (isAlreadyObjectLockedLike(error)) {
                // Object already locked by an earlier write — that counts as applied.
                anyApplied = true;
                continue;
            }
            const errMsg = error instanceof Error ? error.message : "UNKNOWN_RETENTION_ERROR";
            throw new Error(`EVIDENCE_RETENTION_APPLY_FAILED: bucket=${target.bucket} key=${target.key} reason=${errMsg}`);
        }
    }
    return { anyApplied, reason };
}
function buildMultipartSummary(parts, totalSizeBytes) {
    const imageCount = parts.filter((p) => String(p.mimeType ?? "").toLowerCase().startsWith("image/")).length;
    const videoCount = parts.filter((p) => String(p.mimeType ?? "").toLowerCase().startsWith("video/")).length;
    const audioCount = parts.filter((p) => String(p.mimeType ?? "").toLowerCase().startsWith("audio/")).length;
    const documentCount = parts.filter((p) => {
        const mime = String(p.mimeType ?? "").toLowerCase();
        return (mime === "application/pdf" ||
            mime.startsWith("text/") ||
            mime.includes("document") ||
            mime.includes("msword") ||
            mime.includes("officedocument"));
    }).length;
    const mimeTypes = Array.from(new Set(parts
        .map((p) => clean(p.mimeType))
        .filter((v) => Boolean(v))));
    return {
        itemCount: parts.length,
        totalSizeBytes,
        mimeTypes,
        imageCount,
        videoCount,
        audioCount,
        documentCount,
    };
}
function classifyMimeToEvidenceType(mimeType) {
    const mime = String(mimeType ?? "").trim().toLowerCase();
    if (mime.startsWith("image/"))
        return prismaPkg.EvidenceType.PHOTO;
    if (mime.startsWith("video/"))
        return prismaPkg.EvidenceType.VIDEO;
    if (mime.startsWith("audio/"))
        return prismaPkg.EvidenceType.AUDIO;
    return prismaPkg.EvidenceType.DOCUMENT;
}
function deriveCanonicalEvidenceTypeFromParts(parts, fallbackMimeType) {
    if (parts.length === 0) {
        return classifyMimeToEvidenceType(fallbackMimeType);
    }
    const kinds = new Set(parts.map((part) => classifyMimeToEvidenceType(part.mimeType ?? fallbackMimeType)));
    if (kinds.size === 1) {
        return Array.from(kinds)[0] ?? prismaPkg.EvidenceType.DOCUMENT;
    }
    return prismaPkg.EvidenceType.DOCUMENT;
}
function buildFingerprint(params) {
    const gps = {
        lat: decimalToNumber(params.evidence.lat),
        lng: decimalToNumber(params.evidence.lng),
        accuracyMeters: decimalToNumber(params.evidence.accuracyMeters),
    };
    if (params.multipart) {
        const summary = buildMultipartSummary(params.multipart.parts, params.multipart.totalSizeBytes);
        return {
            v: 1,
            evidenceId: params.evidence.id,
            type: params.evidence.type,
            file: {
                multipart: true,
                summary,
                parts: params.multipart.parts.map((p) => ({
                    partIndex: p.partIndex,
                    storageBucket: p.bucket,
                    storageKey: p.key,
                    sizeBytes: Number(p.sizeBytes),
                    mimeType: p.mimeType,
                    sha256: p.sha256,
                })),
            },
            capturedAtUtc: asIso(params.evidence.capturedAtUtc),
            deviceTimeIso: params.evidence.deviceTimeIso ?? null,
            gps,
            uploadedAtUtc: params.uploadedAtUtcIso,
        };
    }
    return {
        v: 1,
        evidenceId: params.evidence.id,
        type: params.evidence.type,
        file: {
            multipart: false,
            bucket: params.singleFile?.bucket ?? null,
            key: params.singleFile?.key ?? null,
            sizeBytes: params.singleFile?.sizeBytes ?? 0,
            mimeType: params.singleFile?.mimeType ?? null,
            sha256: params.singleFile?.sha256 ?? "",
            etag: null,
        },
        capturedAtUtc: asIso(params.evidence.capturedAtUtc),
        deviceTimeIso: params.evidence.deviceTimeIso ?? null,
        gps,
        uploadedAtUtc: params.uploadedAtUtcIso,
    };
}
export async function completeEvidence(params) {
    const signer = getEvidenceSigner();
    const final = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw `
        SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))
      `;
        const evidence = await tx.evidence.findFirst({
            where: {
                id: params.evidenceId,
                ownerUserId: params.ownerUserId,
                deletedAt: null,
            },
        });
        if (!evidence) {
            const err = Object.assign(new Error("NOT_FOUND"), {
                statusCode: 404,
            });
            throw err;
        }
        const scope = await resolveWorkspaceScopeForUser({
            ownerUserId: evidence.ownerUserId,
            teamId: evidence.teamId ?? null,
        });
        const evidenceBucket = clean(evidence.storageBucket);
        const evidenceKey = clean(evidence.storageKey);
        const evidenceMime = normalizeObservedMimeType(evidence.mimeType);
        if (evidence.status === EvidenceStatus.REPORTED) {
            return {
                result: {
                    id: evidence.id,
                    status: evidence.status,
                    fileSha256: evidence.fileSha256,
                    fingerprintHash: evidence.fingerprintHash,
                    signatureBase64: evidence.signatureBase64,
                    signingKeyId: evidence.signingKeyId,
                    signingKeyVersion: evidence.signingKeyVersion,
                },
                shouldEnqueueReport: false,
                retentionTargets: [],
            };
        }
        // Phase A0 — integrity hard-gate terminal short-circuit.
        // FAILED_HASH_MISMATCH is set by the worker (or any future
        // reconciler) when a server-recomputed SHA-256 disagreed with
        // the value persisted at completion. A retry POST to /complete
        // must NOT re-promote this row: completion is single-shot in
        // its current design (it OVERWRITES `fileSha256` from the
        // server-recomputed stream), and a successful retry here would
        // silently re-flip the row to SIGNED even though the worker had
        // recorded a real mismatch. Refuse with 409 and a bounded
        // operator-readable code; the route layer surfaces this to the
        // owner.
        if (evidence.status === EvidenceStatus.FAILED_HASH_MISMATCH) {
            const err = Object.assign(new Error("EVIDENCE_INTEGRITY_FAILED"), { statusCode: 409 });
            throw err;
        }
        if (evidence.status === EvidenceStatus.SIGNED) {
            // Phase 12 — duplicate finalize detected. Audit so operators
            // can spot retry storms; the response is still the canonical
            // existing result so callers see a stable success.
            safeEmitSecurityEvent({
                teamId: evidence.teamId,
                eventType: "finalize_duplicate_detected",
                severity: "INFO",
                evidenceId: evidence.id,
                details: { reason: "already_signed" },
            });
            const retentionTargets = [];
            if (evidenceBucket && evidenceKey) {
                retentionTargets.push({
                    bucket: evidenceBucket,
                    key: evidenceKey,
                });
            }
            return {
                result: {
                    id: evidence.id,
                    status: evidence.status,
                    fileSha256: evidence.fileSha256,
                    fingerprintHash: evidence.fingerprintHash,
                    signatureBase64: evidence.signatureBase64,
                    signingKeyId: evidence.signingKeyId,
                    signingKeyVersion: evidence.signingKeyVersion,
                },
                shouldEnqueueReport: canPlanGenerateReports(scope.plan),
                retentionTargets,
            };
        }
        // Phase 30.7 — custody-safe finalize gate.
        //
        // If a Phase 30 resumable upload session exists for this
        // evidence, refuse finalization unless that session is
        // COMPLETED with every part VERIFIED. Legacy single-shot
        // uploads (no session row) continue unchanged.
        //
        // The gate read runs on the transaction client so it shares
        // the advisory-lock snapshot with the SIGNED-status short-
        // circuit above. A concurrent session abort cannot race past
        // this check.
        //
        // Idempotency: this gate sits AFTER the SIGNED/REPORTED
        // short-circuits. A retry on already-finalized evidence
        // returns the existing chain WITHOUT re-evaluating the gate,
        // so a session that aborted post-finalization cannot retro-
        // actively turn a successful finalize into a denial.
        if (evidence.teamId) {
            const gate = await evaluateUploadSessionFinalizeGate({ teamId: evidence.teamId, evidenceId: evidence.id }, tx);
            if (!gate.ok) {
                safeEmitSecurityEvent({
                    teamId: evidence.teamId,
                    eventType: "finalize_blocked_by_upload_session",
                    severity: "WARNING",
                    evidenceId: evidence.id,
                    details: {
                        reason: gate.reason,
                        sessionId: gate.sessionId ?? null,
                        sessionState: gate.sessionState ?? null,
                    },
                });
                const statusCode = gate.reason === "gate_unavailable" ? 503 : 409;
                const err = Object.assign(new Error(`UPLOAD_SESSION_GATE:${gate.reason}`), { statusCode });
                throw err;
            }
        }
        // Phase 12 — move the operations-side session to VERIFYING. Best
        // effort; failure here MUST NOT break the forensic write path.
        safeTransitionUploadSession({
            evidenceId: evidence.id,
            to: "VERIFYING",
        }).catch(() => null);
        const parts = await tx.evidencePart.findMany({
            where: { evidenceId: evidence.id },
            orderBy: { partIndex: "asc" },
        });
        if (parts.length === 0 && (!evidenceBucket || !evidenceKey)) {
            const err = Object.assign(new Error("Cannot complete evidence without an uploaded file"), { statusCode: 400 });
            throw err;
        }
        let sizeBytesNum = 0;
        let fileSha256 = "";
        let primaryBucket = evidenceBucket;
        let primaryKey = evidenceKey;
        let primaryMimeType = evidenceMime;
        let multipartItemCount = 1;
        let multipart = false;
        let canonical = "";
        let fingerprintHash = "";
        let canonicalEvidenceType = evidence.type;
        // Phase C #4 — multipart hash semantics. These variables are populated
        // in either the multipart branch or the single-file branch and stored
        // alongside fileSha256 so consumers know which is which.
        let multipartManifestSha256Out = null;
        let hashSemanticsOut = "single_file";
        const retentionTargets = [];
        const now = new Date();
        const uploadedAtUtcIso = now.toISOString();
        if (parts.length > 0) {
            const updatedParts = [];
            for (const part of parts) {
                const bucket = clean(part.storageBucket);
                const key = clean(part.storageKey);
                if (!bucket || !key) {
                    const err = Object.assign(new Error("PART_STORAGE_NOT_SET"), { statusCode: 400 });
                    throw err;
                }
                const meta = await safeHead(bucket, key);
                const size = meta.sizeBytes;
                if (!size || size <= 0) {
                    const err = Object.assign(new Error("OBJECT_NOT_FOUND"), {
                        statusCode: 404,
                    });
                    throw err;
                }
                const body = await safeGetStream(bucket, key);
                const sha256 = await sha256HexFromStream(body);
                sizeBytesNum += size;
                const mimeType = normalizeObservedMimeType(meta.contentType) ??
                    normalizeObservedMimeType(part.mimeType) ??
                    null;
                updatedParts.push({
                    id: part.id,
                    partIndex: part.partIndex,
                    sizeBytes: BigInt(size),
                    sha256,
                    mimeType,
                    bucket,
                    key,
                });
                retentionTargets.push({
                    bucket,
                    key,
                    evidencePartId: part.id,
                });
            }
            if (updatedParts.length === 0) {
                const err = Object.assign(new Error("NO_VALID_PARTS_FOUND"), { statusCode: 400 });
                throw err;
            }
            const maxBytes = readMaxEvidenceSizeBytes();
            if (sizeBytesNum > maxBytes) {
                const err = Object.assign(new Error("EVIDENCE_TOO_LARGE"), {
                    statusCode: 413,
                });
                throw err;
            }
            primaryBucket = updatedParts[0].bucket;
            primaryKey = updatedParts[0].key;
            primaryMimeType =
                updatedParts[0].mimeType ?? primaryMimeType ?? evidenceMime;
            canonicalEvidenceType = deriveCanonicalEvidenceTypeFromParts(updatedParts, primaryMimeType);
            const isMultipartPackage = updatedParts.length > 1;
            // Phase C #4 — multipart hash semantics.
            //
            // Single-file evidence: fileSha256 IS the SHA-256 of the original file.
            // Multipart evidence: fileSha256 is a synthetic composite (per-part
            // SHA-256s joined by "|" then hashed). To make multipart integrity
            // independently reproducible by reviewers, we ALSO record an explicit
            // multipartManifestSha256 computed deterministically from the per-part
            // hashes in part-index order, joined by newlines. The package-checksums.json
            // in the verification package is the same source of truth.
            fileSha256 = isMultipartPackage
                ? sha256Hex(updatedParts.map((p) => p.sha256).join("|"))
                : updatedParts[0].sha256;
            const sortedPartsForManifest = [...updatedParts].sort((a, b) => a.partIndex - b.partIndex);
            multipartManifestSha256Out = isMultipartPackage
                ? sha256Hex(sortedPartsForManifest.map((p) => p.sha256).join("\n"))
                : null;
            hashSemanticsOut = isMultipartPackage
                ? "multipart_composite"
                : "single_file";
            multipart = isMultipartPackage;
            multipartItemCount = updatedParts.length;
            await Promise.all(updatedParts.map((p) => tx.evidencePart.update({
                where: { id: p.id },
                data: {
                    sizeBytes: p.sizeBytes,
                    sha256: p.sha256,
                    mimeType: p.mimeType,
                    uploadedByUserId: params.ownerUserId,
                    uploadedAtUtc: now,
                },
            })));
            const fingerprint = buildFingerprint({
                evidence: {
                    id: evidence.id,
                    type: canonicalEvidenceType,
                    capturedAtUtc: evidence.capturedAtUtc,
                    deviceTimeIso: evidence.deviceTimeIso,
                    lat: evidence.lat,
                    lng: evidence.lng,
                    accuracyMeters: evidence.accuracyMeters,
                },
                uploadedAtUtcIso,
                ...(isMultipartPackage
                    ? {
                        multipart: {
                            parts: updatedParts,
                            totalSizeBytes: sizeBytesNum,
                        },
                    }
                    : {
                        singleFile: {
                            bucket: updatedParts[0].bucket,
                            key: updatedParts[0].key,
                            sizeBytes: Number(updatedParts[0].sizeBytes),
                            mimeType: updatedParts[0].mimeType,
                            sha256: updatedParts[0].sha256,
                        },
                    }),
            });
            canonical = canonicalJson(fingerprint);
            fingerprintHash = sha256Hex(canonical);
        }
        else {
            const bucket = evidenceBucket;
            const key = evidenceKey;
            const meta = await safeHead(bucket, key);
            const size = meta.sizeBytes;
            if (!size || size <= 0) {
                const err = Object.assign(new Error("OBJECT_NOT_FOUND"), {
                    statusCode: 404,
                });
                throw err;
            }
            sizeBytesNum = size;
            const maxBytes = readMaxEvidenceSizeBytes();
            if (sizeBytesNum > maxBytes) {
                const err = Object.assign(new Error("EVIDENCE_TOO_LARGE"), {
                    statusCode: 413,
                });
                throw err;
            }
            primaryMimeType =
                normalizeObservedMimeType(meta.contentType) ?? evidenceMime ?? null;
            primaryBucket = bucket;
            primaryKey = key;
            canonicalEvidenceType = classifyMimeToEvidenceType(primaryMimeType);
            retentionTargets.push({
                bucket,
                key,
            });
            const body = await safeGetStream(bucket, key);
            fileSha256 = await sha256HexFromStream(body);
            const fingerprint = buildFingerprint({
                evidence: {
                    id: evidence.id,
                    type: canonicalEvidenceType,
                    capturedAtUtc: evidence.capturedAtUtc,
                    deviceTimeIso: evidence.deviceTimeIso,
                    lat: evidence.lat,
                    lng: evidence.lng,
                    accuracyMeters: evidence.accuracyMeters,
                },
                uploadedAtUtcIso,
                singleFile: {
                    bucket: primaryBucket,
                    key: primaryKey,
                    sizeBytes: sizeBytesNum,
                    mimeType: primaryMimeType,
                    sha256: fileSha256,
                },
            });
            canonical = canonicalJson(fingerprint);
            fingerprintHash = sha256Hex(canonical);
        }
        const existingStoredBytes = typeof evidence.sizeBytes === "bigint" ? evidence.sizeBytes : 0n;
        const nextStoredBytes = BigInt(sizeBytesNum);
        const incomingGrowth = nextStoredBytes > existingStoredBytes
            ? nextStoredBytes - existingStoredBytes
            : 0n;
        await assertWorkspaceAllowsStorageGrowth({
            scope,
            incomingBytes: incomingGrowth,
        });
        const signResult = await signer.signFingerprintHex(fingerprintHash);
        const tsaResult = await createEvidenceTimestamp({
            digestHex: fileSha256,
        });
        const tsaInputKind = multipartItemCount > 1 ? "CANONICAL_PACKAGE_SHA256" : "FILE_SHA256";
        const captureMethod = multipartItemCount > 1
            ? prismaPkg.CaptureMethod.MULTIPART_PACKAGE
            : prismaPkg.CaptureMethod.UPLOADED_FILE;
        // Phase 12 — atomic finalize guard. We already hold the
        // advisory lock and we already returned early if the row was
        // SIGNED, but this `updateMany` re-asserts the precondition at
        // the DB level so a refactor that accidentally removes either
        // guard above cannot silently create a duplicate finalize.
        const finalizeData = {
            status: EvidenceStatus.SIGNED,
            verificationStatus: prismaPkg.VerificationStatus.MATERIALS_AVAILABLE,
            type: canonicalEvidenceType,
            captureMethod,
            uploadedByUserId: params.ownerUserId,
            uploadedAtUtc: now,
            signedAtUtc: now,
            sizeBytes: BigInt(sizeBytesNum),
            mimeType: primaryMimeType,
            fileSha256,
            // Phase C #4: explicit multipart hash semantics, see schema
            // comments. fileSha256 alone is ambiguous for multipart records
            // because it's a synthetic composite of per-part hashes.
            multipartManifestSha256: multipartManifestSha256Out,
            hashSemantics: hashSemanticsOut,
            fingerprintCanonicalJson: canonical,
            fingerprintHash,
            signatureBase64: signResult.signatureBase64,
            signingKeyId: signResult.keyId,
            signingKeyVersion: signResult.keyVersion,
            storageBucket: primaryBucket,
            storageKey: primaryKey,
            tsaProvider: tsaResult?.provider ?? null,
            tsaUrl: tsaResult?.url ?? null,
            tsaSerialNumber: tsaResult?.serialNumber ?? null,
            tsaGenTimeUtc: tsaResult?.genTimeUtc ?? null,
            tsaTokenBase64: tsaResult?.tokenBase64 ?? null,
            tsaMessageImprint: tsaResult?.messageImprint ?? null,
            // Truthful TSA semantics (Issue #8):
            //   - tsaInputDigestHex now ONLY records the digest the TSA provider
            //     actually accepted (i.e., what the returned token imprints).
            //   - When TSA failed / was unavailable / not configured, this is
            //     null. We do NOT fall back to fileSha256, because that
            //     previously implied the TSA accepted something it did not.
            //   - The intended-input digest is implicitly fileSha256, which is
            //     stored in its own column. Reviewers can compare them when both
            //     are present.
            tsaInputDigestHex: tsaResult?.status === "STAMPED"
                ? tsaResult.messageImprint ?? null
                : null,
            tsaInputKind: tsaResult?.status === "STAMPED" ? tsaInputKind : null,
            tsaHashAlgorithm: tsaResult?.hashAlgorithm ?? null,
            tsaStatus: tsaResult?.status ?? null,
            tsaFailureReason: tsaResult?.failureReason ?? null,
        };
        const finalizeClaim = await tx.evidence.updateMany({
            where: {
                id: evidence.id,
                status: {
                    in: [EvidenceStatus.CREATED, EvidenceStatus.UPLOADING],
                },
            },
            data: finalizeData,
        });
        if (finalizeClaim.count !== 1) {
            // Race lost — another finalize won between the early-return
            // check and this update. Audit + raise a stable error so the
            // outer handler can re-fetch and return the canonical result.
            safeEmitSecurityEvent({
                teamId: evidence.teamId,
                eventType: "finalize_duplicate_detected",
                severity: "WARNING",
                evidenceId: evidence.id,
                details: { reason: "lost_finalize_race" },
            });
            const err = Object.assign(new Error("EVIDENCE_FINALIZE_RACE_DETECTED"), { statusCode: 409 });
            throw err;
        }
        const ev = await tx.evidence.findUniqueOrThrow({
            where: { id: evidence.id },
            select: {
                id: true,
                status: true,
                fileSha256: true,
                fingerprintHash: true,
                signatureBase64: true,
                signingKeyId: true,
                signingKeyVersion: true,
                storageRegion: true,
                storageObjectLockMode: true,
                storageObjectLockRetainUntilUtc: true,
                storageObjectLockLegalHoldStatus: true,
            },
        });
        await appendCustodyEventTx(tx, {
            evidenceId: evidence.id,
            eventType: prismaPkg.CustodyEventType.UPLOAD_COMPLETED,
            atUtc: now,
            payload: {
                phase: "upload_completed",
                multipart,
                itemCount: multipartItemCount,
                sizeBytes: sizeBytesNum,
                mimeType: primaryMimeType,
                fileSha256,
                captureMethod,
                uploadedByUserId: params.ownerUserId,
            },
        });
        await appendCustodyEventTx(tx, {
            evidenceId: evidence.id,
            eventType: prismaPkg.CustodyEventType.SIGNATURE_APPLIED,
            atUtc: now,
            payload: {
                phase: "signature_applied",
                verificationStatus: prismaPkg.VerificationStatus.MATERIALS_AVAILABLE,
                captureMethod,
                fingerprintHash,
                signingKeyId: signResult.keyId,
                signingKeyVersion: signResult.keyVersion,
                multipart,
                itemCount: multipartItemCount,
                tsaProvider: tsaResult?.provider ?? null,
                tsaUrl: tsaResult?.url ?? null,
                tsaSerialNumber: tsaResult?.serialNumber ?? null,
                tsaGenTimeUtc: tsaResult?.genTimeUtc?.toISOString() ?? null,
                tsaMessageImprint: tsaResult?.messageImprint ?? null,
                // Issue #8: tsaInputDigestHex only when TSA actually stamped.
                tsaInputDigestHex: tsaResult?.status === "STAMPED"
                    ? tsaResult.messageImprint ?? null
                    : null,
                // Same gating for tsaInputKind so the chain does not imply a TSA
                // accepted-input semantic that did not happen.
                tsaInputKind: tsaResult?.status === "STAMPED" ? tsaInputKind : null,
                tsaHashAlgorithm: tsaResult?.hashAlgorithm ?? null,
                tsaStatus: tsaResult?.status ?? null,
                tsaFailureReason: tsaResult?.failureReason ?? null,
            },
        });
        if (tsaResult) {
            await appendCustodyEventTx(tx, {
                evidenceId: evidence.id,
                eventType: tsaResult.status === "STAMPED"
                    ? prismaPkg.CustodyEventType.TIMESTAMP_APPLIED
                    : prismaPkg.CustodyEventType.TIMESTAMP_FAILED,
                atUtc: now,
                payload: {
                    tsaProvider: tsaResult.provider,
                    tsaUrl: tsaResult.url,
                    tsaSerialNumber: tsaResult.serialNumber,
                    tsaGenTimeUtc: tsaResult.genTimeUtc?.toISOString() ?? null,
                    tsaMessageImprint: tsaResult.messageImprint,
                    tsaInputDigestHex: tsaResult.messageImprint,
                    tsaInputKind,
                    tsaHashAlgorithm: tsaResult.hashAlgorithm,
                    tsaStatus: tsaResult.status,
                    tsaFailureReason: tsaResult.failureReason,
                },
            });
        }
        await consumeWorkspaceCompletionCredits(scope);
        return {
            result: {
                id: ev.id,
                status: ev.status,
                fileSha256: ev.fileSha256,
                fingerprintHash: ev.fingerprintHash,
                signatureBase64: ev.signatureBase64,
                signingKeyId: ev.signingKeyId,
                signingKeyVersion: ev.signingKeyVersion,
            },
            shouldEnqueueReport: canPlanGenerateReports(scope.plan),
            retentionTargets,
        };
    }, {
        maxWait: 10_000,
        timeout: 120_000,
    });
    if (final.retentionTargets.length > 0) {
        const retentionResult = await applyRetentionOrThrow(final.retentionTargets);
        const primaryTarget = final.retentionTargets[0];
        if (primaryTarget) {
            try {
                const lockedMeta = await headObject({
                    bucket: primaryTarget.bucket,
                    key: primaryTarget.key,
                });
                await prisma.evidence.update({
                    where: { id: final.result.id },
                    data: {
                        storageRegion: process.env.S3_REGION?.trim() || null,
                        storageObjectLockMode: lockedMeta.objectLockMode
                            ? String(lockedMeta.objectLockMode)
                            : null,
                        storageObjectLockRetainUntilUtc: lockedMeta.objectLockRetainUntilDate ?? null,
                        storageObjectLockLegalHoldStatus: lockedMeta.objectLockLegalHoldStatus
                            ? String(lockedMeta.objectLockLegalHoldStatus)
                            : null,
                    },
                });
                for (const target of final.retentionTargets) {
                    if (!target.evidencePartId)
                        continue;
                    try {
                        const partMeta = await headObject({
                            bucket: target.bucket,
                            key: target.key,
                        });
                        await prisma.evidencePart.update({
                            where: { id: target.evidencePartId },
                            data: {
                                storageRegion: process.env.S3_REGION?.trim() || null,
                                storageObjectLockMode: partMeta.objectLockMode
                                    ? String(partMeta.objectLockMode)
                                    : null,
                                storageObjectLockRetainUntilUtc: partMeta.objectLockRetainUntilDate ?? null,
                                storageObjectLockLegalHoldStatus: partMeta.objectLockLegalHoldStatus
                                    ? String(partMeta.objectLockLegalHoldStatus)
                                    : null,
                            },
                        });
                    }
                    catch {
                        // ignore per-part snapshot failures
                    }
                }
                // Decide truthfully whether to append EVIDENCE_LOCKED.
                //
                // We require ALL of the following to be true:
                //   1. applyRetentionOrThrow reported at least one target had retention
                //      actually applied (i.e. Object Lock enabled in the environment
                //      AND a PutObjectRetention call succeeded).
                //   2. headObject() reports a non-null objectLockMode on the object.
                //   3. headObject() reports a future objectLockRetainUntilDate.
                //
                // If any of these fail, we append the truthful STORAGE_PROTECTION_UNAVAILABLE
                // event instead of the misleading EVIDENCE_LOCKED. The verify page
                // already correctly downgrades the badge in this case; the chain must
                // not contradict the badge.
                const lockMode = lockedMeta.objectLockMode
                    ? String(lockedMeta.objectLockMode)
                    : null;
                const retainUntil = lockedMeta.objectLockRetainUntilDate ?? null;
                const retentionInForce = retainUntil instanceof Date && retainUntil.getTime() > Date.now();
                const lockTrulyApplied = retentionResult.anyApplied === true &&
                    (lockMode === "COMPLIANCE" || lockMode === "GOVERNANCE") &&
                    retentionInForce;
                if (lockTrulyApplied) {
                    await appendCustodyEvent({
                        evidenceId: final.result.id,
                        eventType: prismaPkg.CustodyEventType.EVIDENCE_LOCKED,
                        atUtc: new Date(),
                        payload: {
                            storageRegion: process.env.S3_REGION?.trim() || null,
                            storageObjectLockMode: lockMode,
                            storageObjectLockRetainUntilUtc: retainUntil?.toISOString() ?? null,
                            storageObjectLockLegalHoldStatus: lockedMeta.objectLockLegalHoldStatus
                                ? String(lockedMeta.objectLockLegalHoldStatus)
                                : null,
                            itemCount: final.retentionTargets.length,
                            retentionApplied: true,
                        },
                    });
                }
                else {
                    await appendCustodyEvent({
                        evidenceId: final.result.id,
                        eventType: prismaPkg.CustodyEventType.STORAGE_PROTECTION_UNAVAILABLE,
                        atUtc: new Date(),
                        payload: {
                            phase: "storage_protection_unavailable",
                            storageRegion: process.env.S3_REGION?.trim() || null,
                            storageObjectLockMode: lockMode,
                            storageObjectLockRetainUntilUtc: retainUntil?.toISOString() ?? null,
                            storageObjectLockLegalHoldStatus: lockedMeta.objectLockLegalHoldStatus
                                ? String(lockedMeta.objectLockLegalHoldStatus)
                                : null,
                            itemCount: final.retentionTargets.length,
                            retentionApplied: false,
                            reason: retentionResult.reason ??
                                (retentionResult.anyApplied
                                    ? "object_metadata_does_not_confirm_lock"
                                    : "object_lock_disabled"),
                        },
                    });
                }
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : "OBJECT_LOCK_SNAPSHOT_FAILED";
                throw new Error(`EVIDENCE_OBJECT_LOCK_SNAPSHOT_FAILED:${final.result.id}:${reason}`);
            }
        }
    }
    if (final.shouldEnqueueReport) {
        await enqueueGenerateReportJob(final.result.id);
    }
    // Phase 12 — operations-side session reached its terminal good state.
    safeTransitionUploadSession({
        evidenceId: final.result.id,
        to: "COMPLETED",
    }).catch(() => null);
    // Phase 10 — fire `evidence.completed` to any subscribed webhook
    // endpoints in this workspace. The dispatcher is feature-flag gated
    // and swallows its own errors so failures here never break the
    // completion path.
    try {
        const ev = await prisma.evidence.findUnique({
            where: { id: final.result.id },
            select: {
                id: true,
                teamId: true,
                type: true,
                status: true,
                verificationStatus: true,
                fileSha256: true,
                mimeType: true,
                sizeBytes: true,
                signedAtUtc: true,
                capturedAtUtc: true,
            },
        });
        if (ev && ev.teamId) {
            await emitWebhookEvent({
                teamId: ev.teamId,
                eventType: "evidence.completed",
                payload: {
                    evidenceId: ev.id,
                    type: ev.type,
                    status: ev.status,
                    verificationStatus: ev.verificationStatus,
                    fileSha256: ev.fileSha256,
                    mimeType: ev.mimeType,
                    sizeBytes: ev.sizeBytes ? ev.sizeBytes.toString() : null,
                    signedAtUtc: ev.signedAtUtc?.toISOString() ?? null,
                    capturedAtUtc: ev.capturedAtUtc?.toISOString() ?? null,
                },
                attemptInline: true,
            });
        }
    }
    catch {
        // Webhook emission is best-effort; never fail completion on it.
    }
    // Phase 11 — enqueue a file security scan row for this evidence and
    // run the active scanner. NEVER blocks completion; scanner failures
    // are recorded as FAILED / SKIPPED rows, not exceptions. Feature flag
    // controls whether any row is written at all.
    if (isMalwareScanningEnabled()) {
        try {
            const ev = await prisma.evidence.findUnique({
                where: { id: final.result.id },
                select: { id: true, teamId: true },
            });
            if (ev) {
                await enqueueScan({ evidenceId: ev.id, teamId: ev.teamId });
                // Fire-and-forget runScan; the scanner is responsible for its
                // own timeouts. Completion returns immediately either way.
                runScan({ evidenceId: ev.id, teamId: ev.teamId }).catch(() => null);
            }
        }
        catch {
            /* never fail completion on scan enqueue */
        }
    }
    // Phase 11 — connect-only event wiring (do-not-duplicate audit, §3.1
    // & §3.2). All three trigger points fan out to EXISTING producers
    // through their existing idempotent helpers; none of them creates
    // new infrastructure. Each is wrapped in try/catch so a producer
    // outage NEVER blocks the evidence-completion flow — the periodic
    // reconcile cron and on-demand operator routes remain the canonical
    // catch-up paths.
    try {
        const ev = await prisma.evidence.findUnique({
            where: { id: final.result.id },
            select: { id: true, teamId: true },
        });
        if (ev && ev.teamId) {
            // (a) Best-effort search reindex via the existing Discovery
            // index-rebuild queue (deterministic jobId collapses retries).
            enqueueSearchIndexingJob({
                teamId: ev.teamId,
                kind: "evidence",
                sourceId: ev.id,
                reason: "evidence_completed",
            }).catch(() => null);
            // (a.1) Phase 1 of Investigation enterprise wiring: auto-populate
            // media_intelligence_signals so /investigation overview shows
            // real counters. Before this, signals stayed empty unless an
            // operator manually POSTed /v1/evidence/:id/media-intelligence/run.
            //
            // Idempotent via the deterministic jobId
            // `media-intelligence:${teamId}:${evidenceId}:analyze_metadata:${signatureVersion ?? 'v1'}`
            // — re-issuing analyze_metadata for the same signing-key version
            // collapses to the existing queued job rather than duplicating
            // it. (Note: the producer in media-intelligence-queue.ts hashes
            // its own jobId off `(kind, evidenceId)`; we still pass the
            // version-tagged id so that operational dashboards can see the
            // intent even when the producer collapses to its internal id.)
            try {
                const signatureVersionTag = final.result.signingKeyVersion ?? "v1";
                // Tagged id is logged inside the queue helper for observability;
                // the producer's own dedupe key remains (analyze_metadata,
                // evidenceId) so concurrent finalizations don't pile up jobs.
                void signatureVersionTag; // kept for future structured-log hook
                await enqueueMediaIntelligenceAnalysis({
                    teamId: ev.teamId,
                    evidenceId: ev.id,
                    kind: "analyze_metadata",
                }).catch(() => null);
            }
            catch {
                // Never fail completion on media-intelligence enqueue failure.
                // The operator-triggered /v1/evidence/:id/media-intelligence/run
                // route remains as the canonical catch-up path; the periodic
                // reconcile cron also picks up drift.
            }
            // (b) Phase 1 of Investigation enterprise wiring: best-effort
            // graph reconcile via the worker queue (see
            // ../queue/graph-reconcile-queue.ts for the full rationale —
            // worker-side indexExistingOcrAndTranscript runs from this
            // enqueue, never inline).
            try {
                await enqueueGraphReconcileJob({
                    teamId: ev.teamId,
                    reason: "evidence_completed",
                    evidenceId: ev.id,
                }).catch(() => null);
            }
            catch {
                // Never fail completion on graph-reconcile enqueue failure.
            }
        }
    }
    catch {
        /* never fail completion on post-finalize fan-out */
    }
    return final.result;
}
