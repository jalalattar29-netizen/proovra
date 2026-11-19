/**
 * PHASE 12 — VERTICAL B (OPERATIONS_INTELLIGENCE).
 *
 * Server-side authority for Command Center workflow actions.
 *
 * This module owns three things the routes must NEVER re-implement or
 * hand to the client:
 *
 *   1. ACTION AVAILABILITY PROJECTION.
 *      `projectWorkflowActions` returns, per workflow, which of the
 *      eight lifecycle actions the CALLER may take right now, and a
 *      bounded reason code when they may not. Availability composes
 *      the caller's capability decision (evaluated once per request
 *      against the workspace derived from the PERSISTED workflow row)
 *      with the workflow's own state machine. The browser renders this
 *      projection; it never decides policy itself.
 *
 *   2. OPTIMISTIC CONCURRENCY.
 *      `assertWorkflowVersion` compares a caller-supplied
 *      `expectedVersion` (the workflow's `updatedAt` ISO string, which
 *      the read projection hands out as `version`) against the
 *      persisted row. A mismatch is a 409 with ZERO mutation — the
 *      operator is looking at a stale board.
 *
 *   3. DURABLE IDEMPOTENCY.
 *      `findWorkflowActionReplay` / `reserveWorkflowActionIdempotency`
 *      persist the caller's idempotency key on an
 *      `OperationalWorkflowEvent.metadataJson` row (durable Postgres
 *      state, NOT in-process memory). A retry with the same key
 *      replays the recorded outcome instead of applying the action a
 *      second time.
 *
 * Hard rules:
 *   - No mutation happens in this module. It reads, projects, and
 *     records provenance. The ONE state writer for every workflow
 *     transition remains `workflow.service.ts`.
 *   - Every read is anchored on `teamId` sourced from the persisted
 *     workflow row.
 *   - Bounded reason codes. No free text reaches the client.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { evaluateMemberAccess } from "../identity/access-policy.service.js";
import { resolveMemberWorkspaceCapabilities } from "../platform-context/workspace-capability.service.js";
import type { CapabilityKey } from "../platform-context/types.js";
import { caseClosedTo, evidenceClosedTo } from "../access/record-reach.js";

// ---------------------------------------------------------------------------
// Bounded action catalog
// ---------------------------------------------------------------------------

export const WORKFLOW_ACTION_KEYS = [
  "start",
  "assign",
  "escalate",
  "mitigation",
  "resolve",
  "suppress",
  "reopen",
  "schedule-retry",
] as const;

export type WorkflowActionKey = (typeof WORKFLOW_ACTION_KEYS)[number];

/**
 * Bounded reason codes surfaced when an action is NOT available. The
 * frontend maps these to operator copy; it never invents its own.
 */
export type WorkflowActionUnavailableReason =
  | "CAPABILITY_REQUIRED"
  | "TERMINAL_STATE"
  | "NOT_RESOLVED_OR_SUPPRESSED"
  | "ALREADY_IN_PROGRESS";

export type WorkflowActionAvailability = {
  action: WorkflowActionKey;
  /** Operator-safe label. Bounded; never derived from row content. */
  label: string;
  available: boolean;
  reason: WorkflowActionUnavailableReason | null;
  /** Canonical capability the action is gated on. */
  permission: string;
  /** True when the action additionally requires a fresh target-bound step-up. */
  requiresStepUp: boolean;
  /** True when the action is destructive enough to warrant a confirm prompt. */
  destructive: boolean;
};

const ACTION_LABELS: Record<WorkflowActionKey, string> = {
  start: "Start",
  assign: "Assign owner",
  escalate: "Escalate",
  mitigation: "Record mitigation",
  resolve: "Resolve",
  suppress: "Suppress",
  reopen: "Reopen",
  "schedule-retry": "Schedule retry",
};

/**
 * Actions that require a fresh, target-bound step-up challenge on top
 * of the capability check. Resolving or suppressing an operational
 * workflow closes the operator record for that pressure item, so the
 * actor must re-prove.
 */
export const WORKFLOW_ACTIONS_REQUIRING_STEP_UP: ReadonlySet<WorkflowActionKey> =
  new Set<WorkflowActionKey>(["resolve", "suppress"]);

