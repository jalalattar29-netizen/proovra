/**
 * PHASE 12 — POINT 5: bounded legacy payload compatibility.
 *
 * The canonical decoder is strict — an unknown field is a rejection, not
 * something to strip. That is correct for anything a Point-5 producer emits,
 * and wrong for the jobs already sitting in Redis when the converged build
 * deploys. Those were written by the old producers, carry the old shape, and
 * would every one of them dead-letter.
 *
 * So compatibility is handled HERE, deliberately and separately, with four
 * properties that keep it from becoming a permanent hole:
 *
 *   1. PER-FAMILY. There is no general "accept anything old" path. Each family
 *      names the one field its old payload used as a reference. A legacy shape
 *      nobody registered is refused exactly like a malformed one.
 *
 *   2. REFERENCE ONLY. The decoder returns the id and nothing else. Tenant,
 *      policy, storage and kind fields that rode along are reported by NAME so
 *      they can be logged and alerted on, and their VALUES are discarded before
 *      the function returns. There is no accessor through which a caller could
 *      reach them.
 *
 *   3. BOUNDED. Every adapter declares the queue's maximum retention window and
 *      the exact drain command that proves no old job survives. The window is
 *      not a guess: it is the point past which BullMQ's own retention settings
 *      make a v0 job impossible.
 *
 *   4. REMOVABLE. Every adapter names an owner and a machine-checkable removal
 *      condition. The closure gate fails on an adapter missing either, which is
 *      what stops "temporary" from meaning "forever".
 */

import {
  QueuePayloadRejected,
  decodeCanonicalJobPayload,
  isAuthorityFieldName,
  isWellFormedTraceparent,
  type DecodedJobPayload,
} from "./payload.js";

/**
 * How long a job of the legacy shape can possibly survive in a queue.
 *
 * BullMQ retains completed jobs by count and failed jobs indefinitely unless
 * told otherwise, so the bound that actually matters is the DELAYED horizon:
 * the furthest into the future any producer scheduled work. The longest such
 * delay in the platform is the OTS upgrade follow-up ladder, which backs off to
 * roughly a day and is capped by a global budget anchored on evidence creation.
 * Seven days clears it with a wide margin.
 */
export const LEGACY_QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What can be done with a pre-Point-5 job still sitting in Redis.
 *
 * The distinction is not about convenience. It is about whether the old payload
 * contains a DURABLE ENTITY ID from which every authority can be reloaded:
 *
 *   `adaptable`   — it does. The adapter extracts that id, discards every
 *                   tenant/policy/storage field that rode along, and the
 *                   processor reloads current truth exactly as it would for a
 *                   canonical job. Nothing about the old payload is believed
 *                   except the reference itself.
 *
 *   `quarantine`  — it does not, OR it carries an authorization outcome that
 *                   cannot be reconstructed. Running it would mean inventing
 *                   the missing authority. The job is dead-lettered with a
 *                   bounded reason, creates NO external side effect, is visible
 *                   to operators, and can only re-enter through an
 *                   owner-approved replay that creates a fresh canonical
 *                   request.
 *
 * A shape must be one or the other. "Unclassified" is the state this type
 * exists to make impossible.
 */
export type LegacyJobDisposition = "adaptable" | "quarantine";

export type LegacyPayloadAdapter = {
  /** The job this adapter decodes for. */
  jobName: string;
  disposition: LegacyJobDisposition;
  /** The exact old payload shape, for the reader who has to evaluate this. */
  oldSchema: string;
  /**
   * Legacy schema versions accepted. `0` means "pre-Point-5 raw payload with
   * no schemaVersion field at all", which is the only legacy shape that exists
   * today — Point 5 is the first versioning of these payloads.
   */
  acceptedVersions: ReadonlyArray<number>;
  /**
   * Pulls the durable authority reference out of the old shape.
   *
   * Returning `null` is meaningful: it means THIS PARTICULAR JOB lacks the
   * durable id its family normally carries, so it falls to quarantine even
   * though the family is adaptable. That is the `runId`-less
   * media-intelligence job and the part-less extraction job.
   */
  readReference: (raw: Record<string, unknown>) => string | null;
  /**
   * Authority-shaped fields this shape is KNOWN to carry, listed so the
   * closure gate can assert each one is discarded rather than read.
   */
  discardsAuthorityFields: ReadonlyArray<string>;
  /** Longest a job of this shape can still exist. */
  maxQueueRetentionMs: number;
  /** The command an operator runs to MEASURE the remaining backlog. */
  backlogCommand: string;
  /** The command whose zero-result output permits deletion of this adapter. */
  drainCommand: string;
  /** The machine-checkable condition under which this adapter is deleted. */
  removalCondition: string;
  /** Team accountable for removing it. */
  owner: string;
};

