/**
 * Phase IA-self-serve-home-rebuild — Home data hook.
 *
 * Orchestrates the four existing endpoints the self-serve Home consumes
 * and feeds them into the `home-view-model.ts` normalizer. This is the
 * ONLY data-fetching surface on Home — every section component reads
 * from the returned `viewModel`.
 *
 * Endpoints (all pre-existing — no new APIs introduced):
 *   1. GET /v1/dashboard/command-center?teamId=<id>
 *      — fetched ONLY for the slice of sections the normalizer
 *        allows through. If the workspace ID is missing or the
 *        request fails, the view model gracefully degrades to empty
 *        lists and the storage/billing slice still renders.
 *   2. GET /v1/billing/overview
 *      — storage usage label + percent. We tolerate a 4xx so a FREE
 *        user without billing setup still sees the rest of the home.
 *   3. GET /v1/reports
 *      — user-scoped report list (added by the Phase IA self-serve
 *        regression fix). Falls back to empty array on failure.
 *   4. envelope.organizations
 *      — team activity for PRO/TEAM (read straight from the
 *        platform-context envelope; no fetch needed).
 *
 * Behaviour:
 *   * Failures are PARTIAL — one slice failing doesn't blank the whole
 *     dashboard. Each fetch is independent.
 *   * The hook fetches once on mount and re-fetches when the workspace
 *     id changes. No polling.
 */

"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import {
  useActiveSpaceId,
  useOrganizations,
} from "../../lib/platform-context";
import { useSurfaceUserContext } from "../../lib/surface/useSurfaceUserContext";

import {
  normalizeHomeViewModel,
  type HomeBillingInput,
  type HomeCommandCenterInput,
  type HomeOrgsInput,
  type HomePlan,
  type HomeReportsInput,
  type HomeViewModel,
} from "./home-view-model";

export type HomeDataState =
  | { status: "loading"; viewModel: null }
  | { status: "ready"; viewModel: HomeViewModel }
  | { status: "error"; viewModel: HomeViewModel; message: string };

type ErrorWithStatus = { statusCode?: number; message?: string };

export function useHomeData(): HomeDataState {
  const { plan } = useSurfaceUserContext();
  // Workspace id is resolved through the canonical tenancy helper.
  const workspaceId = useActiveSpaceId();
  const orgs = useOrganizations();

  const [state, setState] = useState<HomeDataState>({
    status: "loading",
    viewModel: null,
  });

  const reload = useCallback(async () => {
    setState({ status: "loading", viewModel: null });

    // Fan out — every fetch is independent so a single failure can't
    // mask the rest of the dashboard.
    const ccPromise: Promise<HomeCommandCenterInput | null> = workspaceId
      ? apiFetch(
          `/v1/dashboard/command-center?teamId=${encodeURIComponent(
            workspaceId,
          )}`,
          { method: "GET" },
        ).catch(() => null)
      : Promise.resolve(null);

    const billingPromise: Promise<HomeBillingInput | null> = apiFetch(
      "/v1/billing/overview",
      { method: "GET" },
    ).catch((err: ErrorWithStatus) => {
      // A FREE user whose billing setup hasn't been touched yet may
      // see 404 here — that's not a hard error; just no storage card.
      if (err?.statusCode === 401 || err?.statusCode === 403) return null;
      return null;
    });

    const reportsPromise: Promise<HomeReportsInput | null> = apiFetch(
      "/v1/reports",
      { method: "GET" },
    ).catch(() => null);

    const [cc, billing, reports] = await Promise.all([
      ccPromise,
      billingPromise,
      reportsPromise,
    ]);

    // Project envelope.organizations to the normalizer-accepted shape.
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
      commandCenter: cc,
      billing,
      reports,
      orgs: orgsInput,
    });

    setState({ status: "ready", viewModel });
  }, [workspaceId, plan, orgs]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return state;
}
