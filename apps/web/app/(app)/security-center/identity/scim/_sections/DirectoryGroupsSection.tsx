"use client";

/**
 * Members audit DOM-13 — the Organization's DIRECTORY GROUPS and where each
 * one applies.
 *
 * SCIM groups belong to the Organization, not to the workspace this console
 * was opened from. A group applies to a workspace through a PROJECTION, which
 * carries the role the group grants there. This section lists every group of
 * the Organization with its projections, and lets an Organization identity
 * administrator add a projection to another workspace or end one.
 *
 *   GET    /v1/admin/identity/scim/groups?teamId=…
 *   POST   /v1/admin/identity/scim/groups/:id/projections   { teamId, workspaceId, mappedRole }
 *   DELETE /v1/admin/identity/scim/groups/projections/:id   { teamId }
 *
 * Both writes go through the same step-up flow the token actions use. The
 * workspaces offered are the Organization's own list (GET /v1/orgs/:id/
 * workspaces), and whether the viewer may manage is read from their
 * Organization role (GET /v1/orgs/:id → callerRole). Both are PRESENTATION
 * only: the server refuses regardless, and its refusal is shown in the
 * registered copy through toSafeUserError.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import {
  useActiveCustomerOrganizationId,
  useTenantGuard,
} from "../../../../../../lib/platform-context";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../../components/identity-security/StepUpModal";
import { useConfirmAction } from "../../../../../../components/ui/ConfirmActionModal";
import { AdmInline } from "../../../../../../components/admin/AdminSurfaces";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import {
  scimGroupRoleLabel,
  workspaceRoleLabel,
} from "../../../../../../lib/labels/identityOrgLabels";

type ProjectionRole = "ADMIN" | "MEMBER" | "VIEWER";
const PROJECTION_ROLES: readonly ProjectionRole[] = ["ADMIN", "MEMBER", "VIEWER"];

type ScimGroupProjection = {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  mappedRole: string;
  status: string;
};

type ScimDirectoryGroup = {
  id: string;
  displayName: string;
  externalId: string | null;
  mappedRole: string;
  status: string;
  projections: ScimGroupProjection[];
};

type OrgWorkspace = { workspaceId: string; name: string | null };

/** The Organization roles that may change SSO and directory provisioning. */
const ORGANIZATION_IDENTITY_ROLES = new Set([
  "ORG_OWNER",
  "ORG_ADMIN",
  "ORG_SECURITY_ADMIN",
]);

const NOT_IDENTITY_ADMIN_REASON =
  "Only an organization owner, admin or security admin can change where directory groups apply.";
const NO_ORGANIZATION_REASON =
  "Directory groups apply across the workspaces of a customer organization, and this workspace is not part of one.";

type Management =
  | { kind: "loading" }
  | { kind: "allowed"; workspaces: OrgWorkspace[] }
  | { kind: "denied"; reason: string };

function workspaceLabel(name: string | null): string {
  return name && name.trim() ? name : "Unnamed workspace";
}

