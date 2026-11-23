/**
 * Review hub — "My reviews" (TEAM-SPEC §3).
 *
 * `/review` is the hub's default tab: the keyboard-first console over the
 * Unassigned and Assigned-to-me slices. The hub's other tabs keep their URLs
 * (`/review/queues`, `/reviewer-ops/sla` + `/reviewer-ops/escalations`,
 * `/review/settings`) and `ReviewHubNav` renders each only when it opens for
 * this actor. The per-workflow inspector at `/reviewer-ops/[reviewId]` is
 * still the canonical action surface; the console is the navigation +
 * keyboard layer above it.
 *
 * Gate: `review.queue` — PERSONAL_OR_ORG + `reviewerOperationsIncluded`, so a
 * Team-entitled Personal Workspace opens it (TEAM-SPEC R1).
 */

"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ReviewerConsole } from "../../../components/reviewer-experience/ReviewerConsole";
import {
  ReviewHubNav,
  ReviewToolsPanel,
} from "../../../components/reviewer-experience/ReviewHubNav";
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
      {/* TEAM-UI-SPEC (structure) — banner → header → hub nav → content:
          the console renders its ReviewPageHeader and places the hub nav
          directly under it. */}
      <ReviewerConsole
        teamId={teamId}
        hubNav={<ReviewHubNav active="my-reviews" />}
        onOpenRow={(row) => {
          // Delegate to the existing per-workflow inspector. The
          // inspector is the canonical mutation surface (assign,
          // escalate, decide). Rows are the shared QueueRow, whose
          // `id` IS the workflow id.
          const candidate = row.id || null;
          if (candidate) {
            router.push(`/reviewer-ops/${candidate}`);
          }
        }}
      />
      {/* Phase QC — human quality control over sampled Copilot runs. */}
      <QcSamplingPanel />
      {/* TEAM-UI-SPEC §3 — the advanced review tools, as link rows at the
          bottom (only the tools that open for this actor; nothing when none).
          They replaced the "More review tools" row under the hub tabs. */}
      <ReviewToolsPanel />
    </PageRouteGate>
  );
}
