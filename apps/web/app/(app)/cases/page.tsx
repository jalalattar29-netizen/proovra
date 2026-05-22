/**
 * Phase 32.8D — Cases / Matters index page.
 *
 * Delegates to the new `CasesIndex` component, which renders the
 * enterprise investigation-workspace view sourced from the
 * `/v1/cases/summary` aggregator (read-only, no audit emission).
 */

import { CasesIndex } from "../../../components/cases-experience/CasesIndex";

export default function CasesPage() {
  return <CasesIndex />;
}
