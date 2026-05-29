"use client";

/**
 * D-3 closure — Canonical enterprise confirmation modal.
 *
 * Replaces every `window.confirm(...)` and `confirm(...)` call in the
 * web app. Provides:
 *
 *   - Accessible dialog (role=dialog, aria-modal, aria-labelledby,
 *     aria-describedby, scroll lock, focus trap, focus restore).
 *   - Keyboard support — Escape cancels, Enter submits (when not
 *     focused on a textarea / non-button element), Tab cycles
 *     focusables within the dialog.
 *   - Async `onConfirm` with bounded loading state (button shows
 *     "Working…", overlay non-dismissable while busy).
 *   - Three visual tones — neutral, warning, danger — with explicit
 *     danger styling for destructive actions.
 *   - Optional typed-confirm phrase (`requireConfirmText`) for
 *     irreversible operations (mirrors GitHub-style deletion guard).
 *   - Imperative `useConfirmAction()` hook for parity with
 *     `window.confirm` ergonomics:
 *
 *       const ok = await confirm({
 *         title: "Revoke API key?",
 *         description: "The key will stop accepting requests immediately.",
 *         confirmLabel: "Revoke",
 *         tone: "danger",
 *       });
 *       if (!ok) return;
 *
 * Mount `<ConfirmActionProvider>` once at the root layer (see
 * `app/providers.tsx`). Any descendant can call `useConfirmAction()`.
 *
 * The contract test `phase-final-d3-no-window-confirm.test.ts` asserts
 * that no source file under `apps/web` contains a raw `window.confirm(`
 * or bare `confirm(` outside this file.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ConfirmActionTone = "neutral" | "warning" | "danger";

export interface ConfirmActionOptions {
  /** Heading rendered at the top of the dialog. */
  title: string;
  /** Plain text or React node rendered as the body. */
  description?: React.ReactNode;
  /** Label for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Visual tone. Defaults to "neutral". */
  tone?: ConfirmActionTone;
  /**
   * Optional typed-confirm phrase. When set, the confirm button is
   * disabled until the user types this string exactly (case-sensitive).
   * Use for irreversible operations.
   */
  requireConfirmText?: string;
  /**
   * Optional stable test id. Defaults to a stable suffix so contract
   * tests can find the modal.
   */
  testId?: string;
}

interface ConfirmActionRequest extends ConfirmActionOptions {
  resolve: (value: boolean) => void;
}

interface ConfirmActionContextValue {
  confirm: (options: ConfirmActionOptions) => Promise<boolean>;
}

// -----------------------------------------------------------------------------
// Focus trap helpers (kept inline so the modal has no runtime dependency)
// -----------------------------------------------------------------------------

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusFirstIn(dialog: HTMLElement | null) {
  if (!dialog) return;
  const focusables = Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  // Prefer the cancel button on initial open for destructive flows
  // (matches macOS / browser confirm() ergonomics).
  const cancel = focusables.find(
    (el) => el.getAttribute("data-confirm-action-cancel") === "true",
  );
  (cancel ?? focusables[0] ?? dialog).focus();
}

// -----------------------------------------------------------------------------
// Internal modal component (rendered by the provider)
// -----------------------------------------------------------------------------

function toneAccent(tone: ConfirmActionTone): { color: string; bg: string; border: string } {
  switch (tone) {
    case "danger":
      return { color: "#fff", bg: "#b3261e", border: "#7a1d18" };
    case "warning":
      return { color: "#1f1300", bg: "#f1a23a", border: "#a36b14" };
    case "neutral":
    default:
      return { color: "#dce1de", bg: "rgba(255,255,255,0.10)", border: "rgba(255,255,255,0.15)" };
  }
}

