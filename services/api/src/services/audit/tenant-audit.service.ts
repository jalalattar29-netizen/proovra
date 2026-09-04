/**
 * PHASE 11 — THE ONE canonical tenant-audit ENVELOPE emission authority.
 *
 * It does NOT introduce a second audit store: it composes the existing
 * hash-chained platform audit log (`appendPlatformAuditLog`) as the immutable
 * sink, and shapes the ONE tenant-audit envelope on top — tenant attribution,
 * dual-identity (support/break-glass), session/auth provenance, capability,
 * policy version, and correlation/causation references. Specialized domain
 * ledgers (Evidence custody, membership provenance, security events, provider
 * events) remain authoritative and are REFERENCED here (by id), never copied.
 *
 * Secrets are NEVER stored: raw JWTs, support-context tokens, invitation/share
 * secrets, provider/OAuth/SAML secrets, and credentials are stripped before the
 * envelope reaches the sink (and the sink additionally sanitizes metadata).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";

export type TenantAuditSourceApp =
  | "API"
  | "WORKER"
  | "WEB"
  | "MOBILE"
  | "SCIM"
  | "SSO"
  | "SYSTEM";

/**
 * PHASE 5 §3/§7 — THE OUTCOME TAXONOMY, WIDENED RATHER THAN REPLACED.
 *
 * It said success | denied | error. Those three are kept verbatim — they are
 * already persisted on every historical row and are what every existing filter
 * and query sends — but they cannot express the states that make an
 * asynchronous audit trail honest:
 *
 *   - `queued` is not `success`. Accepting a request and putting a job on a
 *     queue is not the same as the work happening, and an audit row that calls
 *     the first one a success tells an operator the estate changed when it may
 *     never have. The worker writes `completed` or `error` LATER, correlated
 *     to the same request.
 *   - `no_op` is not `success`. A replayed revoke, a compare-and-set that
 *     lost, an idempotent retry — each is a legitimate request that changed
 *     nothing. Recording them as success implies the action happened twice.
 *   - `partial` is neither. A bulk action where some members succeeded is not
 *     honestly either one.
 *
 * Lowercase, matching what is already on disk, so no historical row and no
 * existing filter has to be rewritten to understand the new values.
 */
export type TenantAuditOutcome =
  | "success"
  | "denied"
  | "error"
  | "queued"
  | "completed"
  | "no_op"
  | "partial";

/**
 * PHASE 5 §4 — WHAT KIND OF THING ACTED.
 *
 * `actorUserId === null` used to carry this by implication, and it conflated
 * three unlike things: a worker running a scheduled job, a service account
 * calling the API, and an event with no recoverable actor at all. An operator
 * reading "—" cannot tell which, and the difference decides whether an
 * incident is an automation fault or an unattributed action.
 *
 * UNKNOWN_LEGACY is deliberately available and deliberately never inferred.
 * Historical rows predate the contract; the honest answer is that we do not
 * know, not a plausible-looking reconstruction.
 */
export type AuditActorType =
  | "HUMAN"
  | "SERVICE"
  | "WORKER"
  | "SYSTEM"
  | "SUPPORT_CONTEXT"
  | "UNKNOWN_LEGACY";

export type WorkspaceKind = "PERSONAL" | "OWNED" | "ORGANIZATION";

