"use client";

/**
 * PHASE 38.4 — Persona hint callout.
 *
 * Renders a single dismissible callout for the active persona + surface
 * pair. Reads the hint from the canonical `resolvePersonaHint()` library
 * and gates rendering on the optional `capabilityKey` so the callout
 * never points to a feature the user cannot reach.
 *
 * Hard rules:
 *
 *   1. NEVER blocks the page. Dismissible; dismissal persists per-hint-id
 *      in localStorage.
 *   2. NEVER grants permissions. The callout uses `useCan(hint.capabilityKey)`
 *      to GATE rendering; it never bypasses it.
 *   3. Bounded copy. Surfaced verbatim from the hint library — no
 *      runtime string concatenation, no analytics events.
 *   4. Returns `null` when no hint exists or the user already dismissed it.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import {
  resolvePersonaHint,
  useCan,
  usePersonaProfile,
  type PersonaHintSurface,
} from "../../lib/platform-context";

const STORAGE_PREFIX = "proovra.persona-hint.dismissed:";

export function HintCallout({ surface }: { surface: PersonaHintSurface }) {
  const persona = usePersonaProfile();
  const hint = resolvePersonaHint({
    persona: persona.primaryProfile,
    surface,
  });
  const canSeeHintTarget = useCan(
    (hint?.capabilityKey ?? "ACCOUNT_SETTINGS_VIEW") as never,
  );
  const [dismissed, setDismissed] = useState(true);

  // Re-read dismissal state when the hint id changes (persona/surface switch).
  useEffect(() => {
    if (!hint) {
      setDismissed(true);
      return;
    }
    try {
      const stored = window.localStorage.getItem(`${STORAGE_PREFIX}${hint.id}`);
      setDismissed(stored === "1");
    } catch {
      setDismissed(false);
    }
  }, [hint]);

  const onDismiss = useCallback(() => {
    if (!hint) return;
    try {
      window.localStorage.setItem(`${STORAGE_PREFIX}${hint.id}`, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }, [hint]);

  if (!hint) return null;
  if (hint.capabilityKey && !canSeeHintTarget) return null;
  if (dismissed) return null;

  return (
    <aside
      data-persona-hint
      data-persona-hint-id={hint.id}
      data-persona-hint-surface={surface}
      data-persona-hint-persona={persona.primaryProfile}
      style={{
        marginBottom: 16,
        padding: "12px 14px",
        background: "#f8fafc",
        border: "1px solid #cbd5e1",
        borderLeft: "3px solid #1e293b",
        borderRadius: 6,
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      <div style={{ flex: 1 }}>
        <div
          style={{ fontWeight: 600, fontSize: 13, color: "#0f172a" }}
          data-persona-hint-headline
        >
          {hint.headline}
        </div>
        <div
          style={{ fontSize: 12, color: "#475569", marginTop: 4 }}
          data-persona-hint-body
        >
          {hint.body}
        </div>
        <Link
          href={hint.ctaHref}
          data-persona-hint-cta
          style={{
            display: "inline-block",
            marginTop: 8,
            padding: "4px 10px",
            background: "#1e293b",
            color: "#fff",
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            textDecoration: "none",
          }}
        >
          {hint.ctaLabel}
        </Link>
      </div>
      <button
        type="button"
        aria-label="Dismiss hint"
        data-persona-hint-dismiss
        onClick={onDismiss}
        style={{
          padding: "2px 8px",
          background: "transparent",
          color: "#64748b",
          border: "1px solid #cbd5e1",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        Dismiss
      </button>
    </aside>
  );
}
