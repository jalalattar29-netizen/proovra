/**
 * Phase 32.8B — backward-compat redirect.
 *
 * The legacy `/deleted` view is now an evidence filter under
 * `/evidence?filter=deleted` per Phase 32.8A. Existing links and
 * bookmarks resolve here.
 */

import { redirect } from "next/navigation";

export default function DeletedRedirectPage() {
  redirect("/evidence?filter=deleted");
}
