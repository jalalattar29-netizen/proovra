/**
 * Phase 32.8B — backward-compat redirect.
 *
 * The legacy `/security` surface was consolidated with the
 * platform `/security-center` per Phase 32.8A (Platform Health
 * domain). Existing links and bookmarks resolve here.
 */

import { redirect } from "next/navigation";

export default function SecurityRedirectPage() {
  redirect("/security-center");
}
