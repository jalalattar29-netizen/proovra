/**
 * Automation — the PURE half.
 *
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07) rewrote what
 * this module is. It was the in-process dispatcher: match, create a run,
 * execute the action synchronously inside whatever request called it. Nothing
 * ever did call it, so the whole feature was inert — and the shape itself was
 * unsound, because an in-request executor has no lease, no fence, no attempt
 * counter and no retry that survives a restart.
 *
 * What remains here is everything that touches neither the database nor the
 * outside world:
 *
 *   * `evaluateCondition` — a pure descent through the bounded operator set
 *     (`equals` / `not_equals` / `greater_than` / `less_than` / `in` /
 *     `not_in` / `due_within_hours` / `older_than_days` leaves, `all` / `any`
 *     composites). There is no `eval`, no `vm`, no `new Function`, and keeping
 *     it in ONE module is what makes that claim checkable. Unknown shapes and
 *     unknown operators fail CLOSED.
 *
 *   * The operator-safe lifecycle emitters, shared by the producer and the
 *     processor so both describe a run the same way. IDs, enum values and a
 *     sanitised reason only — never raw evidence content, secrets, tokens or
 *     external payloads.
 *
 * The two halves that DO touch state:
 *   PRODUCER   automation-outbox.service.ts
 *   PROCESSOR  automation-dispatch-runtime.service.ts
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import type {
  AutomationActionType,
  AutomationTriggerType,
} from "./automation.service.js";

// The trigger payload shape lives with the PRODUCER
// (`automation-outbox.service.ts#EnqueueAutomationTriggerInput`). It used to be
// declared here as well, which is how a payload contract comes to have two
// definitions that drift.

// ---------------------------------------------------------------------------
// Condition evaluator (pure; no eval; bounded operators only)
// ---------------------------------------------------------------------------

type ConditionLeaf = {
  field: string;
  op: string;
  value: unknown;
};

type ConditionNode =
  | ConditionLeaf
  | { all: ConditionNode[] }
  | { any: ConditionNode[] };

/**
 * Evaluate a parsed condition tree against the trigger context.
 *
 * Returns true iff the condition matches. Empty / missing condition is
 * treated as "always match" — that's the documented E3 semantics.
 *
 * Hard rule: NEVER call `eval`. NEVER use `new Function`. NEVER import
 * `vm`. Pinned by tests at the source level.
 */
export function evaluateCondition(
  condition: unknown,
  context: Readonly<Record<string, unknown>>,
): boolean {
  if (!condition || typeof condition !== "object") return true;
  // Empty object → always match.
  if (Object.keys(condition).length === 0) return true;
  return evalNode(condition as ConditionNode, context);
}

function evalNode(
  node: ConditionNode,
  ctx: Readonly<Record<string, unknown>>,
): boolean {
  if ("all" in node && Array.isArray(node.all)) {
    return node.all.every((child) => evalNode(child, ctx));
  }
  if ("any" in node && Array.isArray(node.any)) {
    return node.any.some((child) => evalNode(child, ctx));
  }
  if ("field" in node && "op" in node && "value" in node) {
    return evalLeaf(node, ctx);
  }
  // Unknown shape → fail closed (no match).
  return false;
}

function evalLeaf(
  leaf: ConditionLeaf,
  ctx: Readonly<Record<string, unknown>>,
): boolean {
  const actual = ctx[leaf.field];
  const expected = leaf.value;
  switch (leaf.op) {
    case "equals":
      return safeEq(actual, expected);
    case "not_equals":
      return !safeEq(actual, expected);
    case "greater_than":
      return typeof actual === "number" && typeof expected === "number"
        ? actual > expected
        : false;
    case "less_than":
      return typeof actual === "number" && typeof expected === "number"
        ? actual < expected
        : false;
    case "in":
      return Array.isArray(expected) && expected.some((v) => safeEq(actual, v));
    case "not_in":
      return Array.isArray(expected) && !expected.some((v) => safeEq(actual, v));
    case "due_within_hours":
      return dueWithinHours(actual, expected);
    case "older_than_days":
      return olderThanDays(actual, expected);
    default:
      return false; // unknown operator → fail closed
  }
}

