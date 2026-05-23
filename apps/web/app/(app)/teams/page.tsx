/**
 * Phase 32.8E — Workspace Administration index.
 *
 * Delegates to the new `WorkspaceAdminPanel` component, which
 * renders the enterprise workspace administration view sourced
 * from `/v1/teams/workspace-admin` (read-only aggregator, no
 * audit emission).
 *
 * The legacy /teams/[id] detail route + audited mutation endpoints
 * remain unchanged — invitation / role-change / removal flows
 * continue to live there.
 *
 * Phase 38.8 — wrapped in canonical PageRouteGate. `admin.teams` is
 * an ACCOUNT-domain route (NONE active-space) so it loads for every
 * authenticated user.
 */

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { WorkspaceAdministrationHome } from "../../../components/workspace-admin/WorkspaceAdministrationHome";

/**
 * ENTERPRISE TENANT MODEL — /teams renders the canonical Workspace
 * Administration index for every authenticated user. Personal users see
 * their Personal Space card + create-organization CTA; organization
 * members additionally see the per-organization admin panel inline.
 */
export default function TeamsPage() {
  return (
    <PageRouteGate routeId="admin.teams">
      <WorkspaceAdministrationHome />
    </PageRouteGate>
  );
}
