/**
 * PHASE 38.12 — `/reviewer-ops/queue` canonical queue-anchored entry.
 *
 * `review.queue_detail` is the per-review workspace surface (lifecycle,
 * SLA, escalation, action surface). The runtime page lives at the
 * dynamic `[reviewId]` path; this index acts as the queue-anchored
 * landing that operators reach via the canonical reviewer console.
 * It redirects to the canonical reviewer console at `/review` so a
 * direct URL hit always resolves to the operator-facing queue rather
 * than a 404.
 */
import { redirect } from "next/navigation";

export default function ReviewerOpsQueueIndex(): never {
  redirect("/review");
}
