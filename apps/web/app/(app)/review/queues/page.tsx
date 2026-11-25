/**
 * RETIRED ROUTE (team remediation T-065, stage D) — redirect only.
 *
 * `/review/queues` was a second review list beside the "My reviews" console,
 * with its own labels and a Queues tab that carried any `?queue=`. There is one
 * Inbox now: a bookmarked or shared link lands on the same view there
 * (`/review/queues?queue=OVERDUE` → `/review?view=OVERDUE`).
 */
import { redirect } from "next/navigation";

import { reviewQueuesRedirectTarget } from "../../../../lib/reviewer-workspace/inbox-views";

export default async function ReviewQueuesRetired({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  redirect(reviewQueuesRedirectTarget((await searchParams) ?? {}));
}
