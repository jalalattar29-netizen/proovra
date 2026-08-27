"use client";

/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the billing-account selector.
 *
 * The page this replaces had none, because it had no concept of an account: it
 * rendered one personal card, N workspace cards and one merged payment list on
 * a single flat column, with header counters that summed across payers. Nothing
 * on it belonged to any one bill.
 *
 * Rules encoded here:
 *   * The selector RENDERS ONLY when the viewer can see two or more accounts.
 *     A solo user never sees a control that offers them one choice.
 *   * Switching changes the whole page together — plan, usage, add-ons,
 *     history, actions — because they all come from one account-scoped read.
 *   * It is a real listbox: arrow keys move, Enter/Space selects, Escape
 *     closes, and the trigger keeps focus. A `<div>` with a click handler is
 *     not a selector.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BillingAccountRef,
  BillingAccountType,
} from "../../../../lib/api/billing-accounts";

const KIND_LABEL: Record<BillingAccountType, string> = {
  PERSONAL: "Personal",
  WORKSPACE: "Workspace",
  ORGANIZATION: "Organization",
};

export function AccountSelector({
  accounts,
  selected,
  onSelect,
}: {
  accounts: BillingAccountRef[];
  selected: BillingAccountRef;
  onSelect: (account: BillingAccountRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const selectedIndex = accounts.findIndex(
    (a) => a.type === selected.type && a.id === selected.id,
  );

  useEffect(() => {
    if (open) setActiveIndex(Math.max(0, selectedIndex));
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (
        !listRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const choose = useCallback(
    (index: number) => {
      const next = accounts[index];
      if (next) onSelect(next);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [accounts, onSelect],
  );

  // ONE account is not a choice. Rendering a selector for it is noise, and it
  // implies other bills the viewer cannot see.
  if (accounts.length < 2) return null;

  return (
    <div style={{ position: "relative" }} data-billing-account-selector>
      {/* A <span> + aria-labelledby rather than <label htmlFor>: a label
          associated with a button REPLACES the button's content as its
          accessible name, so a screen reader would announce "Billing account"
          and never say WHICH account is selected. Referencing both ids names it
          "Billing account, <account>". */}
      <span
        id="billing-account-label"
        style={{
          display: "block",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--text-muted, #5F6878)",
          marginBottom: 6,
        }}
      >
        Billing account
      </span>

      <button
        id="billing-account-trigger"
        ref={triggerRef}
        type="button"
        aria-labelledby="billing-account-label billing-account-trigger-value"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        data-billing-account-trigger
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          width: "min(420px, 100%)",
          minHeight: 44,
          padding: "10px 14px",
          borderRadius: 10,
          border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
          background: "var(--surface-card, #ffffff)",
          cursor: "pointer",
          textAlign: "start",
        }}
      >
        <span id="billing-account-trigger-value" style={{ minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontWeight: 600,
              color: "var(--text-strong, #172033)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {selected.displayName}
          </span>
          <span
            style={{ fontSize: "0.8rem", color: "var(--text-muted, #5F6878)" }}
          >
            {KIND_LABEL[selected.type]}
          </span>
        </span>
        <span aria-hidden style={{ opacity: 0.6 }}>▾</span>
      </button>

      {open ? (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Billing account"
          aria-activedescendant={`billing-account-option-${activeIndex}`}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => Math.min(accounts.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              choose(activeIndex);
            }
          }}
          style={{
            position: "absolute",
            zIndex: 40,
            insetInlineStart: 0,
            marginTop: 6,
            width: "min(420px, 100%)",
            maxHeight: 320,
            overflowY: "auto",
            listStyle: "none",
            padding: 6,
            margin: 0,
            borderRadius: 12,
            border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
            background: "var(--surface-card, #ffffff)",
            boxShadow: "0 16px 40px rgba(15,23,42,0.14)",
          }}
        >
          {accounts.map((account, index) => {
            const isSelected = index === selectedIndex;
            const isActive = index === activeIndex;
            return (
              <li
                key={`${account.type}:${account.id}`}
                id={`billing-account-option-${index}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
                data-billing-account-option={`${account.type}:${account.id}`}
                style={{
                  padding: "10px 12px",
                  minHeight: 44,
                  borderRadius: 8,
                  cursor: "pointer",
                  background: isActive
                    ? "var(--surface-muted, #f1f4f9)"
                    : "transparent",
                }}
              >
                <span
                  style={{
                    display: "block",
                    fontWeight: isSelected ? 600 : 500,
                    color: "var(--text-strong, #172033)",
                  }}
                >
                  {account.displayName}
                  {/* Selection is never colour-only. */}
                  {isSelected ? (
                    <span aria-hidden style={{ marginInlineStart: 8 }}>✓</span>
                  ) : null}
                </span>
                <span
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--text-muted, #5F6878)",
                  }}
                >
                  {KIND_LABEL[account.type]}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
