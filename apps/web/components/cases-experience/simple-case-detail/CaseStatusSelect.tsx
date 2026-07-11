"use client";

/**
 * Phase CASES-STATUS-LISTBOX (§22) — accessible custom status listbox.
 *
 * Replaces the native <select> in the personal Case Detail Settings
 * tab with a fully keyboard-accessible ARIA listbox that renders its
 * menu in a portal (so the outer translucent `.cases-panel` overflow
 * never clips it) and paints its own semantic status dots.
 *
 * Behaviour contract (owned + pinned by cases-status-selector.test.ts):
 *   - The trigger shows a semantic status DOT + label + chevron.
 *   - Opening pops a portal `role="listbox"` positioned under the
 *     trigger; each option is a `role="option"` with a status dot,
 *     label, and a check on the current value.
 *   - Full keyboard: Tab / Enter / Space / Arrow / Home / End / Escape,
 *     click-outside → close + restore focus to the trigger.
 *   - `aria-activedescendant` tracks the highlighted option; the menu
 *     carries `aria-label="Case status"`.
 *   - Selecting an option calls `onSelect(status)`. The PARENT owns the
 *     existing confirm-modal + POST /v1/cases/:id/status flow; this
 *     component performs no mutation and holds no committed value of
 *     its own — `value` is always driven by the caller (the envelope).
 *   - Reduced motion is respected (transitions dropped when the user
 *     prefers reduced motion).
 *
 * Colour system (§2): purple is reserved for the selected/active state
 * and focus; the status dots use the SEMANTIC palette per status.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type CaseStatusOption = { value: string; label: string };

/**
 * §7 — status metadata: a minimal line ICON + a one-line description per
 * status (Linear / Notion / Stripe style). NO coloured dots. Icons are
 * quiet slate line-glyphs; the selected row alone gets the indigo accent.
 */
type StatusMeta = { icon: JSX.Element; description: string };

function icon(path: React.ReactNode): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {path}
    </svg>
  );
}

const STATUS_META: Record<string, StatusMeta> = {
  OPEN: {
    icon: icon(<circle cx="12" cy="12" r="8" />),
    description: "Not started",
  },
  INVESTIGATING: {
    icon: icon(
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </>,
    ),
    description: "In progress",
  },
  ON_HOLD: {
    icon: icon(
      <>
        <line x1="10" y1="9" x2="10" y2="15" />
        <line x1="14" y1="9" x2="14" y2="15" />
        <circle cx="12" cy="12" r="9" />
      </>,
    ),
    description: "Paused",
  },
  RESOLVED: {
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12 2.5 2.5 4.5-5" />
      </>,
    ),
    description: "Work complete",
  },
  CLOSED: {
    icon: icon(
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>,
    ),
    description: "Finalised",
  },
  ARCHIVED: {
    icon: icon(
      <>
        <rect x="4" y="5" width="16" height="4" rx="1" />
        <path d="M6 9v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9" />
        <line x1="10" y1="13" x2="14" y2="13" />
      </>,
    ),
    description: "Out of active view",
  },
};

function statusMeta(status: string): StatusMeta {
  return (
    STATUS_META[status] ?? {
      icon: icon(<circle cx="12" cy="12" r="8" />),
      description: "",
    }
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

function StatusGlyph({ status, active }: { status: string; active?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: active ? "#4F46E5" : "#64748B",
        flexShrink: 0,
      }}
    >
      {statusMeta(status).icon}
    </span>
  );
}

