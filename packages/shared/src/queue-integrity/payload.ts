/**
 * PHASE 12 — POINT 5: the queue payload contract.
 *
 * A queue payload carries REFERENCES, never AUTHORITY:
 *
 *     { commandId, traceId, schemaVersion }
 *
 * `commandId` points at ONE durable authority row that an authorized
 * synchronous path already committed. Tenant, membership, plan, entitlement,
 * policy, retention, legal hold, storage location, provider secret and
 * lifecycle state are RELOADED from persistence by the processor — never read
 * off the wire.
 *
 * Redis being internal is not a trust boundary. A payload that can be written
 * can be tampered with; the only field a processor may believe is an opaque id
 * whose meaning it re-derives from the database.
 *
 * ---------------------------------------------------------------------------
 * STRICT, NOT SANITISING
 * ---------------------------------------------------------------------------
 * The canonical decoder REJECTS a payload carrying any field beyond the three
 * above. It does not strip and continue.
 *
 * That distinction matters. A decoder that silently drops `teamId` turns a
 * tampered payload into a successful job, which means an attacker who can write
 * to the queue gets unlimited free attempts and leaves no failure behind. A
 * decoder that rejects turns the same payload into a refusal that is counted,
 * logged and alertable. Stripping is a repair; the arrival of a field that
 * cannot legitimately exist is evidence, and evidence should stop the job.
 *
 * Legacy shapes are handled separately and explicitly — see `legacy.ts`. A
 * legacy decoder is per-family, treats every field except the reference as
 * untrusted, and carries a registered removal condition.
 */

// ===========================================================================
// Constants
// ===========================================================================

/** Current canonical payload schema version. */
export const CANONICAL_PAYLOAD_SCHEMA_VERSION = 1;

const TRACE_ID_MAX = 64;
const COMMAND_ID_MAX = 128;

/**
 * W3C TraceContext `traceparent`, exactly as the spec shapes it:
 *
 *     <version>-<trace-id>-<parent-id>-<flags>
 *
 * It is accepted on the canonical envelope because it is the one piece of
 * OPERATIONAL metadata whose loss is a real regression: before Point 5 every
 * producer injected an `_otel` carrier so an API request and its worker handler
 * appeared as one distributed trace, and converging onto a three-key envelope
 * would have silently deleted that. A traceparent is not authority — it names
 * no tenant, grants nothing and is re-derived from nothing — so carrying it
 * costs the contract nothing.
 *
 * It is validated by SHAPE rather than trusted: a malformed value is a
 * rejection, not something to pass through to the tracer.
 */
const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export function isWellFormedTraceparent(value: unknown): value is string {
  return typeof value === "string" && TRACEPARENT_PATTERN.test(value);
}

/** The ONLY keys a canonical payload may contain. */
export const CANONICAL_PAYLOAD_KEYS: ReadonlyArray<string> = [
  "commandId",
  "traceId",
  "schemaVersion",
  "traceparent",
];

export type CanonicalJobPayload = {
  commandId: string;
  traceId: string;
  schemaVersion: number;
  /** Present only when the producer was running inside a sampled trace. */
  traceparent?: string;
};

/**
 * Field names that may NEVER be trusted off a queue payload.
 *
 * The canonical decoder rejects ANY unknown field, so this catalog is not what
 * makes the canonical path safe — it is what makes the LEGACY path and the
 * static gate specific. It names the fields whose presence is worth reporting
 * as an authority violation rather than as generic schema noise.
 *
 * Alphabetical so additions stay reviewable.
 */
export const FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS: ReadonlyArray<string> = [
  "accessToken",
  "accountOwnerId",
  "aiPolicy",
  "apiKey",
  "authorizationResult",
  "bucket",
  "credential",
  "email",
  "emailAddress",
  "endpointUrl",
  "entitlement",
  "forceRegenerate",
  "inviteToken",
  "legalHold",
  "legalHoldResult",
  "membership",
  "modelId",
  "objectKey",
  "organizationId",
  "orgId",
  "phone",
  "phoneNumber",
  "plan",
  "planCode",
  "policy",
  "policyVersion",
  "presignedUrl",
  "providerSecret",
  "rawToken",
  "recipientEmail",
  "recipientPhone",
  "redactionPolicy",
  "retentionPolicy",
  "role",
  "seatLimit",
  "secret",
  "securityPolicy",
  "signedUrl",
  "storageBucket",
  "storageKey",
  "tenantKind",
  "token",
  "workspaceId",
  "workspaceKind",
];

