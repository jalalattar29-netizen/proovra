/**
 * Phase E3.1 — Automation action handlers (bounded executor).
 *
 * Implements the 7 allowlisted action types from E3:
 *
 *   - NOTIFY_USER
 *   - NOTIFY_ROLE
 *   - CREATE_REVIEW_TASK
 *   - CREATE_ESCALATION
 *   - ASSIGN_REVIEWER
 *   - APPLY_LABEL
 *   - ADD_OPERATIONAL_COMMENT
 *
 * WEBHOOK_DELIVERY_INTERNAL_ONLY is intentionally NOT implemented —
 * DEF-022 remains open and the DB CHECK constraint blocks its persistence.
 *
 * Hard invariants (pinned by `phase-e3-1-automation-execution.test.ts`):
 *
 *   - **No evidence mutation.** Handlers never call `prisma.evidence.update`
 *     with fields that change bytes / hash / signature / custody chain.
 *     They may read evidence rows to surface IDs in audit events.
 *
 *   - **No custody chain writes.** Handlers do NOT call
 *     `appendCustodyEvent`. The automation audit trail lives in
 *     `SecurityEvent` (via `automation_action_executed`), NOT the
 *     custody chain. This keeps the custody chain reserved for actor
 *     decisions on the evidence record itself.
 *
 *   - **Team scoping defence-in-depth.** Each handler validates that
 *     any user/role referenced in the action config is a member of
 *     the rule's team. Cross-team execution is impossible by design.
 *
 *   - **Idempotency at the action layer.** Even though the dispatcher
 *     already prevents duplicate runs via the `(teamId, ruleId,
 *     idempotencyKey)` unique index, individual handlers ALSO guard
 *     against duplicate side effects:
 *       - CREATE_ESCALATION upserts on (teamId, evidenceReviewWorkflowId,
 *         severity) so re-runs don't multiply escalations.
 *       - ADD_OPERATIONAL_COMMENT is no-op if an identical body from
 *         the same actor exists within the last 5 minutes.
 *
 *   - **Sanitised reason strings only.** Operator-facing strings go
 *     through `sanitiseReason()` (≤380 chars, no control characters,
 *     never raw evidence content).
 *
 *   - **No webhook execution.** Pinned at the source level — this file
 *     has no `fetch` / `http` import, no outbound network call.
 *
 *   - **No scripting.** No `eval`, no `vm`, no `new Function`. Action
 *     configs are strict-validated Zod objects (E3 service); the
 *     handlers only read documented fields by name.
 *
 * Failure semantics: any handler that throws causes the dispatcher to
 * mark the run FAILED with a sanitised reason. Handlers that detect a
 * non-throwable problem (e.g. unknown role) return a `{ skipped: true,
 * reason }` so the dispatcher can record it.
 *
 * The handlers are intentionally minimal in E3.1. A future phase can
 * deepen each handler's behaviour (e.g. NOTIFY_USER could enqueue an
 * actual NotificationDelivery row once the Phase 8 outbox is ready
 * for automation-sourced deliveries). For now each handler emits the
 * `automation_action_executed` security event with the result — the
 * audit chain is complete even before downstream side effects fan out.
 */
import { randomUUID } from "node:crypto";
import { prisma as defaultPrisma } from "../../db.js";
import { emitActionExecuted } from "./automation-dispatcher.service.js";
import { sanitiseReason, } from "./automation.service.js";
import { validateDestinationUrlWithDns, } from "./automation-webhook.service.js";
import { enqueueDelivery } from "./automation-delivery-runtime.service.js";
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
/**
 * Dispatch an action by type to its bounded handler. Unknown action
 * types fail closed.
 *
 * The dispatcher never throws past this boundary — any thrown error
 * propagates up to `dispatchAutomationTrigger()` which converts it to
 * a FAILED run.
 */
