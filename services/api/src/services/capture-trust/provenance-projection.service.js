/**
 * Phase 1B — Provenance Chain projection.
 *
 * Single read API that assembles the bounded `ProvenanceChain`
 * (see `@proovra/shared/capture-trust`) for an evidence row. Consumed
 * by:
 *
 *   * Public Verify page (renders chain status + bounded limitations).
 *   * Reports aggregator (renders chain summary in PDF + Verification
 *     Package).
 *   * Verification Package builder (writes `provenance/chain.json`).
 *   * Trust pillar in-product surface.
 *
 * Hard rules:
 *   * The projection is bounded — every field is in the bounded enum
 *     vocabulary declared in `@proovra/shared/capture-trust`.
 *   * Class C (bulk import) reads NEVER fabricate capture-side
 *     primitives — the projection honestly returns NOT_ATTEMPTED.
 *   * Reads are workspace-anchored (when teamId provided) OR
 *     public-token-anchored (when called from the verify page). The
 *     caller is responsible for authorisation.
 *   * The projection is read-only — it NEVER emits trust events. The
 *     `PROVENANCE_PROJECTION_GENERATED` event is emitted by the
 *     caller (route / report builder) if persistence is desired.
 *
 * Read budget: ≤ 6 small Prisma queries per projection. Designed for
 * the verify-page hot path (cached upstream).
 */