const FORBIDDEN_FIELD_SET = new Set(
  FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS.map((f) => f.toLowerCase()),
);

/**
 * `teamId` deserves its own note.
 *
 * Per the workspace-model verdict, Team IS the workspace. `teamId` on a queue
 * payload is therefore exactly the forbidden `workspaceId`: a client-declared
 * tenant scope. It is listed separately only because pre-Point-5 payloads carry
 * it everywhere, so the legacy decoders need to name it specifically when
 * reporting what a draining job tried to assert.
 */
export const LEGACY_TENANT_PAYLOAD_FIELDS: ReadonlyArray<string> = [
  "teamId",
  "team_id",
  "workspaceId",
  "organizationId",
];

const LEGACY_TENANT_SET = new Set(
  LEGACY_TENANT_PAYLOAD_FIELDS.map((f) => f.toLowerCase()),
);

export function isAuthorityFieldName(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_FIELD_SET.has(lower) || LEGACY_TENANT_SET.has(lower);
}

// ===========================================================================
// Terminal vocabulary
// ===========================================================================

export const JOB_EXECUTION_STATES = [
  "QUEUED",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "BLOCKED_STALE",
  "BLOCKED_POLICY",
  /**
   * The external effect was attempted and its outcome is genuinely unknown — a
   * timeout, a dropped connection, a provider 5xx after the request was
   * accepted. Distinct from FAILED_* because a blind retry may duplicate a
   * side effect the recipient already saw. Only a reconciler that can observe
   * the provider's own record may move a row out of this state.
   */
  "UNKNOWN_PENDING_RECONCILIATION",
] as const;

export type JobExecutionState = (typeof JOB_EXECUTION_STATES)[number];

export const TERMINAL_JOB_EXECUTION_STATES: ReadonlyArray<JobExecutionState> = [
  "SUCCEEDED",
  "FAILED_TERMINAL",
  "BLOCKED_STALE",
  "BLOCKED_POLICY",
];

export function isTerminalJobExecutionState(
  state: string | null | undefined,
): boolean {
  return (
    !!state &&
    (TERMINAL_JOB_EXECUTION_STATES as ReadonlyArray<string>).includes(state)
  );
}

// ===========================================================================
// Errors
// ===========================================================================

export class QueuePayloadRejected extends Error {
  readonly code: string;
  /** Authority-shaped field names that caused the rejection, when any. */
  readonly offendingFields: ReadonlyArray<string>;

  constructor(
    code: string,
    message: string,
    offendingFields: ReadonlyArray<string> = [],
  ) {
    super(message);
    this.name = "QueuePayloadRejected";
    this.code = code;
    this.offendingFields = offendingFields;
  }
}

// ===========================================================================
// Construction
// ===========================================================================

export function buildCanonicalJobPayload(input: {
  commandId: string;
  traceId: string;
  schemaVersion?: number;
  traceparent?: string | null;
}): CanonicalJobPayload {
  const commandId = input.commandId.trim();
  if (!commandId) {
    throw new QueuePayloadRejected(
      "missing_command_id",
      "buildCanonicalJobPayload: commandId is required",
    );
  }
  if (commandId.length > COMMAND_ID_MAX) {
    throw new QueuePayloadRejected(
      "command_id_too_long",
      "buildCanonicalJobPayload: commandId exceeds bound",
    );
  }
  const payload: CanonicalJobPayload = {
    commandId,
    traceId: (input.traceId || "").trim().slice(0, TRACE_ID_MAX),
    schemaVersion: input.schemaVersion ?? CANONICAL_PAYLOAD_SCHEMA_VERSION,
  };
  // Omitted rather than set to null when absent: an absent key cannot be
  // mistaken for a trace that exists, and the wire stays minimal.
  if (isWellFormedTraceparent(input.traceparent)) {
    payload.traceparent = input.traceparent;
  }
  return payload;
}

