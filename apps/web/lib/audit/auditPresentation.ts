/**
 * PHASE 5 — HOW AN AUDIT ROW IS SAID OUT LOUD.
 *
 * The Admin Audit table rendered its actor column as `entry.userId ?? "public/system"`.
 * For a human action that is a bare UUID; for everything else it is a slash
 * between two words that name different things. An operator reading either one
 * learns nothing, and the record they are reading is the product's account of
 * itself during an incident.
 *
 * This module is the one place that decides how an actor, a target, an outcome
 * and a state transition are worded, so the Audit page, the Security page and
 * the Timeline cannot describe the same row three ways.
 *
 * It presents; it never invents. Where the backend has no answer the honest
 * fallback is returned — "Unknown legacy actor" for a row written before the
 * identity contract existed, not a plausible reconstruction, and never the
 * viewer's own name.
 */

export type AuditActorType =
  | "HUMAN"
  | "SERVICE"
  | "WORKER"
  | "SYSTEM"
  | "SUPPORT_CONTEXT"
  | "UNKNOWN_LEGACY";

export type AuditActorSource = {
  actorType?: string | null;
  actorDisplay?: string | null;
  actorAuthority?: string | null;
  userId?: string | null;
  isPublic?: boolean | null;
};

export type PresentedActor = {
  /** The line a person reads first. Never a UUID, never empty. */
  name: string;
  /** What kind of thing acted, in operator language. */
  kind: string;
  /** A stable, safe reference for correlation. Null when there is nothing safe to show. */
  reference: string | null;
  /** True when the record genuinely does not know — for styling as absent, not as a value. */
  unknown: boolean;
};

/** Last 6 characters, so two rows can be told apart without printing an identifier in full. */
function shortRef(prefix: string, id: string | null | undefined): string | null {
  if (!id) return null;
  const t = id.trim();
  if (!t) return null;
  return t.length <= 8 ? `${prefix} ${t}` : `${prefix} …${t.slice(-6)}`;
}

const ACTOR_KIND_LABEL: Record<AuditActorType, string> = {
  HUMAN: "Person",
  SERVICE: "Automated service",
  WORKER: "Background worker",
  SYSTEM: "System",
  SUPPORT_CONTEXT: "Support access",
  UNKNOWN_LEGACY: "Historical record",
};

export function presentActor(row: AuditActorSource): PresentedActor {
  const type = (row.actorType ?? "UNKNOWN_LEGACY") as AuditActorType;
  const kind = ACTOR_KIND_LABEL[type] ?? "Historical record";
  const reference =
    row.actorAuthority && type !== "HUMAN"
      ? row.actorAuthority
      : shortRef("User", row.userId);

  // A snapshot captured at the time of the action is the best answer, and it
  // keeps working after the account is renamed or deleted.
  if (row.actorDisplay && row.actorDisplay.trim()) {
    return { name: row.actorDisplay.trim(), kind, reference, unknown: false };
  }

  // No snapshot. Say what kind of thing acted rather than printing its id as
  // if the id were a name — an operator can act on "Background worker", and
  // cannot act on a UUID.
  if (type !== "HUMAN" && type !== "UNKNOWN_LEGACY") {
    return { name: kind, kind, reference, unknown: false };
  }

  if (row.userId) {
    // A human whose display snapshot predates the contract. The record is real
    // and the person is identifiable by reference; only the label is missing.
    return {
      name: "Unnamed operator",
      kind: "Person",
      reference: shortRef("User", row.userId),
      unknown: false,
    };
  }

  return {
    name: "Unknown legacy actor",
    kind: "Historical record",
    reference: null,
    unknown: true,
  };
}

export type AuditTargetSource = {
  targetDisplay?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  workspaceId?: string | null;
  organizationId?: string | null;
};

export type PresentedTarget = {
  name: string;
  kind: string | null;
  reference: string | null;
  /** Which tenant the row belongs to, or the explicit platform scope. */
  scope: string;
};

