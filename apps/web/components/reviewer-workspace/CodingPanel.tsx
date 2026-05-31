"use client";

/**
 * PROOVRA Phase 2A — Coding panel renderer.
 *
 * Schema-driven coding panel. Renders each `CodingField` per its
 * bounded type with the right widget. On change, the value is
 * persisted via `writeCodingValue` (debounced is left to the parent).
 *
 * Hard rules:
 *   * Bounded vocabulary — every option list comes from the field's
 *     `options` blob or from the canonical shared enum.
 *   * NEVER asserts authenticity — labels and help text describe
 *     what the operator is recording, never the truth of content.
 */

import { useState } from "react";

import {
  CONFIDENCE_SCORE_RANGE,
  ESCALATION_LEVELS,
  REVIEWER_RISK_LEVELS,
  REVIEWER_VERDICTS,
} from "@proovra/shared";

import type {
  CodingFieldRow,
  CodingValueRow,
} from "../../lib/reviewer-workspace/reviewer-api";

export type CodingPanelProps = {
  fields: ReadonlyArray<CodingFieldRow>;
  values: ReadonlyArray<CodingValueRow>;
  unfulfilledFieldIds: ReadonlySet<string>;
  onWrite: (input: {
    fieldId: string;
    value: Record<string, unknown>;
    rationale?: string;
  }) => Promise<void>;
};

export function CodingPanel({
  fields,
  values,
  unfulfilledFieldIds,
  onWrite,
}: CodingPanelProps) {
  const valueMap = new Map(values.map((v) => [v.fieldId, v]));
  return (
    <section
      data-coding-panel
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "14px 16px",
        background: "rgba(15, 23, 42, 0.03)",
        borderRadius: 12,
        border: "1px solid rgba(15, 23, 42, 0.08)",
        minWidth: 320,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13, letterSpacing: 0.4 }}>Coding</strong>
        <small style={{ color: "#475569" }}>
          {fields.length} field{fields.length === 1 ? "" : "s"}
        </small>
      </header>
      {fields.map((f) => {
        const current = valueMap.get(f.id);
        const isMissing = f.required && unfulfilledFieldIds.has(f.id);
        return (
          <FieldRow
            key={f.id}
            field={f}
            current={current}
            isMissing={isMissing}
            onWrite={onWrite}
          />
        );
      })}
    </section>
  );
}

function FieldRow({
  field,
  current,
  isMissing,
  onWrite,
}: {
  field: CodingFieldRow;
  current: CodingValueRow | undefined;
  isMissing: boolean;
  onWrite: CodingPanelProps["onWrite"];
}) {
  const [pending, setPending] = useState(false);
  async function write(value: Record<string, unknown>) {
    setPending(true);
    try {
      await onWrite({ fieldId: field.id, value });
    } finally {
      setPending(false);
    }
  }
  return (
    <div
      data-coding-field-row
      data-coding-field-id={field.id}
      data-coding-field-required={field.required ? "true" : "false"}
      data-coding-field-missing={isMissing ? "true" : "false"}
      style={{ display: "grid", gap: 4 }}
    >
      <label style={{ fontSize: 12, color: "#0f172a", fontWeight: 600 }}>
        {field.label}
        {field.required ? (
          <span style={{ color: "#b91c1c", marginLeft: 4 }}>*</span>
        ) : null}
      </label>
      {field.helpText ? (
        <small style={{ color: "#64748b", fontSize: 11 }}>{field.helpText}</small>
      ) : null}
      <FieldWidget field={field} current={current} pending={pending} write={write} />
      {isMissing ? (
        <small data-coding-required-warning style={{ color: "#b91c1c", fontSize: 11 }}>
          Required to record a non-PENDING verdict.
        </small>
      ) : null}
    </div>
  );
}

