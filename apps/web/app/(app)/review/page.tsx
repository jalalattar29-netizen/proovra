/**
 * Phase C0 — Canonical reviewer workspace.
 *
 * `/review` is the new operational reviewer surface. It consolidates
 * the fragmented `/reviewer-ops`, `/reviewer-ops/escalations`,
 * `/reviewer-ops/sla` surfaces into a single keyboard-first console
 * (Queue · Mine · Escalations · SLA · Workload).
 *
 * The legacy `/reviewer-ops*` routes are NOT removed in C0 — they
 * continue to work, and the per-workflow inspector at
 * `/reviewer-ops/[reviewId]` is still the canonical action surface.
 * The console here is the navigation + keyboard layer above them.
 */

"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ReviewerConsole } from "../../../components/reviewer-experience/ReviewerConsole";
import { usePlatformContext } from "../../../lib/platform-context/PlatformContextProvider";
// PHASE 7 §10.5 — owning-context banner (the console + inspector already
// re-scope on switch via their teamId-keyed reload).
import { WorkspaceContextBanner } from "../../../lib/platform-context/WorkspaceContextBanner";
import { QcSamplingPanel } from "../../../components/ai-copilot/QcSamplingPanel";

export default function ReviewPage() {
  const router = useRouter();
  const ctx = usePlatformContext();

  const teamId = useMemo<string | null>(() => {
    if (ctx.state.name !== "READY") return null;
    const e = ctx.state.envelope;
    if (e.activeSpace?.type === "ORGANIZATION") return e.activeSpace.id;
    if (e.activeSpace?.type === "PERSONAL") return e.activeSpace.id;
    // Legacy fallback while the `ctx.workspace` envelope field is
    // still emitted (Phase B0). Once frontend migration off the
    // legacy field lands (B0.1), this branch can be removed.
    if (e.workspace?.id) return e.workspace.id;
    return null;
  }, [ctx.state]);

  return (
    <PageRouteGate routeId="review.queue">
      <WorkspaceContextBanner action="Reviewing evidence in" />
      <ReviewerConsole
        teamId={teamId}
        onOpenRow={(row) => {
          // Delegate to the existing per-workflow inspector. The
          // inspector is the canonical mutation surface (assign,
          // escalate, decide). The console is a navigation +
          // keyboard layer above it.
          const candidate =
            (row as { workflowId?: string | null }).workflowId ??
            (row as { id?: string }).id ??
            null;
          if (candidate) {
            router.push(`/reviewer-ops/${candidate}`);
          }
        }}
      />
      {/* Phase QC — human quality control over sampled Copilot runs. */}
      <QcSamplingPanel />
    </PageRouteGate>
  );
}
