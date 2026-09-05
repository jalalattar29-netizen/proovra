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
import { usePlatformContext } from "../../lib/platform-context/PlatformContextProvider";

import {
  normalizeHomeViewModel,
  type HomeBillingInput,
  type HomeCommandCenterInput,
  type HomeCommunicationsInput,
  type HomeEvidenceListInput,
  type HomeInboxInput,
  type HomeOperationsSummaryInput,
  type HomeIntakeLinksInput,
  type HomeOrgsInput,
  type HomePlan,
  type HomeReportsInput,
  type HomeTrustSummaryInput,
  type HomeRecordsByTypeInput,
  type HomeSliceKey,
  type HomeViewModel,
} from "./home-view-model";

export type HomeDataState =
  | { status: "loading"; viewModel: null }
  | { status: "ready"; viewModel: HomeViewModel }
  | { status: "error"; viewModel: HomeViewModel; message: string };

/** State plus a stable reload fn so inline mutations can refresh the view. */
export type HomeData = HomeDataState & { reload: () => void };

export function useHomeData(): HomeData {
  // PHASE 12B Track 1A — the surface context no longer carries a plan name.
  // The DISPLAY plan label + the SERVER-projected entitlements come straight
  // from the canonical envelope; the view model decides entitlements from
  // `planFeatures` booleans only.
  const platformCtx = usePlatformContext();
  const envelope = platformCtx?.envelope ?? null;
  const activeSpaceForPlan = envelope?.activeSpace ?? null;
  const plan =
    activeSpaceForPlan?.type === "PERSONAL"
      ? envelope?.personalSpace?.plan ?? envelope?.account?.accountPlan ?? null
      : activeSpaceForPlan?.type === "ORGANIZATION"
        ? envelope?.organizations?.find((o) => o.id === activeSpaceForPlan.id)?.plan ?? null
        : null;
  const planFeatures = envelope?.planFeatures ?? null;
  const workspaceId = useActiveSpaceId();
  const activeSpace = useActiveSpace();
  const activeSpaceType = activeSpace?.type ?? null;
  const orgs = useOrganizations();
  // Read `orgs` through a ref inside `reload` so the callback's identity
  // does NOT change on every render when `useOrganizations()` returns a
  // fresh array reference — which would otherwise re-fire the mount effect
  // and refetch the whole dashboard on every render.
  const orgsRef = useRef(orgs);
  orgsRef.current = orgs;

  const [state, setState] = useState<HomeDataState>({
    status: "loading",
    viewModel: null,
  });

  /*
   * Which reload is current. Incremented at the start of every run so a
   * response from a superseded one — a previous workspace, or a refresh that
   * has already been replaced — is discarded rather than published.
   */
  const runIdRef = useRef(0);

  const reload = useCallback(async () => {
    // KEEP-PREVIOUS-DATA — only show the full-page skeleton on the FIRST
    // load (no prior view-model). Every subsequent refresh (dependency
    // change, or the throttled focus/visibility revalidation below) keeps
    // the current dashboard on screen and swaps in fresh data when it
    // arrives — so returning to /home never blanks to a skeleton or
    // "reloads" the whole page. Background GETs only; no mutations, no
    // upload/finalize/report side effects run from Home.
    setState((prev) =>
      prev.viewModel ? prev : { status: "loading", viewModel: null },
    );

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

    // Phase HOME-RECORDS-BY-TYPE — workspace-aggregated donut counts.
    // Returns { records, files } where `records` counts Evidence rows
    // and `files` counts EvidencePart rows, both excluding soft-deleted.
    // Partial-failure tolerant: if the request fails the view-model uses
    // the latest-100 sample classifier for records (disclosed via
    // `source`) and hides `preservedFilesByType` (no parts sample exists).
    const recordsByTypePromise: Promise<HomeRecordsByTypeInput | null> =
      workspaceId
        ? apiFetch(scoped("/v1/dashboard/records-by-type"), {
            method: "GET",
          }).catch(() => null)
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

    /**
     * ATTENTION ARCHITECTURE PHASE 4C (2026-08-22) — THE canonical workspace
     * Operations summary.
     *
     * Home used to answer "how healthy is this workspace?" from
     * `/v1/me/inbox` above, through `buildOperationalQueue()`. That read ONE
     * PERSON'S notification feed and reported it as the WORKSPACE'S state, so
     * archiving a notification lowered the workspace's issue count.
     *
     * This reads shared operational truth instead. On failure it resolves to
     * null, and the view model turns that into an explicit "unavailable" —
     * it never falls back to the feed, because a substituted health number is
     * worse than an absent one. A 403 (no Operations capability here) lands
     * on the same path for the same reason.
     */
    const operationsSummaryPromise: Promise<HomeOperationsSummaryInput | null> =
      workspaceId
        ? apiFetch(
            `/v1/ops/summary?teamId=${encodeURIComponent(workspaceId)}`,
            { method: "GET" },
          )
            .then((res) =>
              (res as { summary?: HomeOperationsSummaryInput } | null)
                ?.summary ?? null,
            )
            .catch(() => null)
        : Promise.resolve(null);

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

    /*
     * NO BARRIER.
     *
     * These ten reads start together and used to be awaited together, so the
     * page rendered nothing until the SLOWEST of them returned. Measured on
     * the local fixture in an organization workspace, every read but one had
     * settled by 925ms and the barrier held until 1173ms — a quarter of
     * Home's data phase spent waiting for one endpoint with everything else
     * already in hand.
     *
     * Each response now publishes as it lands. The slices still in flight
     * travel with the view model as `loadingSlices`, which is what makes this
     * safe: an earlier attempt at progressive publishing was reverted because
     * a slice that had not arrived rendered as UNAVAILABLE, and telling an
     * operator their Operations status could not be loaded — about a healthy
     * workspace, for the moment before it arrives — is worse than making them
     * wait. The view model can now say "not yet", so it does.
     *
     * ONE REQUEST EACH. This is not a per-field effect: the promises are the
     * same ten already created above, and each is subscribed to exactly once.
     */
    const settled: {
      cc: HomeCommandCenterInput | null;
      trustSummary: HomeTrustSummaryInput | null;
      billing: HomeBillingInput | null;
      reports: HomeReportsInput | null;
      intakeLinks: HomeIntakeLinksInput | null;
      inbox: HomeInboxInput | null;
      communications: HomeCommunicationsInput | null;
      evidenceList: HomeEvidenceListInput | null;
      recordsByType: HomeRecordsByTypeInput | null;
      operationsSummary: HomeOperationsSummaryInput | null;
    } = {
      cc: null,
      trustSummary: null,
      billing: null,
      reports: null,
      intakeLinks: null,
      inbox: null,
      communications: null,
      evidenceList: null,
      recordsByType: null,
      operationsSummary: null,
    };

    const pending = new Set<HomeSliceKey>([
      "commandCenter",
      "trustSummary",
      "billing",
      "reports",
      "intakeLinks",
      "inbox",
      "communications",
      "evidenceList",
      "recordsByType",
      "operationsSummary",
    ]);

    /*
     * A STALE RUN MUST NOT PUBLISH.
     *
     * Switching workspace starts a new run while the old one still has
     * responses in flight. Without this, a slow read from the PREVIOUS
     * workspace would land after the switch and overwrite the new one's data
     * — cross-workspace contamination on a page whose entire job is to be
     * about one workspace.
     */
    const runId = ++runIdRef.current;

    const publish = () => {
      if (runId !== runIdRef.current) return;
      const orgsInput: HomeOrgsInput = orgsRef.current.map((o) => ({
        id: o.id,
        name: o.name,
        displayName: o.displayName,
        memberCount: o.memberCount ?? 0,
        role: o.role,
        membershipStatus: o.membershipStatus,
      }));

      const viewModel = normalizeHomeViewModel({
        plan: plan as HomePlan,
        planFeatures,
        workspaceId: workspaceId ?? null,
        workspaceName: activeSpace?.displayName ?? null,
        activeSpaceType,
        commandCenter: settled.cc,
        trustSummary: settled.trustSummary,
        billing: settled.billing,
        reports: settled.reports,
        intakeLinks: settled.intakeLinks,
        inbox: settled.inbox,
        communications: settled.communications,
        orgs: orgsInput,
        evidenceList: settled.evidenceList,
        recordsByType: settled.recordsByType,
        // PHASE 4C — CONSUMED, never derived. null means unavailable, and the
        // view model renders that honestly rather than substituting the feed.
        operationsSummary: settled.operationsSummary,
        loadingSlices: new Set(pending),
      });

      setState({ status: "ready", viewModel });
    };

    const track = <K extends HomeSliceKey, V>(
      key: K,
      promise: Promise<V>,
      assign: (value: V) => void,
    ): Promise<void> =>
      promise.then((value) => {
        if (runId !== runIdRef.current) return;
        assign(value);
        pending.delete(key);
        publish();
      });

    await Promise.all([
      track("commandCenter", ccPromise, (v) => {
        settled.cc = v;
      }),
      track("trustSummary", trustPromise, (v) => {
        settled.trustSummary = v;
      }),
      track("billing", billingPromise, (v) => {
        settled.billing = v;
      }),
      track("reports", reportsPromise, (v) => {
        settled.reports = v;
      }),
      track("intakeLinks", intakeLinksPromise, (v) => {
        settled.intakeLinks = v;
      }),
      track("inbox", inboxPromise, (v) => {
        settled.inbox = v;
      }),
      track("communications", communicationsPromise, (v) => {
        settled.communications = v;
      }),
      track("evidenceList", evidenceListPromise, (v) => {
        settled.evidenceList = v;
      }),
      track("recordsByType", recordsByTypePromise, (v) => {
        settled.recordsByType = v;
      }),
      track("operationsSummary", operationsSummaryPromise, (v) => {
        settled.operationsSummary = v;
      }),
    ]);

    // `orgs` is intentionally read via `orgsRef` (not a dep) so this
    // callback stays referentially stable across renders.
  }, [workspaceId, activeSpaceType, activeSpace?.displayName, plan, planFeatures]);

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