export function CaseStatusSelect({
  value,
  options,
  onSelect,
  disabled = false,
  title,
}: {
  value: string;
  options: ReadonlyArray<CaseStatusOption>;
  onSelect: (status: string) => void;
  disabled?: boolean;
  /** Optional testid prefix override (default `data-case-status-select`). */
  testIdPrefix?: string;
  /** Optional native tooltip forwarded to the trigger (e.g. disabled reason). */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  const [menuRect, setMenuRect] = useState<{
    left: number;
    top: number;
    width: number;
    openUp: boolean;
    maxHeight: number;
  } | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const listboxId = useId();
  const optionId = useCallback(
    (idx: number) => `${listboxId}-opt-${idx}`,
    [listboxId],
  );

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const selectedLabel = selectedOption?.label ?? value;

  useEffect(() => setMounted(true), []);

  // §11 — collision-aware positioning. The menu matches the trigger
  // width exactly, opens downward when there is room, and flips to open
  // UPWARD when the space below is insufficient (e.g. the selector sits
  // just above the danger zone). It is always clamped inside the
  // viewport and given a scroll-safe max-height so it can never cover
  // unrelated content off-screen.
  const positionMenu = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    // §6 — the menu matches the trigger width exactly.
    const width = r.width;
    const gap = 6;
    const margin = 8;
    // One icon+label+description option ≈ 54px + 6px menu padding.
    const estMenuH = options.length * 54 + 12;
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const openUp = spaceBelow < estMenuH + gap && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      120,
      (openUp ? spaceAbove : spaceBelow) - gap,
    );
    const top = openUp
      ? Math.max(margin, r.top - gap - Math.min(estMenuH, spaceAbove))
      : r.bottom + gap;
    let left = r.left;
    if (left + width > window.innerWidth - margin) {
      left = window.innerWidth - margin - width;
    }
    if (left < margin) left = margin;
    setMenuRect({ left, top, width, openUp, maxHeight });
  }, [options.length]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    positionMenu();
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [disabled, positionMenu, selectedIndex]);

  const closeMenu = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      if (restoreFocus) {
        // Return focus to the trigger per the listbox pattern.
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    },
    [],
  );

  const commit = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt) return;
      closeMenu();
      onSelect(opt.value);
    },
    [options, onSelect, closeMenu],
  );

  // Keep the highlighted option scrolled into view + focus the list on open.
  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    listRef.current?.focus();
  }, [open, positionMenu]);

  // Reposition on scroll / resize while open, and close on outside click.
  useEffect(() => {
    if (!open) return;
    const onReposition = () => positionMenu();
    const onDocPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        triggerRef.current?.contains(t) ||
        listRef.current?.contains(t)
      ) {
        return;
      }
      closeMenu(false);
    };
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    document.addEventListener("mousedown", onDocPointer, true);
    return () => {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
      document.removeEventListener("mousedown", onDocPointer, true);
    };
  }, [open, positionMenu, closeMenu]);

  const onTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Enter" ||
        e.key === " " ||
        e.key === "Spacebar"
      ) {
        e.preventDefault();
        openMenu();
      }
    },
    [disabled, openMenu],
  );

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(options.length - 1, i + 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(0, i - 1));
          break;
        case "Home":
          e.preventDefault();
          setActiveIndex(0);
          break;
        case "End":
          e.preventDefault();
          setActiveIndex(options.length - 1);
          break;
        case "Enter":
        case " ":
        case "Spacebar":
          e.preventDefault();
          commit(activeIndex);
          break;
        case "Escape":
          e.preventDefault();
          closeMenu();
          break;
        case "Tab":
          // Tabbing away closes the menu (focus leaves the widget).
          closeMenu(false);
          break;
        default:
          break;
      }
    },
    [options.length, activeIndex, commit, closeMenu],
  );

  const transition = reducedMotion
    ? "none"
    : "background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease";

  const menu =
    open && menuRect ? (
      <ul
        ref={listRef}
        role="listbox"
        aria-label="Case status"
        aria-activedescendant={optionId(activeIndex)}
        tabIndex={-1}
        data-case-status-select-listbox
        onKeyDown={onListKeyDown}
        style={{
          position: "fixed",
          left: menuRect.left,
          top: menuRect.top,
          width: menuRect.width,
          maxHeight: menuRect.maxHeight,
          overflowY: "auto",
          margin: 0,
          padding: 6,
          listStyle: "none",
          background: "#FFFFFF",
          border: "1px solid rgba(15,23,42,0.10)",
          borderRadius: 12,
          boxShadow: "0 14px 36px rgba(15,23,42,0.14)",
          zIndex: 60,
          outline: "none",
        }}
      >
        {options.map((opt, idx) => {
          const isCurrent = opt.value === value;
          // §11 — the SELECTED row is the only persistent highlight.
          // Keyboard/pointer navigation over a non-selected option gets a
          // much more subtle neutral wash (not lavender), so it never
          // reads as a second "selected" row next to the real one.
          const isActive = idx === activeIndex && !isCurrent;
          const background = isCurrent
            ? "#F5F3FF"
            : isActive
              ? "rgba(15,23,42,0.04)"
              : "transparent";
          const color = isCurrent ? "#3F3A8A" : "#172033";
          return (
            <li
              key={opt.value}
              id={optionId(idx)}
              role="option"
              aria-selected={isCurrent}
              data-case-status-select-option
              data-status={opt.value}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => commit(idx)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "9px 10px",
                borderRadius: 9,
                cursor: "pointer",
                background,
                color,
                transition,
              }}
            >
              <span style={{ marginTop: 1 }}>
                <StatusGlyph status={opt.value} active={isCurrent} />
              </span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 13.5, fontWeight: isCurrent ? 650 : 560, lineHeight: 1.2 }}>
                  {opt.label}
                </span>
                <span style={{ fontSize: 11.5, fontWeight: 500, color: isCurrent ? "#6E68B0" : "#8793A6", lineHeight: 1.25 }}>
                  {statusMeta(opt.value).description}
                </span>
              </span>
              {isCurrent ? (
                <span
                  aria-hidden
                  style={{ color: "#4F46E5", display: "inline-flex", marginTop: 1 }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="m5 13 4 4L19 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-case-status-select-trigger
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label="Case status"
        disabled={disabled}
        title={title}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          height: 44,
          width: 240,
          padding: "0 12px",
          borderRadius: 11,
          background: "rgba(255,255,255,0.88)",
          border: "1px solid rgba(15,23,42,0.10)",
          color: "#172033",
          fontSize: 13.5,
          fontWeight: 600,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          transition,
          outlineOffset: 2,
        }}
      >
        <StatusGlyph status={value} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selectedLabel}
        </span>
        <span
          aria-hidden
          style={{
            color: "#8793A6",
            display: "inline-flex",
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : "none",
            transition: reducedMotion ? "none" : "transform 140ms ease",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="m6 9 6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {mounted && menu ? createPortal(menu, document.body) : null}
    </>
  );
}
