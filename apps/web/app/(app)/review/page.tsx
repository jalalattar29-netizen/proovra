/**
 * Phase 32.8B — backward-compat redirect.
 *
 * The legacy Phase 7 `/review` queue surface was superseded by
 * `/reviewer-ops` in Phase 32.8A. Existing links and bookmarks
 * resolve here. The `/review/operations` sub-route keeps its
 * own page for now and will be folded into `/ops` during
 * Phase 32.8C.
 */

import { redirect } from "next/navigation";

export default function ReviewRedirectPage() {
  redirect("/reviewer-ops");
}
