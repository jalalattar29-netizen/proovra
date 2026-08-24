/**
 * Small enterprise primitives for the Technical Appendix:
 *   - MetadataRow      label/value row; monospace + copy for hashes/IDs
 *   - CopyButton       copy-to-clipboard for hashes/IDs
 *   - AppendixBadge    status word as toned TEXT (explicit tone + humanized label)
 *   - AppendixEmpty    clear empty-state line (never a blank row)
 *   - AdvisoryNote     muted boundary/advisory paragraph
 *
 * No raw enum values are ever passed in — callers humanize first.
 */

"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { AppTone } from "../../../../../../components/app-primitives/AppStatusBadge";
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

export type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info";

/**
 * The appendix's own tone words, in the app's tone vocabulary.
 *
 * This appendix names its tones by MEANING (`success`, `danger`) and the app
 * names them by COLOUR (`green`, `red`). Keeping the appendix vocabulary is
 * deliberate — a signal that passed is a success, not a green — so the
 * translation happens once, here, instead of every call site learning both.
 */
const BADGE_TONE_TO_APP_TONE = {
  success: "green",
  warning: "amber",
  danger: "red",
  neutral: "slate",
  info: "blue",
} as const satisfies Record<BadgeTone, AppTone>;

export function appendixAppTone(tone: BadgeTone): AppTone {
  return BADGE_TONE_TO_APP_TONE[tone];
}

/**
 * A state word in the Technical Appendix.
 *
 * TEXT, not a capsule. These labels sit in dense key/value tables and in the
 * per-signal list, several to a screen; as tinted pills they turned a table of
 * facts into a table of boxes, and the box was never the fact. The `.ta-badge`
 * rules this used to carry — five tinted pairs of private hexes — are deleted,
 * and the ink now comes from the canonical `.app-status-text[data-tone]`.
 *
 * The `data-testid` is preserved: it is a load-bearing probe hook, and its
 * name refers to the ROLE this element plays, which has not changed.
 */
export function AppendixBadge({
  tone,
  children,
}: {
  tone: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span
      className="app-status-text"
      data-size="xs"
      data-tone={appendixAppTone(tone)}
      data-testid="ta-badge"
    >
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
