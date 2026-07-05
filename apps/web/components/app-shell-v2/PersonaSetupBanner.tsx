"use client";

/**
 * PHASE 38.1 — Persona setup discoverability banner.
 *
 * Renders a dismissible banner under the topbar when the active
 * workspace has no persona profile saved (or it's still in draft).
 *
 * Hard rules:
 *
 *   1. NEVER blocks the app. The banner is dismissible; dismissal
 *      persists in localStorage (per workspace).
 *   2. NEVER fakes data or analytics. The visible state comes only
 *      from `envelope.personaProfile.source` + `.onboardingCompleted`.
 *   3. Bounded copy. Two sentences max. No marketing language.
 *   4. Tenant-safe. The banner reads only the canonical envelope; no
 *      separate fetch, no capability check (capabilities remain
 *      authoritative for everything else).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SlidersHorizontal, X } from "lucide-react";

import {
  useActiveSpace,
  usePersonaProfile,
} from "../../lib/platform-context";

const STORAGE_PREFIX = "proovra.persona-banner.dismissed-for-team:";

function storageKey(teamId: string | null): string | null {
  if (!teamId) return null;
  return `${STORAGE_PREFIX}${teamId}`;
}

export function PersonaSetupBanner() {
  const persona = usePersonaProfile();
  const activeSpace = useActiveSpace();
  const teamId =
    activeSpace?.type === "PERSONAL"
      ? activeSpace.id
      : activeSpace?.type === "ORGANIZATION"
        ? activeSpace.id
        : null;

  const [dismissed, setDismissed] = useState(true); // Start dismissed to avoid a flash before hydration.

  useEffect(() => {
    const key = storageKey(teamId);
    if (!key) {
      setDismissed(true);
      return;
    }
    try {
      const value = window.localStorage.getItem(key);
      setDismissed(value === "1");
    } catch {
      setDismissed(false);
    }
  }, [teamId]);

  const handleDismiss = useCallback(() => {
    const key = storageKey(teamId);
    if (!key) return;
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }, [teamId]);

  // The banner shows when:
  //   - we have an active workspace, AND
  //   - the persona profile has source="default" OR onboardingCompleted=false, AND
  //   - the user hasn't dismissed it for this workspace.
  const setupIncomplete =
    !!teamId &&
    (persona.source === "default" || persona.onboardingCompleted === false);

  if (!setupIncomplete || dismissed) {
    return null;
  }

  return (
    <div
      data-persona-setup-banner
      data-persona-source={persona.source}
      data-persona-onboarding-completed={
        persona.onboardingCompleted ? "true" : "false"
      }
      style={{
        // Compact, elegant enterprise callout — an inset card (not a
        // full-bleed colored bar). Subtle surface, thin border, a
        // restrained indigo accent rail, a dismiss control and a single
        // primary action. Sits above the page content.
        display: "flex",
        alignItems: "center",
        gap: 14,
        margin: "20px clamp(14px, 4vw, 40px) 0",
        padding: "12px 12px 12px 16px",
        background: "#ffffff",
        border: "1px solid rgba(15, 23, 42, 0.09)",
        borderLeft: "3px solid #6b5bff",
        borderRadius: 12,
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 34,
          height: 34,
          borderRadius: 9,
          background: "rgba(107, 91, 255, 0.10)",
          color: "#5949e4",
          flexShrink: 0,
        }}
      >
        <SlidersHorizontal size={17} strokeWidth={1.9} />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
          Configure your workflows
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: "#475569" }}>
          Pick the workflows most important to your work so navigation,
          defaults, and labels adapt — it never changes what your workspace can
          do.
        </div>
      </div>

      <Link
        href="/settings/persona"
        data-persona-setup-banner-cta
        style={{
          flexShrink: 0,
          padding: "8px 14px",
          background: "linear-gradient(135deg, #6b5bff 0%, #5949e4 100%)",
          color: "#fff",
          fontWeight: 650,
          borderRadius: 8,
          textDecoration: "none",
          fontSize: 12.5,
          whiteSpace: "nowrap",
          boxShadow: "0 1px 2px rgba(89, 73, 228, 0.28)",
        }}
      >
        Set up
      </Link>

      <button
        type="button"
        data-persona-setup-banner-dismiss
        aria-label="Dismiss workspace setup reminder"
        onClick={handleDismiss}
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          background: "transparent",
          color: "#94a3b8",
          border: "1px solid transparent",
          borderRadius: 8,
          cursor: "pointer",
        }}
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  );
}
