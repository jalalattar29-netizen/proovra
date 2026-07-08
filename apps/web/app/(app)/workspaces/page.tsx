/**
 * Phase G0 (B0.5) — Canonical /workspaces frontend route.
 *
 * Renders the `WorkspaceAdministrationHome` component. Route reality:
 *
 *   * /workspaces — canonical workspace-admin landing (sidebar +
 *     breadcrumbs + topbar point here).
 *   * /teams — the bare landing page was DELETED; next.config.js now
 *     redirects /teams -> /collaboration-teams. Only the
 *     /teams/[id] detail route is kept.
 *
 * The backend `/v1/teams/*` endpoints remain unchanged; renaming
 * those is a backend-tier migration deferred to a later phase.
 *
 * Phase 38.8 — wrapped in canonical PageRouteGate. `admin.teams`
 * is an ACCOUNT-domain route (NONE active-space) so it loads for
 * every authenticated user.
 */

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { WorkspaceAdministrationHome } from "../../../components/workspace-admin/WorkspaceAdministrationHome";
import { OperationalBreadcrumb } from "../../../components/navigation/OperationalBreadcrumb";

export default function WorkspacesPage() {
  return (
    <PageRouteGate routeId="admin.teams">
      <>
        <OperationalBreadcrumb
          routeId="admin.teams"
          items={[{ label: "Workspaces" }]}
        />
        <WorkspaceAdministrationHome />
      </>
    </PageRouteGate>
  );
}
