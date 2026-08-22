"use client";

/**
 * LATEST-REQUEST-WINS (Attention Architecture, Phase 2.6).
 *
 * ---------------------------------------------------------------------------
 * THE RACE
 * ---------------------------------------------------------------------------
 *   1. operator is in workspace A; the page fetches A's notifications
 *   2. operator switches to workspace B; the page fetches B's
 *   3. B answers first and renders
 *   4. A answers second and renders OVER it
 *
 * The screen now shows workspace A's content under workspace B's heading,
 * chips and counts, with no error and no loading state — the operator has no
 * way to tell. On a tenanted product that is not a flicker; it reads as one
 * tenant's data appearing inside another's context, and an operator acting on
 * what they see acts on the wrong workspace.
 *
 * `setState` in a `.then()` is unconditional, so the LAST response to arrive
 * always wins. Responses do not arrive in the order they were sent, and no
 * amount of care at the call site changes that.
 *
 * ---------------------------------------------------------------------------
 * THE FIX
 * ---------------------------------------------------------------------------
 * Give every request an identity, and let only the newest one commit.
 *
 *   const request = useLatestRequest();
 *   const load = useCallback(async () => {
 *     const attempt = request.begin();        // supersedes any in flight
 *     const data = await apiFetch(url, { signal: attempt.signal });
 *     if (!attempt.isCurrent()) return;       // a newer request took over
 *     setState({ kind: "ready", data });
 *   }, [request, url]);
 *
 * Two mechanisms, deliberately, because they cover different failures:
 *
 *   `signal`      aborts the superseded fetch, so the browser stops waiting
 *                 on a response nobody will use.
 *   `isCurrent()` guards the COMMIT, which is what actually matters — an
 *                 abort can lose the race against an already-resolved
 *                 promise, and a caller may legitimately not thread the
 *                 signal through. The guard is the correctness property; the
 *                 abort is the efficiency one.
 *
 * Unmounting cancels everything, so a late response cannot call `setState` on
 * a component that is gone.
 */

import { useCallback, useEffect, useRef } from "react";

export type RequestAttempt = {
  /** Monotonic id. Useful in logs when diagnosing an out-of-order response. */
  readonly id: number;
  /** True only while this is the newest attempt AND the host is mounted. */
  isCurrent(): boolean;
  /** Aborted the moment a newer attempt begins, or on unmount. */
  readonly signal: AbortSignal;
};

export type LatestRequest = {
  /** Start an attempt, superseding (and aborting) any attempt in flight. */
  begin(): RequestAttempt;
  /** Abort whatever is in flight without starting a new attempt. */
  cancel(): void;
};

export function useLatestRequest(): LatestRequest {
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      controller.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
  }, []);

  const begin = useCallback((): RequestAttempt => {
    // Supersede first, then arm. Bumping the generation BEFORE aborting means
    // an in-flight attempt whose abort handler runs synchronously already
    // fails `isCurrent()`, so it cannot squeeze a commit in on the way out.
    generation.current += 1;
    const id = generation.current;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return {
      id,
      isCurrent: () => mounted.current && generation.current === id,
      signal: next.signal,
    };
  }, []);

  const ref = useRef<LatestRequest>({ begin, cancel });
  ref.current.begin = begin;
  ref.current.cancel = cancel;
  return ref.current;
}
