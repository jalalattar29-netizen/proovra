/**
 * Phase 32.8B — backward-compat redirect.
 *
 * The legacy `/locked` view is now an evidence filter under
 * `/evidence?filter=locked` per Phase 32.8A (evidence list is the
 * single source of truth for evidence states). Existing links and
 * bookmarks resolve here.
 */

import { redirect } from "next/navigation";

export default function LockedRedirectPage() {
  redirect("/evidence?filter=locked");
}
