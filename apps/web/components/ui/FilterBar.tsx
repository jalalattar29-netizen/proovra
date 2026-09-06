"use client";

/**
 * FilterBar — consistent filter / search row (Phase 7 foundation).
 *
 * A horizontal toolbar that standardises the "search + filters + actions"
 * strip above tables and lists. Purely presentational: it renders the
 * controls you pass and lays them out; it holds NO filter state and makes
 * NO queries. Wire your own `value`/`onChange` to the provided
 * `FilterBar.Search` / `FilterBar.Select` helpers, or drop arbitrary
 * children in.
 *
 * PARTS
 *   - <FilterBar>            the flex container (wraps on narrow widths).
 *   - <FilterBar.Search>     token-styled search input with a leading
 *                            magnifier + optional clear button.
 *   - <FilterBar.Select>     token-styled native <select>.
 *   - `actions` prop         right-aligned slot (e.g. an export Button).
 *
 * A11Y: Search input takes an accessible `label` (visually hidden) or
 * `aria-label`; selects require a `label`. Focus rings come from the
 * shared `.ui-filterbar__input/select:focus-visible` rules in globals.css.
 *
 * USAGE
 *   <FilterBar actions={<Button variant="secondary">Export</Button>}>
 *     <FilterBar.Search value={q} onChange={setQ} placeholder="Search evidence" />
 *     <FilterBar.Select label="Status" value={status} onChange={setStatus}
 *       options={[{value:'all',label:'All'},{value:'verified',label:'Verified'}]} />
 *   </FilterBar>
 */

import React from "react";

export interface FilterBarProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** Right-aligned actions (buttons, view toggles). */
  actions?: React.ReactNode;
  /**
   * IS ANYTHING ACTUALLY FILTERED, and how does the operator get back?
   *
   * A page with four filters and no single way to clear them makes "show me
   * everything again" a hunt: the operator has to remember which of the four
   * they changed. Measured across the console, NINETEEN routes had two or
   * more filters and no reset control — and exactly one page had written its
   * own, which is what a per-page responsibility produces.
   *
   * It lives here because the filter row is the one place that can know a
   * filter row exists. The page still owns what "filtered" MEANS, because
   * only the page knows its own defaults: passing `filtered` is how it says
   * so, and the control appears only when it is true. A reset button that is
   * always visible is a button that usually does nothing.
   */
  filtered?: boolean;
  onReset?: () => void;
  /** Overrides the control's label where the page's noun reads better. */
  resetLabel?: string;
}

const RESET_STYLE: React.CSSProperties = {
  minHeight: 44,
  padding: "0 10px",
  border: "1px solid transparent",
  borderRadius: "var(--radius-md)",
  background: "transparent",
  color: "var(--accent-600)",
  font: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const CONTROL_STYLE: React.CSSProperties = {
  // 44, not 40: the filter row is the most-used control on every list page in
  // the console, and the matrix measured all of them four pixels under the
  // touch floor. One value here covers every list, which is why it was worth
  // finding rather than patching per page.
  minHeight: 44,
  fontSize: 13.5,
  color: "var(--ink-primary, #0f172a)",
  background: "var(--surface-card, #ffffff)",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-md, 8px)",
  outline: "none",
  transition: "border-color 180ms ease, box-shadow 180ms ease",
};

