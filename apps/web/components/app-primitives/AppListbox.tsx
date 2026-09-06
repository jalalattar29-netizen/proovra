"use client";

/**
 * AppListbox — the single accessible custom listbox for every internal
 * surface. Replaces native <select> everywhere in the authenticated product
 * so option menus never fall back to the OS-native / browser-blue popup.
 *
 * Accessibility contract (WAI-ARIA listbox pattern):
 *   - trigger is a <button role="combobox"> with aria-haspopup="listbox",
 *     aria-expanded, aria-controls
 *   - popup is a <ul role="listbox"> with aria-activedescendant
 *   - keyboard: Enter/Space open + select, ArrowUp/Down move, Home/End jump,
 *     Escape closes (focus returns to trigger), Tab/click-outside closes
 *   - selected + active + disabled option states are all expressed via aria
 *
 * Visual style lives in `app-primitives.css` (`.app-listbox*`). No native
 * appearance; lavender focus ring; restrained selected background.
 *
 * ESCAPING ANCESTORS is delegated to `AppAnchoredOverlay` — the portal, the
 * fixed positioning, the flip and the outside-click detection used to be
 * written out here, and were then written out a SECOND time (badly) for the
 * Search typeahead. One mechanism, two consumers.
 */

import * as React from "react";

import { AppAnchoredOverlay } from "./AppAnchoredOverlay";

export interface AppListboxOption<T extends string = string> {
  value: T;
  label: string;
  /** Optional secondary line shown muted under the label. */
  description?: string;
  /** Optional semantic marker dot colour (status-related lists only). */
  markerColor?: string;
  disabled?: boolean;
}

export interface AppListboxProps<T extends string = string> {
  value: T | null;
  options: ReadonlyArray<AppListboxOption<T>>;
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Accessible name — required when there is no visible <label htmlFor>. */
  ariaLabel?: string;
  /** id of a visible label element that names this control. */
  ariaLabelledby?: string;
  id?: string;
  className?: string;
  /** Render function for the trigger's selected content (defaults to label). */
  renderValue?: (option: AppListboxOption<T> | null) => React.ReactNode;
}

let listboxSeq = 0;

export function AppListbox<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = "Select…",
  disabled = false,
  ariaLabel,
  ariaLabelledby,
  id,
  className,
  renderValue,
}: AppListboxProps<T>) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState<number>(-1);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const popupRef = React.useRef<HTMLUListElement | null>(null);
  const overlayRef = React.useRef<HTMLDivElement | null>(null);
  const optionRefs = React.useRef<Array<HTMLLIElement | null>>([]);

  // Stable ids for aria wiring.
  const baseId = React.useMemo(() => id ?? `app-listbox-${++listboxSeq}`, [id]);
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const firstEnabled = React.useCallback(
    (from: number, dir: 1 | -1): number => {
      const n = options.length;
      let i = from;
      for (let step = 0; step < n; step += 1) {
        if (i >= 0 && i < n && !options[i]?.disabled) return i;
        i += dir;
        if (i < 0) i = n - 1;
        if (i >= n) i = 0;
      }
      return -1;
    },
    [options],
  );

  const openMenu = React.useCallback(() => {
    if (disabled) return;
    setOpen(true);
    const start =
      selectedIndex >= 0 ? selectedIndex : firstEnabled(0, 1);
    setActiveIndex(start);
  }, [disabled, selectedIndex, firstEnabled]);

  const closeMenu = React.useCallback((returnFocus = true) => {
    setOpen(false);
    setActiveIndex(-1);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const commit = React.useCallback(
    (i: number) => {
      const opt = options[i];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      closeMenu();
    },
    [options, onChange, closeMenu],
  );

  const closeOnOutside = React.useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  // Keep the active option scrolled into view.
  //
  // Guarded: `scrollIntoView` is absent in non-browser DOM implementations, and
  // an unguarded call turns a missing CONVENIENCE into a thrown error that
  // takes the whole keyboard interaction down with it.
  React.useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = optionRefs.current[activeIndex];
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [open, activeIndex]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Enter":
      case " ":
        e.preventDefault();
        if (!open) openMenu();
        break;
      case "Home":
        if (open) {
          e.preventDefault();
          setActiveIndex(firstEnabled(0, 1));
        }
        break;
      case "End":
        if (open) {
          e.preventDefault();
          setActiveIndex(firstEnabled(options.length - 1, -1));
        }
        break;
      default:
        break;
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => firstEnabled(i < 0 ? 0 : (i + 1) % options.length, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) =>
          firstEnabled(i <= 0 ? options.length - 1 : i - 1, -1),
        );
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(firstEnabled(0, 1));
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(firstEnabled(options.length - 1, -1));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIndex >= 0) commit(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        closeMenu();
        break;
      case "Tab":
        closeMenu(false);
        break;
      default:
        break;
    }
  };

  const triggerContent = renderValue
    ? renderValue(selected)
    : selected
      ? selected.label
      : placeholder;

  return (
    <div
      ref={rootRef}
      className={`app-listbox${className ? ` ${className}` : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        id={baseId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        disabled={disabled}
        data-placeholder={selected ? "false" : "true"}
        className="app-listbox__trigger"
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {selected?.markerColor ? (
            <span
              className="app-listbox__option-marker"
              style={{ background: selected.markerColor }}
              aria-hidden
            />
          ) : null}
          {triggerContent}
        </span>
        <svg
          className="app-listbox__chevron"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <AppAnchoredOverlay
        anchorRef={triggerRef}
        open={open}
        onPointerDownOutside={closeOnOutside}
        overlayRef={overlayRef}
      >
        <ul
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={ariaLabelledby ?? undefined}
          aria-label={ariaLabelledby ? undefined : ariaLabel}
          aria-activedescendant={
            activeIndex >= 0 ? optionId(activeIndex) : undefined
          }
          className="app-listbox__popup"
          onKeyDown={onListKeyDown}
          ref={(el) => {
            popupRef.current = el;
            // Move focus into the list so keyboard nav is captured.
            if (el && open) el.focus();
          }}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isActive = i === activeIndex;
            return (
              <li
                key={opt.value}
                id={optionId(i)}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                data-active={isActive}
                className="app-listbox__option"
                onMouseEnter={() => !opt.disabled && setActiveIndex(i)}
                onClick={() => commit(i)}
              >
                {opt.markerColor ? (
                  <span
                    className="app-listbox__option-marker"
                    style={{ background: opt.markerColor }}
                    aria-hidden
                  />
                ) : null}
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {opt.label}
                  </span>
                  {opt.description ? (
                    <span className="app-listbox__option-desc">
                      {opt.description}
                    </span>
                  ) : null}
                </span>
                {isSelected ? (
                  <svg
                    className="app-listbox__option-check"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    /* 2 on a 24 box at 16px renders ~1.33px — one glyph weight. */
        strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : null}
              </li>
            );
          })}
        </ul>
      </AppAnchoredOverlay>
    </div>
  );
}

export default AppListbox;