export function DirectoryGroupsSection({ teamId }: { teamId: string }) {
  const organizationId = useActiveCustomerOrganizationId();
  const stepUp = useStepUpAction({ teamId });
  const { confirm } = useConfirmAction();
  const { stamp, isStale } = useTenantGuard();

  const [groups, setGroups] = useState<ScimDirectoryGroup[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [management, setManagement] = useState<Management>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [draftWorkspace, setDraftWorkspace] = useState("");
  const [draftRole, setDraftRole] = useState<ProjectionRole>("MEMBER");

  const loadGroups = useCallback(async () => {
    const captured = stamp();
    try {
      const r = (await apiFetch(
        `/v1/admin/identity/scim/groups?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { groups?: ScimDirectoryGroup[] };
      if (isStale(captured)) return;
      setGroups(r.groups ?? []);
      setLoadError(null);
    } catch (err) {
      if (isStale(captured)) return;
      setGroups([]);
      setLoadError(
        toSafeUserError(err, { message: "Could not load directory groups." }).message,
      );
    }
  }, [teamId, stamp, isStale]);

  const loadManagement = useCallback(async () => {
    if (!organizationId) {
      setManagement({ kind: "denied", reason: NO_ORGANIZATION_REASON });
      return;
    }
    const captured = stamp();
    try {
      const [org, list] = (await Promise.all([
        apiFetch(`/v1/orgs/${encodeURIComponent(organizationId)}`, { method: "GET" }),
        apiFetch(`/v1/orgs/${encodeURIComponent(organizationId)}/workspaces`, {
          method: "GET",
        }),
      ])) as [
        { callerRole?: string | null },
        { workspaces?: Array<{ workspaceId: string; name: string | null; isPersonal?: boolean }> },
      ];
      if (isStale(captured)) return;
      if (!org.callerRole || !ORGANIZATION_IDENTITY_ROLES.has(org.callerRole)) {
        setManagement({ kind: "denied", reason: NOT_IDENTITY_ADMIN_REASON });
        return;
      }
      setManagement({
        kind: "allowed",
        workspaces: (list.workspaces ?? [])
          .filter((w) => !w.isPersonal)
          .map((w) => ({ workspaceId: w.workspaceId, name: w.name })),
      });
    } catch {
      if (isStale(captured)) return;
      // Not an Organization member (or the Organization is unreadable): the
      // viewer cannot manage, whatever the reason the read was refused.
      setManagement({ kind: "denied", reason: NOT_IDENTITY_ADMIN_REASON });
    }
  }, [organizationId, stamp, isStale]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);
  useEffect(() => {
    void loadManagement();
  }, [loadManagement]);

  const canManage = management.kind === "allowed";
  const manageReason =
    management.kind === "denied"
      ? management.reason
      : management.kind === "loading"
        ? "Checking your organization role…"
        : null;

  const openAdd = (groupId: string) => {
    setAddingTo(groupId);
    setDraftWorkspace("");
    setDraftRole("MEMBER");
    setError(null);
    setNotice(null);
  };

  const addProjection = useCallback(
    async (group: ScimDirectoryGroup) => {
      if (!draftWorkspace) return;
      setBusy(`add:${group.id}`);
      setError(null);
      setNotice(null);
      const captured = stamp();
      try {
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/admin/identity/scim/groups/${encodeURIComponent(group.id)}/projections`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({
                teamId,
                workspaceId: draftWorkspace,
                mappedRole: draftRole,
              }),
            },
          ),
        );
        if (isStale(captured)) return;
        setAddingTo(null);
        await loadGroups();
        setNotice(`${group.displayName} now applies to the chosen workspace.`);
      } catch (err) {
        if (isStale(captured)) return;
        const code = (err as { code?: string })?.code;
        setError(
          code === "STEP_UP_CANCEL"
            ? "Step-up cancelled — the group was not applied to that workspace."
            : toSafeUserError(err, {
                message: "Could not apply the group to that workspace.",
              }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, draftWorkspace, draftRole, stepUp, loadGroups, stamp, isStale],
  );

  const endProjection = useCallback(
    async (group: ScimDirectoryGroup, projection: ScimGroupProjection) => {
      const ok = await confirm({
        title: "Stop applying this group to the workspace?",
        description: `${group.displayName} stops granting a role in ${workspaceLabel(
          projection.workspaceName,
        )}. Members who hold that role only through this group lose it there; their accounts and evidence are kept.`,
        confirmLabel: "End projection",
        tone: "danger",
        testId: "scim-group-projection-end",
      });
      if (!ok) return;
      setBusy(projection.id);
      setError(null);
      setNotice(null);
      const captured = stamp();
      try {
        const res = (await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/admin/identity/scim/groups/projections/${encodeURIComponent(projection.id)}`,
            {
              method: "DELETE",
              headers: { "content-type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({ teamId }),
            },
          ),
        )) as { demoted?: number } | null;
        if (isStale(captured)) return;
        await loadGroups();
        const demoted = typeof res?.demoted === "number" ? res.demoted : null;
        setNotice(
          demoted === null
            ? "Projection ended."
            : `Projection ended. ${demoted} member${demoted === 1 ? "" : "s"} lost the role it granted.`,
        );
      } catch (err) {
        if (isStale(captured)) return;
        const code = (err as { code?: string })?.code;
        setError(
          code === "STEP_UP_CANCEL"
            ? "Step-up cancelled — the projection is still in place."
            : toSafeUserError(err, { message: "Could not end the projection." }).message,
        );
      } finally {
        setBusy(null);
      }
    },
    [teamId, confirm, stepUp, loadGroups, stamp, isStale],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="scim-groups">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <p className="adm-help" style={{ maxWidth: 720, margin: 0 }}>
          Groups your identity provider pushes belong to your organization. Each
          one applies to the workspaces listed under it, with the role it grants
          there.
        </p>
        <Button variant="secondary" onClick={() => void loadGroups()}>
          Refresh
        </Button>
      </div>

      {manageReason && management.kind === "denied" ? (
        <p className="adm-help" data-testid="scim-groups-manage-reason" style={{ margin: 0 }}>
          {manageReason}
        </p>
      ) : null}
      {error ? <AdmInline state="error">{error}</AdmInline> : null}
      {notice ? <AdmInline state="done">{notice}</AdmInline> : null}
      {loadError ? <AdmInline state="error">{loadError}</AdmInline> : null}

      {groups === null ? (
        <Card variant="summary" padding="comfortable">
          <p className="adm-help">Loading directory groups…</p>
        </Card>
      ) : groups.length === 0 && !loadError ? (
        <EmptyState
          variant="inline"
          framed
          title="No directory groups yet"
          purpose="Once your identity provider pushes groups over SCIM, each one appears here with the workspaces it applies to."
        />
      ) : (
        groups.map((g) => {
          const groupActive = g.status === "ACTIVE";
          const liveWorkspaces = new Set(
            g.projections.filter((p) => p.status === "ACTIVE").map((p) => p.workspaceId),
          );
          const options =
            management.kind === "allowed"
              ? management.workspaces.filter((w) => !liveWorkspaces.has(w.workspaceId))
              : [];
          const addDisabledReason = !canManage
            ? manageReason
            : !groupActive
              ? "This group has been archived by your identity provider."
              : null;
          const formId = `scim-group-add-${g.id}`;
          return (
            <Card
              key={g.id}
              variant="admin"
              padding="comfortable"
              data-testid="scim-group"
              data-group-id={g.id}
            >
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 14 }}>{g.displayName}</strong>
                <Badge tone={groupActive ? "governance" : "neutral"} subtle>
                  {groupActive ? "Active" : "Archived"}
                </Badge>
                <span className="adm-help">
                  grants {workspaceRoleLabel(g.mappedRole).toLowerCase()} by default
                </span>
                <span style={{ marginInlineStart: "auto" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={addDisabledReason !== null}
                    title={addDisabledReason ?? undefined}
                    aria-expanded={addingTo === g.id}
                    aria-controls={formId}
                    onClick={() => (addingTo === g.id ? setAddingTo(null) : openAdd(g.id))}
                  >
                    Apply to a workspace
                  </Button>
                </span>
              </div>

              {g.projections.length === 0 ? (
                <p className="adm-help" style={{ margin: 0 }}>
                  This group does not apply to any workspace yet.
                </p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="adm-table" aria-label={`Workspaces for ${g.displayName}`}>
                    <thead>
                      <tr>
                        <th>Workspace</th>
                        <th>Role granted</th>
                        <th>Status</th>
                        <th>{" "}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.projections.map((p) => {
                        const live = p.status === "ACTIVE";
                        return (
                          <tr key={p.id} data-projection-id={p.id}>
                            <td>{workspaceLabel(p.workspaceName)}</td>
                            <td>{workspaceRoleLabel(p.mappedRole)}</td>
                            <td>
                              <Badge tone={live ? "verified" : "neutral"} subtle>
                                {live ? "Applied" : "Ended"}
                              </Badge>
                            </td>
                            <td>
                              {live ? (
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  disabled={!canManage || busy === p.id}
                                  title={canManage ? undefined : manageReason ?? undefined}
                                  onClick={() => void endProjection(g, p)}
                                >
                                  {busy === p.id ? "Ending…" : "End"}
                                </Button>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {addingTo === g.id && canManage ? (
                <section
                  id={formId}
                  aria-label={`Apply ${g.displayName} to a workspace`}
                  style={{
                    marginTop: 12,
                    display: "flex",
                    gap: 12,
                    flexWrap: "wrap",
                    alignItems: "flex-end",
                  }}
                >
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span>Workspace</span>
                    <select
                      className="adm-select"
                      value={draftWorkspace}
                      onChange={(e) => setDraftWorkspace(e.target.value)}
                    >
                      <option value="">Choose a workspace</option>
                      {options.map((w) => (
                        <option key={w.workspaceId} value={w.workspaceId}>
                          {workspaceLabel(w.name)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span>Role it grants there</span>
                    <select
                      className="adm-select"
                      value={draftRole}
                      onChange={(e) => setDraftRole(e.target.value as ProjectionRole)}
                    >
                      {PROJECTION_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {scimGroupRoleLabel(r)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="enterprise"
                    size="sm"
                    loading={busy === `add:${g.id}`}
                    disabled={!draftWorkspace || busy === `add:${g.id}`}
                    title={draftWorkspace ? undefined : "Choose a workspace first."}
                    onClick={() => void addProjection(g)}
                  >
                    Apply group
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setAddingTo(null)}>
                    Cancel
                  </Button>
                  {options.length === 0 ? (
                    <p className="adm-help" style={{ margin: 0, flexBasis: "100%" }}>
                      This group already applies to every workspace of your organization.
                    </p>
                  ) : null}
                </section>
              ) : null}
            </Card>
          );
        })
      )}

      <StepUpModal control={stepUp} />
    </div>
  );
}
