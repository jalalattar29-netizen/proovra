"use client";

/**
 * RETIRED ROUTE (team remediation T-077, stage D) — Reviewer Workspace →
 * the Review page's FOCUS MODE.
 *
 * `/review/workspace` was a separate page with its own rail, viewer, decision
 * bar, raw enums and a duplicated role chip, beside the Review page's
 * authority. Focus mode is now a layout of the Review page itself
 * (`/reviewer-ops/<id>?mode=focus`): the same decision, preview, coding and
 * step-up components, keyboard shortcuts, and Next item within the Inbox view.
 *
 * A bookmark lands on focus mode for the next review assigned to the viewer
 * (the first row of the Inbox's "Assigned to me" view); with nothing assigned
 * it says so and links to the Inbox. It never decides anything.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { ReviewPageHeader } from "../../../../components/reviewer-experience/ReviewPageHeader";
import { toQueueRows } from "../../../../components/reviewer-experience/queueRow";
import { PageShell } from "../../../../components/ui/PageShell";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { inboxHref, reviewHrefFromInbox } from "../../../../lib/reviewer-workspace/inbox-views";

export default function ReviewerWorkspaceRetired() {
  return (
    <PageRouteGate routeId="workspace.review_workspace">
      <FocusModeRedirect />
    </PageRouteGate>
  );
}

type State = { kind: "finding" } | { kind: "none" } | { kind: "failed"; message: string };

function FocusModeRedirect() {
  const router = useRouter();
  // The router object is not a reason to read again (it is not stable in every host).
  const routerRef = useRef(router);
  routerRef.current = router;
  const teamId = useActiveSpaceId();
  const [state, setState] = useState<State>({ kind: "finding" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setState({ kind: "finding" });
    apiFetch(`/v1/reviewer-ops/queue?teamId=${encodeURIComponent(teamId)}&queue=MY_REVIEWS&limit=1`, { method: "GET" })
      .then((res: { rows?: ReadonlyArray<unknown> } | null) => {
        if (cancelled) return;
        const next = toQueueRows(res?.rows)[0];
        if (next) routerRef.current.replace(reviewHrefFromInbox(next.id, "MY_REVIEWS", { focus: true }));
        else setState({ kind: "none" });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ kind: "failed", message: toSafeUserError(err, { message: "Your next review could not be found." }).message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, attempt]);

  return (
    <PageShell data-review-workspace-redirect header={<ReviewPageHeader title="Focus mode" backToHub />}>
      {state.kind === "finding" ? (
        <p className="app-field-help" role="status" data-focus-redirect-finding>
          Opening your next review in focus mode…
        </p>
      ) : null}
      {state.kind === "none" ? (
        <section className="app-panel">
          <EmptyState
            title="No reviews are assigned to you."
            purpose="Focus mode opens the next review assigned to you. Pick one up from the Inbox."
            action={
              <Link href={inboxHref("UNASSIGNED")} className="app-secondary-action" data-focus-redirect-inbox>
                Open the Inbox
              </Link>
            }
          />
        </section>
      ) : null}
      {state.kind === "failed" ? (
        <div className="app-alert app-alert--danger" role="alert" data-focus-redirect-error>
          {state.message}{" "}
          <button type="button" className="app-secondary-action" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : null}
    </PageShell>
  );
}
