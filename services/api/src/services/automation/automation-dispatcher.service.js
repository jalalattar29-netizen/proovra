/**
 * Phase E3.1 — Automation execution runtime.
 *
 * This module is the bounded execution layer that closes DEF-021. It:
 *
 *   1. Receives explicit trigger events from internal services via
 *      `dispatchAutomationTrigger()`.
 *   2. Matches enabled `AutomationRule` rows by `teamId + triggerType`.
 *   3. Evaluates each rule's `conditionJson` against the trigger context
 *      using the bounded operator set (`evaluateCondition`).
 *   4. Computes the deterministic idempotency key, creates a PENDING
 *      `AutomationRun`, then synchronously transitions it through
 *      RUNNING → SUCCEEDED / FAILED / SKIPPED.
 *   5. Executes the action through one of the 7 bounded handlers in
 *      `automation-actions.service.ts`.
 *   6. Emits the corresponding `automation_*` security event at every
 *      lifecycle transition.
 *
 * Design choices (matter; documented for future reviewers):
 *
 *   - **Synchronous in-process execution.** The dispatcher does NOT
 *     enqueue to BullMQ. Action handlers are short, bounded, fully
 *     idempotent, and read-only against the trigger target (they only
 *     write to safe surfaces like notifications / comments). A separate
 *     queue would add operational complexity (worker, retry, dead-letter)
 *     unjustified at this phase. If trigger volume ever warrants async
 *     processing, a follow-up phase can split the executor without
 *     changing the public dispatcher signature.
 *
 *   - **Idempotency is enforced at the DB layer.** The
 *     `automation_runs_team_rule_idempotency_uniq` unique index catches
 *     duplicate dispatch attempts; the dispatcher catches `P2002` and
 *     records a SKIPPED run reason of "duplicate_trigger".
 *
 *   - **Conditions are evaluated, not executed.** The condition tree
 *     is a pure descent through `equals` / `not_equals` / `greater_than`
 *     / `less_than` / `in` / `not_in` / `due_within_hours` /
 *     `older_than_days` leaves and `all` / `any` composites. There is
 *     no `eval`, no `vm`, no `new Function`. Pinned by `phase-e3-1-*`
 *     and `phase-e3-*` test suites.
 *
 *   - **Action failures DO NOT throw out of the dispatcher.** Every
 *     handler is wrapped; failures land as `FAILED` runs with a
 *     `sanitiseReason()`-bounded reason string. The caller of
 *     `dispatchAutomationTrigger()` (internal service code) never has
 *     its own flow broken by an automation failure.
 *
 * Hard rules (also pinned by `phase-e3-1-automation-execution.test.ts`):
 *   - Team-scoped: a trigger for team A never matches a rule on team B.
 *   - Disabled rules never execute.
 *   - No webhook execution (DEF-022 remains open).
 *   - No evidence / custody / report / package mutation.
 *   - No `eval` / `vm` / `new Function` in this file.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { AUTOMATION_ACTION_TYPES, AUTOMATION_TRIGGER_TYPES, computeIdempotencyKey, sanitiseReason, } from "./automation.service.js";
import { executeAutomationAction } from "./automation-actions.service.js";
/**
 * Evaluate a parsed condition tree against the trigger context.
 *
 * Returns true iff the condition matches. Empty / missing condition is
 * treated as "always match" — that's the documented E3 semantics.
 *
 * Hard rule: NEVER call `eval`. NEVER use `new Function`. NEVER import
 * `vm`. Pinned by tests at the source level.
 */
