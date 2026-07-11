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

import { Card } from "../../../../../components/ui";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDate } from "../../../../../lib/date";
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

const ROLE_TONE: Record<RoleId, { bg: string; border: string; fg: string }> = {
  OWNER: { bg: "#F3F0FF", border: "#D8CCFF", fg: "#4F46E5" },
  ADMIN: { bg: "#EAF7F1", border: "rgba(22,122,91,0.16)", fg: "#167A5B" },
  MEMBER: { bg: "#F1F5F9", border: "rgba(15,23,42,0.08)", fg: "#475569" },
  VIEWER: { bg: "#F1F5F9", border: "rgba(15,23,42,0.08)", fg: "#5F6B7D" },
};

function RoleBadge({ role }: { role: RoleId }) {
  const t = ROLE_TONE[role];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.fg,
        whiteSpace: "nowrap",
      }}
    >
      {role}
    </span>
  );
}

function KindPill({ kind }: { kind: "MEMBER" | "EXTERNAL" | "PENDING_INVITE" }) {
  const palette =
    kind === "MEMBER"
      ? { bg: "#EAF7F1", border: "rgba(22,122,91,0.16)", fg: "#167A5B", label: "Member" }
      : kind === "EXTERNAL"
        ? { bg: "#FFF6E5", border: "rgba(168,102,18,0.17)", fg: "#A86612", label: "External" }
        : { bg: "#F1F5F9", border: "rgba(15,23,42,0.08)", fg: "#5F6B7D", label: "Pending invite" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.fg,
        whiteSpace: "nowrap",
      }}
    >
      {palette.label}
    </span>
  );
}

function formatDate(iso: string): string {
  return formatUserDate(iso);
}

export function TeamAccessReviewCard({ teamId }: { teamId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "internal" | "external" | "pending">("all");

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

  return (
    <Card
      data-team-access-review-card
    >
      <div>
        <header className="mb-4">
          {/* Phase IA-self-serve-completion — "Access review" is
              SOC2-audit vocabulary. Renamed to plain-language
              "Member roles" without changing the underlying
              aggregator endpoint or restriction semantics. */}
          <h2 className="m-0 text-[1.08rem] font-semibold tracking-[-0.03em] text-[#172033]">
            Member roles
          </h2>
          <p className="m-0 mt-1 text-[12.5px] leading-snug text-[#5F6B7D]">
            Everyone with access to this team today — members, pending
            invites, and external collaborators with case-scoped access.
            Use this list to check who can see what before changing roles
            or removing someone.
          </p>
        </header>

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
              surface="Member roles"
              headline="Member roles can only be reviewed by admins"
              reason="Only an Owner or Admin can see this list of members. Ask a workspace admin to share who has access if you need that information."
              variant="inline"
              actions={[]}
              testid="team-access-review-access-gate"
            />
          </div>
        ) : null}

        {state.kind === "ready" ? (
          <Ready data={state.data} search={search} setSearch={setSearch} filter={filter} setFilter={setFilter} />
        ) : null}
      </div>
    </Card>
  );
}

function Ready({
  data,
  search,
  setSearch,
  filter,
  setFilter,
}: {
  data: AccessReviewResponse;
  search: string;
  setSearch: (s: string) => void;
  filter: "all" | "internal" | "external" | "pending";
  setFilter: (f: "all" | "internal" | "external" | "pending") => void;
}) {
  const summary = data.summary;

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

  // Search filter (case-insensitive on identity + email).
  const needle = search.trim().toLowerCase();
  const matchesSearch = (r: Row) =>
    !needle ||
    r.identity.toLowerCase().includes(needle) ||
    (r.email ?? "").toLowerCase().includes(needle);

  // Kind filter.
  const matchesFilter = (r: Row) => {
    if (filter === "all") return true;
    if (filter === "internal") return r.kind === "MEMBER";
    if (filter === "external") return r.kind === "EXTERNAL";
    if (filter === "pending") return r.kind === "PENDING_INVITE";
    return true;
  };

  const visible = rows.filter((r) => matchesSearch(r) && matchesFilter(r));

  return (
    <>
      <div
        data-team-access-review-summary
        className="mb-4 grid gap-3"
        style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
      >
        <SummaryStat
          label="Internal members"
          value={summary.internalMembers}
          tone="member"
          testid="access-review-summary-internal"
        />
        <SummaryStat
          label="Pending invites"
          value={summary.pendingInvites}
          tone="pending"
          testid="access-review-summary-pending"
        />
        <SummaryStat
          label="External collaborators"
          value={summary.externalCollaborators}
          tone="external"
          testid="access-review-summary-external"
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search by name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-team-access-review-search
          className="cases-form-input"
          style={{
            flex: "1 1 200px",
            padding: "6px 10px",
            borderRadius: 999,
            fontSize: 13,
          }}
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          data-team-access-review-filter
          className="cases-form-input"
          style={{
            padding: "6px 10px",
            borderRadius: 999,
            fontSize: 13,
          }}
        >
          <option value="all">All ({rows.length})</option>
          <option value="internal">Members only</option>
          <option value="external">External only</option>
          <option value="pending">Pending invites only</option>
        </select>
      </div>

      {visible.length === 0 ? (
        <p
          data-team-access-review-empty
          className="m-0 mt-2 text-[12.5px] text-[#5F6B7D]"
        >
          {rows.length === 0
            ? "No one has access to this workspace yet."
            : "No rows match the current filter."}
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
                  {r.whenLabel}
                  {r.kind === "PENDING_INVITE" ? ` · ${r.expiresLabel}` : null}
                  {r.kind === "EXTERNAL" ? ` · ${r.grantSummary}` : null}
                </div>
              </div>
              <div
                style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}
              >
                {r.kind === "EXTERNAL" ? null : <RoleBadge role={r.role} />}
                <KindPill kind={r.kind} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <p
        className="m-0 mt-3 text-[11px] text-[#5F6B7D]"
        data-team-access-review-footnote
      >
        Internal members are managed in the Members card above.
        External collaborators have case-scoped grants — open the
        relevant case to manage their access. Pending invites can be
        resent or revoked from the Invites card.
      </p>
    </>
  );
}

function SummaryStat({
  label,
  value,
  tone,
  testid,
}: {
  label: string;
  value: number;
  tone: "member" | "pending" | "external";
  testid: string;
}) {
  const palette =
    tone === "member"
      ? { bg: "#EAF7F1", border: "rgba(22,122,91,0.16)", fg: "#167A5B" }
      : tone === "external"
        ? { bg: "#FFF6E5", border: "rgba(168,102,18,0.17)", fg: "#A86612" }
        : { bg: "#F1F5F9", border: "rgba(15,23,42,0.08)", fg: "#5F6B7D" };
  return (
    <div
      data-testid={testid}
      style={{
        ...palette,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 14,
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: palette.fg,
          opacity: 0.9,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 22,
          fontWeight: 700,
          color: palette.fg,
          fontVariantNumeric: "tabular-nums",
        }}
        data-access-review-stat-value
      >
        {value}
      </div>
    </div>
  );
}