/** `support_access_grant` reads as machine output; `Support access grant` does not. */
export function humaniseResourceType(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value.trim().replace(/[_.]+/g, " ");
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function presentTarget(row: AuditTargetSource): PresentedTarget {
  const kind = humaniseResourceType(row.resourceType);
  const reference = shortRef(kind ?? "Ref", row.resourceId);
  const scope = row.workspaceId
    ? shortRef("Workspace", row.workspaceId)!
    : row.organizationId
      ? shortRef("Organization", row.organizationId)!
      : "Platform-wide";

  if (row.targetDisplay && row.targetDisplay.trim()) {
    return { name: row.targetDisplay.trim(), kind, reference, scope };
  }
  if (kind) {
    return { name: kind, kind, reference, scope };
  }
  return { name: "No specific target", kind: null, reference: null, scope };
}

export type OutcomeTone = "success" | "danger" | "warning" | "neutral" | "info";

export type PresentedOutcome = {
  label: string;
  tone: OutcomeTone;
  /** True when the row does not state an outcome — rendered as absent, never as success. */
  unknown: boolean;
};

/**
 * PHASE 5 §10 — absence is not success.
 *
 * The table rendered `entry.outcome ?? "success"`, so a row that recorded no
 * outcome at all was shown to an operator as having succeeded. That is the
 * single most misleading default available on this page: it turns "we do not
 * know what happened" into "it worked".
 */
const OUTCOME_PRESENTATION: Record<string, { label: string; tone: OutcomeTone }> = {
  success: { label: "Succeeded", tone: "success" },
  completed: { label: "Completed", tone: "success" },
  queued: { label: "Queued", tone: "info" },
  denied: { label: "Refused", tone: "warning" },
  error: { label: "Failed", tone: "danger" },
  no_op: { label: "No change", tone: "neutral" },
  partial: { label: "Partly applied", tone: "warning" },
};

export function presentOutcome(outcome: string | null | undefined): PresentedOutcome {
  const key = (outcome ?? "").trim().toLowerCase();
  const hit = OUTCOME_PRESENTATION[key];
  if (hit) return { ...hit, unknown: false };
  if (!key) return { label: "Not recorded", tone: "neutral", unknown: true };
  // An unrecognised value is shown verbatim rather than mapped to something
  // reassuring — the operator should see that the vocabulary drifted.
  return { label: key, tone: "neutral", unknown: false };
}

export type PresentedTransition = {
  /** e.g. "ACTIVE → SUSPENDED", or "Requested SUSPENDED (no change)". */
  text: string;
  changed: boolean;
} | null;

/**
 * PHASE 5 §3 — three fields, said in one line.
 *
 * A refusal has a requested state and no resulting one. Rendering only
 * "before → after" would print "ACTIVE → ACTIVE" for a refused suspension,
 * which reads as a successful no-op rather than as a request that was turned
 * down.
 */
export function presentTransition(row: {
  previousState?: string | null;
  requestedState?: string | null;
  resultingState?: string | null;
}): PresentedTransition {
  const prev = row.previousState?.trim() || null;
  const asked = row.requestedState?.trim() || null;
  const now = row.resultingState?.trim() || null;

  if (!prev && !asked && !now) return null;

  if (now && prev && now !== prev) {
    return { text: `${prev} → ${now}`, changed: true };
  }
  if (now && !prev) {
    return { text: `Now ${now}`, changed: true };
  }
  if (asked && !now) {
    return {
      text: prev ? `${prev}; requested ${asked}, not applied` : `Requested ${asked}, not applied`,
      changed: false,
    };
  }
  if (now && prev && now === prev) {
    return { text: `${prev} (unchanged)`, changed: false };
  }
  return { text: prev ?? asked ?? now ?? "", changed: false };
}

/**
 * PHASE 5 §12 — AN ALLOWLIST, NOT A JSON DUMP.
 *
 * The detail panel rendered `JSON.stringify(entry.metadata)`. The writer does
 * strip known secrets, so this was not a live credential leak — but a
 * blanket dump is a standing invitation to become one. Metadata is a free-form
 * column written by 232 call sites; the next one to put a provider payload, a
 * stack trace or an internal path in it would have that reach the screen with
 * nobody deciding it should.
 *
 * An allowlist inverts that: a new key is invisible until someone adds it here
 * and says what it is. The keys below are the correlation and context fields
 * the canonical envelope defines. Anything else is counted, not printed, so an
 * operator can still see that a row carries more and ask for it deliberately.
 */
const METADATA_ALLOWLIST: Record<string, string> = {
  correlationId: "Correlation ID",
  causationId: "Caused by",
  jobId: "Job ID",
  grantId: "Grant ID",
  breakGlassGrantId: "Break-glass grant",
  supportActorUserId: "Support actor",
  effectiveCustomerUserId: "Acting for customer",
  sessionRefHash: "Session reference",
  authMethod: "Authentication method",
  capability: "Capability",
  policyId: "Policy",
  policyVersion: "Policy version",
  workspaceKind: "Workspace kind",
  denialReason: "Refusal reason",
  serviceActor: "Service identity",
  sourceApp: "Source",
  providerEventId: "Provider event",
  custodyRef: "Custody reference",
  scope: "Scope",
  resultCount: "Results returned",
  accessLevel: "Access level",
  approvedByUserId: "Approved by",
  expiresAtUtc: "Expires (UTC)",
};

export type PresentedMetadata = {
  entries: Array<[string, string]>;
  /** Keys present on the row that this view deliberately does not render. */
  withheldCount: number;
};

export function presentMetadata(metadata: unknown): PresentedMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { entries: [], withheldCount: 0 };
  }
  const source = metadata as Record<string, unknown>;
  const entries: Array<[string, string]> = [];
  let withheldCount = 0;

  for (const [key, value] of Object.entries(source)) {
    const label = METADATA_ALLOWLIST[key];
    if (!label) {
      if (value !== null && value !== undefined) withheldCount += 1;
      continue;
    }
    if (value === null || value === undefined) continue;
    // Scalars only. A nested object under an allowlisted key is still an
    // arbitrary payload, and printing it would reopen the hole the allowlist
    // closes.
    if (typeof value === "object") {
      withheldCount += 1;
      continue;
    }
    entries.push([label, String(value).slice(0, 200)]);
  }

  return { entries, withheldCount };
}

/**
 * Canonical event codes read as machine output. `identity.support_access.revoked`
 * becomes "Support access revoked" without inventing a friendlier meaning than
 * the code carries — the raw code stays available in the row's detail.
 */
export function presentAction(action: string): string {
  const parts = action.split(".").filter(Boolean);
  if (parts.length === 0) return action;
  const tail = parts.slice(-2).join(" ").replace(/[_-]+/g, " ").trim();
  if (!tail) return action;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}
