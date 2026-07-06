"use client";

/**
 * ProovraSupportReference — the ONLY sanctioned way to surface an
 * internal request/trace id to a user.
 *
 * Never inline the id inside an error sentence (e.g. "… (requestId: abc)").
 * Instead render a labelled, low-contrast reference with a Copy button so
 * a user can hand it to support without the message reading like a stack
 * trace.
 */

import { useCallback, useState } from "react";

import { FEEDBACK_SURFACE } from "./severity";

export function ProovraSupportReference({
  reference,
  compact = false,
}: {
  reference: string | null | undefined;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const value = (reference ?? "").trim();

  const onCopy = useCallback(() => {
    if (!value) return;
    try {
      void navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the code is still visible to read aloud */
    }
  }, [value]);

  if (!value) return null;

  return (
    <div
      data-support-reference
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        marginTop: compact ? 6 : 10,
        padding: compact ? "3px 8px" : "5px 10px",
        borderRadius: 8,
        background: FEEDBACK_SURFACE.pearl,
        border: `1px solid ${FEEDBACK_SURFACE.border}`,
        maxWidth: "100%",
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: FEEDBACK_SURFACE.inkSubtle,
          whiteSpace: "nowrap",
        }}
      >
        Support reference
      </span>
      <code
        style={{
          fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
          fontSize: 12,
          fontWeight: 600,
          color: FEEDBACK_SURFACE.ink,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy support reference"
        style={{
          border: `1px solid ${FEEDBACK_SURFACE.border}`,
          background: FEEDBACK_SURFACE.card,
          color: FEEDBACK_SURFACE.inkMuted,
          borderRadius: 6,
          padding: "2px 8px",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