/**
 * Producer guard for the hand-rolled `queue.add` sites that have not yet been
 * folded into `enqueueCanonicalJob`.
 */
export function assertNoPayloadAuthorityFields(
  payload: Record<string, unknown>,
): void {
  const offending = Object.keys(payload).filter(isAuthorityFieldName);
  if (offending.length > 0) {
    throw new QueuePayloadRejected(
      "payload_authority_field",
      `queue payload may not carry authority fields: ${offending.join(", ")}`,
      offending,
    );
  }
}

// ===========================================================================
// Strict decode
// ===========================================================================

export type DecodedJobPayload = {
  commandId: string;
  traceId: string;
  schemaVersion: number;
  /** Validated W3C traceparent, or null when the producer carried none. */
  traceparent: string | null;
  /** True when the payload arrived in a pre-Point-5 shape via a legacy decoder. */
  legacy: boolean;
};

/**
 * Decode a CANONICAL payload. Strict: any unknown field is a rejection.
 *
 * Order matters and is deliberate — shape, then version, then extra fields,
 * then the reference itself. Every check happens before the caller can reach a
 * database, so a rejected job causes exactly zero mutation.
 */
export function decodeCanonicalJobPayload(
  expect: { jobName: string; schemaVersion: number },
  raw: unknown,
): DecodedJobPayload {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new QueuePayloadRejected(
      "malformed_payload",
      `${expect.jobName}: payload is not an object`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const version = obj.schemaVersion;
  if (typeof version !== "number") {
    throw new QueuePayloadRejected(
      "unversioned_payload",
      `${expect.jobName}: payload carries no schemaVersion`,
    );
  }
  if (version !== expect.schemaVersion) {
    throw new QueuePayloadRejected(
      "unknown_schema_version",
      `${expect.jobName}: schemaVersion ${version} is not the canonical version`,
    );
  }

  const unknown = Object.keys(obj).filter(
    (k) => !CANONICAL_PAYLOAD_KEYS.includes(k),
  );
  if (unknown.length > 0) {
    const authority = unknown.filter(isAuthorityFieldName);
    throw new QueuePayloadRejected(
      authority.length > 0 ? "payload_authority_field" : "unknown_payload_field",
      `${expect.jobName}: payload carries unexpected fields: ${unknown.join(", ")}`,
      authority,
    );
  }

  const commandId = readString(obj.commandId);
  if (!commandId) {
    throw new QueuePayloadRejected(
      "missing_command_id",
      `${expect.jobName}: commandId is required`,
    );
  }
  if (commandId.length > COMMAND_ID_MAX) {
    throw new QueuePayloadRejected(
      "command_id_too_long",
      `${expect.jobName}: commandId exceeds bound`,
    );
  }

  const traceId = readString(obj.traceId);
  if (traceId !== null && traceId.length > TRACE_ID_MAX) {
    throw new QueuePayloadRejected(
      "trace_id_too_long",
      `${expect.jobName}: traceId exceeds bound`,
    );
  }

  // Present-but-malformed is a rejection rather than a silent drop, for the
  // same reason every other field is: a value that cannot have been written by
  // a legitimate producer is evidence, and evidence stops the job.
  let traceparent: string | null = null;
  if (obj.traceparent !== undefined) {
    if (!isWellFormedTraceparent(obj.traceparent)) {
      throw new QueuePayloadRejected(
        "malformed_traceparent",
        `${expect.jobName}: traceparent is not a W3C trace context header`,
      );
    }
    traceparent = obj.traceparent;
  }

  return {
    commandId,
    traceId: traceId ?? "",
    schemaVersion: expect.schemaVersion,
    traceparent,
    legacy: false,
  };
}

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}
