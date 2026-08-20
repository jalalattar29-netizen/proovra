"use client";

/**
 * Intake links wizard — shared field primitives.
 *
 * `ChoiceCard` is the ONE radio anatomy on this surface (link type, delivery
 * channel, sender identity, location policy). The whole card is a `<label>`
 * wrapping its own `<input type="radio">`, so:
 *   - the hit target is the card, not a 13px circle,
 *   - there is no nested interactive element,
 *   - the accessible name is the title + description the operator reads,
 *   - checked / focus / disabled are real form states, not JS-painted classes.
 *
 * `KindChip` is the same idea for the accepted-file-type checkboxes, built on
 * the canonical `.app-checkbox`.
 */

import * as React from "react";

export function Field({
  label,
  htmlFor,
  help,
  error,
  required,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  help?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
}) {
  const helpId = htmlFor ? `${htmlFor}-help` : undefined;
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;
  return (
    <div className="ilk-field">
      <label className="app-field-label" htmlFor={htmlFor}>
        {label}
        {required ? (
          <>
            {" "}
            <span className="ilk-required">(required)</span>
          </>
        ) : null}
      </label>
      {children}
      {help ? (
        <p className="app-field-help" id={helpId}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p className="ilk-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type ChoiceOption<T extends string> = {
  value: T;
  title: string;
  description: string;
  icon?: React.ReactNode;
  /** Restrained supporting note — deliberately not a status badge. */
  note?: string;
  disabled?: boolean;
  disabledReason?: string;
};

export function ChoiceCards<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  columns = 1,
  error,
  help,
  testAttr,
}: {
  name: string;
  legend: React.ReactNode;
  options: ReadonlyArray<ChoiceOption<T>>;
  value: T;
  onChange: (next: T) => void;
  columns?: 1 | 2;
  error?: string | null;
  help?: React.ReactNode;
  /** `data-<testAttr>` is stamped on every card with its wire value. */
  testAttr: string;
}) {
  const groupId = React.useId();
  return (
    <fieldset className="ilk-fieldset" data-intake-link-choice-group={name}>
      <legend className="ilk-fieldset__legend">{legend}</legend>
      <div className="ilk-choices" data-columns={String(columns)}>
        {options.map((opt) => {
          const selected = value === opt.value;
          const descId = `${groupId}-${opt.value}-desc`;
          return (
            <label
              key={opt.value}
              className="ilk-choice"
              data-selected={selected ? "true" : "false"}
              {...{ [`data-${testAttr}`]: opt.value }}
            >
              <input
                className="ilk-choice__input"
                type="radio"
                name={`${name}-${groupId}`}
                value={opt.value}
                checked={selected}
                disabled={opt.disabled}
                aria-describedby={descId}
                onChange={() => onChange(opt.value)}
                {...{ [`data-${testAttr}-input`]: opt.value }}
              />
              {opt.icon ? (
                <span className="ilk-choice__icon">{opt.icon}</span>
              ) : null}
              <span className="ilk-choice__body">
                <span className="ilk-choice__title">
                  {opt.title}
                  {opt.note ? (
                    <span className="ilk-choice__note">{opt.note}</span>
                  ) : null}
                </span>
                <span className="ilk-choice__desc" id={descId}>
                  {opt.disabled && opt.disabledReason
                    ? opt.disabledReason
                    : opt.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {help ? <p className="app-field-help">{help}</p> : null}
      {error ? (
        <p className="ilk-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function KindChips<T extends string>({
  legend,
  options,
  selected,
  onToggle,
  error,
  help,
}: {
  legend: React.ReactNode;
  options: ReadonlyArray<{
    value: T;
    label: string;
    hint: string;
    icon: React.ReactNode;
  }>;
  selected: ReadonlyArray<T>;
  onToggle: (value: T, next: boolean) => void;
  error?: string | null;
  help?: React.ReactNode;
}) {
  return (
    <fieldset className="ilk-fieldset" data-intake-link-accepted-kinds>
      <legend className="ilk-fieldset__legend">{legend}</legend>
      <div className="ilk-kinds">
        {options.map((opt) => {
          const checked = selected.includes(opt.value);
          return (
            <label
              key={opt.value}
              className="ilk-kind"
              data-intake-link-accepted-kind={opt.value}
              data-selected={checked ? "true" : "false"}
            >
              <input
                type="checkbox"
                className="app-checkbox"
                checked={checked}
                onChange={(e) => onToggle(opt.value, e.target.checked)}
                data-intake-link-accepted-kind-input={opt.value}
              />
              <span className="ilk-kind__icon">{opt.icon}</span>
              <span className="ilk-kind__body">
                <span className="ilk-kind__label">{opt.label}</span>
                <span className="ilk-kind__hint">{opt.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
      {help ? <p className="app-field-help">{help}</p> : null}
      {error ? (
        <p className="ilk-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
