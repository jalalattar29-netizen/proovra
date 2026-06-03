/**
 * Phase E3 — Operational Automation Foundation service.
 *
 * Pure orchestration logic for the bounded automation model:
 *
 *   - Allowlisted trigger types (11)
 *   - Allowlisted action types (7 — webhook intentionally deferred to E3.2)
 *   - Strict JSON validation for conditions + action configs
 *   - Idempotency key computation (deterministic from trigger + target)
 *   - Rule create / update / enable / disable
 *   - Run list / fetch
 *
 * Hard contracts (also pinned by phase-e3-automation-foundation.test.ts):
 *   - Team-scoped: every read + write requires teamId.
 *   - No `eval`, no dynamic code execution, no scripting.
 *   - No evidence / custody / report / package mutation through this
 *     service. Action runtime dispatch is deferred to E3.1 (DEF-021)
 *     and will enforce the same allowlist at execution time.
 *   - All operator-facing strings (reason, name, description) are
 *     bounded length; condition + action config are bounded depth.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
// ---------------------------------------------------------------------------
// Allowlists (mirrored exactly in the DB CHECK constraints; the migration
// is the source of truth for the SQL layer, this file is the source of
// truth for the TS layer)
// ---------------------------------------------------------------------------
export const AUTOMATION_TRIGGER_TYPES = [
    "EVIDENCE_CREATED",
    "EVIDENCE_FINALIZED",
    "EVIDENCE_REPORTED",
    "PACKAGE_READY",
    "REVIEW_ASSIGNED",
    "REVIEW_OVERDUE",
    "SLA_DUE_SOON",
    "ESCALATION_CREATED",
    "LEGAL_HOLD_CREATED",
    "RETENTION_CANDIDATE_FOUND",
    "EXTERNAL_ACCESS_EXPIRING",
];
export const AUTOMATION_ACTION_TYPES = [
    "NOTIFY_USER",
    "NOTIFY_ROLE",
    "CREATE_REVIEW_TASK",
    "CREATE_ESCALATION",
    "ASSIGN_REVIEWER",
    "APPLY_LABEL",
    "ADD_OPERATIONAL_COMMENT",
    // Phase E3.2 — DEF-022 closure. Webhook delivery is bounded by
    // automation-webhook.service.ts: HTTPS-only, SSRF-checked,
    // HMAC-SHA256 signed, 32 KiB payload cap, single bounded attempt
    // with 5 s timeout. Retry worker is deferred as DEF-023.
    "WEBHOOK_DELIVERY_INTERNAL_ONLY",
];
export const AUTOMATION_RUN_STATUSES = [
    "PENDING",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "SKIPPED",
];
// ---------------------------------------------------------------------------
// Strict JSON validation schemas
//
// Conditions are a small, bounded tree of (operator, leaf) shapes. No
// recursion deeper than CONDITION_MAX_DEPTH. No dynamic operators. No
// `eval`. The leaf operators are strictly enumerated.
// ---------------------------------------------------------------------------
export const CONDITION_MAX_DEPTH = 4;
export const CONDITION_LEAF_OPERATORS = [
    "equals",
    "not_equals",
    "greater_than",
    "less_than",
    "in",
    "not_in",
    "due_within_hours",
    "older_than_days",
];
/** Bounded primitive values allowed in condition leaves. */
const ConditionValue = z.union([
    z.boolean(),
    z.string().max(120),
    z.number().int().min(-1_000_000).max(1_000_000),
]);
const ConditionLeaf = z.object({
    field: z.string().min(1).max(80),
    op: z.enum(CONDITION_LEAF_OPERATORS),
    value: z.union([ConditionValue, z.array(ConditionValue).max(16)]),
});
/**
 * Build the bounded recursive Zod schema. Depth is enforced by
 * recursing exactly `depth` times then bottoming out at leaves.
 */
function buildConditionSchema(depth) {
    if (depth <= 0)
        return ConditionLeaf;
    const inner = buildConditionSchema(depth - 1);
    return z.union([
        ConditionLeaf,
        z
            .object({ all: z.array(inner).min(1).max(8) })
            .strict(),
        z
            .object({ any: z.array(inner).min(1).max(8) })
            .strict(),
    ]);
}
export const ConditionSchema = buildConditionSchema(CONDITION_MAX_DEPTH);
/**
 * Empty condition is allowed — it means "always match the trigger
 * target, no extra filter."
 */
