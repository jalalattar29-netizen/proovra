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
        background: "#eef2ff",
        borderBottom: "1px solid #c7d2fe",
        padding: "8px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 13,
      }}
    >
      <div style={{ flex: 1, color: "#1e1b4b" }}>
        <strong>Configure your workflows.</strong>{" "}
        <span style={{ color: "#3730a3" }}>
          Pick the workflows most important to your work so navigation,
          defaults, and labels adapt. This never changes what your workspace
          is allowed to do.
        </span>
      </div>
      <Link
        href="/settings/persona"
        data-persona-setup-banner-cta
        style={{
          padding: "4px 12px",
          background: "#1e293b",
          color: "#fff",
          fontWeight: 600,
          borderRadius: 6,
          textDecoration: "none",
          fontSize: 12,
        }}
      >
        Set up workspace
      </Link>
      <button
        type="button"
        data-persona-setup-banner-dismiss
        aria-label="Dismiss workspace setup reminder"
        onClick={handleDismiss}
        style={{
          padding: "4px 8px",
          background: "transparent",
          color: "#3730a3",
          border: "1px solid #c7d2fe",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        Not now
      </button>
    </div>
  );
}
