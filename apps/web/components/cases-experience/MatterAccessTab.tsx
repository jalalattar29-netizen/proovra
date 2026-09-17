"use client";

/**
 * Matter workspace — Access tab. Who can open this case, and the one place a
 * case manager changes that.
 *
 *   GET    /v1/cases/:id                    the case's individual grants (`case.access`)
 *   GET    /v1/cases/:id/team-members       active workspace members (managers only)
 *   POST   /v1/cases/:id/access             give one active workspace member access
 *   DELETE /v1/cases/:id/access/:accessId   remove an individual grant
 *
 * `POST /access` is the canonical grant: `share-team` is the same grant under
 * an older name, and `share-email` exists for address-based callers.
 *
 * WHO MAY CHANGE ACCESS is the server's MANAGE_ACCESS decision
 * (`evaluateCaseMutationPermission`), projected on the matter envelope as
 * `viewer.canManageAccess` with its reason in `viewer.disabledReasons.manageAccess`.
 * A viewer who may not change access sees the list, a disabled grant control
 * carrying the server's reason, and no remove buttons.
 *
 * THE ACCESS MODEL, stated truthfully on the page: while a case has no
 * individual grants, every active member of its workspace can open it. The
 * first grant RESTRICTS it to the case owner plus the people listed, so that
 * first grant is confirmed and says so; removing the last grant opens it to
 * the workspace again, and that removal says so too.
 *
 * Every change is confirmed by rereading the grants before success is
 * announced. Errors are shown only through toSafeUserError.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { identifierLabel } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { formatUserDate } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { ReasonedActionButton } from "../../app/(app)/evidence/[id]/components/ReasonedActionButton";
import {
  WorkspaceMemberSelect,
  type WorkspaceMember,
} from "../../app/(app)/evidence/[id]/components/WorkspaceMemberSelect";

type Grant = {
  id: string;
  userId: string;
  createdAt: string;
  user?: { id: string; email: string | null; displayName: string | null } | null;
};

type CaseDetailResponse = {
  case: { id: string; ownerUserId: string | null; access?: Grant[] };
};

type TeamMemberRow = {
  userId: string;
  email: string | null;
  displayName: string | null;
  role?: string;
};

type Load<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "failed"; message: string };

export type MatterAccessViewer = {
  userId: string;
  canManageAccess?: boolean;
  disabledReasons?: Readonly<Record<string, string>>;
};

const FALLBACK_MANAGE_REASON =
  "Only a workspace Owner or Admin, or the case owner, can change who has access to this case.";
const NO_WORKSPACE_REASON =
  "This case does not belong to a team workspace, so there is no one to give access to.";

function personLabel(p: { displayName?: string | null; email?: string | null }): string {
  return p.displayName?.trim() || p.email?.trim() || "Workspace member";
}

export function MatterAccessTab({
  caseId,
  teamId,
  caseOwnerUserId,
  viewer,
}: {
  caseId: string;
  teamId: string | null;
  caseOwnerUserId: string | null;
  viewer: MatterAccessViewer;
}) {
  const { confirm } = useConfirmAction();
  const canManage = viewer.canManageAccess === true && teamId !== null;
  const manageReason =
    teamId === null
      ? NO_WORKSPACE_REASON
      : viewer.canManageAccess === true
        ? null
        : viewer.disabledReasons?.["manageAccess"] ?? FALLBACK_MANAGE_REASON;

  const [grants, setGrants] = useState<Load<Grant[]>>({ status: "loading" });
  const [members, setMembers] = useState<Load<TeamMemberRow[]> | null>(null);
  const [selected, setSelected] = useState<WorkspaceMember | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const feedbackRef = useRef<HTMLDivElement | null>(null);

  const readGrants = useCallback(async (): Promise<Grant[]> => {
    const res = (await apiFetch(`/v1/cases/${encodeURIComponent(caseId)}`, {
      method: "GET",
    })) as CaseDetailResponse;
    const rows = res.case.access ?? [];
    setGrants({ status: "ready", data: rows });
    setUnconfirmed(false);
    return rows;
  }, [caseId]);

  const loadGrants = useCallback(() => {
    setGrants({ status: "loading" });
    readGrants().catch((err) => {
      setGrants({
        status: "failed",
        message: toSafeUserError(err, { message: "Who has access to this case could not be loaded." }).message,
      });
    });
  }, [readGrants]);

  const loadMembers = useCallback(() => {
    if (!canManage) {
      setMembers(null);
      return;
    }
    setMembers({ status: "loading" });
    apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/team-members`, { method: "GET" })
      .then((res) => {
        setMembers({ status: "ready", data: (res as { items?: TeamMemberRow[] }).items ?? [] });
      })
      .catch((err) => {
        setMembers({
          status: "failed",
          message: toSafeUserError(err, { message: "Workspace members could not be loaded." }).message,
        });
      });
  }, [caseId, canManage]);

  useEffect(() => {
    loadGrants();
  }, [loadGrants]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const grantList = grants.status === "ready" ? grants.data : [];
  const restricted = grantList.length > 0;
  const viewerIsOwner = caseOwnerUserId !== null && caseOwnerUserId === viewer.userId;
  const alreadyGranted = selected ? grantList.some((g) => g.userId === selected.userId) : false;

  const grantDisabledReason = !canManage
    ? manageReason
    : unconfirmed
      ? "Reload the page to confirm the last access change before making another."
      : grants.status !== "ready"
        ? "Wait for the current access list to load."
        : !selected
          ? "Choose a workspace member first."
          : alreadyGranted
            ? "This person already has individual access."
            : selected.userId === caseOwnerUserId
              ? "The case owner always has access."
              : null;

  const grant = useCallback(async () => {
    if (!selected || busy) return;
    setNotice("");
    setFailure("");
    if (!restricted) {
      const selfNote =
        viewerIsOwner || selected.userId === viewer.userId
          ? ""
          : " You are not on that list, so you will no longer be able to open this case unless you give yourself access too.";
      const ok = await confirm({
        title: "Restrict this case to named people?",
        description:
          `Right now every active member of this workspace can open this case. After ${selected.label} is given access, only the case owner and the people listed here can open it.` +
          selfNote,
        confirmLabel: "Give access and restrict",
        tone: "warning",
      });
      if (!ok) return;
    }
    setBusy("grant");
    let written = false;
    try {
      await apiFetch(`/v1/cases/${encodeURIComponent(caseId)}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selected.userId }),
      });
      written = true;
      const fresh = await readGrants();
      if (fresh.some((g) => g.userId === selected.userId)) {
        setNotice(`${selected.label} now has access to this case. The list was reloaded.`);
        setSelected(null);
      } else {
        setFailure(
          "Access was accepted, but the reloaded list does not show it. Reload the page before trying again.",
        );
      }
    } catch (err) {
      if (written) {
        setUnconfirmed(true);
        setFailure(
          "Access was given, but the list could not be reloaded to confirm it. You may no longer be able to open this case. Reload the page.",
        );
      } else {
        setFailure(toSafeUserError(err, { message: "Access could not be given." }).message);
      }
    } finally {
      setBusy(null);
      feedbackRef.current?.focus();
    }
  }, [busy, caseId, confirm, readGrants, restricted, selected, viewer.userId, viewerIsOwner]);

  const revoke = useCallback(
    async (row: Grant) => {
      if (busy) return;
      setNotice("");
      setFailure("");
      const who = personLabel(row.user ?? {});
      const last = grantList.length === 1;
      const ok = await confirm({
        title: `Remove ${who}'s access?`,
        description:
          `${who} will no longer have individual access to this case.` +
          (last
            ? " This is the last individual grant, so every active member of the workspace will be able to open the case again."
            : ""),
        confirmLabel: "Remove access",
        tone: "danger",
      });
      if (!ok) return;
      setBusy(row.id);
      let written = false;
      try {
        await apiFetch(
          `/v1/cases/${encodeURIComponent(caseId)}/access/${encodeURIComponent(row.id)}`,
          { method: "DELETE" },
        );
        written = true;
        const fresh = await readGrants();
        if (fresh.some((g) => g.id === row.id)) {
          setFailure(
            "The removal was accepted, but the reloaded list still shows it. Reload the page before trying again.",
          );
        } else {
          setNotice(`${who} no longer has individual access. The list was reloaded.`);
        }
      } catch (err) {
        if (written) {
          setUnconfirmed(true);
          setFailure(
            "The removal was sent, but the list could not be reloaded to confirm it. Reload the page.",
          );
        } else {
          setFailure(toSafeUserError(err, { message: "Access could not be removed." }).message);
        }
      } finally {
        setBusy(null);
        feedbackRef.current?.focus();
      }
    },
    [busy, caseId, confirm, grantList.length, readGrants],
  );

  return (
    <div className="app-panel app-panel__body case-detail-stack" data-matter-access-tab>
      <div className="app-panel__head-row">
        <h3>Who can open this case</h3>
      </div>

      <div
        ref={feedbackRef}
        tabIndex={-1}
        className="case-detail-stack"
        data-matter-access-feedback
      >
        {notice ? (
          <p className="app-alert app-alert--ok" role="status">
            {notice}
          </p>
        ) : null}
        {failure ? (
          <p className="app-alert app-alert--danger" role="alert">
            {failure}
          </p>
        ) : null}
      </div>

      {grants.status === "loading" ? (
        <p className="app-hint" role="status" data-matter-access-loading>
          Loading who has access…
        </p>
      ) : grants.status === "failed" ? (
        <div className="app-empty" data-tone="danger" role="alert" data-matter-access-error>
          <strong>Access list unavailable</strong>
          <p>{grants.message}</p>
          <button type="button" className="app-secondary-action" onClick={loadGrants}>
            Try again
          </button>
        </div>
      ) : restricted ? (
        <>
          <p className="app-hint" data-matter-access-mode="restricted">
            Only the case owner and the people below can open this case.
          </p>
          <ul className="case-detail-rows" data-matter-access-grants>
            {grantList.map((g) => {
              const who = personLabel(g.user ?? {});
              return (
                <li
                  key={g.id}
                  className="app-inner-surface case-detail-row"
                  data-matter-access-grant={g.id}
                >
                  <strong>{who}</strong>
                  {g.user?.displayName && g.user?.email ? <span> · {g.user.email}</span> : null}
                  <small> · added {formatUserDate(g.createdAt)}</small>
                  {canManage ? (
                    <ReasonedActionButton
                      className="app-secondary-action app-secondary-action--danger"
                      data-matter-access-revoke={g.id}
                      busy={busy === g.id}
                      disabled={busy !== null || unconfirmed}
                      disabledReason={
                        unconfirmed
                          ? "Reload the page to confirm the last access change before making another."
                          : null
                      }
                      onClick={() => void revoke(g)}
                    >
                      {busy === g.id ? "Removing…" : "Remove access"}
                    </ReasonedActionButton>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className="app-empty" role="status" data-matter-access-mode="workspace">
          <strong>Open to the whole workspace</strong>
          <p>
            No one has been given individual access, so every active member of this
            workspace can open this case.
          </p>
        </div>
      )}

      {canManage && grants.status === "ready" && !restricted ? (
        <section className="case-detail-stack" data-matter-access-members>
          <h4>Active workspace members</h4>
          {members === null || members.status === "loading" ? (
            <p className="app-hint" role="status">
              Loading workspace members…
            </p>
          ) : members.status === "failed" ? (
            <p className="app-field-error" role="alert">
              {members.message}
            </p>
          ) : members.data.length === 0 ? (
            <p className="app-hint">This workspace has no active members.</p>
          ) : (
            <ul className="case-detail-rows">
              {members.data.map((m) => (
                <li key={m.userId} className="case-detail-row">
                  <span>{personLabel(m)}</span>
                  {m.role ? <small> · {identifierLabel(m.role)}</small> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="case-detail-stack" data-matter-access-grant-form>
        <h4>Give a workspace member access</h4>
        {canManage ? (
          <WorkspaceMemberSelect
            id={`matter-access-member-${caseId}`}
            teamId={teamId}
            value={selected?.userId ?? null}
            onChange={setSelected}
            label="Member to give access"
            disabled={busy !== null}
          />
        ) : null}
        <div>
          <ReasonedActionButton
            className="app-primary-action"
            data-matter-access-grant
            busy={busy === "grant"}
            disabled={grantDisabledReason !== null}
            disabledReason={grantDisabledReason}
            onClick={() => void grant()}
          >
            {busy === "grant" ? "Giving access…" : "Give access"}
          </ReasonedActionButton>
        </div>
      </section>
    </div>
  );
}
