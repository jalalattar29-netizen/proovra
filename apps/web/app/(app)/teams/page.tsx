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
 */

import { WorkspaceAdminPanel } from "../../../components/workspace-admin/WorkspaceAdminPanel";

export default function TeamsPage() {
  return <WorkspaceAdminPanel />;
}
