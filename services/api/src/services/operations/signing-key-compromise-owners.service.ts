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
 *
 * FINAL PASS (B7A-F-006 residual, 2026-11-18):
 *
 *   * WHAT IS AFFECTED also covers custody-event attestations
 *     (`security_events` rows `custody_attestation_signed`, whose details carry
 *     the signer's keyId / keyVersion) and destruction certificates (the
 *     certificate body's `signatureEd25519` keyId / keyVersion /
 *     publicKeySha256). Neither is re-issued: an attestation is not re-signed
 *     by the replacement (the operator custody backfill is the only writer, and
 *     it is not linked to the customer's action), and a destruction certificate
 *     records a destruction that already happened (append-only, one per
 *     request). Both are stated in the notice and on the record, never implied
 *     replaced.
 *   * THE OWNER'S CLIENTS READ ONE DECISION. `describeRecordKeyCompromise`
 *     (artifact status `keyCompromise`) and `requestKeyCompromiseReplacement`
 *     evaluate the same facts (`evaluateRecordKeyCompromise`), so the control
 *     shown and the work it starts cannot disagree.
 *   * IN-APP. Besides the e-mail, each notice writes one caller-scoped
 *     `security_events` row (eventType `signing_key_compromise_notice`,
 *     severity HIGH, userId = the recipient) in the same transaction; the
 *     `/v1/me/inbox` aggregation already lists a user's HIGH security events of
 *     the last 7 days. VARCHAR columns: no migration.
 *   * LIMIT. The fan-out runs inline in the operator's declaration (there is no
 *     generic worker job that needs no migration). One call handles at most
 *     `KEY_COMPROMISE_INLINE_NOTICE_LIMIT` records plus certificates and reports
 *     the rest as `deferred`; a repeated declaration (idempotent) continues
 *     where the previous one stopped.
 */
import type { PrismaClient } from "@prisma/client";
import {
  absoluteInternalUrl,
  internalNavPath,
  isTerminalJobExecutionState,
  MAX_TERMINAL_SUPERSESSIONS,
  outputLifecycleRefusal,
  type KeyCompromiseReplacementState,
  type RecordKeyCompromise,
} from "@proovra/shared";
import {
  isKeyIdentityCompromised,
  keyMaterialCompromisedAt,
  publicKeySpkiSha256,
  SIGNING_KEY_COMPROMISE_REPLACEMENT_KEY_PREFIX,
  SIGNING_KEY_COMPROMISE_REPLACEMENT_PURPOSE,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { workspaceIsEnterpriseOrganization } from "../platform-context/enterprise-authority.js";
import { dispatchEnqueuedEmailNotifications, enqueueEmailNotificationTx } from "../notifications/index.js";
import { getEmailWebBaseUrl } from "../notifications/templates.js";
import { requestReportGeneration } from "../reports/report-generation-authority.service.js";
import { getEffectiveSignerStatus, statusPermitsSigning } from "./signer-control-state.service.js";
import { getCurrentActiveSigners } from "./signer-registry.service.js";

export const SIGNING_KEY_COMPROMISE_NOTICE_EVENT = "SIGNING_KEY_COMPROMISE_NOTICE" as const;
/** The in-app twin of the e-mail notice (a caller-scoped HIGH security event). */
export const SIGNING_KEY_COMPROMISE_IN_APP_EVENT = "signing_key_compromise_notice" as const;
/** Records + certificates one declaration notifies inline; the rest are `deferred`. */
export const KEY_COMPROMISE_INLINE_NOTICE_LIMIT = 500;

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
  /** A custody-event attestation of the record was signed by the material. */
  custodyAttestations: boolean;
};