function ConfirmActionModal({
  request,
  onClose,
}: {
  request: ConfirmActionRequest;
  onClose: (result: boolean) => void;
}) {
  const {
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    tone = "neutral",
    requireConfirmText,
    testId,
  } = request;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");

  const accent = toneAccent(tone);
  const dataTestId = testId ?? "confirm-action-modal";
  const confirmGated = Boolean(requireConfirmText) && typed !== requireConfirmText;
  const confirmDisabled = busy || confirmGated;

  const close = useCallback(
    (result: boolean) => {
      if (busy) return;
      onClose(result);
    },
    [busy, onClose],
  );

  const handleConfirm = useCallback(async () => {
    if (confirmDisabled) return;
    setBusy(true);
    onClose(true);
  }, [confirmDisabled, onClose]);

  // Focus trap, scroll lock, escape, restore focus.
  useEffect(() => {
    previouslyFocusedRef.current =
      (typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null) ?? null;

    const focusTimer = setTimeout(() => focusFirstIn(dialogRef.current), 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(false);
        return;
      }
      if (e.key === "Enter") {
        const tag = (document.activeElement?.tagName ?? "").toLowerCase();
        // Don't auto-submit if the user is typing into the gated
        // confirmation text field or a textarea.
        if (tag === "textarea" || tag === "input") return;
        if (confirmDisabled) return;
        e.preventDefault();
        void handleConfirm();
        return;
      }
      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        );
        if (focusables.length === 0) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !dialog.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      const prev = previouslyFocusedRef.current;
      if (prev && document.body.contains(prev)) {
        try {
          prev.focus();
        } catch {
          // ignore
        }
      }
    };
  }, [close, confirmDisabled, handleConfirm]);

  return (
    <div
      role="presentation"
      data-confirm-action-overlay={dataTestId}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(8,18,22,0.72)",
        backdropFilter: "blur(6px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        data-confirm-action-modal={dataTestId}
        data-confirm-action-tone={tone}
        ref={dialogRef}
        tabIndex={-1}
        style={{
          maxWidth: 520,
          width: "100%",
          background:
            "linear-gradient(180deg, rgba(20,30,34,0.98) 0%, rgba(12,20,24,0.98) 100%)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 16,
          boxShadow: "0 20px 50px rgba(0,0,0,0.4)",
          display: "flex",
          flexDirection: "column",
          color: "#dce1de",
          outline: "none",
        }}
      >
        <header
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {tone === "danger" || tone === "warning" ? (
            <span
              aria-hidden="true"
              data-confirm-action-tone-dot={tone}
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: accent.bg,
                boxShadow: `0 0 0 3px ${accent.border}`,
              }}
            />
          ) : null}
          <h2
            id={titleId}
            data-confirm-action-title
            style={{ margin: 0, fontSize: 16, fontWeight: 700, flex: 1 }}
          >
            {title}
          </h2>
        </header>

        <div
          data-confirm-action-body
          style={{ padding: "16px 18px", fontSize: 14, lineHeight: 1.5 }}
        >
          {description ? (
            <div id={descriptionId} data-confirm-action-description>
              {description}
            </div>
          ) : null}

          {requireConfirmText ? (
            <label
              data-confirm-action-typed-label
              style={{
                display: "block",
                marginTop: 14,
                fontSize: 12,
                color: "rgba(220,225,222,0.75)",
              }}
            >
              Type{" "}
              <code
                style={{
                  padding: "1px 5px",
                  borderRadius: 4,
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.10)",
                  fontSize: 12,
                }}
              >
                {requireConfirmText}
              </code>{" "}
              to confirm:
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                data-confirm-action-typed-input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={busy}
                style={{
                  display: "block",
                  marginTop: 6,
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "rgba(0,0,0,0.25)",
                  color: "#dce1de",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 13,
                }}
              />
            </label>
          ) : null}
        </div>

        <footer
          data-confirm-action-footer
          style={{
            padding: "12px 18px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            data-confirm-action-cancel="true"
            onClick={() => close(false)}
            disabled={busy}
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(255,255,255,0.06)",
              color: "#dce1de",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-confirm-action-submit="true"
            data-confirm-action-tone={tone}
            onClick={() => void handleConfirm()}
            disabled={confirmDisabled}
            aria-disabled={confirmDisabled}
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              border: `1px solid ${accent.border}`,
              background: accent.bg,
              color: accent.color,
              cursor: confirmDisabled ? "not-allowed" : "pointer",
              opacity: confirmDisabled ? 0.55 : 1,
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Context + provider + hook
// -----------------------------------------------------------------------------

const ConfirmActionContext = createContext<ConfirmActionContextValue | null>(null);

export function ConfirmActionProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<ConfirmActionRequest | null>(null);

  const value = useMemo<ConfirmActionContextValue>(
    () => ({
      confirm: (options) =>
        new Promise<boolean>((resolve) => {
          setRequest({ ...options, resolve });
        }),
    }),
    [],
  );

  const onClose = useCallback(
    (result: boolean) => {
      setRequest((current) => {
        if (current) current.resolve(result);
        return null;
      });
    },
    [],
  );

  return (
    <ConfirmActionContext.Provider value={value}>
      {children}
      {request ? <ConfirmActionModal request={request} onClose={onClose} /> : null}
    </ConfirmActionContext.Provider>
  );
}

/**
 * Imperative replacement for `window.confirm`. Returns a Promise that
 * resolves with `true` on confirm or `false` on cancel / escape /
 * overlay click.
 *
 * Throws if used outside `<ConfirmActionProvider>` — the provider is
 * mounted globally in `app/providers.tsx` so every (app)-tree page has
 * access to it.
 */
export function useConfirmAction(): ConfirmActionContextValue {
  const ctx = useContext(ConfirmActionContext);
  if (!ctx) {
    throw new Error(
      "useConfirmAction must be used within a ConfirmActionProvider " +
        "(mounted by app/providers.tsx).",
    );
  }
  return ctx;
}
