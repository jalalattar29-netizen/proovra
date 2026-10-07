/**
 * RGA-02 — THE SERVER-AUTHORITATIVE OUTPUT OFFER.
 *
 * `/artifacts/status` hands every caller an opaque, signed offer revision that
 * binds every fact its confirmation depends on (see `OutputOfferBinding` in
 * @proovra/shared). The generation endpoint re-derives the binding from LIVE
 * facts immediately before it creates the durable request and refuses — with
 * the list of what changed — unless every bound field is equal, the revision is
 * unexpired, and it names this record, this workspace and this person.
 *
 * The revision is a stateless HMAC token, so a replay is harmless by
 * construction: once the request it confirmed exists, the binding it carries
 * (`activeRequest`, `latestReportVersion`, the decisions) no longer matches and
 * the replay is refused — while a lost-response retry carrying the SAME client
 * idempotency key is answered from the first request before any offer check.
 *
 * The signing key is derived from OUTPUT_OFFER_SECRET (or, when unset, from the
 * API's AUTH_JWT_SECRET under a distinct label), so every API instance verifies
 * every other instance's revisions and no key material is ever sent anywhere.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  NEW_VERSION_ACTION,
  OUTPUT_OFFER_BINDING_FIELDS,
  OUTPUT_OFFER_TTL_MS,
  REPORTABLE_CUSTODY_EVENT_TYPES,
  deriveReportFreshness,
  diffOutputOfferBindings,
  normalizeOtsAnchorCheck,
  resolveOtsCustodyFacts,
  resolveEffectiveOtsStatus,
  type OutputOfferBinding,
  type OutputOfferChangeCode,
  type OutputOfferEnvelope,
  type OutputOfferOperation,
  type ReportFreshness,
} from "@proovra/shared";
import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import type { LoadedOutputFacts } from "./output-recovery.service.js";

// ===========================================================================
// REPORTABLE FACTS
// ===========================================================================

export type ReportableFacts = {
  /** Canonical fingerprint of what a new report would state. */
  fingerprint: string;
  tsa: {
    status: string | null;
    validated: boolean;
    validatedAtUtc: string | null;
    failureCode: string | null;
    genTimeUtc: string | null;
  };
  ots: {
    /** Effective status: an ANCHORED row without an anchor time reads PENDING. */
    status: string | null;
    anchorCheck: string | null;
    anchoredAtUtc: string | null;
    /** When the current anchor check was recorded (custody), when known. */
    anchorCheckedAtUtc: string | null;
  };
  freshness: ReportFreshness;
};

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * The facts a report states that can change after it is issued, and which of
 * them are newer than the latest report. One evidence row, one report row and
 * one bounded custody aggregate.
 */
