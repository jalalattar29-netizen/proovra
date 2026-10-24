"use client";

/**
 * SETTINGS → WORKSPACE LIFECYCLE (members audit LIFE-01, LIFE-02, LIFE-07).
 *
 * How a Workspace ends is ONE server-projected policy (`team.lifecycle`, from
 * `resolveWorkspaceLifecyclePolicy`). This section renders it and never
 * decides it:
 *
 *   PERSONAL      an explanation and the way to close the account. No Close
 *                 Workspace, no Delete — a Personal Workspace ends only with
 *                 its account, and every plan lives on this same Workspace.
 *   ORGANIZATION  an explanation that the organization governs it.
 *   OWNED         (legacy) the canonical closure request, and ownership
 *                 transfer, for the owner only.
 *
 * There is no delete control for any kind. This used to live at the bottom of
 * Members & Access, where a Personal Workspace showed a Close button the
 * server always refused and a Delete that could destroy the workspace.
 */

import { useCallback, useEffect, useState } from "react";

import {
  describeWorkspaceLifecycle,
  type WorkspaceLifecyclePolicy,
} from "@proovra/shared";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { ProovraSupportReference } from "../../../../components/feedback/ProovraSupportReference";
import { WorkspaceClosureCard } from "../../teams/[id]/components/WorkspaceClosureCard";
import { WorkspaceOwnershipTransferCard } from "../../teams/[id]/components/WorkspaceOwnershipTransferCard";

type WorkspaceLifecycleRead = {
  id: string;
  name?: string | null;
  canManageWorkspace?: boolean;
  lifecycle?: WorkspaceLifecyclePolicy;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; workspace: WorkspaceLifecycleRead }
  | { status: "error"; title: string; message: string; reference?: string };

export function WorkspaceLifecycleSection({
  workspaceId,
  currentUserId,
  onOpenPrivacy,
}: {
  workspaceId: string | null;
  currentUserId: string | null;
  /** Opens Settings → Privacy & data, where the account is closed. */
  onOpenPrivacy: () => void;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({
        status: "error",
        title: "No workspace is selected",
        message: "Choose a workspace, then open its lifecycle again.",
      });
      return;
    }
    setState({ status: "loading" });
    try {
      const workspace = (await apiFetch(
        `/v1/teams/${workspaceId}`,
      )) as WorkspaceLifecycleRead;
      setState({ status: "ready", workspace });
    } catch (err) {
      const safe = toSafeUserError(err);
      setState({
        status: "error",
        title: safe.title,
        message: safe.message,
        reference: safe.supportReference,
      });
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <p role="status" className="app-table__muted" data-workspace-lifecycle-loading>
        Loading this workspace&rsquo;s lifecycle…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div role="alert" data-workspace-lifecycle-error>
        <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{state.title}</p>
        <p className="app-table__muted" style={{ margin: "0 0 8px" }}>
          {state.message}
        </p>
        <ProovraSupportReference reference={state.reference} compact />
        <button
          type="button"
          className="app-secondary-action"
          onClick={() => void load()}
        >
          Try again
        </button>
      </div>
    );
  }

  const { workspace } = state;
  const policy = workspace.lifecycle;
  if (!policy) {
    return (
      <p className="app-table__muted" data-workspace-lifecycle-unknown>
        This workspace&rsquo;s lifecycle isn&rsquo;t available right now.
      </p>
    );
  }
  const copy = describeWorkspaceLifecycle(policy);
  const isOwner = workspace.canManageWorkspace === true;

  return (
    <div
      className="app-section-stack"
      data-workspace-lifecycle
      data-workspace-lifecycle-kind={policy.kind}
    >
      {notice ? (
        // The transfer outcome lives OUTSIDE the owner-gated cards: a transfer
        // demotes the caller, the re-read flips `canManageWorkspace`, and the
        // card that produced the sentence unmounts (NEW-049).
        <div role="status" aria-live="polite" data-workspace-ownership-notice>
          {notice}
        </div>
      ) : null}

      <div className="app-panel">
        <div className="app-panel__head">
          <h3 className="app-panel__title">{copy.title}</h3>
        </div>
        <div className="app-panel__body">
          <p className="app-table__muted" style={{ margin: "0 0 10px" }}>
            {copy.explanation}
          </p>
          {policy.nextAction === "CLOSE_ACCOUNT" ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={onOpenPrivacy}
              data-action="open-account-closure"
            >
              Go to Close account
            </button>
          ) : null}
        </div>
      </div>

      {policy.kind === "OWNED" && isOwner ? (
        <div className="app-grid-panels app-grid-panels--stretch">
          {policy.transferable ? (
            <WorkspaceOwnershipTransferCard
              teamId={workspace.id}
              teamName={workspace.name ?? "this workspace"}
              currentUserId={currentUserId}
              onTransferred={async (message) => {
                setNotice(message);
                await load();
              }}
            />
          ) : null}
          {policy.closable ? <WorkspaceClosureCard teamId={workspace.id} /> : null}
        </div>
      ) : null}
    </div>
  );
}
