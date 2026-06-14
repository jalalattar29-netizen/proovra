/**
 * Phase IA-home-v2 — Home data hook.
 *
 * Orchestrates the workspace-scoped reads the workflow-centric Home
 * consumes and feeds them into the `home-view-model.ts` normalizer.
 * Every fetch is independent and partial-failure tolerant — one slice
 * failing never blanks the whole dashboard.
 *
 * Endpoints (all workspace-scoped by the active space id):
 *   1. GET /v1/dashboard/command-center?teamId=   — pipeline, cases,
 *        recent evidence, timeline, integrity watch.
 *   2. GET /v1/dashboard/trust-summary?teamId=     — REAL integrity
 *        totals (TSA / OTS / signed / verify / needing-attention).
 *   3. GET /v1/billing/overview                    — storage (account).
 *   4. GET /v1/reports?teamId=                      — reports list.
 *   5. GET /v1/workflow/intake-links?teamId=        — active intake links.
 *   6. GET /v1/me/inbox                             — submission review
 *        items (filtered to intake categories by the normalizer).
 *   7. GET /v1/communications/messages?teamId=&purpose=INTAKE_LINK
 *        — delivery state for the collection card + activity.
 *   8. envelope.organizations                       — team work (no fetch).
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import {
  useActiveSpace,
  useActiveSpaceId,
  useOrganizations,
} from "../../lib/platform-context";
import { useSurfaceUserContext } from "../../lib/surface/useSurfaceUserContext";

import {
  normalizeHomeViewModel,
  type HomeBillingInput,
  type HomeCommandCenterInput,
  type HomeCommunicationsInput,
  type HomeEvidenceListInput,
  type HomeInboxInput,
  type HomeIntakeLinksInput,
  type HomeOrgsInput,
  type HomePlan,
  type HomeReportsInput,
  type HomeTrustSummaryInput,
  type HomeViewModel,
} from "./home-view-model";

export type HomeDataState =
  | { status: "loading"; viewModel: null }
  | { status: "ready"; viewModel: HomeViewModel }
  | { status: "error"; viewModel: HomeViewModel; message: string };

/** State plus a stable reload fn so inline mutations can refresh the view. */
export type HomeData = HomeDataState & { reload: () => void };

