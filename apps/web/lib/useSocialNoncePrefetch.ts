"use client";

/**
 * F-P1-05 — A SOCIAL SIGN-IN NONCE THAT IS ALREADY IN HAND WHEN THE BUTTON IS
 * PRESSED.
 *
 * Apple's JS opens its sign-in window from `AppleID.auth.signIn()` with
 * `usePopup: true`. Browsers that block popups not opened directly by a click
 * (Safari on macOS and iOS, strict blockers) refuse a window opened after the
 * click handler has awaited a network round trip — and every Apple button
 * awaited `fetchSocialSignInNonce("apple")` first. The person saw "Apple
 * sign-in failed" for a click that never reached Apple.
 *
 * So the nonce is fetched BEFORE the click (on mount, and again after every
 * attempt and before the held one grows old), and the click takes it
 * synchronously. The PRO-034 rule is unchanged: one API-issued nonce per
 * attempt, accepted once, bound to this browser — a held nonce is handed out
 * exactly once and never reused.
 *
 * `take()` returns null when nothing fresh is held (first click before the
 * fetch landed, or the fetch failed); the caller then falls back to fetching in
 * the click, which is the old behaviour and still works where popups are not
 * blocked.
 *
 * Whether a given browser then opens Apple's window is browser behaviour this
 * code cannot prove; what it guarantees is that no await precedes `signIn()`
 * when a nonce is held.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";

import { fetchSocialSignInNonce } from "./oauth";

/**
 * The API keeps a nonce for 10 minutes (social-sign-in-nonce.service.ts
 * SOCIAL_NONCE_TTL_SECONDS). A held nonce is handed out only while it has at
 * least 5 minutes left — time for the person to finish Apple's sheet — and is
 * replaced on that schedule.
 */
export const SOCIAL_NONCE_HOLD_MS = 5 * 60 * 1000;

type Held = { nonce: string; fetchedAtMs: number };

export function useSocialNoncePrefetch(
  provider: "google" | "apple",
  enabled: boolean,
): { take: () => string | null; prefetch: () => Promise<void> } {
  const heldRef = useRef<Held | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  const prefetch = useCallback((): Promise<void> => {
    if (inflightRef.current) return inflightRef.current;
    const p = fetchSocialSignInNonce(provider)
      .then((nonce) => {
        if (mountedRef.current) heldRef.current = { nonce, fetchedAtMs: Date.now() };
      })
      .catch(() => {
        heldRef.current = null;
      })
      .finally(() => {
        inflightRef.current = null;
      });
    inflightRef.current = p;
    return p;
  }, [provider]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return () => {
      mountedRef.current = false;
    };
    void prefetch();
    const timer = setInterval(() => {
      heldRef.current = null;
      void prefetch();
    }, SOCIAL_NONCE_HOLD_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [enabled, prefetch]);

  const take = useCallback((): string | null => {
    const held = heldRef.current;
    heldRef.current = null;
    // Whatever happens to this attempt, the next one gets its own nonce.
    void prefetch();
    if (!held || Date.now() - held.fetchedAtMs >= SOCIAL_NONCE_HOLD_MS) return null;
    return held.nonce;
  }, [prefetch]);

  return useMemo(() => ({ take, prefetch }), [take, prefetch]);
}
