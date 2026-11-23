"use client";

/**
 * A readable reference with a button that copies the FULL identifier.
 *
 * The inspector used to print bare truncated UUIDs ("Workflow 1a2b3c4d5e6f…")
 * that an operator could neither read aloud nor paste anywhere. The reference
 * is for reading; the button gives the exact id for correlation.
 */

import { useState } from "react";
import { copyWithFeedback } from "../../../../../lib/clipboard/copy-with-feedback";

export function CopyIdButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <button
        type="button"
        className="app-ghost-action"
        aria-label={`Copy full ${label} ID`}
        title={value}
        data-reviewer-copy-id={label}
        onClick={() => {
          void copyWithFeedback(value, (message, tone) => setStatus({ message, tone }), `${label} ID copied.`);
        }}
        style={{ fontSize: 12, padding: "0 8px", height: 26 }}
      >
        Copy ID
      </button>
      <span role="status" aria-live="polite" className="app-field-help" style={{ margin: 0 }}>
        {status?.message ?? ""}
      </span>
    </span>
  );
}
