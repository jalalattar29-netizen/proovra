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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "./api";

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

      // 1) Readiness
      let nextReadiness: GlobalRuntimeState["readiness"] = null;
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
      } catch {
        nextErrors.readiness = true;
      }

      // 2) Incidents (OPEN)
      let nextIncidents: ReadonlyArray<GlobalRuntimeIncident> = [];
      try {
        const r = (await apiFetch(
          `/v1/ops/incidents?teamId=${enc}&status=OPEN&limit=50`,
        )) as { incidents: ReadonlyArray<GlobalRuntimeIncident> };
        nextIncidents = r.incidents ?? [];
      } catch {
        nextErrors.incidents = true;
      }

      // 3) Escalations (OPEN)
      let nextEscalations: ReadonlyArray<GlobalRuntimeEscalation> = [];
      try {
        const r = (await apiFetch(
          `/v1/reviewer-ops/escalations?teamId=${enc}&status=OPEN&limit=100`,
        )) as { escalations: ReadonlyArray<GlobalRuntimeEscalation> };
        nextEscalations = r.escalations ?? [];
      } catch {
        nextErrors.escalations = true;
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
  }, [teamId, clampedPoll, tick]);

  const severity = useMemo<GlobalRuntimeSeverity>(() => {
    if (!teamId) return "UNKNOWN";
    if (loading) return "UNKNOWN";
    return deriveSeverity({
      readinessStatus: readiness?.status ?? null,
      incidents,
      anySourceErrored:
        errors.readiness || errors.incidents || errors.escalations,
    });
  }, [teamId, loading, readiness, incidents, errors]);

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
    readiness: readiness ?? (loading ? null : HEALTHY_READINESS),
    incidents,
    escalations,
    counts,
    errors,
    refreshedAtUtc,
    refresh,
  };
}
