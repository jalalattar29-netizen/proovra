/**
 * Phase 32.8B — backward-compat redirect.
 *
 * `/dashboard` was the legacy operator landing surface. Phase 32.8A
 * consolidated it under `/home` (the canonical workspace landing).
 * Existing links, browser bookmarks, and external references are
 * preserved by this redirect.
 *
 * Sub-routes (`/dashboard/api-keys`, `/dashboard/batch-analysis`,
 * `/dashboard/insights`, `/dashboard/quotas`) keep their existing
 * pages until Phase 32.8C migrates them into their canonical homes
 * (Billing / Home). No functionality is removed by this redirect.
 */

import { redirect } from "next/navigation";

export default function DashboardRedirectPage() {
  redirect("/home");
}