export async function loadReportableFacts(evidenceId: string): Promise<ReportableFacts> {
  const [ev, latest] = await Promise.all([
    prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: {
        status: true,
        tsaStatus: true,
        tsaValidatedAtUtc: true,
        tsaFailureCode: true,
        tsaGenTimeUtc: true,
        otsStatus: true,
        otsAnchoredAtUtc: true,
        otsUpgradedAtUtc: true,
        otsAnchorCheck: true,
        otsBitcoinTxid: true,
        lastVerifiedAtUtc: true,
      },
    }),
    prisma.report.findFirst({
      where: { evidenceId },
      orderBy: { version: "desc" },
      select: {
        version: true,
        generatedAtUtc: true,
        custodyThroughSequence: true,
        lastVerifiedAtUtcSnapshot: true,
      },
    }),
  ]);
  const reportableTypes = REPORTABLE_CUSTODY_EVENT_TYPES as prismaPkg.CustodyEventType[];
  const [maxReportable, afterReport, otsEvents] = await Promise.all([
    prisma.custodyEvent.aggregate({
      where: { evidenceId, eventType: { in: reportableTypes } },
      _max: { sequence: true },
    }),
    latest
      ? prisma.custodyEvent.aggregate({
          where: {
            evidenceId,
            eventType: { in: reportableTypes },
            ...(latest.custodyThroughSequence != null
              ? { sequence: { gt: latest.custodyThroughSequence } }
              : { atUtc: { gt: latest.generatedAtUtc } }),
          },
          _count: { _all: true },
          _max: { atUtc: true },
        })
      : Promise.resolve(null),
    // The OTS lifecycle events (few per record): when the proof was requested
    // and when its current check was recorded.
    prisma.custodyEvent.findMany({
      where: { evidenceId, eventType: prismaPkg.CustodyEventType.OTS_APPLIED },
      orderBy: { sequence: "asc" },
      select: { eventType: true, atUtc: true, payload: true },
    }),
  ]);

  const tsaStatus = ev?.tsaStatus ?? null;
  const otsStatus = resolveEffectiveOtsStatus({
    status: ev?.otsStatus ?? null,
    bitcoinTxid: ev?.otsBitcoinTxid ?? null,
    anchoredAtUtc: ev?.otsAnchoredAtUtc ?? null,
  });
  const anchorCheck = normalizeOtsAnchorCheck(ev?.otsAnchorCheck ?? null);
  const otsCustody = resolveOtsCustodyFacts(otsEvents, anchorCheck);
  const fingerprint = [
    `status:${ev?.status ?? "-"}`,
    `tsa:${tsaStatus ?? "-"}:${iso(ev?.tsaValidatedAtUtc) ?? "-"}:${ev?.tsaFailureCode ?? "-"}`,
    `ots:${otsStatus ?? "-"}:${iso(ev?.otsAnchoredAtUtc) ?? "-"}:${anchorCheck ?? "-"}`,
    `custody:${maxReportable._max.sequence ?? 0}`,
    `verified:${iso(ev?.lastVerifiedAtUtc) ?? "-"}`,
  ].join("|");

  return {
    fingerprint,
    tsa: {
      status: tsaStatus,
      validated: ev?.tsaValidatedAtUtc != null,
      validatedAtUtc: iso(ev?.tsaValidatedAtUtc),
      failureCode: ev?.tsaFailureCode ?? null,
      genTimeUtc: iso(ev?.tsaGenTimeUtc),
    },
    ots: {
      status: otsStatus,
      anchorCheck,
      anchoredAtUtc: otsStatus === "ANCHORED" ? iso(ev?.otsAnchoredAtUtc) : null,
      anchorCheckedAtUtc: otsCustody.anchorCheckedAtUtc,
    },
    freshness: deriveReportFreshness({
      reportVersion: latest?.version ?? null,
      reportGeneratedAtUtc: iso(latest?.generatedAtUtc),
      tsa: { status: tsaStatus, validatedAtUtc: iso(ev?.tsaValidatedAtUtc) },
      ots: {
        status: otsStatus,
        anchoredAtUtc: iso(ev?.otsAnchoredAtUtc),
        upgradedAtUtc: iso(ev?.otsUpgradedAtUtc),
        anchorCheck,
        anchorCheckedAtUtc: otsCustody.anchorCheckedAtUtc,
      },
      custodyAfterReport: {
        count: afterReport?._count._all ?? 0,
        latestAtUtc: iso(afterReport?._max.atUtc ?? null),
      },
      integrity: {
        lastVerifiedAtUtc: iso(ev?.lastVerifiedAtUtc),
        reportLastVerifiedAtUtc: iso(latest?.lastVerifiedAtUtcSnapshot),
      },
    }),
  };
}

// ===========================================================================
// THE BINDING
// ===========================================================================

const decision = (d: { action: string; operation?: string | null; reason?: string | null }) =>
  `${d.action}:${d.operation ?? d.reason ?? "-"}`;

/** The operation a confirmation on this record would start, in priority order. */
export function primaryOfferOperation(loaded: LoadedOutputFacts): {
  operation: OutputOfferOperation;
  targetVersion: number | null;
} {
  const { actions, facts } = loaded;
  const latest = facts.latestReportVersion;
  const map = (a: string): OutputOfferOperation | null =>
    a === "GENERATE" ? "GENERATE" : a === "RETRY" ? "RETRY" : a === "RECOVER" ? "RECOVER" : null;
  const rep = map(actions.report.action);
  if (rep) return { operation: rep, targetVersion: rep === "GENERATE" ? (latest ?? 0) + 1 : latest };
  const pkg = map(actions.verificationPackage.action);
  if (pkg) return { operation: pkg, targetVersion: latest };
  if (actions.newVersion.action === NEW_VERSION_ACTION) {
    return { operation: "NEW_VERSION", targetVersion: actions.newVersion.nextVersion };
  }
  return { operation: "NONE", targetVersion: null };
}

export function buildOutputOfferBinding(
  loaded: LoadedOutputFacts,
  reportable: ReportableFacts,
  callerUserId: string,
): OutputOfferBinding {
  const { actions, facts } = loaded;
  const newest = loaded.packageRequest;
  const estimate = loaded.newVersionEstimate;
  const { targetVersion } = primaryOfferOperation(loaded);
  return {
    evidenceId: loaded.evidenceId,
    workspaceId: loaded.workspaceId,
    callerUserId,
    latestReportVersion: facts.latestReportVersion,
    pairedPackageVersion: loaded.packageAtLatest?.version ?? null,
    latestPackageVersion: facts.latestPackageVersion,
    reportableFacts: reportable.fingerprint,
    tsa: `${reportable.tsa.status ?? "-"}|${reportable.tsa.validated ? "validated" : "not-validated"}`,
    ots: `${reportable.ots.status ?? "-"}|${reportable.ots.anchorCheck ?? "-"}`,
    reportAction: decision(actions.report),
    packageAction: decision(actions.verificationPackage),
    newVersionAction: `${actions.newVersion.action}:${actions.newVersion.reason ?? "-"}:v${actions.newVersion.nextVersion ?? "-"}`,
    targetVersion,
    activeRequest: newest ? `${newest.id}:${newest.state}` : "none",
    callerMayGenerate: facts.callerMayGenerate,
    eligibility: `${facts.reportEligibility}|${facts.packageEligibility}`,
    creditEffect: "NONE",
    storageEffect: `${estimate?.estimatedBytes ?? "unknown"}|${
      estimate?.fitsStorage == null ? "unknown" : estimate.fitsStorage ? "yes" : "no"
    }`,
    reasonRequired: actions.newVersion.action === NEW_VERSION_ACTION,
  };
}

