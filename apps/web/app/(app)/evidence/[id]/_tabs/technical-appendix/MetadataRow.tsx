/**
 * Small enterprise primitives for the Technical Appendix:
 *   - MetadataRow      label/value row; monospace + copy for hashes/IDs
 *   - CopyButton       copy-to-clipboard for hashes/IDs
 *   - AppendixBadge    small status pill (explicit tone + humanized label)
 *   - AppendixEmpty    clear empty-state line (never a blank row)
 *   - AdvisoryNote     muted boundary/advisory paragraph
 *
 * No raw enum values are ever passed in — callers humanize first.
 */

"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { AppendixRow } from "./types";

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ta-copy-btn"
      aria-label={label ?? "Copy to clipboard"}
      title={copied ? "Copied" : "Copy"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

export function MetadataRow({ row }: { row: AppendixRow }) {
  return (
    <div className="ta-row" data-testid="ta-row">
      <span className="ta-row-label">{row.label}</span>
      <span className={`ta-row-value${row.mono ? " ta-mono" : ""}`}>
        <span className="ta-row-value-text">{row.value}</span>
        {row.copyable && row.value ? (
          <CopyButton value={row.value} label={`Copy ${row.label}`} />
        ) : null}
      </span>
    </div>
  );
}

/** Render a list of already-filtered rows, or an empty state when none. */
export function MetadataRows({
  rows,
  empty,
}: {
  rows: AppendixRow[];
  empty: string;
}) {
  if (rows.length === 0) return <AppendixEmpty>{empty}</AppendixEmpty>;
  return (
    <div className="ta-rows">
      {rows.map((r) => (
        <MetadataRow key={r.label} row={r} />
      ))}
    </div>
  );
}

type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info";

export function AppendixBadge({
  tone,
  children,
}: {
  tone: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span className={`ta-badge ta-badge-${tone}`} data-testid="ta-badge">
      {children}
    </span>
  );
}

export function AppendixEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="ta-empty" data-testid="ta-empty">
      {children}
    </p>
  );
}

export function AdvisoryNote({ children }: { children: ReactNode }) {
  return <p className="ta-advisory">{children}</p>;
}