/**
 * Decode a legacy payload through a registered adapter.
 *
 * Returns the reference plus the NAMES of the authority-shaped fields that were
 * present and discarded. Callers log those names; nothing reads their values,
 * because nothing can.
 */
export function decodeLegacyJobPayload(
  adapter: LegacyPayloadAdapter,
  raw: unknown,
): DecodedJobPayload & { discardedAuthorityFields: ReadonlyArray<string> } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new QueuePayloadRejected(
      "malformed_payload",
      `${adapter.jobName}: legacy payload is not an object`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const version =
    typeof obj.schemaVersion === "number" ? obj.schemaVersion : 0;
  if (!adapter.acceptedVersions.includes(version)) {
    throw new QueuePayloadRejected(
      "unknown_schema_version",
      `${adapter.jobName}: legacy schemaVersion ${version} is not accepted`,
    );
  }

  const discarded = Object.keys(obj).filter(isAuthorityFieldName);

  // A shape classified `quarantine` never yields a reference, by construction.
  if (adapter.disposition === "quarantine") {
    throw new LegacyJobQuarantined({
      jobName: adapter.jobName,
      reason: "shape_not_safely_adaptable",
      discardedAuthorityFields: discarded,
    });
  }

  const reference = adapter.readReference(obj);
  if (!reference || !reference.trim()) {
    // The FAMILY is adaptable but THIS job is not: it lacks the durable id its
    // family normally carries. `runId` on a media-intelligence job and
    // `evidencePartId` on an extraction job were both optional, so such jobs
    // genuinely exist. Quarantine rather than reject, because the distinction
    // matters to an operator: a malformed payload is a bug, whereas this is a
    // job that was legitimately produced before the durable row was mandatory.
    throw new LegacyJobQuarantined({
      jobName: adapter.jobName,
      reason: "no_durable_reference_in_payload",
      discardedAuthorityFields: discarded,
    });
  }

  // Pre-Point-5 producers carried the trace context under `_otel.traceparent`.
  // Reading it keeps a draining job's span attached to the request that
  // created it; a malformed carrier is simply dropped, because a legacy job is
  // already being decoded leniently and losing a trace is not worth a failure.
  const otel = obj._otel;
  const legacyTraceparent =
    otel !== null && typeof otel === "object" && !Array.isArray(otel)
      ? (otel as Record<string, unknown>).traceparent
      : undefined;

  return {
    commandId: reference.trim(),
    traceId:
      typeof obj.trace === "string"
        ? obj.trace.slice(0, 64)
        : typeof obj.reason === "string"
          ? obj.reason.slice(0, 64)
          : "",
    schemaVersion: version,
    traceparent: isWellFormedTraceparent(legacyTraceparent)
      ? legacyTraceparent
      : null,
    legacy: true,
    discardedAuthorityFields: discarded,
  };
}