export function useHomeData(): HomeData {
  const { plan } = useSurfaceUserContext();
  const workspaceId = useActiveSpaceId();
  const activeSpace = useActiveSpace();
  const activeSpaceType = activeSpace?.type ?? null;
  const orgs = useOrganizations();

  const [state, setState] = useState<HomeDataState>({
    status: "loading",
    viewModel: null,
  });

  const reload = useCallback(async () => {
    setState({ status: "loading", viewModel: null });

    const scoped = (path: string): string =>
      workspaceId
        ? `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(workspaceId)}`
        : path;

    const ccPromise: Promise<HomeCommandCenterInput | null> = workspaceId
      ? apiFetch(scoped("/v1/dashboard/command-center"), { method: "GET" }).catch(
          () => null,
        )
      : Promise.resolve(null);

    const trustPromise: Promise<HomeTrustSummaryInput | null> = workspaceId
      ? apiFetch(scoped("/v1/dashboard/trust-summary"), { method: "GET" }).catch(
          () => null,
        )
      : Promise.resolve(null);

    const billingPromise: Promise<HomeBillingInput | null> = apiFetch(
      "/v1/billing/overview",
      { method: "GET" },
    ).catch(() => null);

    const reportsPromise: Promise<HomeReportsInput | null> = apiFetch(
      scoped("/v1/reports"),
      { method: "GET" },
    ).catch(() => null);

    const intakeLinksPromise: Promise<HomeIntakeLinksInput | null> = workspaceId
      ? apiFetch(scoped("/v1/workflow/intake-links"), { method: "GET" }).catch(
          () => null,
        )
      : Promise.resolve(null);

    const inboxPromise: Promise<HomeInboxInput | null> = apiFetch(
      "/v1/me/inbox?pageSize=50",
      { method: "GET" },
    ).catch(() => null);

    const communicationsPromise: Promise<HomeCommunicationsInput | null> =
      workspaceId
        ? apiFetch(scoped("/v1/communications/messages?purpose=INTAKE_LINK"), {
            method: "GET",
          }).catch(() => null)
        : Promise.resolve(null);

    // Phase HOME-KPI — newest 100 accessible records. User-scoped on
    // the server; the normalizer scopes to the active workspace
    // (personal spaces also accept legacy teamId-null rows). Feeds the
    // KPI sparkline, the activity chart, the type donut and the
    // Recent Evidence card.
    const evidenceListPromise: Promise<HomeEvidenceListInput | null> = apiFetch(
      "/v1/evidence?limit=100&sort=newest",
      { method: "GET" },
    ).catch(() => null);

    const [
      cc,
      trustSummary,
      billing,
      reports,
      intakeLinks,
      inbox,
      communications,
      evidenceList,
    ] = await Promise.all([
      ccPromise,
      trustPromise,
      billingPromise,
      reportsPromise,
      intakeLinksPromise,
      inboxPromise,
      communicationsPromise,
      evidenceListPromise,
    ]);

    const orgsInput: HomeOrgsInput = orgs.map((o) => ({
      id: o.id,
      name: o.name,
      displayName: o.displayName,
      memberCount: o.memberCount ?? 0,
      role: o.role,
      membershipStatus: o.membershipStatus,
    }));

    const viewModel = normalizeHomeViewModel({
      plan: plan as HomePlan,
      workspaceId: workspaceId ?? null,
      workspaceName: activeSpace?.displayName ?? null,
      activeSpaceType,
      commandCenter: cc,
      trustSummary,
      billing,
      reports,
      intakeLinks,
      inbox,
      communications,
      orgs: orgsInput,
      evidenceList,
    });

    setState({ status: "ready", viewModel });
  }, [workspaceId, activeSpaceType, activeSpace?.displayName, plan, orgs]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Phase HOME-RECORDS-BY-TYPE-FIX —
  //
  // Before this hook fix, Home only refetched when its dependency
  // set changed (workspaceId / plan / orgs) or on first mount. The
  // Next.js App Router preserves /home in its router cache, so a
  // user who captures evidence (router.push("/evidence/${id}") on
  // finalize) and later returns to /home is shown the SNAPSHOT from
  // before the capture — the donut, the activity chart, and the
  // Recent Evidence rail all stay stale until a hard refresh. The
  // user-visible symptom is "Records by type stays static after I
  // captured a new image".
  //
  // The minimal robust fix is the standard SWR/React-Query pattern:
  // refetch when the browser tab regains visibility OR window focus,
  // throttled so back-to-back focus events don't hammer the API.
  // No endpoint changes, no schema changes, no classifier changes.
  //
  // 2-second throttle: prevents a focus-then-visibility double-fire
  // and any rapid tab toggling. The data is bounded (≤100 rows of
  // ≤10 fields each) so a stale window of up to 2 s is acceptable.
  const lastReloadAtRef = useRef<number>(0);
  const STALE_WINDOW_MS = 2_000;
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastReloadAtRef.current < STALE_WINDOW_MS) return;
      lastReloadAtRef.current = now;
      void reload();
    };
    // Initial mount sets the marker so the immediate `reload()` above
    // doesn't count against the throttle.
    lastReloadAtRef.current = Date.now();
    document.addEventListener("visibilitychange", maybeRefresh);
    window.addEventListener("focus", maybeRefresh);
    return () => {
      document.removeEventListener("visibilitychange", maybeRefresh);
      window.removeEventListener("focus", maybeRefresh);
    };
  }, [reload]);

  return { ...state, reload };
}