export type AffectedDestructionCertificate = {
  certificateId: string;
  teamId: string;
  /** The person who asked for the destruction: the certificate's addressee. */
  requestedByUserId: string;
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

/** Records whose custody events carry an attestation signed by one of these identities. */
async function recordsWithCustodyAttestationsBy(
  client: PrismaClient,
  identities: ReadonlyArray<{ keyId: string; version: number }>,
): Promise<string[]> {
  const out = new Set<string>();
  for (const i of identities) {
    // The attestation row stores the signer's keyId and keyVersion (a string).
    const rows = await client.$queryRaw<Array<{ evidence_id: string | null }>>`
      SELECT DISTINCT ("metadataJson"->'attestation'->>'evidenceId') AS evidence_id
        FROM security_events
       WHERE "eventType" = 'custody_attestation_signed'
         AND ("metadataJson"->>'keyId') = ${i.keyId}
         AND ("metadataJson"->>'keyVersion') = ${String(i.version)}`;
    for (const r of rows) if (r.evidence_id && /^[0-9a-f-]{36}$/i.test(r.evidence_id)) out.add(r.evidence_id);
  }
  return [...out];
}

/**
 * Every record with an ISSUED output whose record signature, package seal or
 * custody-event attestations were made by the material. A record with no
 * issued output has nothing a reader relied on and is not listed (its record
 * signature still verifies as revoked wherever it is shown).
 */
export async function findRecordsAffectedByKeyCompromise(
  material: KeyCompromiseMaterial,
  client: PrismaClient = defaultPrisma,
): Promise<AffectedRecord[]> {
  const out = new Map<string, AffectedRecord>();
  const row = (e: { id: string; ownerUserId: string; teamId: string | null }): AffectedRecord => {
    const existing = out.get(e.id);
    if (existing) return existing;
    const created: AffectedRecord = {
      evidenceId: e.id,
      ownerUserId: e.ownerUserId,
      teamId: e.teamId,
      recordSignature: false,
      packageSeal: false,
      custodyAttestations: false,
    };
    out.set(e.id, created);
    return created;
  };
  const recordOr = identityOr("signingKeyId", "signingKeyVersion", "signingKeySha256", material);
  if (recordOr.length > 0) {
    const signed = await client.evidence.findMany({
      where: { OR: recordOr as never, reports: { some: {} } },
      select: { id: true, ownerUserId: true, teamId: true },
    });
    for (const e of signed) row(e).recordSignature = true;
  }
  const sealOr = identityOr("sealSigningKeyId", "sealSigningKeyVersion", "sealSigningKeySha256", material);
  if (sealOr.length > 0) {
    const sealed = await client.verificationPackage.findMany({
      where: { state: "PUBLISHED", OR: sealOr as never },
      select: { evidenceId: true },
      distinct: ["evidenceId"],
    });
    const owners = sealed.length
      ? await client.evidence.findMany({
          where: { id: { in: sealed.map((p) => p.evidenceId) } },
          select: { id: true, ownerUserId: true, teamId: true },
        })
      : [];
    for (const e of owners) row(e).packageSeal = true;
  }
  const attested = await recordsWithCustodyAttestationsBy(client, material.keyIdentities);
  if (attested.length > 0) {
    // Attestations ship inside the record's verification packages: a record
    // with no issued output has nothing a reader relied on.
    const owners = await client.evidence.findMany({
      where: { id: { in: attested }, reports: { some: {} } },
      select: { id: true, ownerUserId: true, teamId: true },
    });
    for (const e of owners) row(e).custodyAttestations = true;
  }
  return [...out.values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

type CertificateSignature = { keyId?: unknown; keyVersion?: unknown; publicKeySha256?: unknown };

/**
 * Destruction certificates whose Ed25519 signature was made by the material.
 * The certificate body (append-only, the record of the destruction) carries the
 * signature's keyId, keyVersion and publicKeySha256.
 */
export async function findDestructionCertificatesAffectedByKeyCompromise(
  material: KeyCompromiseMaterial,
  client: PrismaClient = defaultPrisma,
): Promise<AffectedDestructionCertificate[]> {
  const fps = new Set(material.fingerprints.map((f) => f.toLowerCase()));
  const ids = new Set(material.keyIdentities.map((i) => `${i.keyId}\u0000${i.version}`));
  const or = [
    ...[...fps].map((fp) => ({ certificateBody: { contains: fp } })),
    ...[...new Set(material.keyIdentities.map((i) => i.keyId))].map((keyId) => ({ certificateBody: { contains: keyId } })),
  ];
  if (or.length === 0) return [];
  const rows = await client.destructionCertificate.findMany({
    where: { OR: or },
    select: { id: true, teamId: true, certificateBody: true, request: { select: { requestedByUserId: true } } },
    orderBy: { id: "asc" },
  });
  const out: AffectedDestructionCertificate[] = [];
  for (const r of rows) {
    let sig: CertificateSignature | null = null;
    try {
      const body = JSON.parse(r.certificateBody ?? "null") as { signatureEd25519?: CertificateSignature | null } | null;
      sig = body?.signatureEd25519 ?? null;
    } catch {
      sig = null;
    }
    if (!sig) continue;
    const bySha = typeof sig.publicKeySha256 === "string" && fps.has(sig.publicKeySha256.toLowerCase());
    const byId = typeof sig.keyId === "string" && ids.has(`${sig.keyId}\u0000${Number(sig.keyVersion)}`);
    if (bySha || byId) out.push({ certificateId: r.id, teamId: r.teamId, requestedByUserId: r.request.requestedByUserId });
  }
  return out;
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
  /** In-app notices written (records and certificates). */
  inAppNotices: number;
  /** Destruction certificates signed by the material. */
  affectedCertificates: number;
  /** Certificate notices written (e-mail or in-app) in this call. */
  certificateNotices: number;
  /** Records + certificates over the inline limit, left for a repeated declaration. */
  deferred: number;
};

/**
 * RG-03 (PRO-O1-13, DEC-03) — who is told about one affected record.
 *
 * The record's owner, while they can still act on it: a personal record's
 * owner always; a workspace record's owner while an ACTIVE member of its
 * workspace. When the owner has left (removed, suspended, closed account),
 * the workspace's current ACTIVE OWNER/ADMIN members are told instead, through
 * the same scoped notice (minimal disclosure: the record link only).
 */
async function keyCompromiseRecipients(
  record: Pick<AffectedRecord, "ownerUserId" | "teamId">,
  client: Pick<PrismaClient, "teamMember">,
): Promise<string[]> {
  if (!record.teamId) return [record.ownerUserId];
  const ownerActive = await client.teamMember.findFirst({
    where: { teamId: record.teamId, userId: record.ownerUserId, status: "ACTIVE" },
    select: { id: true },
  });
  if (ownerActive) return [record.ownerUserId];
  const operators = await client.teamMember.findMany({
    where: { teamId: record.teamId, status: "ACTIVE", role: { in: ["OWNER", "ADMIN"] } },
    select: { userId: true },
    orderBy: { userId: "asc" },
    take: 10,
  });
  return operators.length > 0 ? operators.map((o) => o.userId) : [record.ownerUserId];
}

/**
 * One notice per (owner, affected record) — and per (requester, affected
 * destruction certificate) — for this compromise: an e-mail through the
 * transactional outbox and an in-app item, in one transaction. Safe to call
 * again: a subject whose recipient already has a notice written at or after
 * `declaredAt` is skipped, decided under a per-subject transaction lock.
 */
export async function notifyOwnersOfKeyCompromise(
  input: KeyCompromiseMaterial & {
    declaredAt: Date;
    actorUserId: string | null;
    /** New notices written by this call (default KEY_COMPROMISE_INLINE_NOTICE_LIMIT). */
    inlineLimit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<KeyCompromiseNoticeSummary> {
  const affected = await findRecordsAffectedByKeyCompromise(input, client);
  const certificates = await findDestructionCertificatesAffectedByKeyCompromise(input, client);
  const summary: KeyCompromiseNoticeSummary = {
    affectedRecords: affected.length,
    noticesEnqueued: 0,
    alreadyNotified: 0,
    noAddress: 0,
    failed: 0,
    inAppNotices: 0,
    affectedCertificates: certificates.length,
    certificateNotices: 0,
    deferred: 0,
  };
  const replaceable = await replacementSignersUsable(client);
  let budget = Math.max(0, Math.trunc(input.inlineLimit ?? KEY_COMPROMISE_INLINE_NOTICE_LIMIT));
  const webBase = getEmailWebBaseUrl();

  // RG-03 (PRO-O1-13) — one bulk read of the records already noticed for this
  // compromise, so a continuation pass (the maintenance sweep, a repeated
  // declaration) moves straight to the records still owed a notice instead of
  // re-locking every finished one. The per-record lock below still decides.
  const noticed = new Set<string>(
    (
      await client.securityEvent
        .findMany({
          where: { eventType: SIGNING_KEY_COMPROMISE_IN_APP_EVENT, createdAt: { gte: input.declaredAt } },
          select: { details: true },
        })
        .catch(() => [] as Array<{ details: unknown }>)
    )
      .map((e) => (e.details as { evidenceId?: unknown } | null)?.evidenceId)
      .filter((v): v is string => typeof v === "string"),
  );

  for (const record of affected) {
    if (noticed.has(record.evidenceId)) {
      summary.alreadyNotified += 1;
      continue;
    }
    if (budget <= 0) {
      summary.deferred += 1;
      continue;
    }
    try {
      const recipients = await keyCompromiseRecipients(record, client);
      const outcomes: Array<{ kind: "already" } | { kind: "no_address" } | { kind: "enqueued"; id: string | null }> = [];
      for (const recipientUserId of recipients) {
        outcomes.push(
          await client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`signing-key-compromise-notice:${record.evidenceId}`}))`;
        const [priorEmail, priorInApp] = await Promise.all([
          tx.notificationDelivery.findFirst({
            where: {
              eventType: SIGNING_KEY_COMPROMISE_NOTICE_EVENT,
              evidenceId: record.evidenceId,
              recipientUserId,
              createdAt: { gte: input.declaredAt },
            },
            select: { id: true },
          }),
          tx.securityEvent.findFirst({
            where: {
              userId: recipientUserId,
              eventType: SIGNING_KEY_COMPROMISE_IN_APP_EVENT,
              createdAt: { gte: input.declaredAt },
              details: { path: ["evidenceId"], equals: record.evidenceId },
            },
            select: { id: true },
          }),
        ]);
        if (priorEmail || priorInApp) return { kind: "already" as const };
        // In-app: the caller-scoped inbox lists it (security_event_high).
        await tx.securityEvent.create({
          data: {
            teamId: record.teamId,
            userId: recipientUserId,
            eventType: SIGNING_KEY_COMPROMISE_IN_APP_EVENT,
            severity: "HIGH",
            details: { evidenceId: record.evidenceId, subject: "record" },
          },
        });
        const owner = await tx.user.findUnique({
          where: { id: recipientUserId },
          select: { email: true, displayName: true },
        });
        if (!owner?.email) return { kind: "no_address" as const };
        const notReplaceable: Array<"RECORD_SIGNATURE" | "CUSTODY_ATTESTATIONS"> = [];
        if (record.recordSignature) notReplaceable.push("RECORD_SIGNATURE");
        if (record.custodyAttestations) notReplaceable.push("CUSTODY_ATTESTATIONS");
        const id = await enqueueEmailNotificationTx(tx, {
          eventType: SIGNING_KEY_COMPROMISE_NOTICE_EVENT,
          teamId: record.teamId,
          recipientEmail: owner.email,
          recipientName: owner.displayName ?? null,
          recipientUserId,
          evidenceId: record.evidenceId,
          initiatedByUserId: input.actorUserId,
          template: {
            kind: "SigningKeyCompromiseNotice",
            data: {
              actionUrl: absoluteInternalUrl(webBase, internalNavPath(`/evidence/${encodeURIComponent(record.evidenceId)}`)),
              replacementAvailable: replaceable && record.packageSeal && !record.recordSignature,
              ...(notReplaceable.length ? { notReplaceable } : {}),
            },
          },
        });
        return { kind: "enqueued" as const, id };
          }),
        );
      }
      // Only a NEW notice spends the inline budget, so a continuation pass
      // skips the already-notified subjects and continues with the deferred ones.
      if (outcomes.every((o) => o.kind === "already")) summary.alreadyNotified += 1;
      else {
        budget -= 1;
        for (const outcome of outcomes) {
          if (outcome.kind === "already") continue;
          summary.inAppNotices += 1;
          if (outcome.kind === "no_address") summary.noAddress += 1;
          else {
            summary.noticesEnqueued += 1;
            if (outcome.id) await dispatchEnqueuedEmailNotifications([outcome.id], client);
          }
        }
      }
    } catch {
      summary.failed += 1;
    }
  }

  for (const cert of certificates) {
    if (budget <= 0) {
      summary.deferred += 1;
      continue;
    }
    try {
      // PRO-PW-02 (WS-ENT) — /governance/destruction is an Enterprise
      // organization surface (tier ENTERPRISE, notFound). A certificate of a
      // workspace that is no longer one links the recipient's inbox instead,
      // where the in-app notice below is listed. Fails closed to the inbox.
      const destructionSurfaceReachable = cert.teamId
        ? await workspaceIsEnterpriseOrganization(cert.teamId).catch(() => false)
        : false;
      const outcome = await client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`signing-key-compromise-notice:cert:${cert.certificateId}`}))`;
        // The in-app row is the certificate notice's own dedupe key (a
        // certificate has no record id for the e-mail outbox to key on).
        const prior = await tx.securityEvent.findFirst({
          where: {
            userId: cert.requestedByUserId,
            eventType: SIGNING_KEY_COMPROMISE_IN_APP_EVENT,
            createdAt: { gte: input.declaredAt },
            details: { path: ["certificateId"], equals: cert.certificateId },
          },
          select: { id: true },
        });
        if (prior) return { kind: "already" as const };
        await tx.securityEvent.create({
          data: {
            teamId: cert.teamId,
            userId: cert.requestedByUserId,
            eventType: SIGNING_KEY_COMPROMISE_IN_APP_EVENT,
            severity: "HIGH",
            details: { certificateId: cert.certificateId, subject: "destruction_certificate" },
          },
        });
        const user = await tx.user.findUnique({
          where: { id: cert.requestedByUserId },
          select: { email: true, displayName: true },
        });
        if (!user?.email) return { kind: "no_address" as const };
        const id = await enqueueEmailNotificationTx(tx, {
          eventType: SIGNING_KEY_COMPROMISE_NOTICE_EVENT,
          teamId: cert.teamId,
          recipientEmail: user.email,
          recipientName: user.displayName ?? null,
          recipientUserId: cert.requestedByUserId,
          initiatedByUserId: input.actorUserId,
          template: {
            kind: "SigningKeyCompromiseNotice",
            data: {
              actionUrl: absoluteInternalUrl(
                webBase,
                internalNavPath(destructionSurfaceReachable ? "/governance/destruction" : "/notifications"),
              ),
              replacementAvailable: false,
              subject: "destruction_certificate",
            },
          },
        });
        return { kind: "enqueued" as const, id };
      });
      if (outcome.kind === "already") summary.alreadyNotified += 1;
      else {
        budget -= 1;
        summary.certificateNotices += 1;
        summary.inAppNotices += 1;
        if (outcome.kind === "no_address") summary.noAddress += 1;
        else if (outcome.id) await dispatchEnqueuedEmailNotifications([outcome.id], client);
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
 * identities not compromised. (The worker re-checks the signer it actually
 * uses at generation time — services/worker/src/signing/signer-control-guard.ts.)
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

// ---------------------------------------------------------------------------
// ONE RECORD — the decision the owner's clients read and the action applies.
// ---------------------------------------------------------------------------

type CompromisedKeys = { identities: Set<string>; fingerprints: Set<string> };
const idKey = (keyId: string, version: number) => `${keyId}\u0000${version}`;

/**
 * Every revoked (compromised) key material and every identity holding it. The
 * registry is small; with nothing revoked (the normal case) this is one query
 * and the answer is null.
 */
async function loadCompromisedKeys(client: PrismaClient): Promise<CompromisedKeys | null> {
  const revoked = await client.signingKey.findMany({
    where: { revokedAt: { not: null } },
    select: { keyId: true, version: true, publicKeyPem: true, fingerprintSha256: true },
  });
  if (revoked.length === 0) return null;
  const identities = new Set<string>();
  const fingerprints = new Set<string>();
  for (const r of revoked) {
    identities.add(idKey(r.keyId, r.version));
    let fp = r.fingerprintSha256?.toLowerCase() ?? null;
    if (!fp) {
      try {
        fp = publicKeySpkiSha256(r.publicKeyPem);
      } catch {
        fp = null;
      }
    }
    if (fp) fingerprints.add(fp);
  }
  if (fingerprints.size > 0) {
    const same = await client.signingKey.findMany({
      where: { fingerprintSha256: { in: [...fingerprints] } },
      select: { keyId: true, version: true },
    });
    for (const r of same) identities.add(idKey(r.keyId, r.version));
  }
  return { identities, fingerprints };
}

function madeByCompromised(
  keys: CompromisedKeys,
  keyId: string | null | undefined,
  version: number | null | undefined,
  sha: string | null | undefined,
): boolean {
  if (sha && keys.fingerprints.has(sha.toLowerCase())) return true;
  return Boolean(keyId && version != null && keys.identities.has(idKey(keyId, version)));
}

const LIVE_REQUEST_STATES = ["QUEUED", "PROCESSING", "FAILED_RETRYABLE"];


type RecordEvaluation = {
  outputs: RecordKeyCompromise["outputs"];
  replacement: KeyCompromiseReplacementState;
  latestVersion: number | null;
};

async function evaluateRecordKeyCompromise(
  evidenceId: string,
  keys: CompromisedKeys,
  client: PrismaClient,
): Promise<RecordEvaluation | null> {
  const record = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      teamId: true,
      signingKeyId: true,
      signingKeyVersion: true,
      signingKeySha256: true,
      status: true,
      lifecycleState: true,
      deletedAt: true,
    },
  });
  if (!record) return null;
  const [latest, packages] = await Promise.all([
    client.report.findFirst({ where: { evidenceId }, orderBy: { version: "desc" }, select: { version: true } }),
    client.verificationPackage.findMany({
      where: { evidenceId, state: "PUBLISHED" },
      select: { version: true, reportVersion: true, sealSigningKeyId: true, sealSigningKeyVersion: true, sealSigningKeySha256: true },
    }),
  ]);
  const latestVersion = latest?.version ?? null;
  const sealedByMaterial = packages.filter((p) =>
    madeByCompromised(keys, p.sealSigningKeyId, p.sealSigningKeyVersion, p.sealSigningKeySha256),
  );
  let custodyAttestations = false;
  if (record.teamId) {
    const signers = await client.$queryRaw<Array<{ key_id: string | null; key_version: string | null }>>`
      SELECT DISTINCT ("metadataJson"->>'keyId') AS key_id, ("metadataJson"->>'keyVersion') AS key_version
        FROM security_events
       WHERE "eventType" = 'custody_attestation_signed'
         AND "teamId" = ${record.teamId}::uuid
         AND ("metadataJson"->'attestation'->>'evidenceId') = ${evidenceId}`;
    custodyAttestations = signers.some(
      (s) => s.key_id != null && s.key_version != null && keys.identities.has(idKey(s.key_id, Number(s.key_version))),
    );
  }
  const outputs = {
    recordSignature: madeByCompromised(keys, record.signingKeyId, record.signingKeyVersion, record.signingKeySha256),
    packageSeal: sealedByMaterial.length > 0,
    latestPackageSeal:
      latestVersion != null && sealedByMaterial.some((p) => (p.reportVersion ?? p.version) === latestVersion),
    custodyAttestations,
  };
  if (!outputs.recordSignature && !outputs.packageSeal && !outputs.custodyAttestations) return null;

  let replacement: KeyCompromiseReplacementState;
  if (outputs.recordSignature) replacement = "RECORD_SIGNATURE_NOT_REPLACEABLE";
  else {
    const live = await client.reportGenerationRequest.findFirst({
      where: { evidenceId, purpose: SIGNING_KEY_COMPROMISE_REPLACEMENT_PURPOSE, state: { in: LIVE_REQUEST_STATES } },
      select: { id: true },
    });
    if (live) replacement = "IN_PROGRESS";
    else if (outputs.latestPackageSeal && latestVersion != null) {
      // RG-03 (PRO-O1Z-01) — a record whose lifecycle refuses every new output
      // (archived, trashed, pending destruction...) is not offered a control
      // that the writer would refuse.
      const lifecycleRefusal = outputLifecycleRefusal(record as never);
      const attempt = lifecycleRefusal ? null : await replacementAttempt(evidenceId, latestVersion, client);
      if (lifecycleRefusal) replacement = "NOT_OFFERED";
      else if (attempt!.otherForcedLive) replacement = "IN_PROGRESS";
      else if (attempt!.latest?.state === "SUCCEEDED") replacement = "IN_PROGRESS";
      else if (attempt!.latest && attempt!.nextOrdinal >= MAX_TERMINAL_SUPERSESSIONS) replacement = "FAILED";
      // PRO-W1-08 — a terminal attempt within the bound is offered again.
      else replacement = (await replacementSignersUsable(client)) ? "AVAILABLE" : "NO_TRUSTWORTHY_SIGNER";
    } else if (outputs.packageSeal) replacement = "LATEST_UNAFFECTED";
    else replacement = "NOT_OFFERED";
  }
  return { outputs, replacement, latestVersion };
}

function replacementKey(evidenceId: string, version: number): string {
  return `${SIGNING_KEY_COMPROMISE_REPLACEMENT_KEY_PREFIX}${evidenceId}:v${version}`;
}

/** Attempt k's client key: attempt 0 keeps the historical key (existing rows replay). */
function replacementAttemptKey(evidenceId: string, version: number, ordinal: number): string {
  const base = replacementKey(evidenceId, version);
  return ordinal === 0 ? base : `${base}:a${ordinal}`;
}

/**
 * RG-03 (PRO-W1-08 / PRO-O1-01 / PRO-W1-02) — where the replacement of one
 * report version stands.
 *
 *   * attempts are this purpose's rows for the version, keyed
 *     `compromise-reissue:<id>:v<N>` then `…:a1`, `…:a2`; the latest
 *     attempt decides: live or SUCCEEDED is in progress; a terminal
 *     non-success is followed by attempt k+1 while k+1 < the shared
 *     MAX_TERMINAL_SUPERSESSIONS bound (the fixed key used to replay the dead
 *     row forever);
 *   * a live FORCED report request of ANOTHER purpose at this record is
 *     reported as in progress, never collapsed onto or answered "ok" for.
 */
async function replacementAttempt(
  evidenceId: string,
  version: number,
  client: PrismaClient,
): Promise<{
  latest: { state: string; clientRequestKey: string } | null;
  nextOrdinal: number;
  otherForcedLive: boolean;
}> {
  const base = replacementKey(evidenceId, version);
  const rows = (
    await client.reportGenerationRequest.findMany({
      where: { evidenceId, clientRequestKey: { startsWith: base } },
      select: { state: true, clientRequestKey: true },
    })
  ).filter((r) => r.clientRequestKey === base || (r.clientRequestKey ?? "").startsWith(`${base}:a`));
  const ordinalOf = (key: string) => (key === base ? 0 : Number.parseInt(key.slice(base.length + 2), 10) || 0);
  let latest: { state: string; clientRequestKey: string } | null = null;
  let latestOrdinal = -1;
  for (const r of rows) {
    const o = ordinalOf(r.clientRequestKey as string);
    if (o > latestOrdinal) {
      latestOrdinal = o;
      latest = { state: r.state, clientRequestKey: r.clientRequestKey as string };
    }
  }
  const otherForcedLive =
    (await client.reportGenerationRequest.findFirst({
      where: {
        evidenceId,
        artifactType: "REPORT",
        forceRegenerate: true,
        state: { in: LIVE_REQUEST_STATES },
        NOT: { purpose: SIGNING_KEY_COMPROMISE_REPLACEMENT_PURPOSE },
      },
      select: { id: true },
    })) !== null;
  return { latest, nextOrdinal: latestOrdinal + 1, otherForcedLive };
}

/**
 * The record's key-compromise state for its owner's clients (artifact status
 * `keyCompromise`); null = nothing of this record was made by withdrawn key
 * material. `callerMayRequest` is the caller's generate-outputs right (the
 * regenerate route's own access check, `evidence.generate_report`).
 */
export async function describeRecordKeyCompromise(
  input: { evidenceId: string; callerMayRequest: boolean },
  client: PrismaClient = defaultPrisma,
): Promise<RecordKeyCompromise | null> {
  const keys = await loadCompromisedKeys(client);
  if (!keys) return null;
  const evaluated = await evaluateRecordKeyCompromise(input.evidenceId, keys, client);
  if (!evaluated) return null;
  const { outputs, replacement, latestVersion } = evaluated;
  return {
    outputs,
    replacement,
    replacesReportVersion:
      replacement === "AVAILABLE" || replacement === "IN_PROGRESS" || replacement === "FAILED" ? latestVersion : null,
    callerMayRequest: input.callerMayRequest,
  };
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
        | "not_requested"
        | "other_request_active"
        | "replacement_attempts_exhausted";
      reason?: string;
    };

/**
 * Ask for the linked replacement of a record's latest output pair after its
 * package seal key was compromised. The caller's access to the record is the
 * route's (`evidence.generate_report`); everything else is decided here, by
 * the same evaluation the clients read.
 */
export async function requestKeyCompromiseReplacement(
  input: { evidenceId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<KeyCompromiseReplacementResult> {
  const exists = await client.evidence.findUnique({ where: { id: input.evidenceId }, select: { id: true } });
  if (!exists) return { ok: false, code: "not_found" };
  const keys = await loadCompromisedKeys(client);
  const evaluated = keys ? await evaluateRecordKeyCompromise(input.evidenceId, keys, client) : null;
  if (!evaluated || evaluated.latestVersion == null) return { ok: false, code: "not_affected" };
  switch (evaluated.replacement) {
    case "RECORD_SIGNATURE_NOT_REPLACEABLE":
      return { ok: false, code: "record_signature_not_replaceable" };
    case "NO_TRUSTWORTHY_SIGNER":
      return { ok: false, code: "no_trustworthy_signer" };
    case "LATEST_UNAFFECTED":
    case "NOT_OFFERED":
      return { ok: false, code: "not_affected" };
    case "IN_PROGRESS":
    case "FAILED":
      if (!evaluated.outputs.latestPackageSeal) return { ok: false, code: "not_affected" };
      break;
    case "AVAILABLE":
      break;
  }
  const latest = evaluated.latestVersion;
  const attempt = await replacementAttempt(input.evidenceId, latest, client);
  // PRO-W1-02 — another purpose's forced request is running for this record:
  // say so; never answer "ok" with someone else's request.
  if (attempt.otherForcedLive && !(attempt.latest && !isTerminalJobExecutionState(attempt.latest.state))) {
    return { ok: false, code: "other_request_active" };
  }
  // A live or succeeded attempt is replayed; a terminal non-success attempt is
  // followed by the next one within the bound (PRO-W1-08).
  let ordinal = 0;
  if (attempt.latest) {
    const replay = !isTerminalJobExecutionState(attempt.latest.state) || attempt.latest.state === "SUCCEEDED";
    if (replay) ordinal = attempt.nextOrdinal - 1;
    else if (attempt.nextOrdinal >= MAX_TERMINAL_SUPERSESSIONS) {
      return { ok: false, code: "replacement_attempts_exhausted" };
    } else ordinal = attempt.nextOrdinal;
  }
  const key = replacementAttemptKey(input.evidenceId, latest, ordinal);
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
    // The replacement's own request identity: never another purpose's chain.
    systemReissueIdentity: `kc${ordinal}`,
    regenerateReason: `key_compromise_replacement_v${latest}`,
    requestedByUserId: input.actorUserId,
  });
  if (!requested.requested) return { ok: false, code: "not_requested", reason: requested.reason };
  return {
    ok: true,
    requestId: requested.requestId,
    replayed: before !== null,
    outcome: requested.outcome,
    replacesReportVersion: latest,
  };
}

/**
 * RG-03 (PRO-O1-13) — THE DURABLE CONTINUATION of every recent key-compromise
 * declaration's owner notices.
 *
 * A declaration notifies at most KEY_COMPROMISE_INLINE_NOTICE_LIMIT subjects
 * inline; records beyond it were `deferred`, and a failed notice transaction
 * was counted and dropped — completed only if an operator declared the same
 * compromise again. The platform maintenance sweep now calls this every tick:
 * for each compromised key material revoked within the lookback it runs the
 * same idempotent fan-out (one notice per recipient, record and compromise,
 * decided under the per-record lock), bounded per call. No schema: the notice
 * rows themselves are the progress record.
 */
export const KEY_COMPROMISE_CONTINUATION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
export const KEY_COMPROMISE_CONTINUATION_LIMIT = 200;

export async function continueKeyCompromiseNotices(
  input: { now?: Date; inlineLimit?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<{ materials: number; noticesWritten: number; deferred: number; failed: number }> {
  const now = input.now ?? new Date();
  const revoked = await client.signingKey.findMany({
    where: { revokedAt: { gte: new Date(now.getTime() - KEY_COMPROMISE_CONTINUATION_LOOKBACK_MS) } },
    select: { keyId: true, version: true, publicKeyPem: true, fingerprintSha256: true, revokedAt: true },
    take: 50,
  });
  const byFingerprint = new Map<string, Array<{ keyId: string; version: number }>>();
  for (const r of revoked) {
    let fp = r.fingerprintSha256?.toLowerCase() ?? null;
    if (!fp) {
      try {
        fp = publicKeySpkiSha256(r.publicKeyPem);
      } catch {
        fp = null;
      }
    }
    if (!fp) continue;
    const list = byFingerprint.get(fp) ?? [];
    list.push({ keyId: r.keyId, version: r.version });
    byFingerprint.set(fp, list);
  }
  let budget = Math.max(0, Math.trunc(input.inlineLimit ?? KEY_COMPROMISE_CONTINUATION_LIMIT));
  const out = { materials: 0, noticesWritten: 0, deferred: 0, failed: 0 };
  for (const [fp, keyIdentities] of byFingerprint) {
    // Only material DECLARED compromised (an authorization-only revocation is
    // not a compromise and owes no notice).
    const declaredAt = await keyMaterialCompromisedAt(client, fp).catch(() => null);
    if (!declaredAt) continue;
    out.materials += 1;
    const summary = await notifyOwnersOfKeyCompromise(
      { fingerprints: [fp], keyIdentities, declaredAt, actorUserId: null, inlineLimit: budget },
      client,
    );
    const written = summary.inAppNotices;
    out.noticesWritten += written;
    out.deferred += summary.deferred;
    out.failed += summary.failed;
    budget = Math.max(0, budget - written);
  }
  return out;
}