export const ConditionEnvelopeSchema = z.union([
    z.object({}).strict(),
    ConditionSchema,
]);
// ---------------------------------------------------------------------------
// Per-action-type config schemas. Each is strict — unknown fields are
// rejected. No URLs accepted in any action config that is NOT
// WEBHOOK_DELIVERY (and webhook is not shipped in E3).
// ---------------------------------------------------------------------------
const UuidString = z.string().uuid();
const ActionConfigSchemas = {
    NOTIFY_USER: z
        .object({
        userId: UuidString,
        template: z.string().min(1).max(120),
    })
        .strict(),
    NOTIFY_ROLE: z
        .object({
        role: z.enum(["OWNER", "ADMIN", "REVIEWER", "MEMBER"]),
        template: z.string().min(1).max(120),
    })
        .strict(),
    CREATE_REVIEW_TASK: z
        .object({
        assigneeUserId: UuidString.optional(),
        slaHours: z.number().int().min(1).max(720).optional(),
        reason: z.string().min(1).max(200).optional(),
    })
        .strict(),
    CREATE_ESCALATION: z
        .object({
        severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        ownerUserId: UuidString.optional(),
        reason: z.string().min(1).max(200).optional(),
    })
        .strict(),
    ASSIGN_REVIEWER: z
        .object({
        assigneeUserId: UuidString,
        role: z.string().min(1).max(40).optional(),
        reason: z.string().min(1).max(200).optional(),
    })
        .strict(),
    APPLY_LABEL: z
        .object({
        label: z.string().min(1).max(40),
    })
        .strict(),
    ADD_OPERATIONAL_COMMENT: z
        .object({
        body: z.string().min(1).max(2000),
        visibility: z.enum(["INTERNAL", "REVIEWERS", "ALL_MEMBERS"]),
    })
        .strict(),
    // Phase E3.2 — bounded webhook delivery config. The destinationId
    // references a row in `automation_webhook_destinations` that has
    // already passed URL / SSRF / HTTPS validation at creation time.
    // The eventType is a short identifier the receiver can switch on
    // without inspecting the rule. `metadataPassThrough` is a tiny
    // bounded set of metadata keys the rule wants attached to the
    // payload from the trigger context — strictly enumerated, never
    // raw evidence content.
    WEBHOOK_DELIVERY_INTERNAL_ONLY: z
        .object({
        destinationId: UuidString,
        eventType: z.string().min(1).max(80),
        metadataPassThrough: z
            .array(z.string().min(1).max(60))
            .max(8)
            .optional(),
    })
        .strict(),
};
// ---------------------------------------------------------------------------
// Rule input shapes
// ---------------------------------------------------------------------------
const NameSchema = z.string().min(1).max(120);
const DescriptionSchema = z.string().max(500).optional();
export const CreateAutomationRuleInput = z.object({
    teamId: UuidString,
    name: NameSchema,
    description: DescriptionSchema,
    triggerType: z.enum(AUTOMATION_TRIGGER_TYPES),
    conditionJson: ConditionEnvelopeSchema.optional(),
    actionType: z.enum(AUTOMATION_ACTION_TYPES),
    actionConfigJson: z.unknown(),
});
export const UpdateAutomationRuleInput = z.object({
    name: NameSchema.optional(),
    description: DescriptionSchema,
    conditionJson: ConditionEnvelopeSchema.optional(),
    actionConfigJson: z.unknown().optional(),
});
/**
 * Validate the action config against the per-action-type strict schema.
 * Returns either a typed-safe parsed config OR a list of validation
 * errors. Never throws.
 */
export function validateActionConfig(actionType, raw) {
    const schema = ActionConfigSchemas[actionType];
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
        return {
            ok: false,
            errors: parsed.error.issues.map((i) => ({
                field: i.path.join(".") || "(root)",
                reason: i.message,
            })),
        };
    }
    return { ok: true, config: parsed.data };
}
/** Same shape for conditions. Empty `{}` is valid (always-match). */
export function validateCondition(raw) {
    const parsed = ConditionEnvelopeSchema.safeParse(raw ?? {});
    if (!parsed.success) {
        return {
            ok: false,
            errors: parsed.error.issues.map((i) => ({
                field: i.path.join(".") || "(root)",
                reason: i.message,
            })),
        };
    }
    return { ok: true, condition: parsed.data };
}
// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------
/**
 * Deterministic idempotency key derived from (rule, trigger, target).
 * The key is `sha256(ruleId|triggerType|targetType|targetId)` truncated
 * to 64 hex chars (fits the DB column easily, leaves room for a future
 * `:retry-N` suffix without overflowing 120 chars).
 *
 * Duplicate trigger events for the same target collapse to the same
 * key → the unique index on (teamId, ruleId, idempotencyKey) prevents
 * duplicate run rows from ever being inserted.
 */
export function computeIdempotencyKey(input) {
    const h = createHash("sha256");
    h.update(input.ruleId);
    h.update("|");
    h.update(input.triggerType);
    h.update("|");
    h.update(input.targetType);
    h.update("|");
    h.update(input.targetId);
    return h.digest("hex").slice(0, 64);
}
// ---------------------------------------------------------------------------
// Operator-safe reason helper
// ---------------------------------------------------------------------------
/**
 * Truncate + sanitise a reason string for operator visibility. Never
 * passes secrets, raw evidence, or large payloads downstream. The
 * DB column is varchar(400); we cap at 380 to leave room for an
 * appended `…` indicator.
 */
export function sanitiseReason(input) {
    if (typeof input !== "string")
        return "";
    // Strip control chars (keep printable + whitespace).
    const cleaned = input.replace(/[ --]/g, " ");
    if (cleaned.length <= 380)
        return cleaned;
    return `${cleaned.slice(0, 380)}…`;
}
// ---------------------------------------------------------------------------
// Public allowlist constants for tests + UI
// ---------------------------------------------------------------------------
export const E3_AUTOMATION_SECURITY_EVENTS = [
    "automation_rule_created",
    "automation_rule_updated",
    "automation_rule_enabled",
    "automation_rule_disabled",
    "automation_run_started",
    "automation_run_succeeded",
    "automation_run_failed",
    "automation_run_skipped",
    "automation_action_executed",
];
