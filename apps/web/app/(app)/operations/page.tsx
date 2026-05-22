/**
 * Phase 32.8B — backward-compat redirect.
 *
 * The legacy `/operations` namespace overlapped with `/ops`
 * (Platform Health). Phase 32.8A consolidated all platform-health
 * surfaces under `/ops`. `/operations/reliability` retains its
 * own page until Phase 32.8C migrates it.
 */

import { redirect } from "next/navigation";

export default function OperationsRedirectPage() {
  redirect("/ops");
}