export function evaluateCondition(condition, context) {
    if (!condition || typeof condition !== "object")
        return true;
    // Empty object → always match.
    if (Object.keys(condition).length === 0)
        return true;
    return evalNode(condition, context);
}
function evalNode(node, ctx) {
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
function evalLeaf(leaf, ctx) {
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
function safeEq(a, b) {
    if (typeof a === "string" || typeof b === "string")
        return String(a) === String(b);
    return a === b;
}
function parseDateMaybe(v) {
    if (v instanceof Date)
        return v;
    if (typeof v !== "string" || v.length < 8)
        return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}
function dueWithinHours(actual, expected) {
    if (typeof expected !== "number" || !Number.isFinite(expected))
        return false;
    const d = parseDateMaybe(actual);
    if (!d)
        return false;
    const deltaHours = (d.getTime() - Date.now()) / (1000 * 60 * 60);
    return deltaHours >= 0 && deltaHours <= expected;
}
function olderThanDays(actual, expected) {
    if (typeof expected !== "number" || !Number.isFinite(expected))
        return false;
    const d = parseDateMaybe(actual);
    if (!d)
        return false;
    const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
    return ageDays > expected;
}
// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
/**
 * Public entry point. Internal service code calls this when a domain
 * event happens (e.g. a reviewer is reassigned, an SLA is due). The
 * dispatcher MUST NOT throw — failures inside automation never break
 * the calling flow.
 *
 * Returns a small outcome summary the caller can log if useful. The
 * dispatcher itself emits the canonical security events for run
 * lifecycle transitions.
 */
export async function dispatchAutomationTrigger(input, prisma = defaultPrisma) {
    const outcome = {
        considered: 0,
        created: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
    };
    // Guard: only accept allowlisted trigger types.
    if (!AUTOMATION_TRIGGER_TYPES.includes(input.triggerType)) {
        return outcome;
    }
    let rules;
    try {
        rules = await prisma.automationRule.findMany({
            where: {
                teamId: input.teamId,
                triggerType: input.triggerType,
                enabled: true,
            },
        });
    }
    catch {
        // DB error — dispatcher never throws.
        return outcome;
    }
    outcome.considered = rules.length;
    const safeCtx = (input.context ?? {});
    for (const rule of rules) {
        // Allowlist defence-in-depth at the executor too.
        if (!AUTOMATION_ACTION_TYPES.includes(rule.actionType)) {
            outcome.skipped += 1;
            continue;
        }
        // Condition evaluation. Match decides whether we create a run.
        const matched = evaluateCondition(rule.conditionJson, safeCtx);
        if (!matched) {
            // E3 documented decision: condition mismatch records a SKIPPED
            // run so operators can see the rule was considered. The DB
            // unique index still applies — multiple mismatched evaluations
            // for the same target collapse to one row.
            const key = computeIdempotencyKey({
                ruleId: rule.id,
                triggerType: input.triggerType,
                targetType: input.targetType,
                targetId: input.targetId,
            });
            try {
                await prisma.automationRun.create({
                    data: {
                        teamId: rule.teamId,
                        ruleId: rule.id,
                        triggerType: input.triggerType,
                        targetType: input.targetType,
                        targetId: input.targetId,
                        idempotencyKey: key,
                        status: "SKIPPED",
                        reason: "condition_not_matched",
                        startedAt: new Date(),
                        completedAt: new Date(),
                    },
                });
                outcome.skipped += 1;
                emitLifecycle("automation_run_skipped", {
                    teamId: rule.teamId,
                    ruleId: rule.id,
                    triggerType: input.triggerType,
                    actionType: rule.actionType,
                    targetType: input.targetType,
                    targetId: input.targetId,
                    reason: "condition_not_matched",
                });
            }
            catch (err) {
                // Likely P2002 duplicate (we've already recorded a SKIP for
                // this trigger+target). That's the intended behavior.
                if (!isUniqueConflict(err)) {
                    // Unexpected error — record nothing extra, dispatcher
                    // continues with other rules.
                }
            }
            continue;
        }
        // Matched — create a PENDING run + execute.
        const key = computeIdempotencyKey({
            ruleId: rule.id,
            triggerType: input.triggerType,
            targetType: input.targetType,
            targetId: input.targetId,
        });
        let run;
        try {
            run = await prisma.automationRun.create({
                data: {
                    teamId: rule.teamId,
                    ruleId: rule.id,
                    triggerType: input.triggerType,
                    targetType: input.targetType,
                    targetId: input.targetId,
                    idempotencyKey: key,
                    status: "PENDING",
                },
            });
            outcome.created += 1;
        }
        catch (err) {
            if (isUniqueConflict(err)) {
                // Duplicate trigger for the same target — DO NOT execute again.
                outcome.skipped += 1;
                emitLifecycle("automation_run_skipped", {
                    teamId: rule.teamId,
                    ruleId: rule.id,
                    triggerType: input.triggerType,
                    actionType: rule.actionType,
                    targetType: input.targetType,
                    targetId: input.targetId,
                    reason: "duplicate_trigger",
                });
                continue;
            }
            // Unexpected DB failure — skip this rule, keep going.
            outcome.failed += 1;
            continue;
        }
        // Transition PENDING → RUNNING and emit start event.
        try {
            await prisma.automationRun.update({
                where: { id: run.id },
                data: { status: "RUNNING", startedAt: new Date() },
            });
        }
        catch {
            // Best-effort transition — continue.
        }
        emitLifecycle("automation_run_started", {
            teamId: rule.teamId,
            ruleId: rule.id,
            runId: run.id,
            triggerType: input.triggerType,
            actionType: rule.actionType,
            targetType: input.targetType,
            targetId: input.targetId,
        });
        // Execute the action via the bounded handler dispatcher.
        let actionError = null;
        try {
            await executeAutomationAction({
                teamId: rule.teamId,
                ruleId: rule.id,
                runId: run.id,
                actionType: rule.actionType,
                actionConfig: rule.actionConfigJson,
                triggerType: input.triggerType,
                targetType: input.targetType,
                targetId: input.targetId,
                context: safeCtx,
            }, prisma);
        }
        catch (e) {
            actionError = e;
        }
        if (actionError) {
            const reason = sanitiseReason(actionError instanceof Error
                ? actionError.message
                : "action_handler_failed");
            try {
                await prisma.automationRun.update({
                    where: { id: run.id },
                    data: {
                        status: "FAILED",
                        reason: reason || "action_handler_failed",
                        completedAt: new Date(),
                    },
                });
            }
            catch {
                /* swallow — best-effort completion */
            }
            outcome.failed += 1;
            emitLifecycle("automation_run_failed", {
                teamId: rule.teamId,
                ruleId: rule.id,
                runId: run.id,
                triggerType: input.triggerType,
                actionType: rule.actionType,
                targetType: input.targetType,
                targetId: input.targetId,
                reason: reason || "action_handler_failed",
            });
            continue;
        }
        // Success.
        try {
            await prisma.automationRun.update({
                where: { id: run.id },
                data: { status: "SUCCEEDED", completedAt: new Date() },
            });
        }
        catch {
            /* swallow */
        }
        outcome.succeeded += 1;
        emitLifecycle("automation_run_succeeded", {
            teamId: rule.teamId,
            ruleId: rule.id,
            runId: run.id,
            triggerType: input.triggerType,
            actionType: rule.actionType,
            targetType: input.targetType,
            targetId: input.targetId,
        });
    }
    return outcome;
}
function emitLifecycle(eventType, payload) {
    // Operator-safe payload only — IDs + enum values + sanitised reason.
    // NEVER include raw evidence content, secrets, tokens, or external
    // payloads. The shape is intentionally small.
    safeEmitSecurityEvent({
        teamId: payload.teamId,
        eventType,
        severity: eventType === "automation_run_failed" ? "WARNING" : "INFO",
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
export function emitActionExecuted(payload) {
    emitLifecycle("automation_action_executed", payload);
}
// ---------------------------------------------------------------------------
// Prisma error helpers
// ---------------------------------------------------------------------------
function isUniqueConflict(err) {
    const e = err;
    return e?.code === "P2002";
}
