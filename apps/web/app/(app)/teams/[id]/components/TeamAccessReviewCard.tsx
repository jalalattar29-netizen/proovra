"use client";

/**
 * Phase 2.6C — Team access review card.
 *
 * Operator-facing governance visibility surface that consumes the
 * Phase 2.6B aggregator endpoints:
 *
 *   GET /v1/teams/:id/access-review
 *   GET /v1/teams/:id/external-collaborators  (subset of above)
 *
 * The card answers the brief's central questions:
 *   - Who has access to this workspace?
 *   - Are they internal members or external collaborators?
 *   - What role do they have?
 *   - When were they added / granted?
 *   - Are there pending invites?
 *
 * The brief explicitly says "no fake analytics", "no fake risk
 * score", "no fake approval workflows". This card surfaces ONLY
 * what the backend actually knows: identity, role, timestamps,
 * grant chain. Nothing invented.
 *
 * Hard rules:
 *   - Calls the access-review endpoint which is ADMIN+ gated. If
 *     the viewer isn't ADMIN+, we render an AccessGate explaining
 *     why the card is locked instead of trying and showing a raw
 *     403 toast.
 *   - The card is read-only. Mutations (revoke external access,
 *     remove member, etc.) live on the existing surfaces — this
 *     card is the review pane.
 *   - Empty states are operator-readable, not generic
 *     ("No external collaborators yet" — not "No data").
 *   - PII (email) is shown because the access-review endpoint
 *     gates that disclosure to ADMIN+ already; we don't add a
 *     second redaction layer here.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDate } from "../../../../../lib/date";
import { AppStatusText } from "../../../../../components/app-primitives/AppStatusText";
import { AccessGate } from "../../../../../components/access/AccessGate";

type RoleId = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

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
  externalCollaborators: Array<{
    kind: "EXTERNAL";
    userId: string;
    email: string | null;
    displayName: string | null;
    firstGrantedAt: string;
    grants: Array<{
      grantId: string;
      caseId: string;
      caseName: string;
      grantedAt: string;
    }>;
  }>;
};

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: AccessReviewResponse }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };


function formatDate(iso: string): string {
  return formatUserDate(iso);
}

export function TeamAccessReviewCard({ teamId }: { teamId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/teams/${teamId}/access-review`,
      )) as AccessReviewResponse;
      setState({ kind: "ready", data });
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 403) {
        setState({ kind: "forbidden" });
      } else if (e.statusCode === 404) {
        setState({ kind: "forbidden" });
      } else {
        setState({
          kind: "error",
          message: toSafeUserError(e, { message: "Could not load access review." }).message,
        });
      }
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const externalCount =
    state.kind === "ready" ? state.data.externalCollaborators.length : null;

  return (
    /*
      THE CANONICAL PANEL, NOT THE LEGACY CARD (§17, §28), AND EXACTLY ONE OF
      THEM.

      This was the legacy `Card` with a hand-built Tailwind header beside
      panels that all use `.app-panel` / `.app-panel__head` /
      `.app-panel__title`. Two card systems on one page is what made the
      surface look assembled rather than designed.

      The title says what the card SHOWS. It read "Member roles" while listing
      members, invitations and external grants — the two former are the roster
      and the invitations panel on the same page, so the card now shows only
      external collaborators and is named for them. The endpoint, its ADMIN+
      gate and its projection are untouched.
    */
    <div className="app-panel" data-team-access-review-card>
      <div>
        <div className="app-panel__head app-panel__head-row">
          <h2 className="app-panel__title">External collaborators</h2>
          {externalCount !== null ? (
            <AppStatusText tone={externalCount > 0 ? "amber" : "slate"}>
              {externalCount}
            </AppStatusText>
          ) : null}
        </div>
        <div className="app-panel__body">

        {state.kind === "loading" ? (
          <p
            data-team-access-review-loading
            className="m-0 text-[13px] text-[#5F6B7D]"
          >
            Loading access review…
          </p>
        ) : null}

        {state.kind === "error" ? (
          <p
            data-team-access-review-error
            className="m-0 text-[13px] text-[#B23442]"
          >
            {state.message}
          </p>
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

        {state.kind === "ready" ? (
          <Ready data={state.data} />
        ) : null}
        </div>
      </div>
    </div>
  );
}

