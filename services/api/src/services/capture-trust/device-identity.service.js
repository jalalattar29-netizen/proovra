/**
 * Phase 1B — Device Identity service.
 *
 * Manages the lifecycle of workspace-anchored capture devices. Every
 * mobile capture (provenance class A) is signed by a device-bound key
 * registered through this service.
 *
 * Public operations:
 *   - registerDevice    — Create a new Device row. Public key is
 *                         immutable post-registration; key rotation
 *                         creates a NEW device.
 *   - revokeDevice      — Permanent, append-only. A revoked device
 *                         cannot be re-activated; the attestation
 *                         verifier rejects future assertions.
 *   - rotateDeviceKey   — Convenience: revokes the old Device and
 *                         registers a new Device under the same owner.
 *   - findDeviceByPubkey — Lookup by fingerprint for ingest hot path.
 *   - getDevice          — Workspace-anchored single read.
 *   - listDevicesForTeam — Workspace-anchored list with revocation
 *                          status filter.
 *
 * Hard rules:
 *   1. EVERY read filters on teamId server-side. Cross-workspace
 *      access is forbidden.
 *   2. NEVER returns the raw public key in lookups intended for
 *      operator UI (the fingerprint is sufficient).
 *   3. Every mutation emits a CaptureTrustEventCode.
 *   4. Revocation is idempotent — revoking an already-revoked device
 *      is a no-op and emits no duplicate event.
 *   5. Bounded denial reasons. Free-form error strings never leak.
 */