// ===========================================================================
// SIGNING
// ===========================================================================

const PREFIX = "ofr1";

function offerKey(): Buffer {
  const secret =
    process.env.OUTPUT_OFFER_SECRET?.trim() || process.env.AUTH_JWT_SECRET?.trim() || "";
  if (secret.length < 16) {
    // Fail closed: without a key no revision can be issued or accepted.
    throw new Error("OUTPUT_OFFER_KEY_UNAVAILABLE");
  }
  return createHash("sha256").update(`proovra.output-offer.v1\u0000${secret}`).digest();
}

const b64u = (buf: Buffer) => buf.toString("base64url");

function mac(body: string): Buffer {
  return createHmac("sha256", offerKey()).update(`${PREFIX}.${body}`).digest();
}

type OfferPayload = { v: 1; c: number; x: number; b: OutputOfferBinding };

export function signOutputOffer(binding: OutputOfferBinding, nowMs = Date.now()): {
  revision: string;
  createdAtMs: number;
  expiresAtMs: number;
} {
  const payload: OfferPayload = { v: 1, c: nowMs, x: nowMs + OUTPUT_OFFER_TTL_MS, b: binding };
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  return { revision: `${PREFIX}.${body}.${b64u(mac(body))}`, createdAtMs: payload.c, expiresAtMs: payload.x };
}

export function openOutputOffer(
  revision: unknown,
): { ok: true; binding: OutputOfferBinding; createdAtMs: number; expiresAtMs: number } | { ok: false } {
  if (typeof revision !== "string" || revision.length > 8192) return { ok: false };
  const parts = revision.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false };
  const [, body, sig] = parts as [string, string, string];
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = mac(body);
    given = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OfferPayload;
    if (payload?.v !== 1 || typeof payload.c !== "number" || typeof payload.x !== "number" || !payload.b) {
      return { ok: false };
    }
    for (const k of OUTPUT_OFFER_BINDING_FIELDS) {
      if (!(k in payload.b)) return { ok: false };
    }
    return { ok: true, binding: payload.b, createdAtMs: payload.c, expiresAtMs: payload.x };
  } catch {
    return { ok: false };
  }
}

export type OfferCheck = { ok: true } | { ok: false; changes: OutputOfferChangeCode[] };

/**
 * THE CHECK made immediately before a durable request is created. Every bound
 * field is compared; the subject is compared first, so a revision lifted from
 * another record, workspace or person is refused as a mismatch even if the
 * rest happened to agree.
 */
export function checkOutputOffer(
  revision: unknown,
  current: OutputOfferBinding,
  nowMs = Date.now(),
): OfferCheck {
  const opened = openOutputOffer(revision);
  if (!opened.ok) return { ok: false, changes: ["OFFER_INVALID"] };
  const shown = opened.binding;
  if (
    shown.evidenceId !== current.evidenceId ||
    shown.workspaceId !== current.workspaceId ||
    shown.callerUserId !== current.callerUserId
  ) {
    return { ok: false, changes: ["SUBJECT_MISMATCH"] };
  }
  const changes = diffOutputOfferBindings(shown, current);
  if (nowMs > opened.expiresAtMs) changes.unshift("OFFER_EXPIRED");
  return changes.length === 0 ? { ok: true } : { ok: false, changes };
}

/** The envelope `/artifacts/status` sends beside the decisions. */
export function buildOutputOfferEnvelope(
  loaded: LoadedOutputFacts,
  reportable: ReportableFacts,
  callerUserId: string,
  nowMs = Date.now(),
): OutputOfferEnvelope {
  const binding = buildOutputOfferBinding(loaded, reportable, callerUserId);
  const signed = signOutputOffer(binding, nowMs);
  const { operation, targetVersion } = primaryOfferOperation(loaded);
  const estimate = loaded.newVersionEstimate;
  return {
    revision: signed.revision,
    createdAtUtc: new Date(signed.createdAtMs).toISOString(),
    expiresAtUtc: new Date(signed.expiresAtMs).toISOString(),
    operation,
    targetVersion,
    reasonRequired: binding.reasonRequired,
    creditEffect: { kind: "NONE" },
    storageEffect: {
      estimatedBytes: estimate?.estimatedBytes ?? null,
      fitsStorage: estimate?.fitsStorage ?? null,
      storageBytesUsed: estimate?.storageBytesUsed ?? null,
      storageBytesLimit: estimate?.storageBytesLimit ?? null,
    },
  };
}
