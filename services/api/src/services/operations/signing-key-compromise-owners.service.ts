/**
 * B7A-F-006 (free-audit 0ea0) — WHAT A SIGNING-KEY COMPROMISE MEANS FOR THE
 * PEOPLE WHOSE OUTPUTS IT SIGNED.
 *
 * `declareSigningKeyCompromise` revokes the key MATERIAL and withdraws every
 * signer naming it. Verification already reports every signature of that
 * material as made by a revoked key (`resolveRecordSignatureValidity` →
 * REVOKED_KEY; `resolveSealKeyBinding` → KEY_REVOKED): the trust state of
 * affected outputs is DERIVED at read time from `signing_keys.revoked_at`, so
 * nothing issued is rewritten, re-signed or deleted here — history stays
 * immutable.
 *
 * Two consequences were not modelled, and are here:
 *
 *   1. THE OWNER IS TOLD. Every record with an ISSUED output (a report, or a
 *      PUBLISHED verification package) whose record signature or package seal
 *      was made by the compromised material gets ONE notice to its owner —
 *      never to anyone else — through the transactional e-mail outbox
 *      (`enqueueEmailNotificationTx`). Idempotent per (owner, record,
 *      compromise): a repeated declaration, or a retry after a failure, finds
 *      the notice already written under a per-record database lock and writes
 *      no second one. The notice names no key, fingerprint, operator reason,
 *      record title or content.
 *
 *   2. A LINKED REPLACEMENT CAN BE ASKED FOR — through the existing output
 *      writer (`requestReportGeneration`), never automatically and never in
 *      bulk. Allowed only when the SERVER finds the record's latest package
 *      sealed by compromised material (a reason no caller can supply), the
 *      record's own signature is NOT compromised (a re-issue does not re-sign
 *      the record — doing so would rewrite its history — so it could not
 *      restore that trust and is refused, honestly), and the signers that would
 *      produce the replacement are ACTIVE and not themselves compromised. The
 *      request carries the server-only purpose
 *      `signing_key_compromise_replacement` and a server-minted key
 *      (`compromise-reissue:<record>:v<N>`), so a repeat replays the same
 *      request; the allowance treats it as a system re-issue, and no credit
 *      or evidence slot is spent (credits are consumed once per record, at
 *      completion; a re-issue creates no record).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";
import {
  isKeyIdentityCompromised,
  keyMaterialCompromisedAt,
  SIGNING_KEY_COMPROMISE_REPLACEMENT_KEY_PREFIX,
  SIGNING_KEY_COMPROMISE_REPLACEMENT_PURPOSE,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { dispatchEnqueuedEmailNotifications, enqueueEmailNotificationTx } from "../notifications/index.js";
import { getEmailWebBaseUrl } from "../notifications/templates.js";
import { requestReportGeneration } from "../reports/report-generation-authority.service.js";
import { getEffectiveSignerStatus, statusPermitsSigning } from "./signer-control-state.service.js";
import { getCurrentActiveSigners } from "./signer-registry.service.js";

export const SIGNING_KEY_COMPROMISE_NOTICE_EVENT = "SIGNING_KEY_COMPROMISE_NOTICE" as const;

export type KeyCompromiseMaterial = {
  /** SPKI SHA-256 of the revoked material (lower-case hex). */
  fingerprints: ReadonlyArray<string>;
  /** Every (keyId, version) identity that holds the material. */
  keyIdentities: ReadonlyArray<{ keyId: string; version: number }>;
};

export type AffectedRecord = {
  evidenceId: string;
  ownerUserId: string;
  teamId: string | null;
  /** The record's own signature was made by the material. */
  recordSignature: boolean;
  /** A PUBLISHED package of the record was sealed by the material. */
  packageSeal: boolean;
};

function identityOr(
  keyIdField: string,
  versionField: string,
  shaField: string,
  material: KeyCompromiseMaterial,
): Array<Record<string, unknown>> {
  const or: Array<Record<string, unknown>> = material.keyIdentities.map((i) => ({
    [keyIdField]: i.keyId,
    [versionField]: i.version,
  }));
  const fps = [...new Set(material.fingerprints.map((f) => f.toLowerCase()))];
  if (fps.length > 0) or.push({ [shaField]: { in: fps } });
  return or;
}

/**
 * Every record with an ISSUED output whose record signature or package seal
 * was made by the material. A record with no issued output has nothing a
 * reader relied on and is not listed (its record signature still verifies as
 * revoked wherever it is shown).
 */