import { createHash } from "node:crypto";
import { CAPTURE_SIGNATURE_ALGORITHMS, DEVICE_ATTESTATION_PROVIDERS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { emitCaptureTrustEvent } from "./trust-event.service.js";
// -----------------------------------------------------------------------------
// registerDevice
// -----------------------------------------------------------------------------
export async function registerDevice(input) {
    const prisma = input.prisma ?? defaultPrisma;
    // Bounded enum gates.
    if (!CAPTURE_SIGNATURE_ALGORITHMS.includes(input.signatureAlgorithm)) {
        return { ok: false, denial: "ALGORITHM_UNSUPPORTED" };
    }
    if (!DEVICE_ATTESTATION_PROVIDERS.includes(input.attestationProvider)) {
        return { ok: false, denial: "PROVIDER_UNSUPPORTED" };
    }
    // Public-key shape validation.
    const hex = input.publicKeyHex.trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(hex)) {
        return { ok: false, denial: "INVALID_PUBLIC_KEY" };
    }
    if (input.signatureAlgorithm === "Ed25519" && hex.length !== 64) {
        return { ok: false, denial: "INVALID_PUBLIC_KEY" };
    }
    if (input.signatureAlgorithm === "ECDSA_P256_SHA256" && hex.length !== 130) {
        return { ok: false, denial: "INVALID_PUBLIC_KEY" };
    }
    // Label sanity.
    const label = input.label.trim();
    if (label.length === 0 || label.length > 120) {
        return { ok: false, denial: "LABEL_INVALID" };
    }
    const fingerprint = createHash("sha256").update(hex).digest("hex");
    // Uniqueness — a pubkey may only be registered once.
    const existing = await prisma.device.findUnique({
        where: { publicKeyFingerprint: fingerprint },
        select: { id: true, teamId: true, revokedAtUtc: true },
    });
    if (existing) {
        return { ok: false, denial: "DEVICE_PUBKEY_TAKEN" };
    }
    const created = await prisma.device.create({
        data: {
            teamId: input.teamId,
            ownerUserId: input.ownerUserId,
            label,
            deviceModel: input.deviceModel,
            osVersion: input.osVersion,
            appVersion: input.appVersion,
            signatureAlgorithm: input.signatureAlgorithm,
            publicKeyHex: hex,
            publicKeyFingerprint: fingerprint,
            attestationProvider: input.attestationProvider,
            attestationKeyId: input.attestationKeyId,
        },
        select: { id: true, publicKeyFingerprint: true },
    });
    await emitCaptureTrustEvent({
        prisma,
        teamId: input.teamId,
        deviceId: created.id,
        captureSessionId: null,
        evidenceId: null,
        code: "CAPTURE_DEVICE_REGISTERED",
        payload: {
            label,
            deviceModel: input.deviceModel,
            osVersion: input.osVersion,
            appVersion: input.appVersion,
            signatureAlgorithm: input.signatureAlgorithm,
            attestationProvider: input.attestationProvider,
            publicKeyFingerprint: fingerprint,
        },
    });
    return {
        ok: true,
        deviceId: created.id,
        publicKeyFingerprint: created.publicKeyFingerprint,
    };
}
// -----------------------------------------------------------------------------
// revokeDevice
// -----------------------------------------------------------------------------
export async function revokeDevice(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const device = await prisma.device.findFirst({
        where: { id: input.deviceId, teamId: input.teamId },
        select: { id: true, revokedAtUtc: true },
    });
    if (!device)
        return { ok: false, denial: "DEVICE_NOT_FOUND" };
    if (device.revokedAtUtc !== null) {
        return { ok: false, denial: "DEVICE_ALREADY_REVOKED" };
    }
    const now = new Date();
    await prisma.device.update({
        where: { id: device.id },
        data: { revokedAtUtc: now, revocationReason: input.reason },
    });
    await emitCaptureTrustEvent({
        prisma,
        teamId: input.teamId,
        deviceId: device.id,
        captureSessionId: null,
        evidenceId: null,
        code: "CAPTURE_DEVICE_REVOKED",
        payload: { reason: input.reason, revokedAtUtc: now.toISOString() },
    });
    return { ok: true, revokedAtUtc: now.toISOString() };
}
// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------
export async function findDeviceByPubkey(teamId, publicKeyHex, client = defaultPrisma) {
    const fp = createHash("sha256").update(publicKeyHex.toLowerCase()).digest("hex");
    return client.device.findFirst({
        where: { teamId, publicKeyFingerprint: fp },
        select: { id: true, revokedAtUtc: true },
    });
}
export async function getDevice(teamId, deviceId, client = defaultPrisma) {
    const row = await client.device.findFirst({
        where: { id: deviceId, teamId },
        select: {
            id: true,
            label: true,
            deviceModel: true,
            osVersion: true,
            appVersion: true,
            signatureAlgorithm: true,
            publicKeyFingerprint: true,
            attestationProvider: true,
            registeredAtUtc: true,
            revokedAtUtc: true,
            revocationReason: true,
            createdAt: true,
        },
    });
    if (!row)
        return null;
    // R7-capture-trust: deviceModel / osVersion / appVersion / signatureAlgorithm are R7-additive
    // nullable descriptive metadata on Device. They are NEVER used by the crypto path —
    // attestation + signature verification read publicKeyHex / publicKeyFingerprint /
    // attestationProvider / attestationKeyId, all unchanged. Projection coalesces to "" so the
    // device-list UI shows a bounded blank label rather than crashing on legacy rows.
    // registeredAtUtc falls back to createdAt (Device row creation is the canonical registration
    // moment for legacy rows that pre-date the additive column).
    return {
        id: row.id,
        label: row.label,
        deviceModel: row.deviceModel ?? "",
        osVersion: row.osVersion ?? "",
        appVersion: row.appVersion ?? "",
        signatureAlgorithm: row.signatureAlgorithm ?? "",
        publicKeyFingerprint: row.publicKeyFingerprint,
        attestationProvider: row.attestationProvider,
        registeredAtUtc: row.registeredAtUtc ?? row.createdAt,
        revokedAtUtc: row.revokedAtUtc,
        revocationReason: row.revocationReason,
    };
}
export async function listDevicesForTeam(teamId, filter = {}, client = defaultPrisma) {
    return client.device.findMany({
        where: {
            teamId,
            revokedAtUtc: filter.includeRevoked ? undefined : null,
        },
        orderBy: [{ registeredAtUtc: "desc" }],
        select: {
            id: true,
            label: true,
            deviceModel: true,
            osVersion: true,
            appVersion: true,
            signatureAlgorithm: true,
            publicKeyFingerprint: true,
            attestationProvider: true,
            registeredAtUtc: true,
            lastSeenAtUtc: true,
            revokedAtUtc: true,
            revocationReason: true,
        },
        take: 500,
    });
}