const DESTRUCTIVE_ACTIONS: ReadonlySet<WorkflowActionKey> =
  new Set<WorkflowActionKey>(["resolve", "suppress", "reopen"]);

export type WorkflowOpsPermission =
  | "operations.acknowledge"
  | "operations.assign"
  | "operations.resolve"
  | "operations.suppress";

/**
 * PRO-P1C-01 — THE one action → permission table, read by the routes'
 * `requireOpsCapability` gate AND by this projection, so the two cannot
 * disagree. It replaces the single stale `identity.access_review.action`
 * (the pre-Phase-4B gate) the projection used to decide all eight actions
 * by, which disabled every action for a MEMBER who may act and enabled
 * Assign/Escalate for a solo owner the route refuses.
 */
export const WORKFLOW_ACTION_OPS_PERMISSION: Readonly<Record<WorkflowActionKey, WorkflowOpsPermission>> = {
  start: "operations.acknowledge",
  assign: "operations.assign",
  escalate: "operations.assign",
  mitigation: "operations.acknowledge",
  resolve: "operations.resolve",
  suppress: "operations.suppress",
  reopen: "operations.resolve",
  "schedule-retry": "operations.acknowledge",
};

/** Each Operations permission and the workbench capability that must accompany it (as the routes' gate). */
const OPS_PERMISSION_CAPABILITY = {
  "operations.acknowledge": "OPERATIONS_ACKNOWLEDGE",
  "operations.assign": "OPERATIONS_ASSIGN",
  "operations.resolve": "OPERATIONS_RESOLVE",
  "operations.suppress": "OPERATIONS_SUPPRESS",
} as const satisfies Record<WorkflowOpsPermission, CapabilityKey>;

/** Per action: may the caller take it in this workspace (role permission AND workbench capability). */
export type WorkflowActionGrants = Readonly<Record<WorkflowActionKey, boolean>>;

const NO_GRANTS: WorkflowActionGrants = Object.freeze(
  Object.fromEntries(WORKFLOW_ACTION_KEYS.map((a) => [a, false])) as Record<WorkflowActionKey, boolean>,
);

/** True when at least one action is open to the caller (the response's `canAct`). */
export function anyWorkflowActionGranted(grants: WorkflowActionGrants): boolean {
  return WORKFLOW_ACTION_KEYS.some((a) => grants[a]);
}

type WorkflowStatus = prismaPkg.OperationalWorkflowStatus;

const RESOLVED: WorkflowStatus = "RESOLVED" as WorkflowStatus;
const SUPPRESSED: WorkflowStatus = "SUPPRESSED" as WorkflowStatus;
const IN_PROGRESS: WorkflowStatus = "IN_PROGRESS" as WorkflowStatus;

function isClosed(status: WorkflowStatus): boolean {
  return status === RESOLVED || status === SUPPRESSED;
}

/**
 * Pure state-machine predicate. Returns null when the action is legal
 * for the given status, or the bounded reason it is not.
 */
export function stateReasonFor(
  action: WorkflowActionKey,
  status: WorkflowStatus,
): WorkflowActionUnavailableReason | null {
  const closed = isClosed(status);
  switch (action) {
    case "reopen":
      return closed ? null : "NOT_RESOLVED_OR_SUPPRESSED";
    case "start":
      if (closed) return "TERMINAL_STATE";
      return status === IN_PROGRESS ? "ALREADY_IN_PROGRESS" : null;
    case "assign":
    case "escalate":
    case "mitigation":
    case "resolve":
    case "suppress":
    case "schedule-retry":
      return closed ? "TERMINAL_STATE" : null;
    default:
      return "TERMINAL_STATE";
  }
}

export type WorkflowActionProjection = {
  /** Stale-state token the caller must echo back as `expectedVersion`. */
  version: string;
  /** True when the caller may take at least one action in this workspace. */
  canAct: boolean;
  actions: ReadonlyArray<WorkflowActionAvailability>;
};

