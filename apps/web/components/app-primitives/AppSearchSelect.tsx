"use client";

/**
 * AppSearchSelect — the one searchable single-select for internal surfaces.
 *
 * `AppListbox` is the right control when the options are a FIXED vocabulary
 * that fits in a menu: a status, a priority, a role. It is the wrong control
 * when the options are RECORDS — a workspace's cases, its evidence, its
 * reviews — because those are unbounded, they are searched on the server, and
 * the set that comes back changes with every keystroke.
 *
 * That case was written page-locally in the Collaboration Team assignment
 * modal, as a bare `<input>` plus a `<div role="listbox">` of buttons, and it
 * failed in the two ways an ad-hoc picker always fails:
 *
 *   1. IT WAS INVISIBLE WHEN IT WORKED. The option rows carried
 *      `app-listbox-option` / `app-listbox-option--selected`, class names that
 *      match no rule in any stylesheet (the canonical primitive is
 *      `.app-listbox__option`, BEM double-underscore). Clicking a case DID set
 *      the id in React state — and nothing on screen changed: no hover, no
 *      selected background, the search box still showing the typed text and
 *      the list still hanging open. "Clicking Talal does not select it" was
 *      true of everything the operator could see.
 *   2. IT WAS CLIPPED. The list was a sibling inside `.app-dialog__body`,
 *      which is `overflow-y: auto` — and a non-visible overflow on one axis
 *      forces the other to `auto` too, so a long list was cut off by the
 *      dialog rather than floating over it.
 *
 * Both are properties of writing the pattern by hand, so the pattern lives
 * here once instead. The popup is portaled through `AppAnchoredOverlay` — the
 * same escape hatch `AppListbox` uses — and the rows reuse
 * `.app-listbox__option`, so this is one more consumer of the existing
 * vocabulary rather than a second picker design.
 *
 * ACCESSIBILITY (WAI-ARIA 1.2 combobox, list autocomplete):
 *   - the text field is `role="combobox"` with `aria-expanded`,
 *     `aria-controls`, `aria-autocomplete="list"` and `aria-activedescendant`
 *   - the popup is `role="listbox"`, its rows `role="option"` with
 *     `aria-selected`
 *   - ArrowDown/ArrowUp move the active row (ArrowDown also opens),
 *     Home/End jump, Enter selects the active row, Escape closes and restores
 *     the selected label, Tab closes
 *   - focus never leaves the text field, so the active row is announced
 *     through `aria-activedescendant` rather than by moving focus
 *
 * THE CLICK IS NOT RACED BY A BLUR. Options `preventDefault()` their
 * `mousedown`, which keeps focus in the field and lets the `click` land. The
 * menu closes on Escape, on selection, and on a pointer down outside both the
 * field and the popup — never on blur, because a blur-to-close is exactly what
 * makes a picker unusable with a mouse.
 */

import * as React from "react";

import { AppAnchoredOverlay } from "./AppAnchoredOverlay";

export interface AppSearchSelectOption {
  /** The value submitted. Never a label, never an index. */
  id: string;
  label: string;
  /** Secondary identifying line, shown muted beside the label. */
  sublabel?: string | null;
  /** Short state word, shown right-aligned as semantic TEXT — not a capsule. */
  status?: string | null;
}

export interface AppSearchSelectProps {
  /** id of the text field; the popup derives its own id from this. */
  id: string;
  /**
   * The chosen record, held by the CALLER.
   *
   * Deliberately the option and not just its id: the results list is the
   * server's answer to the current query, so the selected record is routinely
   * absent from it (search for something else and it is gone). A picker that
   * derived its label by looking the id up in `options` would blank the field
   * the moment the query moved on.
   */
  selected: AppSearchSelectOption | null;
  onSelect: (option: AppSearchSelectOption) => void;
  /** The current query text, owned by the caller (it is what it fetches with). */
  search: string;
  onSearchChange: (next: string) => void;
  options: ReadonlyArray<AppSearchSelectOption>;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Shown when the server returned nothing for the current query. */
  emptyLabel?: string;
  ariaLabel?: string;
  /** id of the visible <label> that names this control. */
  ariaLabelledby?: string;
  /** Test hook on the text field; the popup and rows derive from it. */
  testid?: string;
}