function FilterBarRoot({
  actions,
  filtered,
  onReset,
  resetLabel = "Clear filters",
  children,
  className,
  style,
  ...rest
}: FilterBarProps) {
  return (
    <div
      {...rest}
      data-ui-filter-bar
      className={["ui-filterbar", className].filter(Boolean).join(" ")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          flex: "1 1 auto",
          minWidth: 0,
        }}
      >
        {children}
        {onReset && filtered ? (
          <button
            type="button"
            data-ui-filter-reset
            onClick={onReset}
            style={RESET_STYLE}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--border-default)";
              e.currentTarget.style.background = "var(--surface-muted)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "transparent";
              e.currentTarget.style.background = "transparent";
            }}
          >
            {resetLabel}
          </button>
        ) : null}
      </div>
      {actions != null ? (
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>{actions}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface FilterSearchProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "onChange" | "value" | "type"
  > {
  value: string;
  onChange: (value: string) => void;
  /** Accessible label (visually hidden). Falls back to aria-label. */
  label?: string;
  /** Show a clear (✕) button when non-empty. */
  clearable?: boolean;
}

function FilterSearch({
  value,
  onChange,
  label,
  placeholder = "Search",
  clearable = true,
  style,
  ...rest
}: FilterSearchProps) {
  const inputId = React.useId();
  return (
    <div
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        flex: "1 1 240px",
        minWidth: 180,
        maxWidth: 420,
      }}
    >
      {label ? (
        <label
          htmlFor={inputId}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clip: "rect(0,0,0,0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          {label}
        </label>
      ) : null}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          /* LOGICAL, NOT LEFT. The magnifier belongs where the text STARTS,
             and in Arabic that is the right-hand end of the field. `left: 12`
             pinned it to the same corner in every language, so an RTL search
             box had its icon sitting on top of the end of what the person
             typed. */
          insetInlineStart: 12,
          display: "inline-flex",
          color: "var(--ink-muted, #94a3b8)",
          pointerEvents: "none",
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </span>
      <input
        {...rest}
        id={inputId}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="ui-filterbar__input"
        style={{
          ...CONTROL_STYLE,
          width: "100%",
          /* Logical padding: the magnifier's inset is logical now, so the
             room made for it has to be too, or the icon lands on the text in
             one direction and floats in a gap in the other. */
          paddingBlock: 0,
          paddingInlineStart: 34,
          paddingInlineEnd: 40,
          ...style,
        }}
      />
      {clearable && value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          style={{
            position: "absolute",
            /* The clear control sits at the END of the field, which mirrors
               with the direction for the same reason the magnifier does. */
            insetInlineEnd: 4,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            /* 36×44, NOT 22×22. The glyph stays small — a large ✕ inside a
               search field reads as a warning — but the thing a finger has to
               hit is the BUTTON, and 22px was half the touch floor on the
               control the console uses most. The field is 44 tall, so the
               target takes its full height and only needs width. */
            width: 36,
            minHeight: 44,
            borderRadius: 999,
            border: "none",
            background: "transparent",
            color: "var(--ink-muted, #94a3b8)",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface FilterSelectOption {
  value: string;
  label: string;
}

export interface FilterSelectProps
  extends Omit<
    React.SelectHTMLAttributes<HTMLSelectElement>,
    "onChange" | "value"
  > {
  value: string;
  onChange: (value: string) => void;
  options: FilterSelectOption[];
  /** Accessible label (visually hidden unless `showLabel`). */
  label: string;
  showLabel?: boolean;
}

function FilterSelect({
  value,
  onChange,
  options,
  label,
  showLabel = false,
  style,
  ...rest
}: FilterSelectProps) {
  const id = React.useId();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flex: "0 1 auto",
      }}
    >
      <label
        htmlFor={id}
        style={
          showLabel
            ? {
                fontSize: 12,
                fontWeight: 600,
                color: "var(--ink-secondary, #475569)",
              }
            : {
                position: "absolute",
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: "hidden",
                clip: "rect(0,0,0,0)",
                whiteSpace: "nowrap",
                border: 0,
              }
        }
      >
        {label}
      </label>
      <select
        {...rest}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="ui-filterbar__select"
        style={{
          ...CONTROL_STYLE,
          padding: "0 30px 0 12px",
          cursor: "pointer",
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 8px center",
          ...style,
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export const FilterBar = Object.assign(FilterBarRoot, {
  Search: FilterSearch,
  Select: FilterSelect,
});

export default FilterBar;
