/**
 * Phase 18 — Communication preference service.
 *
 * Manages opt-out + preferred-channel for two kinds of subjects:
 *
 *   - workspace User (`userId`)
 *   - external contact (`externalContactHash` = HMAC-SHA256 of E.164 phone)
 *
 * Inbound STOP/START webhooks call `applyInboundOptOut` /
 * `applyInboundOptIn`. Operators call `upsertContactPreference` from
 * the UI. Every preference change writes a platform audit log entry +
 * SecurityEvent so the trail is reproducible.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { hashRecipientPhone } from "./communication.service.js";
// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------
export async function getContactPreference(input, client = defaultPrisma) {
    const hash = hashRecipientPhone(input.phoneE164);
    return client.communicationPreference.findFirst({
        where: { teamId: input.teamId, externalContactHash: hash },
    });
}
export async function getUserPreference(input, client = defaultPrisma) {
    return client.communicationPreference.findFirst({
        where: { teamId: input.teamId, userId: input.userId },
    });
}
export async function upsertContactPreference(input, client = defaultPrisma) {
    const hash = hashRecipientPhone(input.phoneE164);
    const existing = await client.communicationPreference.findFirst({
        where: { teamId: input.teamId, externalContactHash: hash },
    });
    const baseSmsOptOut = existing?.smsOptOut ?? false;
    const baseWhatsAppOptOut = existing?.whatsappOptOut ?? false;
    const data = {
        smsOptOut: input.smsOptOut ?? baseSmsOptOut,
        whatsappOptOut: input.whatsappOptOut ?? baseWhatsAppOptOut,
        preferredChannel: input.preferredChannel === undefined
            ? existing?.preferredChannel ?? null
            : input.preferredChannel,
        optOutReason: input.optOutReason !== undefined
            ? input.optOutReason?.slice(0, 400) ?? null
            : existing?.optOutReason ?? null,
        optOutAtUtc: (input.smsOptOut ?? input.whatsappOptOut) === true
            ? new Date()
            : existing?.optOutAtUtc ?? null,
    };
    const row = existing
        ? await client.communicationPreference.update({
            where: { id: existing.id },
            data,
        })
        : await client.communicationPreference.create({
            data: {
                teamId: input.teamId,
                externalContactHash: hash,
                ...data,
            },
        });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "communications.preference.upsert",
        category: "communications.preference",
        severity: "info",
        source: "communications_service",
        outcome: "success",
        resourceType: "communication_preference",
        resourceId: row.id,
        metadata: {
            teamId: input.teamId,
            externalContactHash: hash,
            smsOptOut: row.smsOptOut,
            whatsappOptOut: row.whatsappOptOut,
            preferredChannel: row.preferredChannel,
        },
        db: client,
    });
    return row;
}
export async function upsertUserPreference(input, client = defaultPrisma) {
    const existing = await client.communicationPreference.findFirst({
        where: { teamId: input.teamId, userId: input.userId },
    });
    const data = {
        smsOptOut: input.smsOptOut ?? existing?.smsOptOut ?? false,
        whatsappOptOut: input.whatsappOptOut ?? existing?.whatsappOptOut ?? false,
        preferredChannel: input.preferredChannel === undefined
            ? existing?.preferredChannel ?? null
            : input.preferredChannel,
    };
    const row = existing
        ? await client.communicationPreference.update({
            where: { id: existing.id },
            data,
        })
        : await client.communicationPreference.create({
            data: {
                teamId: input.teamId,
                userId: input.userId,
                ...data,
            },
        });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "communications.preference.user.upsert",
        category: "communications.preference",
        severity: "info",
        source: "communications_service",
        outcome: "success",
        resourceType: "communication_preference",
        resourceId: row.id,
        metadata: {
            teamId: input.teamId,
            subjectUserId: input.userId,
            smsOptOut: row.smsOptOut,
            whatsappOptOut: row.whatsappOptOut,
            preferredChannel: row.preferredChannel,
        },
        db: client,
    });
    return row;
}
// -----------------------------------------------------------------------------
// STOP / START webhook handlers
// -----------------------------------------------------------------------------
export async function applyInboundOptOut(input, client = defaultPrisma) {
    const hash = hashRecipientPhone(input.phoneE164);
    const existing = await client.communicationPreference.findFirst({
        where: { teamId: input.teamId, externalContactHash: hash },
    });
    const data = {
        smsOptOut: input.channel === "SMS" ? true : existing?.smsOptOut ?? false,
        whatsappOptOut: input.channel === "WHATSAPP" ? true : existing?.whatsappOptOut ?? false,
        optOutReason: "inbound_stop",
        optOutAtUtc: new Date(),
    };
    const row = existing
        ? await client.communicationPreference.update({
            where: { id: existing.id },
            data,
        })
        : await client.communicationPreference.create({
            data: {
                teamId: input.teamId,
                externalContactHash: hash,
                ...data,
            },
        });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "communication_inbound_stop_received",
        severity: "INFO",
        details: {
            channel: input.channel,
            externalContactHash: hash,
        },
    }, client);
    return row;
}
export async function applyInboundOptIn(input, client = defaultPrisma) {
    const hash = hashRecipientPhone(input.phoneE164);
    const existing = await client.communicationPreference.findFirst({
        where: { teamId: input.teamId, externalContactHash: hash },
    });
    if (!existing)
        return null;
    const row = await client.communicationPreference.update({
        where: { id: existing.id },
        data: {
            smsOptOut: input.channel === "SMS" ? false : existing.smsOptOut,
            whatsappOptOut: input.channel === "WHATSAPP" ? false : existing.whatsappOptOut,
            optOutReason: null,
            optOutAtUtc: null,
        },
    });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "communication_inbound_start_received",
        severity: "INFO",
        details: {
            channel: input.channel,
            externalContactHash: hash,
        },
    }, client);
    return row;
}