export function AppSearchSelect({
  id,
  selected,
  onSelect,
  search,
  onSearchChange,
  options,
  loading = false,
  disabled = false,
  placeholder = "Search…",
  emptyLabel = "Nothing matches that.",
  ariaLabel,
  ariaLabelledby,
  testid,
}: AppSearchSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const fieldRef = React.useRef<HTMLDivElement | null>(null);

  const listId = `${id}-options`;
  const optionId = (i: number) => `${id}-option-${i}`;

  /*
   * WHAT THE FIELD SHOWS.
   *
   * Closed, it shows the SELECTION — that is the whole point of a field, and
   * the previous picker never did it: it was permanently a search box, so the
   * only evidence a case had been chosen was a class that styled nothing.
   *
   * Open, it shows the QUERY, because while the menu is open the field is
   * being used to search. Re-opening does not clear the selection; closing
   * without choosing restores the label.
   */
  const displayValue = open ? search : (selected?.label ?? "");

  const close = React.useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const commit = React.useCallback(
    (option: AppSearchSelectOption | undefined) => {
      if (!option) return;
      onSelect(option);
      // The query has done its job. Clearing it means re-opening the field
      // offers the unfiltered candidates again rather than the stale search
      // that happened to find this one.
      onSearchChange("");
      close();
      /*
       * AND THE FIELD IS NOT RE-FOCUSED HERE.
       *
       * It was, and it re-opened the menu it had just closed: `onFocus` opens,
       * so calling `focus()` after `close()` is a loop with one iteration —
       * the selection landed, the field went back to showing an empty query,
       * and the list reappeared. Caught by the regression test, which asserts
       * what the field SHOWS rather than what the state holds.
       *
       * Focus does not need restoring because it never left: the option
       * cancels its own mousedown, so the click cannot move it, and a keyboard
       * selection was already in the field.
       */
    },
    [onSelect, onSearchChange, close],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(options.length > 0 ? 0 : -1);
          return;
        }
        setActiveIndex((i) => (options.length === 0 ? -1 : (i + 1) % options.length));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) return;
        setActiveIndex((i) =>
          options.length === 0 ? -1 : i <= 0 ? options.length - 1 : i - 1,
        );
        break;
      case "Home":
        if (!open) return;
        e.preventDefault();
        setActiveIndex(options.length > 0 ? 0 : -1);
        break;
      case "End":
        if (!open) return;
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
        // Only swallowed when it is selecting something. Otherwise it stays
        // the enclosing form's Enter, which is what submits a dialog.
        if (open && activeIndex >= 0) {
          e.preventDefault();
          commit(options[activeIndex]);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          close();
        }
        break;
      case "Tab":
        close();
        break;
      default:
        break;
    }
  };

  return (
    <div className="app-search-select" ref={fieldRef}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        autoComplete="off"
        disabled={disabled}
        className="app-form-input app-search-select__input"
        data-testid={testid}
        data-has-selection={selected ? "true" : "false"}
        placeholder={placeholder}
        value={displayValue}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setOpen(true);
          setActiveIndex(-1);
          onSearchChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />

      <AppAnchoredOverlay
        anchorRef={fieldRef}
        open={open && !disabled}
        onPointerDownOutside={close}
        flipThreshold={240}
      >
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          className="app-listbox__popup app-search-select__popup"
          data-testid={testid ? `${testid}-options` : undefined}
        >
          {options.length === 0 ? (
            <li className="app-search-select__empty" role="presentation">
              {loading ? "Searching…" : emptyLabel}
            </li>
          ) : (
            options.map((opt, i) => {
              const isSelected = selected?.id === opt.id;
              return (
                <li
                  key={opt.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  data-active={i === activeIndex}
                  data-testid={testid ? `${testid}-option-${opt.id}` : undefined}
                  className="app-listbox__option app-search-select__option"
                  onMouseEnter={() => setActiveIndex(i)}
                  // Keeps focus in the field so the click below is not raced
                  // by a blur — the single most common way a mouse-driven
                  // picker stops selecting anything.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(opt)}
                >
                  <span className="app-search-select__option-text">
                    <span className="app-search-select__option-label">
                      {opt.label}
                    </span>
                    {opt.sublabel ? (
                      <span className="app-listbox__option-desc">
                        {opt.sublabel}
                      </span>
                    ) : null}
                  </span>
                  {opt.status ? (
                    <span className="app-search-select__option-status">
                      {opt.status}
                    </span>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      </AppAnchoredOverlay>
    </div>
  );
}

export default AppSearchSelect;
