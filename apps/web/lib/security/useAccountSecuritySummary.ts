"use client";

/**
 * Account security summary hook (2026-07-17 Settings remediation).
 *
 * Minimal reusable summary for the Settings overview card, derived from
 * the SAME canonical security APIs the Account Security page consumes
 * (login methods, MFA factors, session inventory) — never hardcoded and
 * never a second source of truth.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../api";
import {
  summarizeLoginMethods,
  type LoginMethodsState,
} from "./loginMethodsSummary";

export type AccountSecuritySummary = {
  /** e.g. "Google", "Google · Password"; null while loading/failed. */
  loginMethods: string | null;
  /** null while loading/failed. */
  mfaConfigured: boolean | null;
  /** null while loading/failed. */
  activeSessions: number | null;
};

export function useAccountSecuritySummary(enabled: boolean): AccountSecuritySummary {
  const [summary, setSummary] = useState<AccountSecuritySummary>({
    loginMethods: null,
    mfaConfigured: null,
    activeSessions: null,
  });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      const [links, mfa, sessions] = await Promise.all([
        apiFetch("/v1/identity/links")
          .then((r) => r as LoginMethodsState)
          .catch(() => null),
        apiFetch("/v1/identity/mfa/factors")
          .then((r) => r as { hasMfa?: boolean })
          .catch(() => null),
        apiFetch("/v1/identity-security/my-sessions")
          .then((r) => r as { sessions?: unknown[] })
          .catch(() => null),
      ]);
      if (!alive) return;
      setSummary({
        loginMethods: links ? summarizeLoginMethods(links) : null,
        mfaConfigured: mfa ? Boolean(mfa.hasMfa) : null,
        activeSessions: sessions?.sessions ? sessions.sessions.length : null,
      });
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);

  return summary;
}
