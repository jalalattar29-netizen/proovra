"use client";

/**
 * Phase 28-J — Global runtime awareness hook.
 *
 * Single source of truth for the operational state surfaced in:
 *   - The topbar GlobalRuntimeIndicator pill + dropdown
 *   - The sidebar operational badges (escalation count, runtime dot)
 *   - Any future operator-facing chrome that needs a unified snapshot
 *
 * The hook polls THREE real endpoints (no fake counters, ever):
 *   - GET /admin/runtime/readiness?teamId=…
 *   - GET /v1/ops/incidents?teamId=…&status=OPEN
 *   - GET /v1/reviewer-ops/escalations?teamId=…&status=OPEN
 *
 * FAIL-CLOSED:
 *   - Any subset of the three endpoints failing → the hook reports the
 *     overall state as UNKNOWN with the affected sources in `errors`.
 *     UNKNOWN never collapses into HEALTHY. Operators are told the
 *     truth: we couldn't confirm.
 *
 * Severity precedence (most severe wins):
 *   CRITICAL > INCIDENT_ACTIVE > DEGRADED > UNKNOWN > HEALTHY
 *
 *   - CRITICAL ← readiness.status === "CRITICAL"
 *                  OR any incident with severity "CRITICAL" is open
 *   - INCIDENT_ACTIVE ← any open incident with severity HIGH | WARNING
 *                  (CRITICAL is already covered above)
 *   - DEGRADED ← readiness.status === "DEGRADED" with no critical
 *                  incidents
 *   - UNKNOWN ← any source failed AND nothing more severe was confirmed
 *   - HEALTHY ← readiness.status === "HEALTHY" AND zero open incidents
 *                  AND zero hook fetch errors
 *
 * Polling cadence: default 45 s. Bounded by [15s, 5 min] in the runtime
 * to avoid melting the API.
 *
 * CAPABILITY BOUNDARY (closure pass).
 * ---------------------------------------------------------------------------
 * Each of the three sources is gated on the capability that actually governs
 * it, resolved by `resolveRuntimeReadAccess` from the SERVER-projected
 * envelope. Before this the hook polled whenever the caller handed it a
 * `teamId`, and the sidebar computed that id from the workspace's SHAPE
 * (`scope === "TEAM"`) rather than from the caller's AUTHORITY. A platform
 * administrator with no membership, a member below the operational role floor
 * and a workspace with no Operations surface therefore all polled
 * `/v1/ops/incidents` every 45 seconds — and drove a severity pill for a
 * page the route gate refuses them.
 *
 * A refused source is not merely ignored: it is never REQUESTED. And a source
 * the server answers with 403 or 404 is latched off for that workspace, so an
 * unauthorised context cannot retry forever on a timer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "./api";
import { usePlatformContext } from "./platform-context";
import {
  readsNothing,
  resolveRuntimeReadAccess,
  type RuntimeReadAccess,
} from "./platform-context/runtimeReadAccess";

export type GlobalRuntimeSeverity =
  | "HEALTHY"
  | "DEGRADED"
  | "INCIDENT_ACTIVE"
  | "CRITICAL"
  | "UNKNOWN";

export type GlobalRuntimeReadinessSubsystem = {
  id: string;
  status: "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";
  reasonCode: string;
  detail: string;
};

export type GlobalRuntimeIncident = {
  id: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status: string;
  category: string;
  title: string;
  firstSeenAtUtc: string;
  runbookSlug: string | null;
};

export type GlobalRuntimeEscalation = {
  id: string;
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  status: string;
  reason: string;
};

export type GlobalRuntimeState = {
  loading: boolean;
  /** Derived severity rollup — most-severe-wins across all three sources. */
  severity: GlobalRuntimeSeverity;
  /** Raw readiness snapshot (or null if the read failed). */
  readiness: {
    status: "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";
    ranAtUtc: string | null;
    subsystems: ReadonlyArray<GlobalRuntimeReadinessSubsystem>;
  } | null;
  /** Open incidents (status in OPEN | ACKNOWLEDGED) — bounded list. */
  incidents: ReadonlyArray<GlobalRuntimeIncident>;
  /** Open reviewer escalations. */
  escalations: ReadonlyArray<GlobalRuntimeEscalation>;
  /** Counters surfaced to the topbar pill + sidebar badges. */
  counts: {
    incidents: number;
    incidentsCritical: number;
    incidentsHigh: number;
    escalations: number;
    degradedSubsystems: number;
  };
  /** Per-source error flags. Any true ⇒ severity floor of UNKNOWN. */
  errors: {
    readiness: boolean;
    incidents: boolean;
    escalations: boolean;
  };
  /** ISO timestamp of the last full poll cycle that produced this state. */
  refreshedAtUtc: string | null;
  /** Manual refresh — re-fires the three fetches now. */
  refresh: () => void;
};

const POLL_MS_DEFAULT = 45_000;
const POLL_MS_MIN = 15_000;
const POLL_MS_MAX = 5 * 60_000;