export type TenantAuditEnvelope = {
  action: string;
  outcome: TenantAuditOutcome;
  denialReason?: string | null;
  sourceApp: TenantAuditSourceApp;

  /** Authenticated human actor (null for pure service/system actions). */
  actorUserId: string | null;
  /**
   * PHASE 5 §4 — what kind of thing acted. Derived when omitted (see
   * `deriveActorType`), so no existing caller has to change to get a truthful
   * value, but statable explicitly where the caller knows better.
   */
  actorType?: AuditActorType | null;
  /**
   * PHASE 5 §5 — a safe display label captured AT THE TIME OF THE ACTION.
   *
   * Not a convenience. A record that resolves its actor through a live join
   * stops being readable exactly when it is most needed: after the account is
   * renamed, anonymised or deleted. The snapshot is what keeps a two-year-old
   * revocation intelligible; the immutable id is what keeps it correlatable.
   * Both, or the record is only one of legible and durable.
   */
  actorDisplay?: string | null;
  /** The authority the actor acted UNDER, at the time (e.g. PLATFORM_ADMIN). */
  actorAuthority?: string | null;
  /** Safe display label for the target, captured the same way and for the same reason. */
  targetDisplay?: string | null;
  /**
   * PHASE 5 §3 — the transition. `previousState` is what authoritative storage
   * held before, `requestedState` is what was asked for, `resultingState` is
   * what storage holds now. They are three fields and not two because a
   * refused or failed action has a requested state and no resulting change,
   * and collapsing them would make those indistinguishable from a success.
   */
  previousState?: string | null;
  requestedState?: string | null;
  resultingState?: string | null;
  /** Stable machine reason (a code, not prose) for why this happened. */
  reasonCode?: string | null;
  /** Worker/service identity when there is no human actor. */
  serviceActor?: string | null;
  /** SUPPORT dual identity: the customer scope the support actor operated on. */
  effectiveCustomerUserId?: string | null;
  supportActorUserId?: string | null;
  /** Emergency (break-glass) grant id when the action ran under an overlay. */
  breakGlassGrantId?: string | null;
  /** Hash of the authenticated session (never the raw sid/JWT). */
  sessionRefHash?: string | null;
  authMethod?: string | null;

  organizationId?: string | null;
  /** The authoritative Workspace (teamId) — from persistence, never the URL. */
  workspaceId?: string | null;
  workspaceKind?: WorkspaceKind | null;

  resourceType?: string | null;
  resourceId?: string | null;
  capability?: string | null;
  policyId?: string | null;
  policyVersion?: number | null;
  /** Optional override for genuinely high-severity events (e.g. break-glass,
   * security). Defaults to outcome-derived (success→info/denied→warning/error). */
  severity?: string | null;

  correlationId?: string | null;
  causationId?: string | null;
  jobId?: string | null;
  providerEventId?: string | null;

  /** Custody/retention snapshot reference (id only, never the record content). */
  custodyRef?: string | null;

  metadata?: Record<string, unknown>;
};

const SECRET_KEY = /(token|secret|jwt|password|credential|api[_-]?key|relaystate|cookie|authorization|bearer)/i;

/** Deep-strip any key that looks like a secret. Values are never inspected. */
function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = stripSecrets(v, depth + 1);
  }
  return out;
}

function outcomeSeverity(o: TenantAuditOutcome): string {
  return o === "denied" ? "warning" : o === "error" ? "error" : "info";
}

// ── §2 — canonical severity policy (caller may ELEVATE, never DOWNGRADE) ─────
const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 0,
  notice: 1,
  warning: 2,
  error: 3,
  high: 3,
  critical: 4,
};
/** The MINIMUM severity a given action/outcome must carry, by policy. */
function minimumSeverity(action: string, outcome: TenantAuditOutcome): string {
  const a = action.toLowerCase();
  // Security-critical families retain a floor regardless of caller input.
  if (/break.?glass|emergency/.test(a)) return "critical";
  if (/integrity.*fail|custody.*(destroy|destruct)|destruction|support.*(misuse|denied)/.test(a)) return "high";
  if (/security|mfa|session.*revoke|quarantine|managed_identity_conflict|cross_org/.test(a)) return "warning";
  return outcomeSeverity(outcome);
}
/**
 * Resolve the stored severity. Starts from the policy MINIMUM for the
 * action/outcome; a caller-supplied severity may only ELEVATE it. An unknown
 * caller severity is ignored (fail closed to the minimum) — never a downgrade.
 */
function resolveSeverity(
  action: string,
  outcome: TenantAuditOutcome,
  callerSeverity: string | null | undefined,
): string {
  const min = minimumSeverity(action, outcome);
  const minRank = SEVERITY_RANK[min] ?? 0;
  if (!callerSeverity) return min;
  const callerRank = SEVERITY_RANK[callerSeverity.toLowerCase()];
  if (callerRank === undefined) return min; // unknown → fail closed to the floor
  return callerRank > minRank ? callerSeverity : min; // elevate only
}

/**
 * PHASE 5 §4 — the ONE place an actor type is decided.
 *
 * Derived rather than demanded, so that 196 existing `emitTenantAudit` callers
 * and 36 `emitPlatformAudit` callers get a truthful value without each having
 * to be edited to say something they already implied. A caller that knows
 * better states it and wins.
 *
 * The order is the precedence that matters. Support context is checked BEFORE
 * plain human, because a staff member acting inside a customer's workspace is
 * not simply a human actor — flattening the two is the exact confusion that
 * makes a support action read as though the customer performed it.
 */