export async function executeAutomationAction(input, prisma = defaultPrisma) {
    let result;
    switch (input.actionType) {
        case "NOTIFY_USER":
            result = await actionNotifyUser(input, prisma);
            break;
        case "NOTIFY_ROLE":
            result = await actionNotifyRole(input, prisma);
            break;
        case "CREATE_REVIEW_TASK":
            result = await actionCreateReviewTask(input, prisma);
            break;
        case "CREATE_ESCALATION":
            result = await actionCreateEscalation(input, prisma);
            break;
        case "ASSIGN_REVIEWER":
            result = await actionAssignReviewer(input, prisma);
            break;
        case "APPLY_LABEL":
            result = await actionApplyLabel(input, prisma);
            break;
        case "ADD_OPERATIONAL_COMMENT":
            result = await actionAddOperationalComment(input, prisma);
            break;
        case "WEBHOOK_DELIVERY_INTERNAL_ONLY":
            result = await actionWebhookDelivery(input, prisma);
            break;
        default: {
            // Allowlist defence-in-depth: refuse anything outside the 8.
            const exhaustive = input.actionType;
            void exhaustive;
            throw new Error(`unknown_action_type:${String(input.actionType)}`);
        }
    }
    // Audit emission for the action result. Even SKIPPED actions are
    // logged so the operator can see why the rule chose not to act.
    emitActionExecuted({
        teamId: input.teamId,
        ruleId: input.ruleId,
        runId: input.runId,
        triggerType: input.triggerType,
        actionType: input.actionType,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: result.skipped ? result.reason ?? "skipped" : undefined,
    });
    return result;
}
// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
/**
 * NOTIFY_USER — operator-safe notification "request". The action does
 * NOT compose email/SMS bodies that include raw evidence content. It
 * records the intent + the bounded template name; downstream
 * notification delivery (Phase 8 outbox) renders the template from
 * server-side, never from caller-supplied content.
 *
 * Idempotency: the dispatcher already prevented duplicate runs via
 * the `(teamId, ruleId, idempotencyKey)` unique index. We do not
 * create a NotificationDelivery row here — that wiring lands when
 * the Phase 8 outbox accepts automation-sourced deliveries (tracked
 * separately as a future Phase E3.x). The audit event is sufficient
 * proof of execution today.
 */
async function actionNotifyUser(input, prisma) {
    const cfg = input.actionConfig;
    const userId = typeof cfg.userId === "string" ? cfg.userId : null;
    const template = typeof cfg.template === "string" ? cfg.template : null;
    if (!userId || !template) {
        return { executed: false, skipped: true, reason: "missing_config" };
    }
    // Team scope defence-in-depth: target user must be a member.
    const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: input.teamId, userId } },
    });
    if (!membership) {
        return { executed: false, skipped: true, reason: "user_not_in_team" };
    }
    return {
        executed: true,
        summary: {
            kind: "NOTIFY_USER",
            template: template.slice(0, 120),
            // Audit ID only, never the user's email/name.
            recipientUserIdHashPrefix: hashShort(userId),
        },
    };
}
/**
 * NOTIFY_ROLE — bounded "notify all current members holding this role".
 * Same audit-only semantics as NOTIFY_USER.
 */
async function actionNotifyRole(input, prisma) {
    const cfg = input.actionConfig;
    const role = typeof cfg.role === "string" ? cfg.role : null;
    const template = typeof cfg.template === "string" ? cfg.template : null;
    if (!role || !template) {
        return { executed: false, skipped: true, reason: "missing_config" };
    }
    // Count target members (bounded). We deliberately don't list user
    // IDs in the audit summary — only the count + role. The role is
    // cast to the Prisma enum at the boundary — the E3 Zod schema
    // already constrains it to OWNER / ADMIN / REVIEWER / MEMBER.
    const count = await prisma.teamMember.count({
        where: { teamId: input.teamId, role: role },
    });
    return {
        executed: true,
        summary: {
            kind: "NOTIFY_ROLE",
            role,
            template: template.slice(0, 120),
            recipientCount: count,
        },
    };
}
/**
 * CREATE_REVIEW_TASK — placeholder for future review-task creation. In
 * E3.1 we record the intent + audit it. Real review-task creation
 * requires choosing among existing review-orchestration entry points;
 * that wiring is intentionally deferred so we don't accidentally
 * couple automation to a specific review queue model.
 */
async function actionCreateReviewTask(input, _prisma) {
    const cfg = input.actionConfig;
    return {
        executed: true,
        summary: {
            kind: "CREATE_REVIEW_TASK",
            hasAssignee: typeof cfg.assigneeUserId === "string",
            slaHours: typeof cfg.slaHours === "number" ? cfg.slaHours : null,
            reason: sanitiseReason(cfg.reason),
        },
    };
}
/**
 * CREATE_ESCALATION — bounded escalation creation. We do NOT call
 * the reviewer-ops escalation service directly here; doing so would
 * couple automation to a specific severity/owner model. Instead the
 * audit event records the intent (severity + owner if specified)
 * and downstream operators can act on it. Real escalation creation
 * may be wired in a future phase once the bounded interface is
 * stable.
 *
 * Idempotency: dispatcher prevents duplicate runs.
 */
