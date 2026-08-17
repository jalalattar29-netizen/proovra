"use client";

/**
 * PHASE 13 §UI — Automation rule CREATE + EDIT.
 *
 * Closes two registered-but-unreachable routes:
 *
 *   POST  /v1/automation/rules       — services/api/src/routes/automation.routes.ts:243
 *   PATCH /v1/automation/rules/:id   — services/api/src/routes/automation.routes.ts:305
 *
 * Before this component the page admitted, in its own copy, that rules could
 * only be created "via API" — the empty state at `/operations/automation`
 * could never be escaped from the product.
 *
 * Contract mirrored EXACTLY from the server:
 *
 *   CreateAutomationRuleInput  (services/api/src/services/automation/automation.service.ts:216)
 *     teamId           uuid, required
 *     name             1..120, required
 *     description      <=500, optional
 *     triggerType      enum(AUTOMATION_TRIGGER_TYPES), required
 *     conditionJson    `{}` or a bounded condition tree, optional
 *     actionType       enum(AUTOMATION_ACTION_TYPES), required
 *     actionConfigJson validated per action type by `validateActionConfig`
 *
 *   UpdateAutomationRuleInput  (…automation.service.ts:227)
 *     name / description / conditionJson / actionConfigJson ONLY.
 *     triggerType and actionType are IMMUTABLE — the edit form renders them
 *     read-only and never sends them, because the server would silently
 *     ignore them and the action-config schema is keyed off the STORED
 *     actionType.
 *
 * Server responses handled: 201/200 (success), 400 (invalid body / invalid
 * action config / invalid condition), 401, 403 (capability), 404
 * (anti-enumeration non-member, or rule gone), >=500.
 *
 * The trigger/action allowlists are NOT hardcoded here — they arrive on the
 * GET /v1/automation/rules envelope, which is the single authority.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import type { AutomationRule } from "./types";

// ---------------------------------------------------------------------------
// Bounded condition vocabulary — mirrors CONDITION_LEAF_OPERATORS in
// services/api/src/services/automation/automation.service.ts:82.
// ---------------------------------------------------------------------------

export const CONDITION_LEAF_OPERATORS = [
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "in",
  "not_in",
  "due_within_hours",
  "older_than_days",
] as const;
type ConditionLeafOperator = (typeof CONDITION_LEAF_OPERATORS)[number];

const NUMERIC_OPERATORS: ReadonlySet<string> = new Set([
  "greater_than",
  "less_than",
  "due_within_hours",
  "older_than_days",
]);
const LIST_OPERATORS: ReadonlySet<string> = new Set(["in", "not_in"]);

// ---------------------------------------------------------------------------
// Per-action-type config fields — mirrors ActionConfigSchemas
// (services/api/src/services/automation/automation.service.ts:144).
// ---------------------------------------------------------------------------

type FieldKind = "text" | "textarea" | "uuid" | "int" | "select" | "csv";

export type ConfigFieldSpec = {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  maxItems?: number;
  options?: readonly string[];
  help?: string;
};

export const ACTION_CONFIG_FIELDS: Readonly<
  Record<string, readonly ConfigFieldSpec[]>
> = {
  NOTIFY_USER: [
    { key: "userId", label: "Recipient user id", kind: "uuid", required: true },
    {
      key: "template",
      label: "Notification template",
      kind: "text",
      required: true,
      maxLength: 120,
    },
  ],
  NOTIFY_ROLE: [
    {
      key: "role",
      label: "Recipient role",
      kind: "select",
      required: true,
      options: ["OWNER", "ADMIN", "REVIEWER", "MEMBER"],
    },
    {
      key: "template",
      label: "Notification template",
      kind: "text",
      required: true,
      maxLength: 120,
    },
  ],
  CREATE_REVIEW_TASK: [
    {
      key: "assigneeUserId",
      label: "Assignee user id (optional)",
      kind: "uuid",
      required: false,
    },
    {
      key: "slaHours",
      label: "SLA hours (optional)",
      kind: "int",
      required: false,
      min: 1,
      max: 720,
    },
    {
      key: "reason",
      label: "Reason (optional)",
      kind: "text",
      required: false,
      maxLength: 200,
    },
  ],
  CREATE_ESCALATION: [
    {
      key: "severity",
      label: "Severity",
      kind: "select",
      required: true,
      options: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
    },
    {
      key: "ownerUserId",
      label: "Owner user id (optional)",
      kind: "uuid",
      required: false,
    },
    {
      key: "reason",
      label: "Reason (optional)",
      kind: "text",
      required: false,
      maxLength: 200,
    },
  ],
  ASSIGN_REVIEWER: [
    {
      key: "assigneeUserId",
      label: "Reviewer user id",
      kind: "uuid",
      required: true,
    },
    {
      key: "role",
      label: "Review role (optional)",
      kind: "text",
      required: false,
      maxLength: 40,
    },
    {
      key: "reason",
      label: "Reason (optional)",
      kind: "text",
      required: false,
      maxLength: 200,
    },
  ],
  APPLY_LABEL: [
    { key: "label", label: "Label", kind: "text", required: true, maxLength: 40 },
  ],
  ADD_OPERATIONAL_COMMENT: [
    {
      key: "body",
      label: "Comment body",
      kind: "textarea",
      required: true,
      maxLength: 2000,
    },
    {
      key: "visibility",
      label: "Visibility",
      kind: "select",
      required: true,
      options: ["INTERNAL", "REVIEWERS", "ALL_MEMBERS"],
    },
  ],
  WEBHOOK_DELIVERY_INTERNAL_ONLY: [
    {
      key: "destinationId",
      label: "Webhook destination id",
      kind: "uuid",
      required: true,
      help: "An already-registered destination. No URL is entered here — the destination row owns the (SSRF-checked) URL and its signing secret.",
    },
    {
      key: "eventType",
      label: "Event type",
      kind: "text",
      required: true,
      maxLength: 80,
    },
    {
      key: "metadataPassThrough",
      label: "Metadata keys to pass through (optional, comma separated)",
      kind: "csv",
      required: false,
      maxItems: 8,
      maxLength: 60,
    },
  ],
};

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------------------------------------------------------------------------
// Client-side validation — the SAME bounds the server enforces, checked here
// first so a rejectable request is never sent and the user is told which
// field is wrong (a 400 body is never rendered).
// ---------------------------------------------------------------------------

type ConfigValues = Record<string, string>;

export function buildActionConfig(
  actionType: string,
  values: ConfigValues,
):
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> } {
  const specs = ACTION_CONFIG_FIELDS[actionType];
  const errors: Record<string, string> = {};
  const config: Record<string, unknown> = {};
  if (!specs) {
    return {
      ok: false,
      errors: {
        actionType:
          "This action type is not supported by this form yet. Pick another action.",
      },
    };
  }

  for (const spec of specs) {
    const raw = (values[spec.key] ?? "").trim();
    if (!raw) {
      if (spec.required) errors[spec.key] = `${spec.label} is required.`;
      continue;
    }
    if (spec.kind === "uuid") {
      if (!UUID_RE.test(raw)) {
        errors[spec.key] = `${spec.label} must be a valid id (UUID).`;
        continue;
      }
      config[spec.key] = raw;
      continue;
    }
    if (spec.kind === "int") {
      if (!/^-?\d+$/.test(raw)) {
        errors[spec.key] = `${spec.label} must be a whole number.`;
        continue;
      }
      const n = Number(raw);
      if (
        (spec.min !== undefined && n < spec.min) ||
        (spec.max !== undefined && n > spec.max)
      ) {
        errors[spec.key] = `${spec.label} must be between ${spec.min ?? 0} and ${spec.max ?? 0}.`;
        continue;
      }
      config[spec.key] = n;
      continue;
    }
    if (spec.kind === "select") {
      if (spec.options && !spec.options.includes(raw)) {
        errors[spec.key] = `${spec.label} is not an allowed value.`;
        continue;
      }
      config[spec.key] = raw;
      continue;
    }
    if (spec.kind === "csv") {
      const items = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (spec.maxItems !== undefined && items.length > spec.maxItems) {
        errors[spec.key] = `${spec.label}: at most ${spec.maxItems} values.`;
        continue;
      }
      const tooLong = items.some(
        (s) => spec.maxLength !== undefined && s.length > spec.maxLength,
      );
      if (tooLong) {
        errors[spec.key] = `${spec.label}: each value must be ${spec.maxLength} characters or fewer.`;
        continue;
      }
      if (items.length > 0) config[spec.key] = items;
      continue;
    }
    // text / textarea
    if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
      errors[spec.key] = `${spec.label} must be ${spec.maxLength} characters or fewer.`;
      continue;
    }
    config[spec.key] = raw;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, config };
}

function coerceConditionScalar(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= -1_000_000 && n <= 1_000_000) return n;
  }
  return raw;
}

export function buildCondition(input: {
  enabled: boolean;
  field: string;
  op: string;
  value: string;
}):
  | { ok: true; condition: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> } {
  if (!input.enabled) return { ok: true, condition: {} };

  const errors: Record<string, string> = {};
  const field = input.field.trim();
  const value = input.value.trim();

  if (!field) errors.conditionField = "Condition field is required.";
  else if (field.length > 80)
    errors.conditionField = "Condition field must be 80 characters or fewer.";

  if (!(CONDITION_LEAF_OPERATORS as readonly string[]).includes(input.op)) {
    errors.conditionOp = "Pick an allowed comparison.";
  }
  if (!value) errors.conditionValue = "Condition value is required.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  if (NUMERIC_OPERATORS.has(input.op)) {
    if (!/^-?\d+$/.test(value)) {
      return {
        ok: false,
        errors: { conditionValue: "This comparison needs a whole number." },
      };
    }
    const n = Number(value);
    if (n < -1_000_000 || n > 1_000_000) {
      return {
        ok: false,
        errors: {
          conditionValue: "Value must be between -1,000,000 and 1,000,000.",
        },
      };
    }
    return { ok: true, condition: { field, op: input.op, value: n } };
  }

  if (LIST_OPERATORS.has(input.op)) {
    const items = value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      return {
        ok: false,
        errors: { conditionValue: "Enter at least one comma-separated value." },
      };
    }
    if (items.length > 16) {
      return {
        ok: false,
        errors: { conditionValue: "At most 16 values." },
      };
    }
    if (items.some((s) => s.length > 120)) {
      return {
        ok: false,
        errors: { conditionValue: "Each value must be 120 characters or fewer." },
      };
    }
    return {
      ok: true,
      condition: { field, op: input.op, value: items.map(coerceConditionScalar) },
    };
  }

  if (value.length > 120) {
    return {
      ok: false,
      errors: { conditionValue: "Value must be 120 characters or fewer." },
    };
  }
  return {
    ok: true,
    condition: { field, op: input.op, value: coerceConditionScalar(value) },
  };
}

// ---------------------------------------------------------------------------
// Read an existing rule back into form state (edit mode).
// ---------------------------------------------------------------------------

function configToValues(
  actionType: string,
  stored: unknown,
): ConfigValues {
  const values: ConfigValues = {};
  const specs = ACTION_CONFIG_FIELDS[actionType] ?? [];
  const obj =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  for (const spec of specs) {
    const v = obj[spec.key];
    if (v === undefined || v === null) {
      values[spec.key] = "";
    } else if (Array.isArray(v)) {
      values[spec.key] = v.map((x) => String(x)).join(", ");
    } else {
      values[spec.key] = String(v);
    }
  }
  return values;
}

function conditionToState(stored: unknown): {
  enabled: boolean;
  field: string;
  op: string;
  value: string;
} {
  const empty = { enabled: false, field: "", op: "equals", value: "" };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return empty;
  }
  const obj = stored as Record<string, unknown>;
  if (typeof obj.field !== "string" || typeof obj.op !== "string") {
    // `{}` (always match) or a nested all/any tree authored elsewhere. The
    // form only edits a SINGLE leaf, so a nested tree stays untouched: the
    // condition section is left off and no conditionJson is sent.
    return empty;
  }
  const value = Array.isArray(obj.value)
    ? obj.value.map((x) => String(x)).join(", ")
    : String(obj.value ?? "");
  return { enabled: true, field: obj.field, op: obj.op, value };
}

function hasNestedCondition(stored: unknown): boolean {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
  const obj = stored as Record<string, unknown>;
  return Array.isArray(obj.all) || Array.isArray(obj.any);
}

// ---------------------------------------------------------------------------
// Status model
// ---------------------------------------------------------------------------

type FormStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

export type AutomationRuleFormProps = {
  mode: "create" | "edit";
  teamId: string;
  rule?: AutomationRule | null;
  triggerTypes: readonly string[];
  actionTypes: readonly string[];
  canManage: boolean;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
};

export function AutomationRuleForm({
  mode,
  teamId,
  rule = null,
  triggerTypes,
  actionTypes,
  canManage,
  onSaved,
  onCancel,
}: AutomationRuleFormProps): JSX.Element {
  const isEdit = mode === "edit";

  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [triggerType, setTriggerType] = useState(
    rule?.triggerType ?? triggerTypes[0] ?? "",
  );
  const [actionType, setActionType] = useState(
    rule?.actionType ?? actionTypes[0] ?? "",
  );
  const [configValues, setConfigValues] = useState<ConfigValues>(() =>
    rule ? configToValues(rule.actionType, rule.actionConfigJson) : {},
  );
  const [condition, setCondition] = useState(() =>
    rule ? conditionToState(rule.conditionJson) : {
      enabled: false,
      field: "",
      op: "equals" as string,
      value: "",
    },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<FormStatus>({ kind: "idle" });

  // Stale-response protection: only the most recent submit may write state,
  // and an unmounted form writes nothing at all.
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const specs = ACTION_CONFIG_FIELDS[actionType] ?? null;
  const nestedCondition = isEdit && hasNestedCondition(rule?.conditionJson);

  const busy = status.kind === "saving";
  const disabled = !canManage || busy || !teamId;

  // Changing the action type in CREATE mode invalidates the config fields.
  const onActionTypeChange = useCallback((next: string) => {
    setActionType(next);
    setConfigValues({});
    setErrors({});
  }, []);

  const setConfigValue = useCallback((key: string, value: string) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const statusText = useMemo(() => {
    switch (status.kind) {
      case "saving":
        return isEdit ? "Saving changes…" : "Creating rule…";
      case "saved":
      case "invalid":
      case "denied":
      case "error":
        return status.message;
      default:
        return "";
    }
  }, [status, isEdit]);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (disabled) return;

      // ---- client-side validation of every required body field ----
      const nextErrors: Record<string, string> = {};
      const trimmedName = name.trim();
      if (!trimmedName) nextErrors.name = "Rule name is required.";
      else if (trimmedName.length > 120)
        nextErrors.name = "Rule name must be 120 characters or fewer.";
      if (description.trim().length > 500)
        nextErrors.description = "Description must be 500 characters or fewer.";
      if (!isEdit) {
        if (!triggerType || !triggerTypes.includes(triggerType))
          nextErrors.triggerType = "Choose a trigger.";
        if (!actionType || !actionTypes.includes(actionType))
          nextErrors.actionType = "Choose an action.";
      }

      const configResult = buildActionConfig(actionType, configValues);
      if (!configResult.ok) Object.assign(nextErrors, configResult.errors);

      const conditionResult = buildCondition(condition);
      if (!conditionResult.ok) Object.assign(nextErrors, conditionResult.errors);

      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        setStatus({
          kind: "invalid",
          message:
            "Some details need attention before this rule can be saved. Check the highlighted fields.",
        });
        return;
      }
      setErrors({});

      const mine = ++seq.current;
      setStatus({ kind: "saving" });

      const actionConfigJson = configResult.ok ? configResult.config : {};
      const conditionJson = conditionResult.ok ? conditionResult.condition : {};

      try {
        if (isEdit && rule) {
          // PATCH accepts name / description / conditionJson /
          // actionConfigJson ONLY. triggerType + actionType are immutable.
          // `description` is sent even when empty: the server only writes the
          // column when the key is PRESENT (`!== undefined`), so omitting it
          // would make the description un-clearable from the product.
          const body: Record<string, unknown> = {
            name: trimmedName,
            description: description.trim(),
            actionConfigJson,
          };
          if (!nestedCondition) body.conditionJson = conditionJson;
          await apiFetch(
            `/v1/automation/rules/${encodeURIComponent(rule.id)}`,
            { method: "PATCH", body: JSON.stringify(body) },
          );
        } else {
          await apiFetch("/v1/automation/rules", {
            method: "POST",
            body: JSON.stringify({
              teamId,
              name: trimmedName,
              description: description.trim() ? description.trim() : undefined,
              triggerType,
              conditionJson,
              actionType,
              actionConfigJson,
            }),
          });
        }
        if (!mounted.current || mine !== seq.current) return;
        setStatus({
          kind: "saved",
          message: isEdit
            ? "Rule updated."
            : "Rule created. New rules always start disabled — review the action config, then enable it.",
        });
        await onSaved();
      } catch (err) {
        if (!mounted.current || mine !== seq.current) return;
        const e = err as { statusCode?: number };
        const code = typeof e.statusCode === "number" ? e.statusCode : 0;
        if (code === 403) {
          setStatus({
            kind: "denied",
            message:
              "You don't have permission to change automation rules in this workspace. Ask a workspace owner or admin.",
          });
          return;
        }
        if (code === 404) {
          setStatus({
            kind: "error",
            message:
              "That rule is no longer available in this workspace. Refresh the list and try again.",
          });
          return;
        }
        if (code === 400) {
          setStatus({
            kind: "invalid",
            message:
              "The service rejected these details. Review the trigger, action and condition values and try again.",
          });
          return;
        }
        // 401, >=500, network, or an unexpected 4xx — bounded copy only. The
        // raw error body is NEVER rendered.
        setStatus({
          kind: "error",
          message: toSafeUserError(err, {
            message: isEdit
              ? "We couldn't save this rule. Please try again."
              : "We couldn't create this rule. Please try again.",
          }).message,
        });
      }
    },
    [
      disabled,
      name,
      description,
      isEdit,
      triggerType,
      triggerTypes,
      actionType,
      actionTypes,
      configValues,
      condition,
      rule,
      nestedCondition,
      teamId,
      onSaved,
    ],
  );

  const idPrefix = isEdit && rule ? `automation-edit-${rule.id}` : "automation-create";

  return (
    <form
      onSubmit={onSubmit}
      aria-busy={busy}
      data-automation-rule-form={mode}
      style={formStyle}
    >
      <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>
        {isEdit ? `Edit rule · ${rule?.name ?? ""}` : "New automation rule"}
      </h3>

      {!canManage ? (
        <p
          data-automation-form-permission-denied
          style={{ fontSize: 12, color: "#7f1d1d", margin: "0 0 8px" }}
        >
          You have view-only access to automation. Creating and editing rules
          needs the AUTOMATION_MANAGE capability (workspace owner or admin).
        </p>
      ) : null}

      <div style={gridStyle}>
        <div style={fieldStyle}>
          <label htmlFor={`${idPrefix}-name`} style={labelStyle}>
            Rule name (required)
          </label>
          <input
            id={`${idPrefix}-name`}
            data-automation-field="name"
            value={name}
            maxLength={120}
            disabled={disabled}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${idPrefix}-name-error` : undefined}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
          {errors.name ? (
            <span id={`${idPrefix}-name-error`} style={errorTextStyle}>
              {errors.name}
            </span>
          ) : null}
        </div>

        <div style={fieldStyle}>
          <label htmlFor={`${idPrefix}-description`} style={labelStyle}>
            Description (optional)
          </label>
          <input
            id={`${idPrefix}-description`}
            data-automation-field="description"
            value={description}
            maxLength={500}
            disabled={disabled}
            aria-invalid={errors.description ? true : undefined}
            onChange={(e) => setDescription(e.target.value)}
            style={inputStyle}
          />
          {errors.description ? (
            <span style={errorTextStyle}>{errors.description}</span>
          ) : null}
        </div>

        <div style={fieldStyle}>
          <label htmlFor={`${idPrefix}-trigger`} style={labelStyle}>
            Trigger (required)
          </label>
          <select
            id={`${idPrefix}-trigger`}
            data-automation-field="triggerType"
            value={triggerType}
            disabled={disabled || isEdit}
            aria-invalid={errors.triggerType ? true : undefined}
            onChange={(e) => setTriggerType(e.target.value)}
            style={inputStyle}
          >
            {triggerTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {isEdit ? (
            <span style={helpTextStyle}>
              Immutable after creation — create a new rule to change the trigger.
            </span>
          ) : null}
          {errors.triggerType ? (
            <span style={errorTextStyle}>{errors.triggerType}</span>
          ) : null}
        </div>

        <div style={fieldStyle}>
          <label htmlFor={`${idPrefix}-action`} style={labelStyle}>
            Action (required)
          </label>
          <select
            id={`${idPrefix}-action`}
            data-automation-field="actionType"
            value={actionType}
            disabled={disabled || isEdit}
            aria-invalid={errors.actionType ? true : undefined}
            onChange={(e) => onActionTypeChange(e.target.value)}
            style={inputStyle}
          >
            {actionTypes.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {isEdit ? (
            <span style={helpTextStyle}>
              Immutable after creation — the action config below is validated
              against this action type.
            </span>
          ) : null}
          {errors.actionType ? (
            <span style={errorTextStyle}>{errors.actionType}</span>
          ) : null}
        </div>
      </div>

      <fieldset
        data-automation-action-config={actionType}
        style={fieldsetStyle}
        disabled={disabled}
      >
        <legend style={{ fontSize: 12, color: "#475569" }}>Action config</legend>
        {specs === null ? (
          <p style={{ fontSize: 12, color: "#7f1d1d", margin: 0 }}>
            This action type has no editable config in this release.
          </p>
        ) : specs.length === 0 ? (
          <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>
            This action needs no extra configuration.
          </p>
        ) : (
          <div style={gridStyle}>
            {specs.map((spec) => {
              const fieldId = `${idPrefix}-cfg-${spec.key}`;
              const value = configValues[spec.key] ?? "";
              const err = errors[spec.key];
              return (
                <div key={spec.key} style={fieldStyle}>
                  <label htmlFor={fieldId} style={labelStyle}>
                    {spec.label}
                  </label>
                  {spec.kind === "select" ? (
                    <select
                      id={fieldId}
                      data-automation-config-field={spec.key}
                      value={value}
                      aria-invalid={err ? true : undefined}
                      onChange={(e) => setConfigValue(spec.key, e.target.value)}
                      style={inputStyle}
                    >
                      <option value="">Select…</option>
                      {(spec.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : spec.kind === "textarea" ? (
                    <textarea
                      id={fieldId}
                      data-automation-config-field={spec.key}
                      value={value}
                      rows={3}
                      maxLength={spec.maxLength}
                      aria-invalid={err ? true : undefined}
                      onChange={(e) => setConfigValue(spec.key, e.target.value)}
                      style={inputStyle}
                    />
                  ) : (
                    <input
                      id={fieldId}
                      data-automation-config-field={spec.key}
                      value={value}
                      inputMode={spec.kind === "int" ? "numeric" : undefined}
                      maxLength={spec.kind === "csv" ? undefined : spec.maxLength}
                      aria-invalid={err ? true : undefined}
                      onChange={(e) => setConfigValue(spec.key, e.target.value)}
                      style={inputStyle}
                    />
                  )}
                  {spec.help ? (
                    <span style={helpTextStyle}>{spec.help}</span>
                  ) : null}
                  {err ? <span style={errorTextStyle}>{err}</span> : null}
                </div>
              );
            })}
          </div>
        )}
      </fieldset>

      <fieldset style={fieldsetStyle} disabled={disabled || nestedCondition}>
        <legend style={{ fontSize: 12, color: "#475569" }}>
          Condition (optional)
        </legend>
        {nestedCondition ? (
          <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>
            This rule uses a nested all/any condition tree. It is left untouched
            by this form — saving here will not change it.
          </p>
        ) : (
          <>
            <label
              htmlFor={`${idPrefix}-cond-enabled`}
              style={{ ...labelStyle, display: "inline-flex", gap: 6 }}
            >
              <input
                id={`${idPrefix}-cond-enabled`}
                data-automation-condition-enabled
                type="checkbox"
                checked={condition.enabled}
                onChange={(e) =>
                  setCondition((c) => ({ ...c, enabled: e.target.checked }))
                }
              />
              Only run when a field matches
            </label>
            {condition.enabled ? (
              <div style={gridStyle}>
                <div style={fieldStyle}>
                  <label htmlFor={`${idPrefix}-cond-field`} style={labelStyle}>
                    Field (required)
                  </label>
                  <input
                    id={`${idPrefix}-cond-field`}
                    data-automation-condition-field
                    value={condition.field}
                    maxLength={80}
                    aria-invalid={errors.conditionField ? true : undefined}
                    onChange={(e) =>
                      setCondition((c) => ({ ...c, field: e.target.value }))
                    }
                    style={inputStyle}
                  />
                  {errors.conditionField ? (
                    <span style={errorTextStyle}>{errors.conditionField}</span>
                  ) : null}
                </div>
                <div style={fieldStyle}>
                  <label htmlFor={`${idPrefix}-cond-op`} style={labelStyle}>
                    Comparison (required)
                  </label>
                  <select
                    id={`${idPrefix}-cond-op`}
                    data-automation-condition-op
                    value={condition.op}
                    aria-invalid={errors.conditionOp ? true : undefined}
                    onChange={(e) =>
                      setCondition((c) => ({
                        ...c,
                        op: e.target.value as ConditionLeafOperator,
                      }))
                    }
                    style={inputStyle}
                  >
                    {CONDITION_LEAF_OPERATORS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  {errors.conditionOp ? (
                    <span style={errorTextStyle}>{errors.conditionOp}</span>
                  ) : null}
                </div>
                <div style={fieldStyle}>
                  <label htmlFor={`${idPrefix}-cond-value`} style={labelStyle}>
                    Value (required)
                  </label>
                  <input
                    id={`${idPrefix}-cond-value`}
                    data-automation-condition-value
                    value={condition.value}
                    aria-invalid={errors.conditionValue ? true : undefined}
                    onChange={(e) =>
                      setCondition((c) => ({ ...c, value: e.target.value }))
                    }
                    style={inputStyle}
                  />
                  <span style={helpTextStyle}>
                    `in` / `not_in` take a comma-separated list (max 16).
                  </span>
                  {errors.conditionValue ? (
                    <span style={errorTextStyle}>{errors.conditionValue}</span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        )}
      </fieldset>

      <div
        role="status"
        aria-live="polite"
        data-automation-form-status={status.kind}
        style={{
          minHeight: 18,
          fontSize: 12,
          margin: "8px 0",
          color:
            status.kind === "saved"
              ? "#166534"
              : status.kind === "idle" || status.kind === "saving"
              ? "#475569"
              : "#7f1d1d",
        }}
      >
        {statusText}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="submit"
          data-automation-form-submit={mode}
          disabled={disabled}
          aria-busy={busy}
          title={
            canManage
              ? undefined
              : "Requires the AUTOMATION_MANAGE capability (workspace owner or admin) on this platform-admin console."
          }
          style={primaryButtonStyle}
        >
          {busy
            ? isEdit
              ? "Saving…"
              : "Creating…"
            : isEdit
            ? "Save changes"
            : "Create rule"}
        </button>
        <button
          type="button"
          data-automation-form-cancel
          onClick={onCancel}
          disabled={busy}
          style={secondaryButtonStyle}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Local styles (this page predates the app-* primitives; kept consistent
// with the surrounding automation surface).
// ---------------------------------------------------------------------------

const formStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 12,
  background: "#fff",
  marginBottom: 12,
};
const gridStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
};
const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#334155",
  fontWeight: 600,
};
const helpTextStyle: React.CSSProperties = { fontSize: 11, color: "#64748b" };
const errorTextStyle: React.CSSProperties = { fontSize: 11, color: "#b91c1c" };
const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
  boxSizing: "border-box",
  width: "100%",
};
const fieldsetStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 10,
  marginTop: 10,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
};
