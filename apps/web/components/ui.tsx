import type { ReactNode } from "react";
import Link from "next/link";

export function Button({
  children,
  variant = "primary",
  onClick,
  disabled,
  className
}: {
  children: ReactNode;
  variant?: "primary" | "secondary";
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`btn ${variant} ${className ?? ""}`.trim()}
      onClick={onClick}
      type="button"
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className ?? ""}`}>{children}</div>;
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

export function Tabs({ items }: { items: string[] }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      {items.map((item, idx) => (
        <div
          key={item}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            border: "1px solid #E2E8F0",
            background: idx === 0 ? "var(--color-primary)" : "#fff",
            color: idx === 0 ? "#fff" : "#475569",
            fontSize: 12,
            fontWeight: 600
          }}
        >
          {item}
        </div>
      ))}
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
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: "#E2E8F0"
        }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
        <div style={{ color: "#64748b", fontSize: 11 }}>{subtitle}</div>
      </div>
      {badge}
    </div>
  );
}

export function TopBar({
  title,
  right,
  logoSrc = "/brand/logo.svg",
  logoHref
}: {
  title: string;
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
      {right}
    </div>
  );
}

export function BottomNav() {
  const items = ["Home", "Cases", "Teams", "Settings"];
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
      {items.map((item, idx) => (
        <div
          key={item}
          style={{
            fontSize: 10,
            color: idx === 0 ? "var(--color-primary)" : "#94A3B8",
            fontWeight: 600
          }}
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