function FieldWidget({
  field,
  current,
  pending,
  write,
}: {
  field: CodingFieldRow;
  current: CodingValueRow | undefined;
  pending: boolean;
  write: (v: Record<string, unknown>) => Promise<void>;
}) {
  const v = (current?.value ?? {}) as Record<string, unknown>;
  switch (field.fieldType) {
    case "TEXT":
      return (
        <textarea
          rows={3}
          disabled={pending}
          defaultValue={typeof v["text"] === "string" ? (v["text"] as string) : ""}
          onBlur={(e) => void write({ text: e.target.value })}
          style={widgetStyle}
        />
      );
    case "NUMERIC":
      return (
        <input
          type="number"
          disabled={pending}
          defaultValue={typeof v["number"] === "number" ? (v["number"] as number) : 0}
          onBlur={(e) => void write({ number: Number(e.target.value) })}
          style={widgetStyle}
        />
      );
    case "BOOLEAN":
      return (
        <input
          type="checkbox"
          disabled={pending}
          defaultChecked={v["boolean"] === true}
          onChange={(e) => void write({ boolean: e.target.checked })}
        />
      );
    case "CONFIDENCE_SCORE":
      return (
        <input
          type="range"
          min={CONFIDENCE_SCORE_RANGE.min}
          max={CONFIDENCE_SCORE_RANGE.max}
          step={1}
          defaultValue={typeof v["confidence"] === "number" ? (v["confidence"] as number) : 50}
          disabled={pending}
          onChange={(e) => void write({ confidence: Number(e.target.value) })}
        />
      );
    case "REVIEWER_VERDICT":
      return (
        <SelectWidget
          options={REVIEWER_VERDICTS.map((x) => ({ value: x, label: x }))}
          current={typeof v["verdict"] === "string" ? (v["verdict"] as string) : ""}
          onChange={(val) => void write({ verdict: val })}
          disabled={pending}
        />
      );
    case "RISK_LEVEL":
      return (
        <SelectWidget
          options={REVIEWER_RISK_LEVELS.map((x) => ({ value: x, label: x }))}
          current={typeof v["risk"] === "string" ? (v["risk"] as string) : ""}
          onChange={(val) => void write({ risk: val })}
          disabled={pending}
        />
      );
    case "ESCALATION_LEVEL":
      return (
        <SelectWidget
          options={ESCALATION_LEVELS.map((x) => ({
            value: String(x),
            label: `Level ${x}`,
          }))}
          current={typeof v["escalation"] === "number" ? String(v["escalation"]) : ""}
          onChange={(val) => void write({ escalation: Number(val) })}
          disabled={pending}
        />
      );
    case "SINGLE_SELECT": {
      const opts =
        ((field.options ?? {})["options"] as Array<{ value: string; label: string }>) ??
        [];
      return (
        <SelectWidget
          options={opts}
          current={typeof v["single"] === "string" ? (v["single"] as string) : ""}
          onChange={(val) => void write({ single: val })}
          disabled={pending}
        />
      );
    }
    case "MULTI_SELECT": {
      const opts =
        ((field.options ?? {})["options"] as Array<{ value: string; label: string }>) ??
        [];
      const selected = (Array.isArray(v["multi"]) ? (v["multi"] as string[]) : []).filter(
        (x) => typeof x === "string",
      );
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {opts.map((o) => {
            const isOn = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                disabled={pending}
                onClick={() => {
                  const next = isOn
                    ? selected.filter((x) => x !== o.value)
                    : [...selected, o.value];
                  void write({ multi: next });
                }}
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  border: `1px solid ${isOn ? "#0f172a" : "#cbd5e1"}`,
                  background: isOn ? "#0f172a" : "#fff",
                  color: isOn ? "#fafafa" : "#0f172a",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: pending ? "not-allowed" : "pointer",
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
  }
}

function SelectWidget({
  options,
  current,
  onChange,
  disabled,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  current: string;
  onChange: (val: string) => void;
  disabled: boolean;
}) {
  return (
    <select
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={widgetStyle}
    >
      <option value="">— Select —</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const widgetStyle = {
  padding: "6px 8px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#fff",
  width: "100%",
  boxSizing: "border-box" as const,
};
