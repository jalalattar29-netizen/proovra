"use client";

import { AppListbox } from "./app-primitives/AppListbox";
import type {
  ReactNode,
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
} from "react";
import { createContext, useContext, useId, useState, useCallback } from "react";
import { ProovraToast, type ProovraToastData } from "./feedback/ProovraToast";

/* =========================
   Toast Context and Provider

   The PROOVRA Feedback System toast. The visual surface lives in
   `components/feedback/ProovraToast.tsx` (premium light card, severity
   accent, icon, a11y). This provider owns the queue, backward-compatible
   `addToast(message, type, duration?)` API, de-duplication, and
   severity-aware default durations.
   ========================= */

type ToastType = "success" | "error" | "info" | "warning";

/** Optional richer options — old call sites keep working without them. */
export interface ToastOptions {
  title?: string;
  supportReference?: string;
  action?: { label: string; href?: string; onClick?: () => void; newTab?: boolean };
}

interface Toast extends ProovraToastData {
  /** Back-compat alias for `severity`. */
  type: ToastType;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (
    message: string,
    type?: ToastType,
    duration?: number,
    options?: ToastOptions,
  ) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

// Errors/warnings need reading time; success/info are quick confirmations.
function defaultDurationFor(type: ToastType): number {
  return type === "error" || type === "warning" ? 7000 : 4500;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (
      message: string,
      type: ToastType = "info",
      duration?: number,
      options?: ToastOptions,
    ) => {
      const resolvedDuration =
        typeof duration === "number" ? duration : defaultDurationFor(type);
      setToasts((prev) => {
        // De-dupe: identical message + severity already on screen → no spam.
        if (
          prev.some(
            (t) => t.message === message && t.type === type && t.title === options?.title,
          )
        ) {
          return prev;
        }
        const id = Math.random().toString(36).slice(2, 11);
        const next: Toast = {
          id,
          message,
          type,
          severity: type,
          duration: resolvedDuration,
          title: options?.title,
          supportReference: options?.supportReference,
          action: options?.action,
        };
        return [...prev, next];
      });
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}

function ToastContainer({
  toasts,
  onRemove,
}: {
  toasts: Toast[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="toast-container" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <ProovraToast
          key={toast.id}
          toast={toast}
          onClose={() => onRemove(toast.id)}
        />
      ))}
    </div>
  );
}

/* =========================
   Button
   ========================= */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary";
};

export function Button({
  children,
  variant = "primary",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  const cn = (className ?? "").trim();

  const hasCustomCtaClass =
    cn.includes("proovra-cta-btn") ||
    cn.includes("hero-cta-btn") ||
    cn.includes("cta-btn") ||
    cn.includes("button-danger") ||
    cn.includes("button-disabled");

  const finalClassName = hasCustomCtaClass
    ? `btn ${cn}`.trim()
    : `btn ${variant} ${cn}`.trim();

  return (
    <button className={finalClassName} type={type} {...props}>
      {children}
    </button>
  );
}

/* =========================
   Card
   ========================= */

type CardProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
};

export function Card({ children, className, ...props }: CardProps) {
  return (
    <div className={`card ${className ?? ""}`.trim()} {...props}>
      {children}
    </div>
  );
}

/* =========================
   Modal
   ========================= */

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  actions,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  if (!isOpen) return null;

  return (
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button onClick={onClose} className="modal-close" aria-label="Close modal">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-footer">{actions}</div>}
      </div>
    </>
  );
}

/* =========================
   Skeleton
   ========================= */

export function Skeleton({
  width = "100%",
  height = "20px",
}: {
  width?: string;
  height?: string;
}) {
  return (
    <div
      className="skeleton"
      style={{
        width,
        height,
      }}
    />
  );
}

/* =========================
   Empty State
   ========================= */

export function EmptyState({
  icon,
  title,
  subtitle,
  action,
  actionLabel,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="empty-state-container">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <h3 className="empty-state-title">{title}</h3>
      {subtitle && <p className="empty-state-subtitle">{subtitle}</p>}
      {action && actionLabel && (
        <Button onClick={action} className="empty-state-button">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

/* =========================
   Input
   ========================= */

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  error?: string;
};

/**
 * AUD-0059 — an error is announced, not only drawn. While `error` is set the
 * input carries aria-invalid="true" and its aria-describedby names the error
 * text (after any description the caller passed, e.g. a hint), so a screen
 * reader reads "invalid entry, <message>" on focus. The error id derives from
 * the input's id (`<id>-error`) so a caller can reference it; inputs without
 * an id get a generated one.
 */
export function Input({
  value,
  onChange,
  error,
  className,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  ...props
}: InputProps) {
  const generatedId = useId();
  const errorId = `${props.id ?? generatedId}-error`;
  const describedByIds =
    [describedBy, error ? errorId : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <input
        className={`input ${error ? "input-has-error" : ""} ${className ?? ""}`.trim()}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...props}
        aria-invalid={error ? true : ariaInvalid}
        aria-describedby={describedByIds}
      />
      {error && (
        <div id={errorId} className="input-error">
          {error}
        </div>
      )}
    </div>
  );
}

/* =========================
   Select
   ========================= */

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> & {
  label?: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
};

/**
 * TWO DEFECTS FIXED, BOTH MEASURED ON ITS ONE REMAINING CONSUMER.
 *
 * 1. THE LABEL WAS NOT ATTACHED TO ANYTHING. `<label className="select-label">`
 *    with no `htmlFor` and no wrapping is a styled paragraph: a screen reader
 *    announces the control with no name, and clicking the label does not focus
 *    it. It now carries a generated id pair.
 *
 * 2. IT INJECTED ITS OWN EMPTY OPTION IN FRONT OF THE CALLER'S OPTIONS.
 *    `/admin/contact-sales` passes `{ value: "", label: "All statuses" }` as
 *    its first option, so the rendered dropdown was:
 *
 *      =Select...          <- injected, and SELECTED by default
 *      =All statuses       <- the caller's
 *      NEW=New …
 *
 *    Two entries with the same empty value doing the same thing, and the
 *    control read "Select..." while it was in fact showing every status. The
 *    placeholder is now rendered ONLY when the caller has not supplied an
 *    empty-valued option of their own, so a page that names its own "all"
 *    state keeps its wording and a page that does not still gets a
 *    placeholder.
 *
 * `/admin/contact-sales` is the only file still importing this Select, which
 * is why both changes are safe to make here rather than at the call site.
 */
export function Select({
  label,
  options,
  value,
  onChange,
  className,
  id,
  ...props
}: SelectProps) {
  const auto = useId();
  const selectId = id ?? `select-${auto}`;
  const hasOwnPlaceholder = options.some((opt) => opt.value === "");
  return (
    <div>
      {label && (
        <label className="select-label" htmlFor={selectId}>
          {label}
        </label>
      )}
      <AppListbox
        id={selectId}
        className={`select ${className ?? ""}`.trim()}
        value={value}
        options={[
          ...(hasOwnPlaceholder ? [] : [{ value: "", label: "Select..." }]),
          ...options.map((opt) => ({ value: opt.value, label: opt.label })),
        ]}
        onChange={onChange}
        disabled={props.disabled}
        ariaLabel={props["aria-label"]}
        triggerProps={{ title: props.title }}
      />
    </div>
  );
}