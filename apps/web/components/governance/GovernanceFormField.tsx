"use client";

/**
 * PHASE 13 — labelled field primitives for the governance write surfaces.
 *
 * Every field is a real `<label htmlFor>` bound to a real control, so the
 * whole form is keyboard- and screen-reader-navigable without any ARIA
 * substitution. A field in error sets `aria-invalid` and points
 * `aria-describedby` at its own message, and the message is rendered inline
 * rather than in a toast, so the error survives focus movement.
 */

import React from "react";

import { Card } from "../ui/Card";
import type { GovernanceOutcome } from "./governance-action-state";

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "#334155",
  marginBottom: 4,
};

const controlStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 38,
  padding: "8px 10px",
  fontSize: 13,
  color: "#0f172a",
  background: "#ffffff",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  boxSizing: "border-box",
};

const errorTextStyle: React.CSSProperties = {
  margin: "4px 0 0",
  fontSize: 12,
  fontWeight: 600,
  color: "#991b1b",
};

const hintTextStyle: React.CSSProperties = {
  margin: "4px 0 0",
  fontSize: 11,
  color: "#64748b",
};

export const governanceFieldGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 12,
  alignItems: "start",
};

export const governanceFieldRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  marginTop: 14,
};

function FieldFrame({
  id,
  label,
  error,
  hint,
  children,
  span,
}: {
  id: string;
  label: string;
  error?: string | null;
  hint?: React.ReactNode;
  children: React.ReactNode;
  span?: boolean;
}) {
  return (
    <div style={span ? { gridColumn: "1 / -1" } : undefined}>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} style={errorTextStyle}>
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} style={hintTextStyle}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function GovernanceTextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  maxLength,
  disabled,
  span,
  type = "text",
  testAttr,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string | null;
  hint?: React.ReactNode;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  span?: boolean;
  type?: "text" | "datetime-local" | "number";
  testAttr?: string;
}) {
  const props = testAttr ? { [testAttr]: "" } : {};
  return (
    <FieldFrame id={id} label={label} error={error} hint={hint} span={span}>
      <input
        {...props}
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        style={controlStyle}
      />
    </FieldFrame>
  );
}

export function GovernanceTextArea({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  maxLength,
  disabled,
  rows = 3,
  testAttr,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string | null;
  hint?: React.ReactNode;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  rows?: number;
  testAttr?: string;
}) {
  const props = testAttr ? { [testAttr]: "" } : {};
  return (
    <FieldFrame id={id} label={label} error={error} hint={hint} span>
      <textarea
        {...props}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        style={{ ...controlStyle, minHeight: 72, resize: "vertical" }}
      />
    </FieldFrame>
  );
}

export function GovernanceSelectField({
  id,
  label,
  value,
  onChange,
  options,
  error,
  hint,
  disabled,
  span,
  testAttr,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  error?: string | null;
  hint?: React.ReactNode;
  disabled?: boolean;
  span?: boolean;
  testAttr?: string;
}) {
  const props = testAttr ? { [testAttr]: "" } : {};
  return (
    <FieldFrame id={id} label={label} error={error} hint={hint} span={span}>
      <select
        {...props}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        style={controlStyle}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

/**
 * The single screen-reader status region every governance form renders.
 *
 * `role="status"` + `aria-live="polite"` means a submit result is announced
 * without stealing focus, and `aria-busy` while the request is in flight
 * tells assistive technology the region is mid-update. The copy is always the
 * bounded outcome message — never a backend body.
 */
export function GovernanceActionStatus({
  busy,
  outcome,
  busyLabel,
  testAttr,
}: {
  busy: boolean;
  outcome: GovernanceOutcome | null;
  busyLabel: string;
  testAttr: string;
}) {
  const tone =
    outcome?.kind === "success"
      ? "verified"
      : outcome?.kind === "denied"
        ? "governance"
        : "risk";
  const props = { [testAttr]: outcome ? outcome.kind : busy ? "busy" : "idle" };
  return (
    <div
      {...props}
      role="status"
      aria-live="polite"
      aria-busy={busy || undefined}
      style={{ marginTop: 12 }}
    >
      {busy ? (
        <Card variant="status" tone="info" padding="compact">
          {busyLabel}
        </Card>
      ) : outcome ? (
        <Card variant="status" tone={tone} padding="compact">
          {outcome.message}
        </Card>
      ) : null}
    </div>
  );
}