/*
 * The search box and the kind filter are gone with the internal and pending
 * rows they existed to narrow: a filter over a list of external collaborators
 * — usually none, occasionally a handful — is a control with nothing to do.
 * `data.summary` went the same way. Its three counts were the roster, the
 * invitations panel, and this card's own heading.
 */
function Ready({ data }: { data: AccessReviewResponse }) {

  // Flatten all rows into a single searchable list with kind tags so
  // the operator can grep across internal+external+pending without
  // switching tabs.
  type Row =
    | {
        kind: "MEMBER";
        id: string;
        identity: string;
        email: string | null;
        role: RoleId;
        when: string;
        whenLabel: string;
      }
    | {
        kind: "PENDING_INVITE";
        id: string;
        identity: string;
        email: string;
        role: RoleId;
        when: string;
        whenLabel: string;
        expiresLabel: string;
      }
    | {
        kind: "EXTERNAL";
        id: string;
        identity: string;
        email: string | null;
        when: string;
        whenLabel: string;
        grants: number;
        grantSummary: string;
      };

  const rows: Row[] = [];
  for (const m of data.members) {
    rows.push({
      kind: "MEMBER",
      id: `member-${m.memberId}`,
      identity: m.displayName ?? m.email ?? m.userId,
      email: m.email,
      role: m.role,
      when: m.addedAt,
      whenLabel: `Added ${formatDate(m.addedAt)}`,
    });
  }
  for (const inv of data.pendingInvites) {
    rows.push({
      kind: "PENDING_INVITE",
      id: `invite-${inv.inviteId}`,
      identity: inv.email,
      email: inv.email,
      role: inv.role,
      when: inv.createdAt,
      whenLabel: `Invited ${formatDate(inv.createdAt)}`,
      expiresLabel: `Expires ${formatDate(inv.expiresAt)}`,
    });
  }
  for (const ext of data.externalCollaborators) {
    rows.push({
      kind: "EXTERNAL",
      id: `external-${ext.userId}`,
      identity: ext.displayName ?? ext.email ?? ext.userId,
      email: ext.email,
      when: ext.firstGrantedAt,
      whenLabel: `First granted ${formatDate(ext.firstGrantedAt)}`,
      grants: ext.grants.length,
      grantSummary:
        ext.grants.length === 1
          ? `Case: ${ext.grants[0]?.caseName}`
          : `${ext.grants.length} cases`,
    });
  }


  /**
   * EXTERNALS ONLY (§3).
   *
   * `rows` still carries every kind the endpoint returns — the projection,
   * its authority and its restriction semantics are untouched — but this card
   * now renders only what no other panel on the page can show. Internal
   * members are the roster directly above; pending invitations are the panel
   * below it. Repeating either here made the page say one thing three times.
   */
  const visible = rows.filter((r) => r.kind === "EXTERNAL");

  // The panel, its heading and the count belong to the wrapper above; this
  // renders the body only, so the card is one panel rather than two nested.
  return (
    <>
      {visible.length === 0 ? (
        <p
          data-team-access-review-empty
          className="m-0 mt-2 text-[12.5px] text-[#5F6B7D]"
        >
          No external collaborators. Everyone with access to this workspace is
          a member of it.
        </p>
      ) : (
        <ul
          data-team-access-review-list
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gap: 6,
          }}
        >
          {visible.map((r) => (
            <li
              key={r.id}
              data-team-access-review-row-kind={r.kind}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 14,
                border: "1px solid rgba(15,23,42,0.05)",
                background: "rgba(255,255,255,0.70)",
              }}
            >
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: "#172033",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  data-team-access-review-row-identity
                >
                  {r.identity}
                </div>
                <div
                  style={{
                    marginTop: 3,
                    fontSize: 11.5,
                    color: "#5F6B7D",
                  }}
                  data-team-access-review-row-meta
                >
                  {r.whenLabel} &middot; {r.grantSummary}
                </div>
              </div>
              <div
                style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}
              >
                {/* Every row is EXTERNAL here, so the kind label would repeat
                    the panel heading on every line. The grant summary in the
                    meta line above is what distinguishes one row from another. */}
                <AppStatusText tone="amber" size="xs">
                  Case-scoped
                </AppStatusText>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p
        className="m-0 mt-3 text-[11px] text-[#5F6B7D]"
        data-team-access-review-footnote
      >
        People who are not workspace members but hold case-scoped access. Their
        grants belong to the case, so open the relevant case to change them.
      </p>
    </>
  );
}