import { PROVENANCE_CHAIN_SCHEMA_VERSION, STANDING_PROVENANCE_LIMITATIONS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
export async function projectProvenanceChain(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const evidenceId = input.evidenceId;
    const generatedAtUtc = new Date().toISOString();
    // ----- Evidence root + certification fields ---------------------------
    const evidence = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { id: true },
    });
    if (!evidence) {
        return emptyProjection(evidenceId, generatedAtUtc, "BULK_IMPORT", "C");
    }
    // ----- Capture-trust events for this evidence -------------------------
    const trustEvents = await prisma.captureTrustEventRecord.findMany({
        where: { evidenceId },
        orderBy: { sequence: "asc" },
        select: {
            id: true,
            code: true,
            sequence: true,
            atUtc: true,
            deviceId: true,
            captureSessionId: true,
            payload: true,
        },
        take: 200,
    });
    // ----- Resolve capture-side mode, class, session, device, sig verdict --
    // We derive these from the trust-event timeline + the most-recent
    // attestation row. The verifier writes these as payload fields when
    // it emits CAPTURE_ARTIFACT_RECEIVED / CAPTURE_ARTIFACT_SIGNED_AT_SOURCE.
    let mode = "BULK_IMPORT";
    let provenanceClass = "C";
    let sessionId = null;
    let deviceId = null;
    let signatureVerdict = "MISSING";
    let signedAtUtc = null;
    for (const ev of trustEvents) {
        const payload = (ev.payload ?? {});
        if (ev.code === "CAPTURE_ARTIFACT_RECEIVED" || ev.code === "CAPTURE_ARTIFACT_SIGNED_AT_SOURCE") {
            if (typeof payload["captureMode"] === "string") {
                mode = payload["captureMode"];
            }
            if (typeof payload["provenanceClass"] === "string") {
                provenanceClass = payload["provenanceClass"];
            }
            if (typeof payload["signatureVerdict"] === "string") {
                signatureVerdict = payload["signatureVerdict"];
            }
            if (typeof payload["signedAtUtc"] === "string") {
                signedAtUtc = payload["signedAtUtc"];
            }
        }
        sessionId = sessionId ?? ev.captureSessionId;
        deviceId = deviceId ?? ev.deviceId;
    }
    // ----- Most-recent attestation verdict for the session ----------------
    let attestationVerdict = "NOT_ATTEMPTED";
    let attestationProvider = "NONE";
    if (sessionId !== null) {
        const att = await prisma.captureDeviceAttestation.findFirst({
            where: { captureSessionId: sessionId },
            orderBy: { verifiedAtUtc: "desc" },
            select: { verdict: true, provider: true },
        });
        if (att) {
            attestationVerdict = att.verdict;
            attestationProvider = att.provider;
        }
    }
    // ----- Server countersignature + time anchoring -----------------------
    // The existing custody chain records SIGNATURE_APPLIED + TIMESTAMP_APPLIED
    // + OTS_APPLIED + ANCHOR_PUBLISHED events. We read those bounded events
    // to fill the projection.
    const custodyEvents = await prisma.custodyEvent.findMany({
        where: {
            evidenceId,
            eventType: {
                in: [
                    "SIGNATURE_APPLIED",
                    "TIMESTAMP_APPLIED",
                    "OTS_APPLIED",
                    "ANCHOR_PUBLISHED",
                ],
            },
        },
        orderBy: { sequence: "asc" },
        select: {
            eventType: true,
            atUtc: true,
            payload: true,
        },
        take: 50,
    });
    let countersigned = false;
    let countersignKeyId = null;
    let countersignedAtUtc = null;
    let rfc3161Applied = false;
    let rfc3161TsaUrl = null;
    let rfc3161AtUtc = null;
    let otsApplied = false;
    let otsTxId = null;
    let otsAtUtc = null;
    let otsConfirmations = null;
    for (const ce of custodyEvents) {
        const p = (ce.payload ?? {});
        if (ce.eventType === "SIGNATURE_APPLIED") {
            countersigned = true;
            countersignKeyId =
                typeof p["keyId"] === "string"
                    ? p["keyId"]
                    : countersignKeyId;
            countersignedAtUtc = ce.atUtc.toISOString();
        }
        else if (ce.eventType === "TIMESTAMP_APPLIED") {
            rfc3161Applied = true;
            rfc3161TsaUrl =
                typeof p["tsaUrl"] === "string"
                    ? p["tsaUrl"]
                    : rfc3161TsaUrl;
            rfc3161AtUtc = ce.atUtc.toISOString();
        }
        else if (ce.eventType === "OTS_APPLIED" || ce.eventType === "ANCHOR_PUBLISHED") {
            otsApplied = true;
            otsTxId =
                typeof p["txId"] === "string" ? p["txId"] : otsTxId;
            otsAtUtc = ce.atUtc.toISOString();
            if (typeof p["confirmations"] === "number") {
                otsConfirmations = p["confirmations"];
            }
        }
    }
    // ----- C2PA aggregate (best-effort; reads existing projection) --------
    // We read from `Evidence.verificationPackageMetadata.c2pa` when present.
    // Defaults to "not_present" / "disabled" when not.
    let c2paAggregateStatus = "not_present";
    let c2paProviderMode = "disabled";
    try {
        const ev2 = (await prisma.evidence.findUnique({
            where: { id: evidenceId },
            select: { verificationPackageMetadata: true },
        }));
        const c2pa = ev2?.verificationPackageMetadata?.c2pa;
        if (c2pa) {
            if (typeof c2pa["aggregateStatus"] === "string") {
                c2paAggregateStatus = c2pa["aggregateStatus"];
            }
            if (typeof c2pa["providerMode"] === "string") {
                c2paProviderMode = c2pa["providerMode"];
            }
        }
    }
    catch {
        // Optional field — never block the projection.
    }
    // ----- Derivations (parent→derived edges) -----------------------------
    const derivations = [];
    try {
        const derivationEvents = await prisma.captureTrustEventRecord.findMany({
            where: { evidenceId, code: "CAPTURE_DERIVATION_CREATED" },
            orderBy: { sequence: "asc" },
            select: { atUtc: true, payload: true },
            take: 50,
        });
        for (const d of derivationEvents) {
            const p = (d.payload ?? {});
            derivations.push({
                derivedEvidenceId: typeof p["derivedEvidenceId"] === "string"
                    ? p["derivedEvidenceId"]
                    : "",
                transformLabel: typeof p["transform"] === "string" ? p["transform"] : "",
                derivedAtUtc: d.atUtc != null ? d.atUtc.toISOString() : new Date(0).toISOString(),
            });
        }
    }
    catch {
        // Optional surface.
    }
    // ----- Trust event summary --------------------------------------------
    const failures = trustEvents.filter((e) => isFailureCode(e.code)).length;
    const last = trustEvents[trustEvents.length - 1] ?? null;
    return {
        schemaVersion: PROVENANCE_CHAIN_SCHEMA_VERSION,
        generatedAtUtc,
        evidenceId,
        capture: {
            mode,
            provenanceClass,
            sessionId,
            deviceId,
            signatureVerdict,
            attestationVerdict,
            attestationProvider,
            signedAtUtc,
        },
        server: {
            countersigned,
            countersignKeyId,
            countersignedAtUtc,
        },
        time: {
            rfc3161: {
                applied: rfc3161Applied,
                tsaUrl: rfc3161TsaUrl,
                appliedAtUtc: rfc3161AtUtc,
            },
            ots: {
                applied: otsApplied,
                anchorTxId: otsTxId,
                appliedAtUtc: otsAtUtc,
                confirmations: otsConfirmations,
            },
        },
        c2pa: {
            aggregateStatus: c2paAggregateStatus,
            providerMode: c2paProviderMode,
        },
        derivations,
        trustEventSummary: {
            total: trustEvents.length,
            failures,
            lastEventAtUtc: last?.atUtc != null ? last.atUtc.toISOString() : null,
        },
        limitations: STANDING_PROVENANCE_LIMITATIONS,
    };
}
function emptyProjection(evidenceId, generatedAtUtc, mode, cls) {
    return {
        schemaVersion: PROVENANCE_CHAIN_SCHEMA_VERSION,
        generatedAtUtc,
        evidenceId,
        capture: {
            mode,
            provenanceClass: cls,
            sessionId: null,
            deviceId: null,
            signatureVerdict: "MISSING",
            attestationVerdict: "NOT_ATTEMPTED",
            attestationProvider: "NONE",
            signedAtUtc: null,
        },
        server: {
            countersigned: false,
            countersignKeyId: null,
            countersignedAtUtc: null,
        },
        time: {
            rfc3161: { applied: false, tsaUrl: null, appliedAtUtc: null },
            ots: {
                applied: false,
                anchorTxId: null,
                appliedAtUtc: null,
                confirmations: null,
            },
        },
        c2pa: { aggregateStatus: "not_present", providerMode: "disabled" },
        derivations: [],
        trustEventSummary: { total: 0, failures: 0, lastEventAtUtc: null },
        limitations: STANDING_PROVENANCE_LIMITATIONS,
    };
}
function isFailureCode(code) {
    return (code === "ATTESTATION_FAILED" ||
        code === "ATTESTATION_REPLAY_DETECTED" ||
        code === "CAPTURE_ARTIFACT_VERIFICATION_FAILED" ||
        code === "CAPTURE_POLICY_DEGRADED");
}