const HEALTHY_READINESS: GlobalRuntimeState["readiness"] = {
  status: "HEALTHY",
  ranAtUtc: null,
  subsystems: [],
};

function deriveSeverity(input: {
  readinessStatus: "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN" | null;
  incidents: ReadonlyArray<GlobalRuntimeIncident>;
  anySourceErrored: boolean;
}): GlobalRuntimeSeverity {
  const { readinessStatus, incidents, anySourceErrored } = input;
  const anyCritical =
    readinessStatus === "CRITICAL" ||
    incidents.some((i) => i.severity === "CRITICAL");
  if (anyCritical) return "CRITICAL";
  const anyActive = incidents.some(
    (i) => i.severity === "HIGH" || i.severity === "WARNING",
  );
  if (anyActive) return "INCIDENT_ACTIVE";
  if (readinessStatus === "DEGRADED") return "DEGRADED";
  if (anySourceErrored || readinessStatus === "UNKNOWN") return "UNKNOWN";
  if (readinessStatus === "HEALTHY") return "HEALTHY";
  return "UNKNOWN";
}

export function useGlobalRuntimeState(
  teamId: string | null,
  pollMs: number = POLL_MS_DEFAULT,
): GlobalRuntimeState {
  const clampedPoll = Math.max(POLL_MS_MIN, Math.min(POLL_MS_MAX, pollMs));

  // WHAT THIS CONTEXT MAY READ. Resolved from the canonical envelope, per
  // source, before a single request is built.
  const { envelope } = usePlatformContext();
  const access = useMemo<RuntimeReadAccess>(
    () => resolveRuntimeReadAccess({ envelope, teamId }),
    [envelope, teamId],
  );
  const silent = readsNothing(access);

  /**
   * Sources the SERVER refused for this workspace.
   *
   * A 403 or an anti-enumeration 404 is a settled answer, not a transient
   * failure: retrying it every 45 seconds produces an unbounded stream of
   * requests that will never succeed, and a permanent "unknown" in the pill.
   * The latch is keyed on the workspace and cleared whenever it changes.
   */
  const refusedRef = useRef<Set<"readiness" | "incidents" | "escalations">>(
    new Set(),
  );

  const [readiness, setReadiness] =
    useState<GlobalRuntimeState["readiness"]>(null);
  const [incidents, setIncidents] = useState<
    ReadonlyArray<GlobalRuntimeIncident>
  >([]);
  const [escalations, setEscalations] = useState<
    ReadonlyArray<GlobalRuntimeEscalation>
  >([]);
  const [errors, setErrors] = useState<GlobalRuntimeState["errors"]>({
    readiness: false,
    incidents: false,
    escalations: false,
  });
  const [loading, setLoading] = useState(true);
  const [refreshedAtUtc, setRefreshedAtUtc] = useState<string | null>(null);

  // Bump this to force a re-poll outside the timer.
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Track whether component is still mounted; effects cleanup with this.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Phase 32.6.4 — request-generation counter. Every effect run for
  // a new teamId/clampedPoll/tick combination increments this. Any
  // in-flight `tickOnce` that completes AFTER the generation has
  // moved on (e.g. account switch, workspace switch) discards its
  // result instead of leaking stale readiness into the new
  // workspace's badge.
  const generationRef = useRef(0);

  useEffect(() => {
    // Phase 32.6.4 — explicit state reset when there is no teamId
    // (logout, no-workspace account, between-workspace transitions).
    // The previous implementation only set loading=false and left
    // readiness/incidents/escalations holding stale data from the
    // prior workspace, which the topbar pill then read as CRITICAL
    // or INCIDENT_ACTIVE for the new context.
    // A context that may read NOTHING holds no state and issues no request.
    // This is the same reset the no-workspace path performs, for the same
    // reason: stale readiness from a context the caller has left must never
    // colour the next one's badge.
    if (silent) {
      refusedRef.current = new Set();
      setReadiness(null);
      setIncidents([]);
      setEscalations([]);
      setErrors({ readiness: false, incidents: false, escalations: false });
      setRefreshedAtUtc(null);
      setLoading(false);
      generationRef.current += 1;
      return;
    }

    if (!teamId) {
      setReadiness(null);
      setIncidents([]);
      setEscalations([]);
      setErrors({ readiness: false, incidents: false, escalations: false });
      setRefreshedAtUtc(null);
      setLoading(false);
      // Bump the generation so any in-flight previous-teamId tick
      // discards its result on return.
      generationRef.current += 1;
      return;
    }

    const myGeneration = ++generationRef.current;
    refusedRef.current = new Set();
    let cancelled = false;

    // Phase 32.6.4 — clear stale readiness/incidents/escalations on
    // EVERY teamId transition, including from one valid teamId to
    // another. Otherwise the badge can briefly render CRITICAL or
    // INCIDENT_ACTIVE from the prior workspace while the new poll
    // is still in flight. Loading state goes back to true so
    // severity correctly maps to UNKNOWN during the transition.
    setReadiness(null);
    setIncidents([]);
    setEscalations([]);
    setErrors({ readiness: false, incidents: false, escalations: false });
    setRefreshedAtUtc(null);
    setLoading(true);

    async function tickOnce() {
      if (!teamId) return;
      const enc = encodeURIComponent(teamId);
      const nextErrors = {
        readiness: false,
        incidents: false,
        escalations: false,
      };

      /**
       * A settled refusal, as opposed to a transient failure.
       *
       * 403 is "you may not", 404 is the anti-enumeration form of the same
       * answer. Neither becomes true by waiting, so the source is latched off
       * for this workspace instead of being retried on every tick.
       */
      const isSettledRefusal = (err: unknown): boolean => {
        const code = (err as { statusCode?: number } | null)?.statusCode;
        return code === 401 || code === 403 || code === 404;
      };

      // 1) Readiness
      let nextReadiness: GlobalRuntimeState["readiness"] = null;
      if (access.readiness && !refusedRef.current.has("readiness")) {
        try {
          const r = (await apiFetch(
            `/admin/runtime/readiness?teamId=${enc}`,
          )) as {
            status: "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";
            ranAtUtc: string;
            subsystems: ReadonlyArray<GlobalRuntimeReadinessSubsystem>;
          };
          nextReadiness = {
            status: r.status,
            ranAtUtc: r.ranAtUtc,
            subsystems: r.subsystems,
          };
        } catch (err) {
          nextErrors.readiness = true;
          if (isSettledRefusal(err)) refusedRef.current.add("readiness");
        }
      }

      // 2) Incidents (OPEN)
      let nextIncidents: ReadonlyArray<GlobalRuntimeIncident> = [];
      if (access.incidents && !refusedRef.current.has("incidents")) {
        try {
          const r = (await apiFetch(
            `/v1/ops/incidents?teamId=${enc}&status=OPEN&limit=50`,
          )) as { incidents: ReadonlyArray<GlobalRuntimeIncident> };
          nextIncidents = r.incidents ?? [];
        } catch (err) {
          nextErrors.incidents = true;
          if (isSettledRefusal(err)) refusedRef.current.add("incidents");
        }
      }

      // 3) Escalations (OPEN)
      let nextEscalations: ReadonlyArray<GlobalRuntimeEscalation> = [];
      if (access.escalations && !refusedRef.current.has("escalations")) {
        try {
          const r = (await apiFetch(
            `/v1/reviewer-ops/escalations?teamId=${enc}&status=OPEN&limit=100`,
          )) as { escalations: ReadonlyArray<GlobalRuntimeEscalation> };
          nextEscalations = r.escalations ?? [];
        } catch (err) {
          nextErrors.escalations = true;
          if (isSettledRefusal(err)) refusedRef.current.add("escalations");
        }
      }

      // Phase 32.6.4 — drop stale responses. Three guards in order
      // of cheapness: the explicit cancelled flag, the component
      // mounted flag, and the request-generation match. Generation
      // mismatch is the only one that catches a slow response that
      // arrives AFTER teamId has changed but BEFORE the next
      // teardown has run.
      if (cancelled || !mountedRef.current) return;
      if (generationRef.current !== myGeneration) return;
      setReadiness(nextReadiness);
      setIncidents(nextIncidents);
      setEscalations(nextEscalations);
      setErrors(nextErrors);
      setRefreshedAtUtc(new Date().toISOString());
      setLoading(false);
    }

    void tickOnce();
    const handle = window.setInterval(tickOnce, clampedPoll);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [teamId, clampedPoll, tick, silent, access]);

  const severity = useMemo<GlobalRuntimeSeverity>(() => {
    if (!teamId) return "UNKNOWN";
    // A context that reads nothing knows nothing. UNKNOWN — never HEALTHY,
    // which would be a false all-clear drawn from an absence of data rather
    // than from data.
    if (silent) return "UNKNOWN";
    if (loading) return "UNKNOWN";
    return deriveSeverity({
      readinessStatus: readiness?.status ?? null,
      incidents,
      anySourceErrored:
        errors.readiness || errors.incidents || errors.escalations,
    });
  }, [teamId, silent, loading, readiness, incidents, errors]);

  const counts = useMemo(() => {
    const degradedSubsystems =
      readiness?.subsystems.filter((s) => s.status !== "HEALTHY").length ?? 0;
    const incidentsCritical = incidents.filter(
      (i) => i.severity === "CRITICAL",
    ).length;
    const incidentsHigh = incidents.filter(
      (i) => i.severity === "HIGH",
    ).length;
    return {
      incidents: incidents.length,
      incidentsCritical,
      incidentsHigh,
      escalations: escalations.length,
      degradedSubsystems,
    };
  }, [readiness, incidents, escalations]);

  return {
    loading,
    severity,
    // A silent context has no readiness to report. Falling back to
    // HEALTHY_READINESS here would paint a green subsystem list for a caller
    // who was never allowed to look.
    readiness: readiness ?? (loading || silent ? null : HEALTHY_READINESS),
    incidents,
    escalations,
    counts,
    errors,
    refreshedAtUtc,
    refresh,
  };
}
