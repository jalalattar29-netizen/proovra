/**
 * RETIRED ROUTE (Team remediation T-007, 2026-11-24) — redirect only.
 *
 * `/review/operations` was the Phase 13 per-evidence review-stage queue: a
 * fourth queue and decision door with no in-product link, whose bulk path had
 * no step-up and answered with a browser alert box. There is one review inbox now. A
 * bookmarked or shared link keeps working: it lands on the Inbox, on the queue
 * that matches the stage filter it carried (`?stage=`), when there is one.
 *
 * The API it used (`/v1/review-operations/{queue,queue-counts,bulk}`) stays for
 * the Evidence page and older clients.
 */
import { redirect } from "next/navigation";

import { reviewOperationsRedirectTarget } from "../../../../lib/navigation/review-operations-redirect";

export default async function ReviewOperationsRetired({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  redirect(reviewOperationsRedirectTarget((await searchParams) ?? {}));
}
