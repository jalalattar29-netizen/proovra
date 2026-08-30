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

/**
 * One recent sign-in, from the fields the sessions route actually projects.
 *
 * `uaPreview` and `countryCode` are on every row `GET
 * /v1/identity-security/my-sessions` returns and were being discarded here —
 * which is why the account summary could only ever offer a single timestamp,
 * and why the Settings Activity card read "Not available" for an account with
 * fifteen live sessions: `lastLoginAtUtc` was taken from the session flagged
 * `isCurrent`, and when no row carries that flag the whole card had nothing
 * to say. `lastSeenAtUtc` is always populated, so the recent list is built
 * from it instead.
 *
 * Nothing here is derived or guessed: a device label the server did not send
 * stays null and the surface omits it.
 */
export type RecentSignIn = {
  id: string;
  /** e.g. "Chrome on Windows" — server-projected, null when unknown. */
  device: string | null;
  /** ISO-3166 alpha-2, null when the server did not resolve one. */
  countryCode: string | null;
  lastSeenAtUtc: string;
  isCurrent: boolean;
};

export type AccountSecuritySummary = {
  /** e.g. "Google", "Google · Password"; null while loading/failed. */
  loginMethods: string | null;
  /** null while loading/failed. */
  mfaConfigured: boolean | null;
  /** null while loading/failed. */
  activeSessions: number | null;
  /** ISO timestamp the CURRENT session was signed in; null when unknown. */
  lastLoginAtUtc: string | null;
  /** The three most recently active sessions, newest first. */
  recentSignIns: RecentSignIn[];
};

export function useAccountSecuritySummary(enabled: boolean): AccountSecuritySummary {
  const [summary, setSummary] = useState<AccountSecuritySummary>({
    loginMethods: null,
    mfaConfigured: null,
    activeSessions: null,
    lastLoginAtUtc: null,
    recentSignIns: [],
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
          .then(
            (r) =>
              r as {
                sessions?: Array<{
                  id?: string;
                  isCurrent?: boolean;
                  issuedAtUtc?: string;
                  lastSeenAtUtc?: string;
                  uaPreview?: string | null;
                  countryCode?: string | null;
                }>;
              },
          )
          .catch(() => null),
      ]);
      if (!alive) return;
      const current = sessions?.sessions?.find((s) => s.isCurrent) ?? null;
      // Newest first by last activity. The route already orders by
      // `lastSeenAtUtc` desc, but the summary must not depend on that.
      const recent = (sessions?.sessions ?? [])
        .filter((row) => typeof row.lastSeenAtUtc === "string")
        .sort((a, b) => (a.lastSeenAtUtc! < b.lastSeenAtUtc! ? 1 : -1))
        .slice(0, 3)
        .map((row, index) => ({
          id: row.id ?? `session-${index}`,
          device: row.uaPreview ?? null,
          countryCode: row.countryCode ?? null,
          lastSeenAtUtc: row.lastSeenAtUtc as string,
          isCurrent: row.isCurrent === true,
        }));

      setSummary({
        loginMethods: links ? summarizeLoginMethods(links) : null,
        mfaConfigured: mfa ? Boolean(mfa.hasMfa) : null,
        activeSessions: sessions?.sessions ? sessions.sessions.length : null,
        // Fall back to the most recent activity when no row is flagged
        // current — the flag depends on a session-hash match that is not
        // always available, and a missing flag is not an absence of sign-ins.
        lastLoginAtUtc: current?.issuedAtUtc ?? recent[0]?.lastSeenAtUtc ?? null,
        recentSignIns: recent,
      });
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);

  return summary;
}
