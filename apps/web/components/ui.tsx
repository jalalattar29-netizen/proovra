import type { ReactNode } from "react";
import Link from "next/link";
import { createContext, useContext, useState, useCallback } from "react";

// Toast Context and Provider
type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (message: string, type: ToastType, duration?: number) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback(
    (message: string, type: ToastType = "info", duration = 4000) => {
      const id = Math.random().toString(36).slice(2, 11);
      setToasts((prev) => [...prev, { id, message, type, duration }]);

      if (duration > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
      }
    },
    []
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

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
  onRemove
}: {
  toasts: Toast[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onClose={() => onRemove(toast.id)}
        />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onClose
}: {
  toast: Toast;
  onClose: () => void;
}) {
  return (
    <div className={`toast-item toast-${toast.type}`}>
      <span className="toast-message">{toast.message}</span>
      <button onClick={onClose} className="toast-close" aria-label="Close notification">
        ×
      </button>
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  onClick,
  disabled,
  className,
  type = "button"
}: {
  children: ReactNode;
  variant?: "primary" | "secondary";
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
}) {
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
    <button
      className={finalClassName}
      onClick={onClick}
      type={type}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`card ${className ?? ""}`.trim()}>{children}</div>;
}

export function Badge({
  children,
  tone
}: {
  children: ReactNode;
  tone: "signed" | "processing" | "ready";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function StatusPill({ children }: { children: ReactNode }) {
  return <span className="phone-pill">{children}</span>;
}

export function Tabs({
  items,
  active,
  onChange
}: {
  items: Array<{ label: string; value: string; icon?: ReactNode }> | string[];
  active?: string;
  onChange?: (value: string) => void;
}) {
  const tabItems = items.map((item) =>
    typeof item === "string" ? { label: item, value: item } : item
  );

  return (
    <div className="ui-tabs">
      {tabItems.map((item, idx) => {
        const isActive = active ? item.value === active : idx === 0;
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onChange?.(item.value)}
            className={`ui-tab ${isActive ? "active" : ""}`}
          >
            {item.icon && <span className="ui-tab-icon">{item.icon}</span>}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function ListRow({
  title,
  subtitle,
  badge
}: {
  title: string;
  subtitle: string;
  badge: ReactNode;
}) {
  return (
    <div className="ui-list-row">
      <div className="ui-list-row-icon" />
      <div className="ui-list-row-body">
        <div className="ui-list-row-title">{title}</div>
        <div className="ui-list-row-subtitle">{subtitle}</div>
      </div>
      {badge}
    </div>
  );
}

export function TopBar({
  title,
  center,
  right,
  logoSrc = "/brand/logo.svg",
  logoHref
}: {
  title: string;
  center?: ReactNode;
  right?: ReactNode;
  logoSrc?: string;
  logoHref?: string;
}) {
  return (
    <div className="nav">
      <div className="nav-left">
        {logoHref ? (
          <Link className="logo" href={logoHref}>
            <img src={logoSrc} alt="PROO✓RA" width={34} height={34} />
            <span>{title}</span>
          </Link>
        ) : (
          <div className="logo">
            <img src={logoSrc} alt="PROO✓RA" width={34} height={34} />
            <span>{title}</span>
          </div>
        )}
      </div>
      {center && <div className="nav-center">{center}</div>}
      {right}
    </div>
  );
}

export function BottomNav() {
  const items = ["Home", "Cases", "Teams", "Settings"];
  return (
    <div className="ui-bottom-nav-preview">
      {items.map((item, idx) => (
        <div
          key={item}
          className={`ui-bottom-nav-preview-item ${idx === 0 ? "active" : ""}`}
        >
          {item}
        </div>
      ))}
    </div>
  );
}

export function TimelineBlock({ items }: { items: string[] }) {
  return (
    <div className="timeline">
      {items.map((item) => (
        <div key={item} className="timeline-row">
          <span className="timeline-dot" />
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  actions
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

export function Skeleton({
  width = "100%",
  height = "20px"
}: {
  width?: string;
  height?: string;
}) {
  return (
    <div
      className="skeleton"
      style={{
        width,
        height
      }}
    />
  );
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? "80%" : "100%"} height="16px" />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
  action,
  actionLabel
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

export function Input({
  placeholder,
  value,
  onChange,
  type = "text",
  disabled,
  error,
  maxLength
}: {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  disabled?: boolean;
  error?: string;
  maxLength?: number;
}) {
  return (
    <div>
      <input
        className={`input ${error ? "input-has-error" : ""}`}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        maxLength={maxLength}
      />
      {error && <div className="input-error">{error}</div>}
    </div>
  );
}

export function Select({
  label,
  options,
  value,
  onChange,
  disabled
}: {
  label?: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      {label && <label className="select-label">{label}</label>}
      <select
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">Select...</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}