function safeEq(a: unknown, b: unknown): boolean {
  if (typeof a === "string" || typeof b === "string") return String(a) === String(b);
  return a === b;
}

function parseDateMaybe(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v !== "string" || v.length < 8) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dueWithinHours(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "number" || !Number.isFinite(expected)) return false;
  const d = parseDateMaybe(actual);
  if (!d) return false;
  const deltaHours = (d.getTime() - Date.now()) / (1000 * 60 * 60);
  return deltaHours >= 0 && deltaHours <= expected;
}

function olderThanDays(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "number" || !Number.isFinite(expected)) return false;
  const d = parseDateMaybe(actual);
  if (!d) return false;
  const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > expected;
}

// ---------------------------------------------------------------------------
// WHERE THE DISPATCHER WENT
//
// PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07).
//
// `dispatchAutomationTrigger` used to live here: it matched rules, created a
// run, and then executed the action SYNCHRONOUSLY, in whatever API request
// happened to call it — except that nothing ever did. It had zero production
// callers, so the feature was configurable and inert; and had anything called
// it, an in-request executor with no lease, no fence, no attempt counter and
// no retry that survives a restart would have lost work on every deploy.
//
// It is split in two, and neither half is here by accident:
//
//   PRODUCER   automation-outbox.service.ts#enqueueAutomationTrigger
//              writes PENDING runs INSIDE the source domain transaction, so a
//              rolled-back change leaves no run and a committed one cannot be
//              lost between commit and dispatch.
//
//   PROCESSOR  automation-dispatch-runtime.service.ts
//              claims a due run under a lease + monotonic generation, executes
//              the bounded action, and writes exactly one terminal state.
//
// What stays in THIS file is the pure part: the condition evaluator, which
// touches no database and no clock beyond `Date.now()`, and the operator-safe
// lifecycle emitters both halves share. Keeping the evaluator here keeps its
// no-eval guarantee in one place.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lifecycle event emission
// ---------------------------------------------------------------------------

type LifecyclePayload = {
  teamId: string;
  ruleId: string;
  runId?: string;
  triggerType: AutomationTriggerType;
  actionType: AutomationActionType;
  targetType: string;
  targetId: string;
  reason?: string;
};

export function emitRunLifecycle(
  eventType:
    | "automation_run_started"
    | "automation_run_succeeded"
    | "automation_run_failed"
    | "automation_run_skipped"
    // ARCH-005 §1 (2026-08-07) — an outcome the system cannot determine is
    // audited AS unknown. Folding it into `_failed` would put a refusal in
    // the trail that nobody observed.
    | "automation_run_ambiguous"
    | "automation_run_dead_lettered_unknown"
    | "automation_action_executed",
  payload: LifecyclePayload,
): void {
  // Operator-safe payload only — IDs + enum values + sanitised reason.
  // NEVER include raw evidence content, secrets, tokens, or external
  // payloads. The shape is intentionally small.
  safeEmitSecurityEvent({
    teamId: payload.teamId,
    eventType,
    severity:
      eventType === "automation_run_failed" ||
      eventType === "automation_run_dead_lettered_unknown"
        ? "WARNING"
        : "INFO",
    details: {
      ruleId: payload.ruleId,
      ...(payload.runId ? { runId: payload.runId } : {}),
      triggerType: payload.triggerType,
      actionType: payload.actionType,
      targetType: payload.targetType,
      targetId: payload.targetId,
      ...(payload.reason ? { reason: payload.reason } : {}),
    },
  });
}

// Re-export for the action handlers to call when they execute.
export function emitActionExecuted(payload: LifecyclePayload): void {
  emitRunLifecycle("automation_action_executed", payload);
}

/** The lifecycle payload shape, exported for the processor. */
export type AutomationLifecyclePayload = LifecyclePayload;

// Type re-exports for consumers of the runtime.
export type AutomationDispatcherClient = Prisma.TransactionClient | PrismaClient;