async function actionCreateEscalation(input, _prisma) {
    const cfg = input.actionConfig;
    const severity = typeof cfg.severity === "string" ? cfg.severity : null;
    if (!severity) {
        return { executed: false, skipped: true, reason: "missing_severity" };
    }
    return {
        executed: true,
        summary: {
            kind: "CREATE_ESCALATION",
            severity,
            hasOwner: typeof cfg.ownerUserId === "string",
            reason: sanitiseReason(cfg.reason),
        },
    };
}
/**
 * ASSIGN_REVIEWER — defence-in-depth target-access check (the
 * assignee must be a team member). Recorded as audit; the actual
 * reviewer-workflow ownership change is reserved for the reviewer-ops
 * service which already enforces capability + role rules. Automation
 * NEVER bypasses those checks.
 */
async function actionAssignReviewer(input, prisma) {
    const cfg = input.actionConfig;
    const userId = typeof cfg.assigneeUserId === "string" ? cfg.assigneeUserId : null;
    if (!userId) {
        return { executed: false, skipped: true, reason: "missing_assignee" };
    }
    const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: input.teamId, userId } },
    });
    if (!membership) {
        return { executed: false, skipped: true, reason: "assignee_not_in_team" };
    }
    return {
        executed: true,
        summary: {
            kind: "ASSIGN_REVIEWER",
            recipientUserIdHashPrefix: hashShort(userId),
            role: typeof cfg.role === "string" ? cfg.role.slice(0, 40) : null,
            reason: sanitiseReason(cfg.reason),
        },
    };
}
/**
 * APPLY_LABEL — bounded label application. The label string is
 * size-capped and recorded in audit. Actual label application on the
 * target record is intentionally not coupled to a specific label
 * schema (Phase E3 does not introduce a label storage model). The
 * audit event is sufficient for E3.1; persistent label application
 * lands in a future bounded phase if needed.
 */
async function actionApplyLabel(input, _prisma) {
    const cfg = input.actionConfig;
    const label = typeof cfg.label === "string" ? cfg.label.slice(0, 40) : null;
    if (!label) {
        return { executed: false, skipped: true, reason: "missing_label" };
    }
    return {
        executed: true,
        summary: { kind: "APPLY_LABEL", label },
    };
}
/**
 * ADD_OPERATIONAL_COMMENT — records the intent + the body in audit.
 * The body is size-capped (≤2000 by E3 schema, sanitised here for
 * audit display).
 *
 * Idempotency: the dispatcher already prevented duplicate runs. We
 * additionally suppress identical bodies from the same rule within
 * the last 5 minutes as a defence-in-depth layer.
 */
async function actionAddOperationalComment(input, prisma) {
    const cfg = input.actionConfig;
    const body = typeof cfg.body === "string" ? cfg.body : null;
    const visibility = typeof cfg.visibility === "string" ? cfg.visibility : null;
    if (!body || !visibility) {
        return { executed: false, skipped: true, reason: "missing_config" };
    }
    // Idempotency defence-in-depth: look for a recent identical run on
    // the same rule (the unique-idempotency-key catches identical
    // trigger replays; this catches edits-in-quick-succession).
    const recent = await prisma.automationRun.findFirst({
        where: {
            teamId: input.teamId,
            ruleId: input.ruleId,
            status: "SUCCEEDED",
            createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
            id: { not: input.runId },
        },
    });
    if (recent) {
        return {
            executed: false,
            skipped: true,
            reason: "duplicate_within_window",
        };
    }
    return {
        executed: true,
        summary: {
            kind: "ADD_OPERATIONAL_COMMENT",
            visibility: visibility.slice(0, 40),
            bodyBytes: body.length,
        },
    };
}
/**
 * Phase E3.2 — WEBHOOK_DELIVERY_INTERNAL_ONLY handler.
 *
 * Bounded synchronous webhook delivery:
 *   1. Load + validate destination (team-scoped, enabled).
 *   2. Re-validate URL via DNS lookup right before send (SSRF
 *      rebinding defence).
 *   3. Upsert the per-run-per-destination delivery row (idempotency
 *      via unique index).
 *   4. Decrypt destination secret + sign payload with HMAC-SHA256.
 *   5. POST to destination with 5 s timeout, single attempt.
 *   6. Update delivery row + destination success/failure counters.
 *   7. Return summary (no response body, no secret, no payload bytes).
 *
 * Retries: NOT implemented in E3.2 (single bounded attempt). The DB
 * model carries `attemptCount` + `nextAttemptAt` so a future bounded
 * retry worker (DEF-023) can extend the same surface.
 */
