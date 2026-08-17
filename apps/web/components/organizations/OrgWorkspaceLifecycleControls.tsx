"use client";

/**
 * PHASE 13 — organization workspace suspend / resume.
 *
 *   POST /v1/orgs/:id/workspaces/:teamId/suspend
 *   POST /v1/orgs/:id/workspaces/:teamId/resume
 *
 * Registered at services/api/src/routes/organizations.routes.ts:2207 and
 * never reachable: the org detail page listed workspaces read-only.
 *
 * Contract:
 *
 *   body      none
 *   200       { suspend: { teamId, membersSuspended } }
 *             { resume:  { teamId, membersReactivated } }
 *   403       { error: { code: "admin_required" } }  — caller below ORG_ADMIN
 *   404       TEAM_NOT_FOUND | TEAM_NOT_IN_ORGANIZATION
 *   409       NOT_ORGANIZATION_WORKSPACE — personal / owned workspaces are
 *             out of scope for org-level suspension
 *
 * The denial bodies carry a nested `error.code` with no `message`, which the
 * canonical client does not surface as `code`; the status is therefore the
 * signal, and the copy below covers every case a given status can mean.
 *
 * Suspension is destructive (every active member loses access and webhook
 * delivery is paused), so it requires an explicit confirmation step.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/Button";
import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

type Action = "suspend" | "resume";

export interface OrgWorkspaceLifecycleControlsProps {
  orgId: string;
  workspaceId: string;
  workspaceName: string;
  /** Personal spaces are refused by the service (NOT_ORGANIZATION_WORKSPACE). */
  isPersonal: boolean;
  /** ORG_ADMIN+ projection derived from GET /v1/orgs/:id callerRole. */
  canManage: boolean;
  /** Re-reads the workspace list. */
  onChanged: () => void | Promise<void>;
}

function denialCopy(err: unknown, action: Action): string {
  const e = err as { statusCode?: number };
  const status = typeof e.statusCode === "number" ? e.statusCode : 0;

  if (status === 403) {
    return "You don't have permission to change this workspace. Organization admins and owners can suspend and resume workspaces.";
  }
  if (status === 404) {
    return "This workspace is no longer bound to this organization. The list has been reloaded.";
  }
  if (status === 409) {
    return "Only organization workspaces can be suspended here. Personal spaces and individually owned workspaces are governed by their owner.";
  }
  return toSafeUserError(err, {
    message:
      action === "suspend"
        ? "Could not suspend this workspace. Nothing was changed."
        : "Could not resume this workspace. Nothing was changed.",
  }).message;
}

export function OrgWorkspaceLifecycleControls({
  orgId,
  workspaceId,
  workspaceName,
  isPersonal,
  canManage,
  onChanged,
}: OrgWorkspaceLifecycleControlsProps) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Stale-response protection.
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (action: Action) => {
      setError(null);
      setNotice(null);
      setBusy(action);
      const seq = ++seqRef.current;

      try {
        const res = (await apiFetch(
          `/v1/orgs/${orgId}/workspaces/${workspaceId}/${action}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        )) as
          | { suspend?: { membersSuspended?: number }; resume?: { membersReactivated?: number } }
          | null;
        if (!mountedRef.current || seq !== seqRef.current) return;
        setConfirming(false);
        const suspended = res?.suspend?.membersSuspended ?? 0;
        const reactivated = res?.resume?.membersReactivated ?? 0;
        setNotice(
          action === "suspend"
            ? `${workspaceName} is suspended. ${suspended} member${suspended === 1 ? "" : "s"} lost access and webhook delivery is paused. Evidence and audit history are untouched.`
            : `${workspaceName} is active again. ${reactivated} member${reactivated === 1 ? "" : "s"} regained access; webhooks stay disabled until you re-enable them.`,
        );
        await onChanged();
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setError(denialCopy(err, action));
        if ((err as { statusCode?: number }).statusCode === 404) await onChanged();
      } finally {
        if (mountedRef.current && seq === seqRef.current) setBusy(null);
      }
    },
    [orgId, workspaceId, workspaceName, onChanged],
  );

  const blocked = !canManage || isPersonal;
  const disabled = blocked || busy !== null;

  return (
    <div
      data-org-workspace-lifecycle={workspaceId}
      aria-busy={busy !== null}
      style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}
    >
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || confirming}
          loading={busy === "suspend"}
          onClick={() => {
            setError(null);
            setNotice(null);
            setConfirming(true);
          }}
          data-action="suspend-org-workspace"
          data-testid={`workspace-suspend-${workspaceId}`}
          aria-label={`Suspend workspace ${workspaceName}`}
        >
          Suspend…
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          loading={busy === "resume"}
          onClick={() => void run("resume")}
          data-action="resume-org-workspace"
          data-testid={`workspace-resume-${workspaceId}`}
          aria-label={`Resume workspace ${workspaceName}`}
        >
          Resume
        </Button>
      </div>

      {!canManage ? (
        <p data-state="forbidden" style={{ margin: 0, fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
          Organization admin access is required to suspend or resume a workspace.
        </p>
      ) : isPersonal ? (
        <p data-state="not-applicable" style={{ margin: 0, fontSize: 12, color: "var(--ink-muted, #94a3b8)" }}>
          A personal space can&apos;t be suspended from here.
        </p>
      ) : null}

      {confirming ? (
        <div
          data-org-workspace-suspend-confirm={workspaceId}
          style={{
            marginTop: 4,
            padding: "10px 12px",
            border: "1px solid var(--border-default, rgba(15,23,42,0.14))",
            borderRadius: 10,
            background: "var(--surface-card, #ffffff)",
            maxWidth: 420,
            textAlign: "left",
          }}
        >
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-secondary, #475569)" }}>
            Suspend <strong>{workspaceName}</strong>? Every active member loses
            access, anyone working in it is returned to their personal space,
            and webhook delivery pauses. Evidence, cases and audit history are
            not deleted, and Resume brings the members back.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              loading={busy === "suspend"}
              disabled={busy !== null}
              onClick={() => void run("suspend")}
              data-action="confirm-suspend-org-workspace"
              data-testid={`workspace-suspend-confirm-${workspaceId}`}
            >
              Confirm suspension
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => setConfirming(false)}
              data-action="cancel-suspend-org-workspace"
            >
              Keep it running
            </Button>
          </div>
        </div>
      ) : null}

      <div
        role="status"
        aria-live="polite"
        data-org-workspace-lifecycle-status={workspaceId}
        style={{
          fontSize: 12,
          textAlign: "right",
          color: error ? "var(--status-risk-fg, #991b1b)" : "var(--ink-secondary, #475569)",
        }}
      >
        {busy === "suspend"
          ? "Suspending…"
          : busy === "resume"
            ? "Resuming…"
            : error
              ? error
              : notice
                ? notice
                : ""}
      </div>
    </div>
  );
}

export default OrgWorkspaceLifecycleControls;