/** Read a string property, or null. Shared by the adapters below. */
function str(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Build the standard removal condition text for an adapter.
 *
 * One sentence, one command, one deadline — so the condition can be evaluated
 * by someone who was not present when it was written.
 */
function removalCondition(queueName: string): string {
  return (
    `Delete this adapter once \`pnpm --filter proovra-api queue:drain-check -- --queue=${queueName}\` ` +
    `reports zero jobs across every state whose payload lacks \`schemaVersion\`. ` +
    `The check is the gate; ${LEGACY_QUEUE_RETENTION_MS / (24 * 60 * 60 * 1000)} days after the ` +
    `converged producers deploy, no such job can exist and the check is guaranteed to pass.`
  );
}

/**
 * Registered legacy adapters, keyed by job name.
 *
 * A job with no entry here has NO legacy path: its payload must be canonical.
 * That is the default, and most jobs stay on it.
 */
/** The measurement an operator runs to see how much of a shape is left. */
function backlogCommand(queueName: string): string {
  return `pnpm --filter proovra-api queue:drain-check -- --queue=${queueName} --count-only`;
}

/**
 * Every pre-Point-5 payload shape, classified.
 *
 * A job whose family has no entry here has NO legacy path: its payload must be
 * canonical, and anything else is refused. That remains the default.
 *
 * The entries below exist because Point 5 CHANGED those payload
 * shapes. Without them, every job already sitting in Redis when the
 * converged build deploys would be refused — fail-safe, but lossy, and a
 * deployment plan that silently discards in-flight evidence work is not one
 * anybody would approve if it were stated out loud. So each shape is stated out
 * loud, with its disposition.
 *
 * Nothing here trusts a legacy field. `readReference` returns an id and the
 * decoder discards the rest by construction — `decodeLegacyJobPayload` returns
 * the NAMES of the authority fields it dropped and no accessor for their
 * values.
 */
export const LEGACY_PAYLOAD_ADAPTERS: ReadonlyArray<LegacyPayloadAdapter> = [
  // ---- Family 1: redaction --------------------------------------------------
  {
    jobName: "RenderRedactionDerivative",
    disposition: "adaptable",
    oldSchema: "{ derivativeId, teamId?, signedUrl?, trace? }",
    acceptedVersions: [0],
    readReference: (raw) => str(raw, "derivativeId"),
    discardsAuthorityFields: ["teamId", "signedUrl"],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("redaction-derivative"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=redaction-derivative",
    removalCondition: removalCondition("redaction-derivative"),
    owner: "platform-redaction",
  },

  // ---- Family 8: reconciliation (search projection) -------------------------
  {
    jobName: "RebuildSearchDocument",
    disposition: "adaptable",
    oldSchema: "{ teamId, kind, sourceId, reason }",
    acceptedVersions: [0],
    // The reference is the composite `<kind>:<sourceId>`; `teamId` and
    // `reason` are discarded. The kind is re-validated against the closed
    // catalog by `parseSearchIndexCommandId` before any database access.
    readReference: (raw) => {
      const kind = str(raw, "kind");
      const sourceId = str(raw, "sourceId");
      return kind && sourceId ? `${kind}:${sourceId}` : null;
    },
    discardsAuthorityFields: ["teamId"],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("search-indexing"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=search-indexing",
    removalCondition: removalCondition("search-indexing"),
    owner: "platform-search",
  },

  // ---- Family 4: reports and packages ---------------------------------------
  {
    jobName: "GenerateReportJob",
    disposition: "adaptable",
    oldSchema: "{ evidenceId, forceRegenerate?, regenerateReason? }",
    acceptedVersions: [0],
    // The evidence id IS durable, so the job can run — but `forceRegenerate` is
    // the authorization outcome this whole phase exists to remove from the wire.
    // The processor mints a NON-FORCE `ReportGenerationRequest` from this
    // reference, so a draining payload can produce a first artifact and can NOT
    // overwrite a finalised one. A legacy job cannot escalate its own
    // privileges by surviving in a queue.
    readReference: (raw) => str(raw, "evidenceId"),
    discardsAuthorityFields: ["forceRegenerate"],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("report"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=report",
    removalCondition: removalCondition("report"),
    owner: "platform-evidence",
  },

  // ---- Family 3: retention and destruction ----------------------------------
  {
    jobName: "PurgeDeletedEvidenceJob",
    disposition: "adaptable",
    oldSchema:
      "Phase-X.1 envelope { kind, idempotencyKey, correlationId, teamId, body: { evidenceId } }",
    acceptedVersions: [0],
    // The evidence id is nested inside the retired envelope's `body`. Read from
    // both shapes: the envelope, and the even older raw `{ evidenceId }`.
    readReference: (raw) => {
      const direct = str(raw, "evidenceId");
      if (direct) return direct;
      const body = raw.body;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        return str(body as Record<string, unknown>, "evidenceId");
      }
      return null;
    },
    discardsAuthorityFields: ["teamId"],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("evidence-purge"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=evidence-purge",
    removalCondition: removalCondition("evidence-purge"),
    owner: "platform-lifecycle",
  },

  // ---- Family 7: evidence finalization --------------------------------------
  {
    jobName: "UpgradeOts",
    disposition: "adaptable",
    oldSchema: "{ evidenceId, _otel? }",
    acceptedVersions: [0],
    readReference: (raw) => str(raw, "evidenceId"),
    discardsAuthorityFields: [],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("ots-upgrade"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=ots-upgrade",
    removalCondition: removalCondition("ots-upgrade"),
    owner: "platform-evidence",
  },

  // ---- Family 9: intelligence and operations --------------------------------
  {
    jobName: "RunMediaIntelligence",
    disposition: "adaptable",
    oldSchema: "{ teamId, evidenceId, kind, runId?, evidencePartId?, textKind? }",
    acceptedVersions: [0],
    // `runId` was OPTIONAL, and that is exactly the hole. A job that carries one
    // names a durable run row and adapts cleanly. A job that does NOT has no
    // durable row anywhere — the producer was permitted to skip creating it —
    // so there is nothing to reload authority from and nothing for a reconciler
    // to find. Returning null routes it to quarantine rather than inventing a
    // run row on a tampered `teamId`.
    readReference: (raw) => str(raw, "runId"),
    discardsAuthorityFields: ["teamId"],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("media-intelligence"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=media-intelligence",
    removalCondition: removalCondition("media-intelligence"),
    owner: "platform-intelligence",
  },
  {
    jobName: "ExtractExif",
    disposition: "adaptable",
    oldSchema: "{ teamId, evidenceId, kind, evidencePartId?, runId? }",
    acceptedVersions: [0],
    // The EXIF job reads ONE part's bytes, so the part is its authority. A job
    // without `evidencePartId` never named the thing it was going to read.
    readReference: (raw) => str(raw, "evidencePartId"),
    discardsAuthorityFields: ["teamId"],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("mi-exif"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=mi-exif",
    removalCondition: removalCondition("mi-exif"),
    owner: "platform-intelligence",
  },
  // PHASE 12 POINT 5 — the `ExtractOcr` and `ExtractTranscript` adapters were
  // removed with their queues. An adapter exists to decode jobs ALREADY IN
  // REDIS when the converged build deploys; `enqueueOcrJob` and
  // `enqueueTranscriptJob` had no caller in any commit of this repository, so
  // `mi-ocr` and `mi-transcript` have never held a job and no such payload can
  // exist. Retaining an adapter for a shape that cannot occur is the
  // "temporary forever" state the removal condition above exists to prevent.
  {
    jobName: "EmbedSemanticChunks",
    disposition: "adaptable",
    oldSchema: "{ teamId, chunkIds: string[<=200], reason }",
    acceptedVersions: [0],
    // The FIRST chunk id is the anchor. The rest of the list is deliberately
    // dropped rather than honoured: it was a snapshot taken at enqueue time, and
    // re-embedding chunks that have since been embedded spends provider budget
    // on completed work. The processor re-derives the batch from current state.
    readReference: (raw) => {
      const ids = raw.chunkIds;
      if (!Array.isArray(ids) || ids.length === 0) return null;
      const first = ids[0];
      return typeof first === "string" && first.trim() ? first.trim() : null;
    },
    discardsAuthorityFields: ["teamId"],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("mi-embed"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=mi-embed",
    removalCondition: removalCondition("mi-embed"),
    owner: "platform-search",
  },
  {
    jobName: "GenerateDerivedAsset",
    disposition: "quarantine",
    oldSchema: "{ teamId, evidenceId, evidencePartId, assetKind }",
    acceptedVersions: [0],
    // QUARANTINE, and the reason is worth stating precisely: the old payload
    // has no id for an `EvidencePartDerivedAsset` row, because the producer
    // never created one. The row could be reconstructed from
    // (evidencePartId, assetKind) — but `assetKind` selects WHICH PIPELINE RUNS
    // (sharp vs ffmpeg), and reconstructing a durable row from an untrusted
    // discriminator is exactly the move this phase removes. These jobs
    // dead-letter with a bounded reason and are replayed by an operator, which
    // creates a fresh canonical request through the authorized route.
    readReference: () => null,
    discardsAuthorityFields: ["teamId"],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("mi-derived-assets"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=mi-derived-assets",
    removalCondition: removalCondition("mi-derived-assets"),
    owner: "platform-intelligence",
  },

  // ---- Family 8: reconciliation (workspace projections) ---------------------
  //
  // All five carry `{ teamId, reason }` (graph-domain-sync adds `domain`). The
  // `teamId` here is not an assertion to be believed — it is a Team ROW ID, and
  // the processor resolves it to a live workspace whose Organization must still
  // be ACTIVE before anything runs. A tampered value causes another workspace's
  // own projection to be rebuilt from that workspace's own rows: bounded,
  // non-escalating, idempotent, and refused outright if the org is suspended.
  {
    jobName: "IndexMediaIntelligence",
    disposition: "adaptable",
    oldSchema: "{ teamId, evidenceId, reason }",
    acceptedVersions: [0],
    readReference: (raw) => str(raw, "evidenceId"),
    discardsAuthorityFields: ["teamId"],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("mi-search-index"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=mi-search-index",
    removalCondition: removalCondition("mi-search-index"),
    owner: "platform-search",
  },
  {
    jobName: "ReconcileTeamGraph",
    disposition: "adaptable",
    oldSchema: "{ teamId, reason, evidenceId?, requestedByUserId?, requestId? }",
    acceptedVersions: [0],
    readReference: (raw) => str(raw, "teamId"),
    discardsAuthorityFields: [],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("graph-reconcile"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=graph-reconcile",
    removalCondition: removalCondition("graph-reconcile"),
    owner: "platform-intelligence",
  },
  {
    jobName: "SyncTeamGraphDomain",
    disposition: "adaptable",
    oldSchema: "{ teamId, domain?, reason? }",
    acceptedVersions: [0],
    // The domain becomes the first half of the composite command id and is
    // re-validated against the closed catalog. An unknown legacy domain
    // therefore fails at decode instead of producing a job the processor
    // silently completes as a no-op, which is what used to happen.
    readReference: (raw) => {
      const teamId = str(raw, "teamId");
      if (!teamId) return null;
      const domain = str(raw, "domain") ?? "all";
      return `${domain}:${teamId}`;
    },
    discardsAuthorityFields: [],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("graph-domain-sync"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=graph-domain-sync",
    removalCondition: removalCondition("graph-domain-sync"),
    owner: "platform-intelligence",
  },
  {
    jobName: "SyncTeamGraphTimeline",
    disposition: "adaptable",
    oldSchema: "{ teamId, reason? }",
    acceptedVersions: [0],
    readReference: (raw) => str(raw, "teamId"),
    discardsAuthorityFields: [],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("graph-timeline-sync"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=graph-timeline-sync",
    removalCondition: removalCondition("graph-timeline-sync"),
    owner: "platform-intelligence",
  },
  {
    jobName: "RefreshGraphSearchProjection",
    disposition: "adaptable",
    oldSchema: "{ teamId, reason? }",
    acceptedVersions: [0],
    readReference: (raw) => str(raw, "teamId"),
    discardsAuthorityFields: [],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("graph-search-projection"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=graph-search-projection",
    removalCondition: removalCondition("graph-search-projection"),
    owner: "platform-search",
  },
  {
    jobName: "RefreshOrgHealthProjection",
    disposition: "adaptable",
    oldSchema: "{ teamId }",
    acceptedVersions: [0],
    readReference: (raw) => str(raw, "teamId"),
    discardsAuthorityFields: [],
    maxQueueRetentionMs: LEGACY_QUEUE_RETENTION_MS,
    backlogCommand: backlogCommand("org-health-refresh"),
    drainCommand:
      "pnpm --filter proovra-api queue:drain-check -- --queue=org-health-refresh",
    removalCondition: removalCondition("org-health-refresh"),
    owner: "platform-operations",
  },
];

export function getLegacyAdapter(
  jobName: string,
): LegacyPayloadAdapter | null {
  return (
    LEGACY_PAYLOAD_ADAPTERS.find((a) => a.jobName === jobName) ?? null
  );
}

export type DecodedWithProvenance = DecodedJobPayload & {
  /** Authority-shaped field names discarded from a legacy payload. Always
   *  empty for a canonical payload, because a canonical payload carrying one
   *  is REJECTED rather than cleaned. */
  discardedAuthorityFields: ReadonlyArray<string>;
};

/**
 * The decode every processor calls.
 *
 * Canonical first, strictly. Only if the payload is not canonical does a
 * registered legacy adapter get a turn, and only for the job it was registered
 * against. A job with no adapter has exactly one accepted shape.
 *
 * The ordering is what keeps strictness meaningful: a payload that IS canonical
 * but carries an extra `teamId` fails here and never reaches the legacy path,
 * because the legacy path is for old shapes, not for new shapes with smuggled
 * fields.
 */
export function decodeJobPayload(
  expect: { jobName: string; schemaVersion: number },
  raw: unknown,
): DecodedWithProvenance {
  const looksCanonical =
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof (raw as Record<string, unknown>).schemaVersion === "number";

  if (looksCanonical) {
    return {
      ...decodeCanonicalJobPayload(expect, raw),
      discardedAuthorityFields: [],
    };
  }

  const adapter = getLegacyAdapter(expect.jobName);
  if (!adapter) {
    // No registered legacy shape: run the canonical decoder so the caller gets
    // its precise rejection code rather than a generic "no adapter" error.
    return {
      ...decodeCanonicalJobPayload(expect, raw),
      discardedAuthorityFields: [],
    };
  }
  return decodeLegacyJobPayload(adapter, raw);
}

/**
 * Adapters missing a removal condition, drain command, retention bound or
 * owner. The closure gate asserts this is empty — that assertion is what makes
 * `TemporaryPayloadAdaptersWithoutCondition = 0` a measurement.
 */
export function findAdaptersWithoutRemovalCondition(
  adapters: ReadonlyArray<LegacyPayloadAdapter> = LEGACY_PAYLOAD_ADAPTERS,
): string[] {
  return adapters
    .filter(
      (a) =>
        !a.removalCondition.trim() ||
        !a.drainCommand.trim() ||
        !a.backlogCommand.trim() ||
        !a.oldSchema.trim() ||
        !a.owner.trim() ||
        !(a.maxQueueRetentionMs > 0) ||
        a.acceptedVersions.length === 0,
    )
    .map((a) => a.jobName);
}

// ===========================================================================
// Quarantine
// ===========================================================================

/**
 * A legacy job that cannot be adapted.
 *
 * Thrown, not returned, so it cannot be mistaken for a decode result and
 * accidentally run. The processor catches it, dead-letters the job with this
 * bounded reason and completes — the job disappears from the live queue but NOT
 * from the operator's view, and it produces no external side effect on the way
 * out.
 *
 * The alternative designs were both worse. Silently dropping it loses evidence
 * work with no record. Running it anyway means inventing the authority the
 * payload failed to carry, which is the exact failure mode this phase exists to
 * remove — and doing it at the moment the system is least sure of itself.
 */
export class LegacyJobQuarantined extends Error {
  readonly code = "legacy_job_quarantined" as const;
  readonly jobName: string;
  readonly reason: string;
  /** Authority-shaped field names the payload carried. NAMES only. */
  readonly discardedAuthorityFields: ReadonlyArray<string>;

  constructor(input: {
    jobName: string;
    reason: string;
    discardedAuthorityFields?: ReadonlyArray<string>;
  }) {
    super(`${input.jobName}: legacy job quarantined (${input.reason})`);
    this.name = "LegacyJobQuarantined";
    this.jobName = input.jobName;
    this.reason = input.reason;
    this.discardedAuthorityFields = input.discardedAuthorityFields ?? [];
  }
}

/** Shapes classified `quarantine`, for the closure gate and the runbook. */
export function getQuarantinedLegacyShapes(
  adapters: ReadonlyArray<LegacyPayloadAdapter> = LEGACY_PAYLOAD_ADAPTERS,
): ReadonlyArray<LegacyPayloadAdapter> {
  return adapters.filter((a) => a.disposition === "quarantine");
}

/**
 * Job names whose payload shape CHANGED in Point 5 but which have no registered
 * adapter — i.e. shapes nobody classified.
 *
 * The closure gate asserts this is empty. That is what makes
 * `UnclassifiedLegacyJobShapes = 0` a measurement rather than a claim: the
 * caller passes the set of changed job names and the function reports which of
 * them nothing has decided about.
 */
export function findUnclassifiedLegacyShapes(
  changedJobNames: ReadonlyArray<string>,
  adapters: ReadonlyArray<LegacyPayloadAdapter> = LEGACY_PAYLOAD_ADAPTERS,
): string[] {
  const known = new Set(adapters.map((a) => a.jobName));
  return changedJobNames.filter((j) => !known.has(j));
}