export async function findRecordsAffectedByKeyCompromise(
  material: KeyCompromiseMaterial,
  client: PrismaClient = defaultPrisma,
): Promise<AffectedRecord[]> {
  const out = new Map<string, AffectedRecord>();
  const recordOr = identityOr("signingKeyId", "signingKeyVersion", "signingKeySha256", material);
  if (recordOr.length > 0) {
    const signed = await client.evidence.findMany({
      where: { OR: recordOr as Prisma.EvidenceWhereInput[], reports: { some: {} } },
      select: { id: true, ownerUserId: true, teamId: true },
    });
    for (const e of signed) {
      out.set(e.id, { evidenceId: e.id, ownerUserId: e.ownerUserId, teamId: e.teamId, recordSignature: true, packageSeal: false });
    }
  }
  const sealOr = identityOr("sealSigningKeyId", "sealSigningKeyVersion", "sealSigningKeySha256", material);
  if (sealOr.length > 0) {
    const sealed = await client.verificationPackage.findMany({
      where: { state: "PUBLISHED", OR: sealOr as Prisma.VerificationPackageWhereInput[] },
      select: { evidenceId: true },
      distinct: ["evidenceId"],
    });
    const missing = sealed.map((p) => p.evidenceId).filter((id) => !out.has(id));
    const owners = missing.length
      ? await client.evidence.findMany({
          where: { id: { in: missing } },
          select: { id: true, ownerUserId: true, teamId: true },
        })
      : [];
    for (const e of owners) {
      out.set(e.id, { evidenceId: e.id, ownerUserId: e.ownerUserId, teamId: e.teamId, recordSignature: false, packageSeal: false });
    }
    for (const p of sealed) {
      const row = out.get(p.evidenceId);
      if (row) row.packageSeal = true;
    }
  }
  return [...out.values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

/**
 * When the material was declared compromised: the earliest `revoked_at` of its
 * rows, or `fallback` (the declaration time) when the identity had none.
 */
export async function keyCompromiseDeclaredAt(
  material: KeyCompromiseMaterial,
  fallback: Date,
  client: PrismaClient = defaultPrisma,
): Promise<Date> {
  const times: Date[] = [];
  for (const fp of new Set(material.fingerprints)) {
    const at = await keyMaterialCompromisedAt(client, fp);
    if (at) times.push(at);
  }
  times.sort((a, b) => a.getTime() - b.getTime());
  return times[0] ?? fallback;
}

export type KeyCompromiseNoticeSummary = {
  affectedRecords: number;
  noticesEnqueued: number;
  alreadyNotified: number;
  noAddress: number;
  failed: number;
};

/**
 * One notice per (owner, affected record) for this compromise. Safe to call
 * again: a record whose owner already has a notice written at or after
 * `declaredAt` is skipped, decided under a per-record transaction lock so two
 * concurrent runs cannot both write it.
 */
export async function notifyOwnersOfKeyCompromise(
  input: KeyCompromiseMaterial & { declaredAt: Date; actorUserId: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<KeyCompromiseNoticeSummary> {
  const affected = await findRecordsAffectedByKeyCompromise(input, client);
  const summary: KeyCompromiseNoticeSummary = {
    affectedRecords: affected.length,
    noticesEnqueued: 0,
    alreadyNotified: 0,
    noAddress: 0,
    failed: 0,
  };
  const replaceable = await replacementSignersUsable(client);
  for (const record of affected) {
    try {
      const outcome = await client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`signing-key-compromise-notice:${record.evidenceId}`}))`;
        const prior = await tx.notificationDelivery.findFirst({
          where: {
            eventType: SIGNING_KEY_COMPROMISE_NOTICE_EVENT,
            evidenceId: record.evidenceId,
            recipientUserId: record.ownerUserId,
            createdAt: { gte: input.declaredAt },
          },
          select: { id: true },
        });
        if (prior) return { kind: "already" as const };
        const owner = await tx.user.findUnique({
          where: { id: record.ownerUserId },
          select: { email: true, displayName: true },
        });
        if (!owner?.email) return { kind: "no_address" as const };
        const id = await enqueueEmailNotificationTx(tx, {
          eventType: SIGNING_KEY_COMPROMISE_NOTICE_EVENT,
          teamId: record.teamId,
          recipientEmail: owner.email,
          recipientName: owner.displayName ?? null,
          recipientUserId: record.ownerUserId,
          evidenceId: record.evidenceId,
          initiatedByUserId: input.actorUserId,
          template: {
            kind: "SigningKeyCompromiseNotice",
            data: {
              actionUrl: absoluteInternalUrl(
                getEmailWebBaseUrl(),
                internalNavPath(`/evidence/${encodeURIComponent(record.evidenceId)}`),
              ),
              replacementAvailable: replaceable && record.packageSeal && !record.recordSignature,
            },
          },
        });
        return { kind: "enqueued" as const, id };
      });
      if (outcome.kind === "already") summary.alreadyNotified += 1;
      else if (outcome.kind === "no_address") summary.noAddress += 1;
      else {
        summary.noticesEnqueued += 1;
        await dispatchEnqueuedEmailNotifications([outcome.id], client);
      }
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * Would a replacement be produced by signers we can trust? The current
 * report-PDF and verification-package signers must be ACTIVE and their key
 * identities not compromised.
 */
export async function replacementSignersUsable(client: PrismaClient = defaultPrisma): Promise<boolean> {
  const signers = getCurrentActiveSigners().filter(
    (s) => s.signerPurpose === "verification_package" || s.signerPurpose === "report_pdf",
  );
  if (signers.length === 0) return false;
  for (const s of signers) {
    if (!statusPermitsSigning(await getEffectiveSignerStatus(s.signerId, client))) return false;
    const version = Number(s.keyVersion);
    if (s.keyId && Number.isInteger(version) && version >= 1) {
      if (await isKeyIdentityCompromised(client, { keyId: s.keyId, version })) return false;
    }
  }
  return true;
}

export type KeyCompromiseReplacementResult =
  | {
      ok: true;
      requestId: string;
      /** Same request as before (a repeat), not a second version. */
      replayed: boolean;
      outcome: string;
      replacesReportVersion: number;
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "not_affected"
        | "record_signature_not_replaceable"
        | "no_trustworthy_signer"
        | "not_requested";
      reason?: string;
    };

async function sealCompromised(
  client: PrismaClient,
  pkg: { sealSigningKeyId: string | null; sealSigningKeyVersion: number | null; sealSigningKeySha256: string | null },
): Promise<boolean> {
  if (pkg.sealSigningKeySha256 && (await keyMaterialCompromisedAt(client, pkg.sealSigningKeySha256))) return true;
  if (pkg.sealSigningKeyId && pkg.sealSigningKeyVersion != null) {
    return isKeyIdentityCompromised(client, { keyId: pkg.sealSigningKeyId, version: pkg.sealSigningKeyVersion });
  }
  return false;
}

/**
 * Ask for the linked replacement of a record's latest output pair after its
 * package seal key was compromised. The caller's access to the record is the
 * route's (`evidence.generate_report`); everything else is decided here.
 */
export async function requestKeyCompromiseReplacement(
  input: { evidenceId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<KeyCompromiseReplacementResult> {
  const record = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { signingKeyId: true, signingKeyVersion: true, signingKeySha256: true },
  });
  if (!record) return { ok: false, code: "not_found" };
  const latest = await client.report.findFirst({
    where: { evidenceId: input.evidenceId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  if (!latest) return { ok: false, code: "not_affected" };

  const recordCompromised =
    (record.signingKeySha256 ? (await keyMaterialCompromisedAt(client, record.signingKeySha256)) !== null : false) ||
    (record.signingKeyId && record.signingKeyVersion != null
      ? await isKeyIdentityCompromised(client, { keyId: record.signingKeyId, version: record.signingKeyVersion })
      : false);

  const packages = await client.verificationPackage.findMany({
    where: { evidenceId: input.evidenceId, state: "PUBLISHED", reportVersion: latest.version },
    select: { sealSigningKeyId: true, sealSigningKeyVersion: true, sealSigningKeySha256: true },
  });
  let sealAffected = false;
  for (const p of packages) {
    if (await sealCompromised(client, p)) {
      sealAffected = true;
      break;
    }
  }
  if (recordCompromised) return { ok: false, code: "record_signature_not_replaceable" };
  if (!sealAffected) return { ok: false, code: "not_affected" };
  if (!(await replacementSignersUsable(client))) return { ok: false, code: "no_trustworthy_signer" };

  const key = `${SIGNING_KEY_COMPROMISE_REPLACEMENT_KEY_PREFIX}${input.evidenceId}:v${latest.version}`;
  const before = await client.reportGenerationRequest.findFirst({
    where: { evidenceId: input.evidenceId, clientRequestKey: key },
    select: { id: true },
  });
  const requested = await requestReportGeneration({
    evidenceId: input.evidenceId,
    purpose: SIGNING_KEY_COMPROMISE_REPLACEMENT_PURPOSE,
    artifactType: "REPORT",
    forceRegenerate: true,
    intent: "NEW_VERSION",
    clientRequestKey: key,
    regenerateReason: `key_compromise_replacement_v${latest.version}`,
    requestedByUserId: input.actorUserId,
  });
  if (!requested.requested) return { ok: false, code: "not_requested", reason: requested.reason };
  return {
    ok: true,
    requestId: requested.requestId,
    replayed: before !== null,
    outcome: requested.outcome,
    replacesReportVersion: latest.version,
  };
}
