"use client";

/**
 * External collaborators — who outside the workspace holds case access, and
 * the one place that access can be withdrawn.
 *
 *   GET    /v1/teams/:id/access-review                  (ADMIN+)
 *   DELETE /v1/teams/:id/external-grants/:grantId       (ADMIN+, audited)
 *
 * The card used to say its mutations "live on the existing surfaces". They
 * did not: the per-case revoke (`DELETE /v1/cases/:id/access/:accessId`) is
 * owner-only and had no caller, so no surface in the product could remove an
 * outsider's standing access to a workspace case. Each external collaborator
 * now expands to their grants, and each grant can be revoked here.
 *
 * Hard rules:
 *   - The access-review read is ADMIN+ gated. A refusal renders the
 *     AccessGate, never an empty list; any other failure renders an error
 *     with a retry.
 *   - Revoking is confirmed first and names the person and the case.
 *   - Success is announced only after the access review is reread and the
 *     grant is gone from it.
 *   - Only external grants are revocable here. A grant whose holder has since
 *     joined the workspace is refused by the server (INTERNAL_MEMBER) and the
 *     operator is pointed at Members.
 *   - Contact details are shown because the endpoint already restricts them
 *     to ADMIN+; there is no second redaction layer here.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDate } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { AppStatusText } from "../../../../../components/app-primitives/AppStatusText";
import { AccessGate } from "../../../../../components/access/AccessGate";
import { Button } from "../../../../../components/ui/Button";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";

type RoleId = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

type ExternalGrant = {
  grantId: string;
  caseId: string;
  caseName: string;
  grantedAt: string;
};

type ExternalCollaborator = {
  kind: "EXTERNAL";
  userId: string;
  email: string | null;
  displayName: string | null;
  firstGrantedAt: string;
  grants: ExternalGrant[];
};

type AccessReviewResponse = {
  teamId: string;
  summary: {
    internalMembers: number;
    pendingInvites: number;
    externalCollaborators: number;
  };
  members: Array<{
    kind: "MEMBER";
    memberId: string;
    userId: string;
    email: string | null;
    displayName: string | null;
    role: RoleId;
    addedAt: string;
  }>;
  pendingInvites: Array<{
    kind: "PENDING_INVITE";
    inviteId: string;
    email: string;
    role: RoleId;
    invitedByUserId: string;
    createdAt: string;
    expiresAt: string;
  }>;
  externalCollaborators: ExternalCollaborator[];
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: AccessReviewResponse }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

type Outcome = { tone: "ok" | "danger"; message: string } | null;

function personLabel(c: Pick<ExternalCollaborator, "displayName" | "email">): string {
  return c.displayName?.trim() || c.email || "External collaborator";
}

function caseLabel(g: ExternalGrant): string {
  // The server substitutes "(unknown case)" when the name cannot be resolved.
  return g.caseName && g.caseName !== "(unknown case)" ? g.caseName : "an unnamed case";
}

export function TeamAccessReviewCard({ teamId }: { teamId: string }) {
  const { confirm } = useConfirmAction();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const alive = useRef(true);
  const teamRef = useRef(teamId);
  teamRef.current = teamId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Reads the access review; returns the payload, or null when it failed. */
  const load = useCallback(async (): Promise<AccessReviewResponse | null> => {
    if (!teamId) return null;
    const requested = teamId;
    try {
      const data = (await apiFetch(`/v1/teams/${encodeURIComponent(teamId)}/access-review`)) as AccessReviewResponse;
      if (!alive.current || teamRef.current !== requested) return null;
      setState({ kind: "ready", data });
      return data;
    } catch (err) {
      if (!alive.current || teamRef.current !== requested) return null;
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 403 || status === 404) {
        setState({ kind: "forbidden" });
      } else {
        setState({
          kind: "error",
          message: toSafeUserError(err, { message: "Could not load external collaborators." }).message,
        });
      }
      return null;
    }
  }, [teamId]);

  useEffect(() => {
    setState({ kind: "loading" });
    setExpanded(null);
    setOutcome(null);
    void load();
  }, [load]);

  const revoke = useCallback(
    async (person: ExternalCollaborator, grant: ExternalGrant) => {
      if (revokingGrantId) return;
      setOutcome(null);
      const who = personLabel(person);
      const where = caseLabel(grant);
      const confirmed = await confirm({
        title: `Remove ${who}'s access to ${where}?`,
        description: `${who} will immediately lose access to ${where}. They are not a member of this workspace, so this removes their standing access to that case. The removal is recorded in the workspace audit trail; to give access back, the case owner must share the case again.`,
        confirmLabel: "Revoke access",
        tone: "danger",
        testId: "team-external-grant-revoke",
      });
      if (!alive.current || !confirmed) return;
      setRevokingGrantId(grant.grantId);
      let written = false;
      try {
        await apiFetch(
          `/v1/teams/${encodeURIComponent(teamId)}/external-grants/${encodeURIComponent(grant.grantId)}`,
          { method: "DELETE" },
        );
        written = true;
        const reread = await load();
        if (!alive.current) return;
        const stillThere = reread?.externalCollaborators.some((c) =>
          c.grants.some((g) => g.grantId === grant.grantId),
        );
        if (reread && !stillThere) {
          setOutcome({ tone: "ok", message: `${who} no longer has access to ${where}.` });
        } else {
          setOutcome({
            tone: "danger",
            message: reread
              ? "The removal was accepted, but the reloaded access review still lists this grant. Reload the page before trying again."
              : "The removal was accepted, but the access review could not be reloaded to confirm it. Reload the page to check.",
          });
        }
      } catch (err) {
        if (!alive.current) return;
        if (written) return;
        const e = err as { statusCode?: number; code?: string };
        if (e?.statusCode === 403) {
          setState({ kind: "forbidden" });
        } else if (e?.statusCode === 404 && e.code === "GRANT_NOT_FOUND") {
          await load();
          if (!alive.current) return;
          setOutcome({
            tone: "danger",
            message: `This workspace cannot remove ${who}'s access to ${where}: the grant is gone, or the case is not owned by this workspace. The list has been reloaded; if the grant is still shown, the case owner must remove it from the case.`,
          });
        } else if (e?.statusCode === 422 && e.code === "INTERNAL_MEMBER") {
          setOutcome({
            tone: "danger",
            message: `${who} is now a member of this workspace, so their access is managed from Members, not here. Nothing was changed.`,
          });
          await load();
        } else {
          setOutcome({
            tone: "danger",
            message: toSafeUserError(err, { message: "The access could not be removed. Nothing was changed." }).message,
          });
        }
      } finally {
        if (alive.current) setRevokingGrantId(null);
      }
    },
    [revokingGrantId, confirm, teamId, load],
  );

  const externalCount = state.kind === "ready" ? state.data.externalCollaborators.length : null;

  return (
    <div className="app-panel" data-team-access-review-card>
      <div className="app-panel__head app-panel__head-row">
        <h2 className="app-panel__title">External collaborators</h2>
        {externalCount !== null ? (
          <AppStatusText tone={externalCount > 0 ? "amber" : "slate"}>{externalCount}</AppStatusText>
        ) : null}
      </div>
      <div className="app-panel__body">
        {state.kind === "loading" ? (
          <p data-team-access-review-loading className="app-table__muted" role="status" style={{ margin: 0 }}>
            Loading external collaborators…
          </p>
        ) : null}

        {state.kind === "error" ? (
          <div data-team-access-review-error className="app-alert app-alert--danger" role="alert">
            <span>{state.message}</span>{" "}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setState({ kind: "loading" });
                void load();
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {state.kind === "forbidden" ? (
          <div data-team-access-review-forbidden>
            <AccessGate
              kind="REQUEST_ACCESS"
              surface="External collaborators"
              headline="External access can only be reviewed by admins"
              reason="Only an Owner or Admin can see who holds case-scoped access to this workspace. Ask a workspace admin if you need that information."
              variant="inline"
              actions={[]}
              testid="team-access-review-access-gate"
            />
          </div>
        ) : null}

        {outcome ? (
          <p
            className={`app-alert ${outcome.tone === "ok" ? "app-alert--ok" : "app-alert--danger"}`}
            role={outcome.tone === "ok" ? "status" : "alert"}
            data-team-access-review-outcome={outcome.tone}
          >
            {outcome.message}
          </p>
        ) : null}

        {state.kind === "ready" ? (
          state.data.externalCollaborators.length === 0 ? (
            <p data-team-access-review-empty className="app-table__muted" style={{ margin: 0 }}>
              No external collaborators. Everyone with access to this workspace is a member of it.
            </p>
          ) : (
            <ul
              data-team-access-review-list
              aria-label="External collaborators"
              style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}
            >
              {state.data.externalCollaborators.map((person) => {
                const open = expanded === person.userId;
                const who = personLabel(person);
                const grantsId = `external-grants-${person.userId}`;
                return (
                  <li
                    key={person.userId}
                    data-team-access-review-row-kind="EXTERNAL"
                    className="app-inner-surface"
                    style={{ display: "grid", gap: 8, padding: "10px 12px", minWidth: 0 }}
                  >
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                      <div style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}>
                        <div className="app-table__primary" data-team-access-review-row-identity>
                          {who}
                        </div>
                        <div className="app-table__muted" data-team-access-review-row-meta>
                          {person.email && person.displayName ? `${person.email} · ` : ""}
                          First granted {formatUserDate(person.firstGrantedAt)} ·{" "}
                          {person.grants.length === 1 ? "1 case" : `${person.grants.length} cases`}
                        </div>
                      </div>
                      <AppStatusText tone="amber" size="xs">
                        Case-scoped
                      </AppStatusText>
                      <button
                        type="button"
                        className="app-secondary-action"
                        aria-expanded={open}
                        aria-controls={grantsId}
                        onClick={() => setExpanded(open ? null : person.userId)}
                      >
                        {open ? "Hide cases" : `Show cases for ${who}`}
                      </button>
                    </div>
                    <div id={grantsId} hidden={!open}>
                      {open ? (
                        <ul aria-label={`Cases ${who} can access`} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                          {person.grants.map((grant) => {
                            const busy = revokingGrantId === grant.grantId;
                            const blocked = revokingGrantId !== null && !busy;
                            return (
                              <li
                                key={grant.grantId}
                                data-team-external-grant={grant.grantId}
                                style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}
                              >
                                <span style={{ flex: "1 1 180px", minWidth: 0, overflowWrap: "anywhere" }}>
                                  <span className="app-table__primary">{caseLabel(grant)}</span>{" "}
                                  <span className="app-table__muted">granted {formatUserDate(grant.grantedAt)}</span>
                                </span>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  aria-label={`Revoke ${who}'s access to ${caseLabel(grant)}`}
                                  loading={busy}
                                  disabled={revokingGrantId !== null}
                                  disabledReason={blocked ? "Another access removal is in progress. Wait for it to finish." : undefined}
                                  onClick={() => void revoke(person, grant)}
                                >
                                  Revoke access
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}

        {state.kind === "ready" ? (
          <p className="app-hint" data-team-access-review-footnote style={{ marginBottom: 0 }}>
            People who are not workspace members but hold access to individual cases in this
            workspace. Revoking removes their access to that case only; workspace members are
            managed from Members.
          </p>
        ) : null}
      </div>
    </div>
  );
}
