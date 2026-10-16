/**
 * Phase 32.8D — Reports & Artifacts enterprise index.
 *
 * Delegates to `ReportsIndex`, which renders the artifact lifecycle /
 * deliverables system sourced from `/v1/reports/artifacts` (read-only
 * aggregator, side-effect-free).
 *
 * Phase 38.7 — wrapped in canonical PageRouteGate so access denial renders a
 * structured state via the canonical registry + resolver.
 *
 * NO PLAN NOTICE ABOVE THE PAGE (2026-08-27). Every plan renders the same
 * shell; report generation and downloads stay gated by the backend and the
 * row-level controls read the server-projected capability.
 *
 * 2026-10-16 — the filters live in the URL (`useSearchParams`), so the index
 * renders inside a Suspense boundary, as the App Router requires.
 */
"use client";

import { Suspense } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ReportsIndex } from "../../../components/reports-experience/ReportsIndex";

export default function ReportsPage() {
  return (
    <PageRouteGate routeId="workspace.reports">
      <Suspense fallback={null}>
        <ReportsIndex />
      </Suspense>
    </PageRouteGate>
  );
}
