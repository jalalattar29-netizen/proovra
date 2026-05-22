/**
 * Phase 32.8B — backward-compat redirect.
 *
 * Policy administration was consolidated under the Governance domain
 * in Phase 32.8A. The canonical surface is now `/governance/policy`.
 * Existing links and bookmarks resolve here. Functionality is
 * unchanged — the page just moved.
 */

import { redirect } from "next/navigation";

export default function ReviewerOpsPolicyRedirectPage() {
  redirect("/governance/policy");
}
