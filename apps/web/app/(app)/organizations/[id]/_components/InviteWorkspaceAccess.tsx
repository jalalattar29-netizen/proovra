"use client";

/**
 * WHERE THE INVITED PERSON WILL WORK.
 *
 * An organization role governs the organization. It grants no evidence, cases or
 * queues: those are workspace-scoped, so an invitation that names no workspace
 * lands the person on "Workspace setup required" with nothing to open. The
 * invitation route has always carried `workspaceAssignments`, honoured and
 * seat-checked by the accept transaction; this is the control that states one.
 */
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";

export type WorkspaceAccess = "NONE" | "VIEWER" | "MEMBER" | "ADMIN";

const OPTIONS: ReadonlyArray<{ value: WorkspaceAccess; label: string }> = [
  { value: "MEMBER", label: "Member" },
  { value: "VIEWER", label: "Viewer" },
  { value: "ADMIN", label: "Admin" },
  { value: "NONE", label: "No workspace access" },
];

/** The invitation's assignment, or nothing for a governance-only invitation. */
export function inviteWorkspaceAssignments(
  workspaceId: string | null,
  access: WorkspaceAccess,
): { workspaceAssignments: Array<{ teamId: string; role: Exclude<WorkspaceAccess, "NONE"> }> } | Record<string, never> {
  if (!workspaceId || access === "NONE") return {};
  return { workspaceAssignments: [{ teamId: workspaceId, role: access }] };
}

export function InviteWorkspaceAccess({
  label,
  value,
  onChange,
  disabled,
  disabledReason,
}: {
  label: string;
  value: WorkspaceAccess;
  onChange: (next: WorkspaceAccess) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <AppListbox<WorkspaceAccess>
      ariaLabel={label}
      value={value}
      onChange={onChange}
      disabled={disabled}
      disabledReason={disabledReason}
      options={OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      triggerProps={{ "data-input": "invite-workspace-access" }}
    />
  );
}
