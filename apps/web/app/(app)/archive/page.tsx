/**
 * Phase 32.8B — backward-compat redirect.
 *
 * The legacy `/archive` view is now an evidence filter under
 * `/evidence?filter=archived` per Phase 32.8A. Existing links and
 * bookmarks resolve here.
 */

import { redirect } from "next/navigation";

export default function ArchiveRedirectPage() {
  redirect("/evidence?filter=archived");
}