/**
 * Builds the permission-aware action projection for one workflow.
 *
 * `grants` is resolved ONCE per request by the caller (routes evaluate
 * it against the workspace derived from the persisted workflow row) and
 * threaded in, so a list projection does not fan out one capability
 * evaluation per row.
 */
export function projectWorkflowActions(input: {
  workflow: Pick<prismaPkg.OperationalWorkflow, "status" | "updatedAt">;
  grants: WorkflowActionGrants;
}): WorkflowActionProjection {
  const actions = WORKFLOW_ACTION_KEYS.map<WorkflowActionAvailability>(
    (action) => {
      const stateReason = stateReasonFor(action, input.workflow.status);
      const reason: WorkflowActionUnavailableReason | null = !input.grants[action]
        ? "CAPABILITY_REQUIRED"
        : stateReason;
      return {
        action,
        label: ACTION_LABELS[action],
        available: reason === null,
        reason,
        permission: WORKFLOW_ACTION_OPS_PERMISSION[action],
        requiresStepUp: WORKFLOW_ACTIONS_REQUIRING_STEP_UP.has(action),
        destructive: DESTRUCTIVE_ACTIONS.has(action),
      };
    },
  );
  return {
    version: workflowVersion(input.workflow),
    canAct: anyWorkflowActionGranted(input.grants),
    actions,
  };
}

/**
 * The stale-state token. `updatedAt` is maintained by Prisma's
 * `@updatedAt` on every write to the row, so any concurrent mutation
 * invalidates a token the operator captured earlier.
 */
export function workflowVersion(
  workflow: Pick<prismaPkg.OperationalWorkflow, "updatedAt">,
): string {
  return workflow.updatedAt.toISOString();
}

/**
 * PRO-P1C-01 — per action, whether the caller holds what the action's route
 * enforces: the action's `operations.*` permission (canonical role matrix,
 * member lifecycle included) AND the matching workbench capability (plan,
 * workspace kind, sharing). The same two questions `requireOpsCapability`
 * asks, answered once per distinct permission. Fail-closed: any evaluator
 * error resolves to "no action" rather than granting one.
 */
export async function resolveWorkflowActionCapability(input: {
  teamId: string;
  userId: string;
}): Promise<WorkflowActionGrants> {
  try {
    const resolved = await resolveMemberWorkspaceCapabilities({
      userId: input.userId,
      teamId: input.teamId,
    });
    if (!resolved) return NO_GRANTS;
    const permissions = [...new Set(Object.values(WORKFLOW_ACTION_OPS_PERMISSION))];
    const held = new Map<WorkflowOpsPermission, boolean>();
    for (const permission of permissions) {
      const decision = await evaluateMemberAccess({
        teamId: input.teamId,
        userId: input.userId,
        permission,
      });
      held.set(
        permission,
        decision.allowed === true && resolved.capabilities[OPS_PERMISSION_CAPABILITY[permission]] === true,
      );
    }
    return Object.fromEntries(
      WORKFLOW_ACTION_KEYS.map((a) => [a, held.get(WORKFLOW_ACTION_OPS_PERMISSION[a]) === true]),
    ) as Record<WorkflowActionKey, boolean>;
  } catch {
    return NO_GRANTS;
  }
}

// ---------------------------------------------------------------------------
// Workspace binding — the persisted row is the authority
// ---------------------------------------------------------------------------

export type BoundWorkflow = {
  workflow: prismaPkg.OperationalWorkflow;
  /** Workspace id read from the PERSISTED row, never from the request. */
  teamId: string;
};

/**
 * Loads a workflow by id ALONE and confirms the client-declared
 * workspace matches the persisted one.
 *
 * A caller who names a workspace that does not own the row gets the
 * same `null` a caller naming a non-existent workflow gets, so the
 * route's 404 cannot be used to enumerate workflows across tenants.
 */