export function deriveActorType(env: {
  actorType?: AuditActorType | null;
  actorUserId: string | null;
  supportActorUserId?: string | null;
  breakGlassGrantId?: string | null;
  serviceActor?: string | null;
  sourceApp?: TenantAuditSourceApp;
}): AuditActorType {
  if (env.actorType) return env.actorType;
  if (env.supportActorUserId || env.breakGlassGrantId) return "SUPPORT_CONTEXT";
  if (env.actorUserId) return "HUMAN";
  if (env.serviceActor) {
    // `worker:*` names a background executor; anything else named itself as a
    // service. The distinction is what separates "a job ran" from "an
    // integration called us", and operators triage those differently.
    return env.serviceActor.startsWith("worker:") ? "WORKER" : "SERVICE";
  }
  if (env.sourceApp === "SYSTEM") return "SYSTEM";
  // No human, no named service, no system source. Saying SYSTEM here would be
  // a guess dressed as a fact.
  return "UNKNOWN_LEGACY";
}

/** Bound a snapshot to its column width without throwing at the database. */
function boundedLabel(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const t = String(value).trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * PHASE 5 §5 — THE SNAPSHOT IS TAKEN HERE, NOT ASKED OF 232 CALL SITES.
 *
 * Every writer could have been edited to pass a display name. None would have
 * stayed edited: the next audit call added anywhere in the service would omit
 * it, and the field would rot into "sometimes populated", which is worse than
 * absent because a blank cell would then mean two different things.
 *
 * So the facade resolves it once, at write time, from the actor id the caller
 * already had to supply. That is also the only moment the CONTEMPORANEOUS
 * value exists — the whole point of a snapshot is that it is what was true
 * when the action happened, and a later read cannot recover it.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 *
 * The display name, or a masked form of the email when there is no name. Never
 * the raw email: §5 asks for the minimum that identifies an operator, and a
 * full address in an append-only trail is a permanent copy of personal data
 * that no retention job can reach. `j••••@example.com` is enough to recognise
 * a colleague and not enough to be a mailing list.
 *
 * FAILURE IS NOT FATAL
 *
 * A snapshot lookup that fails must never stop a sensitive action from being
 * audited — an unlabelled audit row is recoverable, a missing one is not. The
 * lookup is wrapped and falls back to null, which renders as the honest
 * "Unnamed operator".
 */
const ACTOR_SNAPSHOT_CACHE = new Map<string, string | null>();
const ACTOR_SNAPSHOT_CACHE_MAX = 500;

function maskEmailForAudit(email: string): string | null {
  const at = email.indexOf("@");
  if (at < 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${"•".repeat(Math.min(Math.max(local.length - 1, 1), 6))}@${domain}`;
}

export async function resolveActorDisplaySnapshot(
  actorUserId: string | null,
  db: PrismaClient,
): Promise<string | null> {
  if (!actorUserId) return null;
  if (ACTOR_SNAPSHOT_CACHE.has(actorUserId)) {
    return ACTOR_SNAPSHOT_CACHE.get(actorUserId) ?? null;
  }
  let label: string | null = null;
  try {
    const user = await db.user.findUnique({
      where: { id: actorUserId },
      select: { displayName: true, email: true },
    });
    const name = user?.displayName?.trim();
    label = name && name.length > 0 ? name : user?.email ? maskEmailForAudit(user.email) : null;
  } catch {
    // An audit row without a label is recoverable. An action without an audit
    // row is not. This never throws.
    label = null;
  }
  if (ACTOR_SNAPSHOT_CACHE.size >= ACTOR_SNAPSHOT_CACHE_MAX) {
    ACTOR_SNAPSHOT_CACHE.clear();
  }
  ACTOR_SNAPSHOT_CACHE.set(actorUserId, label);
  return label;
}

/** Test seam: the cache is process-local and must not leak between cases. */
export function __clearActorSnapshotCacheForTests(): void {
  ACTOR_SNAPSHOT_CACHE.clear();
}

/**
 * Emit ONE tenant-audit event. Denials are audited too (with a bounded reason)
 * and MUST NOT leak record existence — pass only `denialReason`, never the
 * concealed resource's data. Runs on the caller's `db`/tx when supplied so an
 * audit can share a domain mutation's atomic boundary.
 */
export async function emitTenantAudit(
  env: TenantAuditEnvelope,
  db?: PrismaClient,
): Promise<void> {
  const metadata = stripSecrets({
    sourceApp: env.sourceApp,
    organizationId: env.organizationId ?? null,
    workspaceId: env.workspaceId ?? null,
    workspaceKind: env.workspaceKind ?? null,
    effectiveCustomerUserId: env.effectiveCustomerUserId ?? null,
    supportActorUserId: env.supportActorUserId ?? null,
    breakGlassGrantId: env.breakGlassGrantId ?? null,
    sessionRefHash: env.sessionRefHash ?? null,
    authMethod: env.authMethod ?? null,
    capability: env.capability ?? null,
    policyId: env.policyId ?? null,
    policyVersion: env.policyVersion ?? null,
    correlationId: env.correlationId ?? null,
    causationId: env.causationId ?? null,
    jobId: env.jobId ?? null,
    providerEventId: env.providerEventId ?? null,
    custodyRef: env.custodyRef ?? null,
    serviceActor: env.serviceActor ?? null,
    denialReason: env.outcome === "denied" ? (env.denialReason ?? null) : null,
    ...(env.metadata ?? {}),
  }) as Record<string, unknown>;

  await appendPlatformAuditLog({
    // A pure service/system event has no human actor → recorded as a public row.
    userId: env.actorUserId,
    isPublic: env.actorUserId === null,
    action: env.action,
    category: "tenant_audit",
    severity: resolveSeverity(env.action, env.outcome, env.severity),
    source: env.sourceApp.toLowerCase(),
    outcome: env.outcome,
    resourceType: env.resourceType ?? null,
    resourceId: env.resourceId ?? null,
    // AUTHORITATIVE tenant columns (DB-level scope filter) — never JSON only.
    organizationId: env.organizationId ?? null,
    workspaceId: env.workspaceId ?? null,
    // PHASE 5 — identity and transition, as sealed columns rather than JSON.
    actorType: deriveActorType(env),
    actorDisplay: boundedLabel(
      env.actorDisplay ??
        (await resolveActorDisplaySnapshot(env.actorUserId, db ?? defaultPrisma)),
      160,
    ),
    actorAuthority: boundedLabel(env.actorAuthority, 64),
    targetDisplay: boundedLabel(env.targetDisplay, 160),
    previousState: boundedLabel(env.previousState, 64),
    requestedState: boundedLabel(env.requestedState, 64),
    resultingState: boundedLabel(env.resultingState, 64),
    reasonCode: boundedLabel(env.reasonCode, 64),
    metadata,
    db,
  });
}

// ── PLATFORM-scoped events (the discriminated non-tenant arm of the facade) ──
//
// A genuinely global platform/security/operations event with NO tenant subject.
// It uses the SAME canonical audit facade + hash-chained sink but NEVER
// fabricates a Workspace/Organization — the tenant columns stay null so it can
// never be returned by a tenant-scoped query.
export type PlatformAuditEnvelope = {
  action: string;
  outcome: TenantAuditOutcome;
  denialReason?: string | null;
  sourceApp: TenantAuditSourceApp;
  actorUserId: string | null;
  serviceActor?: string | null;
  sessionRefHash?: string | null;
  authMethod?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  metadata?: Record<string, unknown>;
  // PHASE 5 — the platform arm carries the same contract as the tenant arm.
  // A platform-scoped event has no tenant subject; it still has an actor, a
  // target and a transition, and an operator reading the two side by side in
  // one console should not find one of them mute.
  actorType?: AuditActorType | null;
  actorDisplay?: string | null;
  actorAuthority?: string | null;
  targetDisplay?: string | null;
  previousState?: string | null;
  requestedState?: string | null;
  resultingState?: string | null;
  reasonCode?: string | null;
  supportActorUserId?: string | null;
  breakGlassGrantId?: string | null;
};

export async function emitPlatformAudit(
  env: PlatformAuditEnvelope,
  db?: PrismaClient,
): Promise<void> {
  const metadata = stripSecrets({
    sourceApp: env.sourceApp,
    scope: "PLATFORM",
    serviceActor: env.serviceActor ?? null,
    sessionRefHash: env.sessionRefHash ?? null,
    authMethod: env.authMethod ?? null,
    correlationId: env.correlationId ?? null,
    causationId: env.causationId ?? null,
    denialReason: env.outcome === "denied" ? (env.denialReason ?? null) : null,
    ...(env.metadata ?? {}),
  }) as Record<string, unknown>;
  await appendPlatformAuditLog({
    userId: env.actorUserId,
    isPublic: env.actorUserId === null,
    action: env.action,
    category: "platform_audit",
    severity: resolveSeverity(env.action, env.outcome, null),
    source: env.sourceApp.toLowerCase(),
    outcome: env.outcome,
    resourceType: env.resourceType ?? null,
    resourceId: env.resourceId ?? null,
    organizationId: null,
    workspaceId: null,
    actorType: deriveActorType(env),
    actorDisplay: boundedLabel(
      env.actorDisplay ??
        (await resolveActorDisplaySnapshot(env.actorUserId, db ?? defaultPrisma)),
      160,
    ),
    actorAuthority: boundedLabel(env.actorAuthority, 64),
    targetDisplay: boundedLabel(env.targetDisplay, 160),
    previousState: boundedLabel(env.previousState, 64),
    requestedState: boundedLabel(env.requestedState, 64),
    resultingState: boundedLabel(env.resultingState, 64),
    reasonCode: boundedLabel(env.reasonCode, 64),
    metadata,
    db,
  });
}

// ── ONE canonical tenant-audit QUERY / EXPORT surface ───────────────────────
//
// The ONLY authorized tenant-audit reader. AUTHORIZATION is NOT decided here —
// the route composes canonical `authorizeOrFail` (Workspace capability /
// Organization-admin boundary) and passes only the VALIDATED scope. This
// function enforces the tenant FILTER (rows are scoped to the caller's proven
// workspace/organization via the persisted attribution), deterministic UTC
// pagination, and a projection that never re-exposes stripped secrets. Export
// uses the SAME function (same filter + projection) — it cannot widen scope.

export type TenantAuditScope =
  | { kind: "WORKSPACE"; workspaceId: string }
  | { kind: "ORGANIZATION"; organizationId: string };

export type TenantAuditQuery = {
  scope: TenantAuditScope;
  action?: string | null;
  outcome?: TenantAuditOutcome | null;
  resourceType?: string | null;
  /** Inclusive UTC lower/upper bounds. */
  occurredFromUtc?: Date | null;
  occurredUntilUtc?: Date | null;
  limit?: number;
  cursorId?: string | null;
};

export type TenantAuditRow = {
  eventId: string;
  occurredAtUtc: string;
  action: string;
  outcome: string | null;
  actorUserId: string | null;
  sourceApp: unknown;
  organizationId: unknown;
  workspaceId: unknown;
  resourceType: string | null;
  resourceId: string | null;
  denialReason: unknown;
  correlationId: unknown;
};

function scopeWhere(scope: TenantAuditScope): Prisma.AdminAuditLogWhereInput {
  // §5 — DB-LEVEL filter on the AUTHORITATIVE tenant COLUMN (indexed), never on
  // arbitrary JSON metadata. The canonical facade is the only writer of these
  // columns, so a cross-Organization / cross-Workspace row can never match.
  return scope.kind === "WORKSPACE"
    ? { category: "tenant_audit", workspaceId: scope.workspaceId }
    : { category: "tenant_audit", organizationId: scope.organizationId };
}

export async function queryTenantAudit(
  input: TenantAuditQuery,
  db: PrismaClient = defaultPrisma,
): Promise<{ items: TenantAuditRow[]; nextCursorId: string | null }> {
  const take = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const where: Prisma.AdminAuditLogWhereInput = {
    ...scopeWhere(input.scope),
    ...(input.action ? { action: input.action } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    ...(input.occurredFromUtc || input.occurredUntilUtc
      ? {
          createdAt: {
            ...(input.occurredFromUtc ? { gte: input.occurredFromUtc } : {}),
            ...(input.occurredUntilUtc ? { lte: input.occurredUntilUtc } : {}),
          },
        }
      : {}),
  };

  let cursor: { id: string; createdAt: Date } | null = null;
  if (input.cursorId) {
    cursor = await db.adminAuditLog.findUnique({
      where: { id: input.cursorId },
      select: { id: true, createdAt: true },
    });
  }

  const rows = await db.adminAuditLog.findMany({
    where: cursor
      ? { AND: [where, { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] }
      : where,
    // Deterministic UTC ordering (createdAt desc, id desc tiebreak).
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true, createdAt: true, action: true, outcome: true, userId: true,
      resourceType: true, resourceId: true, organizationId: true, workspaceId: true, metadata: true,
    },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const items: TenantAuditRow[] = page.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      eventId: r.id,
      occurredAtUtc: r.createdAt.toISOString(),
      action: r.action,
      outcome: r.outcome,
      actorUserId: r.userId,
      sourceApp: m["sourceApp"] ?? null,
      organizationId: r.organizationId,
      workspaceId: r.workspaceId,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      denialReason: m["denialReason"] ?? null,
      correlationId: m["correlationId"] ?? null,
    };
  });
  return { items, nextCursorId: hasMore ? page[page.length - 1]!.id : null };
}

// ── Admin MANUAL audit-write passthrough (zero-decision) ────────────────────
//
// The `POST /v1/admin/audit-log` endpoint lets a platform admin record a manual
// audit entry. §3 HARDENS it — it is NOT an arbitrary passthrough:
//   - action must match a bounded vocabulary shape (no forged system actions);
//   - category is CLOSED to "platform_admin_manual" (caller cannot choose it);
//   - it is always PLATFORM-scoped — the caller CANNOT set organization/workspace
//     (there is no persisted tenant authorization on this endpoint) and CANNOT
//     forge a support/break-glass/service actor identity;
//   - the actor is the AUTHENTICATED session user (the route passes req.user.sub,
//     immutable — never a body field);
//   - severity is policy-resolved (a caller may elevate, never downgrade);
//   - metadata is secret-stripped; raw tokens/credentials never stored.
export class AdminManualAuditError extends Error {
  readonly code = "INVALID_ADMIN_MANUAL_AUDIT";
  constructor(message: string) {
    super(message);
    this.name = "AdminManualAuditError";
  }
}
const ADMIN_MANUAL_ACTION = /^[a-z][a-z0-9_.:-]{1,80}$/;

export type AdminManualAuditInput = {
  /** The AUTHENTICATED session actor — set by the route from req.user, never a body field. */
  userId: string | null;
  action: string;
  category?: string | null;
  severity?: string | null;
  source?: string | null;
  outcome?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  metadata: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
};
export async function emitAdminManualAudit(
  input: AdminManualAuditInput,
  db?: PrismaClient,
): Promise<void> {
  if (!input.action || !ADMIN_MANUAL_ACTION.test(input.action)) {
    throw new AdminManualAuditError("invalid_action");
  }
  const outcome: TenantAuditOutcome =
    input.outcome === "denied"
      ? "denied"
      : input.outcome === "error" || input.outcome === "failure"
        ? "error"
        : "success";
  const metadata = stripSecrets({
    scope: "PLATFORM",
    adminManual: true,
    // The caller's requested category/source are recorded as DATA, never as the
    // authoritative category (which is closed).
    requestedCategory: input.category ?? null,
    requestedSource: input.source ?? null,
    ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : {}),
  }) as Record<string, unknown>;

  await appendPlatformAuditLog({
    userId: input.userId, // immutable authenticated actor (from the session)
    isPublic: input.userId === null,
    action: input.action,
    category: "platform_admin_manual", // CLOSED
    severity: resolveSeverity(input.action, outcome, input.severity), // elevate-only
    source: "admin_console", // fixed
    outcome,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    organizationId: null, // caller CANNOT set tenant scope (no persisted authz here)
    workspaceId: null,
    requestId: input.requestId ?? null,
    // PHASE 5 — the manual-entry arm gets the same identity as the other two.
    // It is the arm an operator uses BY HAND, so a row with no attributable
    // actor here would be the least explicable of all.
    actorType: input.userId ? "HUMAN" : "UNKNOWN_LEGACY",
    actorDisplay: boundedLabel(
      await resolveActorDisplaySnapshot(input.userId, defaultPrisma),
      160,
    ),
    metadata,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db,
  });
}
