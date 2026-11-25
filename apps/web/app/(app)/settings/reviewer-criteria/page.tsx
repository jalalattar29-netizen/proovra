"use client";

/**
 * Settings → Reviewer criteria.
 *
 * Stage D (T-079): where the Review hub opens for this actor (Team and
 * above), reviewer criteria are a section of Review settings, so this URL
 * forwards there. Where it does not (Pro, which authors criteria for the
 * Copilot without reviewer operations), the catalog is shown here as before.
 * Mobile keeps its own screen.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { useReviewDestination } from "../../../../components/reviewer-experience/reviewDestination";
import { ReviewerCriteriaPanel } from "./_panel";

export default function ReviewerCriteriaPage() {
  return (
    <PageRouteGate routeId="workspace.reviewer_criteria">
      <ReviewerCriteriaRoute />
    </PageRouteGate>
  );
}

function ReviewerCriteriaRoute() {
  const router = useRouter();
  const settings = useReviewDestination("review.settings", { label: "Review settings" });
  const forward = settings?.kind === "link";
  useEffect(() => {
    if (forward) router.replace("/review/settings?section=criteria");
  }, [forward, router]);
  if (forward) {
    return (
      <p className="app-field-help" role="status" style={{ padding: 24 }} data-reviewer-criteria-forwarding>
        Opening Review settings…
      </p>
    );
  }
  return <ReviewerCriteriaPanel />;
}
