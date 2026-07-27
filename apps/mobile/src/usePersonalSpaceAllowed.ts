/**
 * PHASE 10 CLOSURE — FIX 3 (2026-07-23).
 *
 * Fetches the canonical platform-context envelope once per authenticated
 * session and exposes ONLY the `personalSpaceAllowed` projection (see
 * ./personal-space.ts for the pure gate + copy). This is a UX hint, not a
 * security boundary — the server independently enforces the same field on
 * every personal-scope mutation regardless of what this hook reports, so a
 * transient fetch failure fails OPEN (does not block capture on a network
 * hiccup) rather than guessing at policy.
 */

import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { useAuth } from "./auth-context";
import { isPersonalSpaceDisallowed } from "./personal-space";

export type PersonalSpaceAllowedState = {
  loading: boolean;
  allowed: boolean;
};

export function usePersonalSpaceAllowed(): PersonalSpaceAllowedState {
  const { token, authReady } = useAuth();
  const [state, setState] = useState<PersonalSpaceAllowedState>({
    loading: true,
    allowed: true
  });

  useEffect(() => {
    let alive = true;

    if (!authReady || !token) {
      setState({ loading: false, allowed: true });
      return;
    }

    setState((prev) => ({ ...prev, loading: true }));

    apiFetch("/v1/platform/context", { method: "GET" })
      .then((envelope) => {
        if (!alive) return;
        setState({ loading: false, allowed: !isPersonalSpaceDisallowed(envelope) });
      })
      .catch(() => {
        if (!alive) return;
        // Fail OPEN on a transient network error — the server remains the
        // authority and independently rejects any disallowed mutation with
        // a real 403; this hook only decides what to render.
        setState({ loading: false, allowed: true });
      });

    return () => {
      alive = false;
    };
  }, [authReady, token]);

  return state;
}