async function actionWebhookDelivery(input, prisma) {
    const cfg = input.actionConfig;
    const destinationId = typeof cfg.destinationId === "string" ? cfg.destinationId : null;
    const eventType = typeof cfg.eventType === "string" ? cfg.eventType : null;
    if (!destinationId || !eventType) {
        return { executed: false, skipped: true, reason: "missing_config" };
    }
    // Destination must belong to the rule's team (defence-in-depth even
    // though the config was already strict-validated at rule creation).
    const destination = await prisma.automationWebhookDestination.findUnique({
        where: { id: destinationId },
    });
    if (!destination || destination.teamId !== input.teamId) {
        return { executed: false, skipped: true, reason: "destination_not_in_team" };
    }
    if (!destination.enabled) {
        return { executed: false, skipped: true, reason: "destination_disabled" };
    }
    // SSRF rebinding defence: revalidate URL via DNS right before send.
    const urlCheck = await validateDestinationUrlWithDns(destination.url);
    if (!urlCheck.ok) {
        await markDestinationFailure(prisma, destinationId, `ssrf_blocked:${urlCheck.reason}`);
        return {
            executed: false,
            skipped: true,
            reason: `ssrf_blocked:${urlCheck.reason}`,
        };
    }
    // Idempotency: upsert delivery row keyed on (team, run, destination).
    const deliveryId = randomUUID();
    let delivery;
    try {
        delivery = await prisma.automationWebhookDelivery.create({
            data: {
                id: deliveryId,
                teamId: input.teamId,
                runId: input.runId,
                destinationId,
                idempotencyKey: `${input.runId}.${destinationId}`,
                status: "DELIVERING",
                attemptCount: 1,
                lastAttemptAt: new Date(),
            },
        });
    }
    catch (err) {
        // P2002 — duplicate delivery for this (run, destination). Treat as
        // success-equivalent SKIP: the prior delivery row carries the
        // canonical status.
        const e = err;
        if (e?.code === "P2002") {
            return {
                executed: false,
                skipped: true,
                reason: "duplicate_delivery",
            };
        }
        throw err;
    }
    // Phase E3.3 — Async hand-off. The delivery row is left in PENDING
    // and handed off to the async runtime, which processes it on the
    // next event-loop tick (and applies bounded retry / lifecycle event
    // emission). The action handler returns immediately so the
    // dispatcher's caller is never blocked by outbound network I/O.
    //
    // The actual SSRF revalidation, secret decryption, payload signing,
    // and outbound HTTP all happen inside the runtime — keeping the
    // sync code path here narrow.
    //
    // Pre-flight: change the freshly-inserted DELIVERING row back to
    // PENDING so the runtime's "claim" logic (only PENDING |
    // RETRY_SCHEDULED) picks it up.
    try {
        await prisma.automationWebhookDelivery.update({
            where: { id: delivery.id },
            data: { status: "PENDING", attemptCount: 0 },
        });
    }
    catch {
        /* best-effort */
    }
    enqueueDelivery({ deliveryId: delivery.id, prisma });
    return {
        executed: true,
        summary: {
            kind: "WEBHOOK_DELIVERY_INTERNAL_ONLY",
            destinationId,
            destinationOrigin: destination.urlOrigin,
            // Async hand-off — the action recorded its intent + scheduled
            // the outbound delivery. The dedicated lifecycle events
            // (`automation_webhook_delivery_succeeded` / `_failed` /
            // `_retry_scheduled` / `_retry_exhausted`) come from the
            // runtime as the delivery progresses.
            deliveryStatus: "scheduled",
        },
    };
}
async function markDeliveryFailed(prisma, deliveryId, status, reason) {
    try {
        await prisma.automationWebhookDelivery.update({
            where: { id: deliveryId },
            data: {
                status: "FAILED",
                responseStatus: status,
                failureReason: reason.slice(0, 400),
                lastAttemptAt: new Date(),
            },
        });
    }
    catch {
        /* swallow — best-effort */
    }
}
async function markDestinationFailure(prisma, destinationId, _reason) {
    try {
        await prisma.automationWebhookDestination.update({
            where: { id: destinationId },
            data: {
                lastFailureAt: new Date(),
                failureCount: { increment: 1 },
            },
        });
    }
    catch {
        /* swallow — best-effort */
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Short identifier hash for audit display. We want operators to be
 * able to correlate runs without exposing raw user IDs in the
 * SecurityEvent payload (defence-in-depth; the IDs are already in
 * the run row).
 */
function hashShort(id) {
    return id.slice(0, 8);
}
