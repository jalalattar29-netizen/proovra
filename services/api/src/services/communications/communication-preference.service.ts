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

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import type { CommunicationChannel } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

import { hashRecipientPhone } from "./communication.service.js";

// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------

export async function getContactPreference(
  input: { teamId: string; phoneE164: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CommunicationPreference | null> {
  const hash = hashRecipientPhone(input.phoneE164);
  return client.communicationPreference.findFirst({
    where: { teamId: input.teamId, externalContactHash: hash },
  });
}

export async function getUserPreference(
  input: { teamId: string; userId: string },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CommunicationPreference | null> {
  return client.communicationPreference.findFirst({
    where: { teamId: input.teamId, userId: input.userId },
  });
}

// -----------------------------------------------------------------------------
// Mutations
// -----------------------------------------------------------------------------

export type UpsertContactPreferenceInput = {
  teamId: string;
  phoneE164: string;
  actorUserId: string;
  smsOptOut?: boolean;
  whatsappOptOut?: boolean;
  preferredChannel?: CommunicationChannel | null;
  optOutReason?: string | null;
};

export async function upsertContactPreference(
  input: UpsertContactPreferenceInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CommunicationPreference> {
  const hash = hashRecipientPhone(input.phoneE164);
  const existing = await client.communicationPreference.findFirst({
    where: { teamId: input.teamId, externalContactHash: hash },
  });
  const baseSmsOptOut = existing?.smsOptOut ?? false;
  const baseWhatsAppOptOut = existing?.whatsappOptOut ?? false;
  const data = {
    smsOptOut: input.smsOptOut ?? baseSmsOptOut,
    whatsappOptOut: input.whatsappOptOut ?? baseWhatsAppOptOut,
    preferredChannel:
      input.preferredChannel === undefined
        ? existing?.preferredChannel ?? null
        : (input.preferredChannel as prismaPkg.CommunicationChannel | null),
    optOutReason:
      input.optOutReason !== undefined
        ? input.optOutReason?.slice(0, 400) ?? null
        : existing?.optOutReason ?? null,
    optOutAtUtc:
      (input.smsOptOut ?? input.whatsappOptOut) === true
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
  await emitTenantAudit({
    action: "communications.preference.upsert",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "communication_preference",
    resourceId: row.id,
    metadata: {
      externalContactHash: hash,
      smsOptOut: row.smsOptOut,
      whatsappOptOut: row.whatsappOptOut,
      preferredChannel: row.preferredChannel,
    },
  }, client);
  return row;
}

export type UpsertUserPreferenceInput = {
  teamId: string;
  userId: string;
  actorUserId: string;
  smsOptOut?: boolean;
  whatsappOptOut?: boolean;
  preferredChannel?: CommunicationChannel | null;
};

export async function upsertUserPreference(
  input: UpsertUserPreferenceInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CommunicationPreference> {
  const existing = await client.communicationPreference.findFirst({
    where: { teamId: input.teamId, userId: input.userId },
  });
  const data = {
    smsOptOut: input.smsOptOut ?? existing?.smsOptOut ?? false,
    whatsappOptOut: input.whatsappOptOut ?? existing?.whatsappOptOut ?? false,
    preferredChannel:
      input.preferredChannel === undefined
        ? existing?.preferredChannel ?? null
        : (input.preferredChannel as prismaPkg.CommunicationChannel | null),
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
  await emitTenantAudit({
    action: "communications.preference.user.upsert",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "communication_preference",
    resourceId: row.id,
    metadata: {
      subjectUserId: input.userId,
      smsOptOut: row.smsOptOut,
      whatsappOptOut: row.whatsappOptOut,
      preferredChannel: row.preferredChannel,
    },
  }, client);
  return row;
}

// -----------------------------------------------------------------------------
// STOP / START webhook handlers
// -----------------------------------------------------------------------------

export async function applyInboundOptOut(
  input: { teamId: string; phoneE164: string; channel: CommunicationChannel },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CommunicationPreference> {
  const hash = hashRecipientPhone(input.phoneE164);
  const existing = await client.communicationPreference.findFirst({
    where: { teamId: input.teamId, externalContactHash: hash },
  });
  const data = {
    smsOptOut: input.channel === "SMS" ? true : existing?.smsOptOut ?? false,
    whatsappOptOut:
      input.channel === "WHATSAPP" ? true : existing?.whatsappOptOut ?? false,
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
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "communication_inbound_stop_received",
      severity: "INFO",
      details: {
        channel: input.channel,
        externalContactHash: hash,
      },
    },
    client,
  );
  return row;
}

export async function applyInboundOptIn(
  input: { teamId: string; phoneE164: string; channel: CommunicationChannel },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.CommunicationPreference | null> {
  const hash = hashRecipientPhone(input.phoneE164);
  const existing = await client.communicationPreference.findFirst({
    where: { teamId: input.teamId, externalContactHash: hash },
  });
  if (!existing) return null;
  const row = await client.communicationPreference.update({
    where: { id: existing.id },
    data: {
      smsOptOut: input.channel === "SMS" ? false : existing.smsOptOut,
      whatsappOptOut:
        input.channel === "WHATSAPP" ? false : existing.whatsappOptOut,
      optOutReason: null,
      optOutAtUtc: null,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "communication_inbound_start_received",
      severity: "INFO",
      details: {
        channel: input.channel,
        externalContactHash: hash,
      },
    },
    client,
  );
  return row;
}