export async function bindWorkflowWorkspace(
  input: {
    workflowId: string;
    declaredTeamId: string;
    /**
     * The acting user (required, PRO-P1-01): a workflow naming a record or a
     * case a restricted case closes to the actor is, to them, not there, the
     * same 404 as an unknown id. `null` is a machine path (only unrestricted
     * records stay open).
     */
    actorUserId: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<BoundWorkflow | null> {
  const workflow = await client.operationalWorkflow.findUnique({
    where: { id: input.workflowId },
  });
  if (!workflow) return null;
  if (workflow.teamId !== input.declaredTeamId) return null;
  if (workflow.evidenceId && (await evidenceClosedTo(workflow.evidenceId, input.actorUserId, client))) {
    return null;
  }
  if (workflow.caseId && (await caseClosedTo(workflow.caseId, input.actorUserId, client))) return null;
  return { workflow, teamId: workflow.teamId };
}

// ---------------------------------------------------------------------------
// Optimistic concurrency
// ---------------------------------------------------------------------------

export type VersionCheck =
  | { ok: true }
  | { ok: false; currentVersion: string; currentStatus: string };

/**
 * Compares the caller's `expectedVersion` with the persisted row. An
 * absent expectation is accepted (the field is optional for callers
 * that legitimately act without a prior read, e.g. automation), but
 * the Command Center always sends it.
 */
export function assertWorkflowVersion(
  workflow: prismaPkg.OperationalWorkflow,
  expectedVersion: string | null | undefined,
): VersionCheck {
  if (!expectedVersion) return { ok: true };
  const current = workflowVersion(workflow);
  if (current === expectedVersion) return { ok: true };
  return {
    ok: false,
    currentVersion: current,
    currentStatus: workflow.status,
  };
}

// ---------------------------------------------------------------------------
// Durable idempotency
// ---------------------------------------------------------------------------

/**
 * Namespaced so two different actions on the same workflow can never
 * collide on a caller-chosen key.
 */
export function idempotencyToken(
  action: WorkflowActionKey,
  idempotencyKey: string,
): string {
  return `${action}:${idempotencyKey}`;
}

export type WorkflowIdempotencyReplay = {
  recordedAtUtc: string;
  action: WorkflowActionKey;
};

/**
 * Looks for a previously recorded execution of (workflow, action, key).
 *
 * Durable: the marker lives on `operational_workflow_events`, a real
 * Postgres table, so it survives process restarts and is visible to
 * every API instance.
 */
export async function findWorkflowActionReplay(
  input: {
    workflowId: string;
    teamId: string;
    action: WorkflowActionKey;
    idempotencyKey: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<WorkflowIdempotencyReplay | null> {
  const token = idempotencyToken(input.action, input.idempotencyKey);
  try {
    const row = await client.operationalWorkflowEvent.findFirst({
      where: {
        workflowId: input.workflowId,
        teamId: input.teamId,
        metadataJson: {
          path: ["opsIdempotencyToken"],
          equals: token,
        },
      },
      orderBy: { occurredAtUtc: "desc" },
      select: { occurredAtUtc: true },
    });
    if (!row) return null;
    return {
      recordedAtUtc: row.occurredAtUtc.toISOString(),
      action: input.action,
    };
  } catch {
    // A replay lookup failure must NOT convert into a duplicate
    // mutation being silently applied — but it also must not hard-fail
    // an operator action. Returning null means "no known replay"; the
    // action proceeds and the marker write below still runs.
    return null;
  }
}

/** PRO-P1-06 — the reservation token, unique per workspace. */
export function workflowReservationToken(
  workflowId: string,
  action: WorkflowActionKey,
  idempotencyKey: string,
): string {
  return `${workflowId}:${idempotencyToken(action, idempotencyKey)}`.slice(0, 200);
}

export type WorkflowIdempotencyReservation =
  | { kind: "reserved"; markerId: string }
  | { kind: "replay"; recordedAtUtc: string };

/**
 * PRO-P1-06 — RESERVE the key BEFORE the effect.
 *
 * The marker used to be written after the state writer, so two concurrent
 * requests with one key both found no marker and both applied. The marker is
 * now inserted first under the (team, idempotency_token) unique index: exactly
 * one request inserts it and runs the action; the other hits the index and
 * replays. A marker whose action then fails is released
 * (`releaseWorkflowActionIdempotency`), so a retry can run.
 */
export async function reserveWorkflowActionIdempotency(
  input: {
    workflowId: string;
    teamId: string;
    action: WorkflowActionKey;
    idempotencyKey: string;
    actorUserId: string;
    currentStatus: prismaPkg.OperationalWorkflowStatus;
  },
  client: PrismaClient = defaultPrisma,
): Promise<WorkflowIdempotencyReservation> {
  const reservationToken = workflowReservationToken(input.workflowId, input.action, input.idempotencyKey);
  try {
    const marker = await client.operationalWorkflowEvent.create({
      data: {
        workflowId: input.workflowId,
        teamId: input.teamId,
        eventType: "STATUS_CHANGED",
        actorUserId: input.actorUserId,
        fromStatus: input.currentStatus,
        summary: `Operator action "${input.action}" recorded with an idempotency key.`,
        idempotencyToken: reservationToken,
        metadataJson: {
          opsIdempotencyToken: idempotencyToken(input.action, input.idempotencyKey),
          opsAction: input.action,
        },
      },
      select: { id: true },
    });
    return { kind: "reserved", markerId: marker.id };
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;
    const prior = await client.operationalWorkflowEvent.findFirst({
      where: { teamId: input.teamId, idempotencyToken: reservationToken },
      select: { occurredAtUtc: true },
    });
    return {
      kind: "replay",
      recordedAtUtc: (prior?.occurredAtUtc ?? new Date()).toISOString(),
    };
  }
}

/** PRO-P1-06 — the action applied: the reservation records the resulting status. */
export async function completeWorkflowActionIdempotency(
  markerId: string,
  resultingStatus: prismaPkg.OperationalWorkflowStatus,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  await client.operationalWorkflowEvent
    .update({ where: { id: markerId }, data: { toStatus: resultingStatus } })
    .catch(() => undefined);
}

/** PRO-P1-06 — the action did NOT apply: release the key so a retry runs. */
export async function releaseWorkflowActionIdempotency(
  markerId: string,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  await client.operationalWorkflowEvent.delete({ where: { id: markerId } }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Read projection
// ---------------------------------------------------------------------------

export type WorkflowPublicProjection = {
  id: string;
  teamId: string;
  workflowKey: string;
  workflowType: string;
  status: string;
  severity: string;
  priority: string;
  title: string;
  safeSummary: string;
  assignedOwnerUserId: string | null;
  escalationLevel: number;
  retryCount: number;
  nextRetryAtUtc: string | null;
  mitigationSummary: string | null;
  resolutionSummary: string | null;
  dueAtUtc: string | null;
  resolvedAtUtc: string | null;
  caseId: string | null;
  evidenceId: string | null;
  queueName: string | null;
  updatedAtUtc: string;
  /** Server-rendered availability. The client renders, never decides. */
  projection: WorkflowActionProjection;
};

/**
 * Narrow, anti-leak projection. `metadataJson` is deliberately NOT
 * projected — it can carry generator internals.
 */
export function projectWorkflowForPublic(
  workflow: prismaPkg.OperationalWorkflow,
  grants: WorkflowActionGrants,
): WorkflowPublicProjection {
  return {
    id: workflow.id,
    teamId: workflow.teamId,
    workflowKey: workflow.workflowKey,
    workflowType: workflow.workflowType,
    status: workflow.status,
    severity: workflow.severity,
    priority: workflow.priority,
    title: workflow.title,
    safeSummary: workflow.safeSummary,
    assignedOwnerUserId: workflow.assignedOwnerUserId,
    escalationLevel: workflow.escalationLevel,
    retryCount: workflow.retryCount,
    nextRetryAtUtc: workflow.nextRetryAtUtc?.toISOString() ?? null,
    mitigationSummary: workflow.mitigationSummary,
    resolutionSummary: workflow.resolutionSummary,
    dueAtUtc: workflow.dueAtUtc?.toISOString() ?? null,
    resolvedAtUtc: workflow.resolvedAtUtc?.toISOString() ?? null,
    caseId: workflow.caseId,
    evidenceId: workflow.evidenceId,
    queueName: workflow.queueName,
    updatedAtUtc: workflow.updatedAt.toISOString(),
    projection: projectWorkflowActions({ workflow, grants }),
  };
}
