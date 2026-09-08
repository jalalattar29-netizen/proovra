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
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusText } from "../../../../../components/app-primitives/AppStatusText";
import type { AppTone } from "../../../../../components/app-primitives/AppStatusBadge";
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

/**
 * ROLE AND ACCESS CLASS ARE TWO DIFFERENT FACTS (§17).
 *
 * These were two adjacent filled capsules with hand-rolled palettes, rendered
 * with nothing between them, so a row read "OWNERMember" — one word that is
 * neither of the two things it is made of. They answer different questions:
 * ROLE is the workspace permission the person holds, ACCESS CLASS is how they
 * reach this workspace at all (a member, an external collaborator, or an
 * invitation nobody has accepted yet).
 *
 * Both are `AppStatusText` now, so the tone vocabulary is the canonical one
 * and neither carries a capsule, and they are separated by a real divider with
 * their own labels in the accessible name. Six hardcoded hex palettes went
 * with them.
 */
const ROLE_TONE: Record<RoleId, AppTone> = {
  OWNER: "indigo",
  ADMIN: "green",
  MEMBER: "slate",
  VIEWER: "slate",
};

function RoleBadge({ role }: { role: RoleId }) {
  return (
    <AppStatusText tone={ROLE_TONE[role]} size="xs" title={`Workspace role: ${role}`}>
      {role}
    </AppStatusText>
  );
}

const KIND_TONE: Record<
  "MEMBER" | "EXTERNAL" | "PENDING_INVITE",
  { tone: AppTone; label: string }
> = {
  MEMBER: { tone: "green", label: "Member" },
  EXTERNAL: { tone: "amber", label: "External" },
  PENDING_INVITE: { tone: "slate", label: "Pending invite" },
};

function KindPill({ kind }: { kind: "MEMBER" | "EXTERNAL" | "PENDING_INVITE" }) {
  const { tone, label } = KIND_TONE[kind];
  return (
    <AppStatusText tone={tone} size="xs" title={`Access: ${label}`}>
      {label}
    </AppStatusText>
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
    /*
      THE CANONICAL PANEL, NOT THE LEGACY CARD (§17, §28).

      This was the legacy `Card` with a hand-built Tailwind header — its own
      heading size, its own tracking, its own colour — beside panels that all
      use `.app-panel` / `.app-panel__head` / `.app-panel__title`. Two card
      systems on one page is what made the surface look assembled rather than
      designed.

      The four-sentence description shrank to one. What it USED to say — how to
      read the list, what an external collaborator is, where each kind is
      managed — was never wrong, it was just four lines of prose above the data
      it described. It lives in the footnote below the list now, which is where
      a reader looks after seeing the rows rather than before.
    */
    <div className="app-panel" data-team-access-review-card>
      <div>
        <div className="app-panel__head">
          {/* Phase IA-self-serve-completion — "Access review" is
              SOC2-audit vocabulary. Renamed to plain-language
              "Member roles" without changing the underlying
              aggregator endpoint or restriction semantics. */}
          <h2 className="app-panel__title">Member roles</h2>
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
      </div>
    </div>
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
        className="app-grid-kpis app-grid-kpis--dense"
        style={{ marginBottom: 14 }}
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

      {/*
        THE CANONICAL CONTROLS, NOT PAGE-LOCAL ONES.

        This row held two hand-styled pills: a bare `<input>` and a native
        `<select>`, both `cases-form-input` with inline `borderRadius: 999` and
        their own padding and font size. The `<select>` is where the reported
        blue came from — a native select paints its selected and focus states
        from the browser/OS, so no amount of styling the closed control reaches
        the open menu, and it could never match the accent hierarchy every
        other current surface uses.

        `AppListbox` is that hierarchy, and `.app-search-field` /
        `.app-search-icon` / `.app-search-input` are the same search primitive
        Evidence, Intake Links and Operations use. Both `data-*` hooks are
        preserved verbatim, and the filter values are unchanged.
      */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="app-search-field">
          <span className="app-search-icon" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            type="search"
            className="app-search-input"
            placeholder="Search by name or email"
            aria-label="Search access review by name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-team-access-review-search
          />
        </div>
        <div style={{ minWidth: 200 }} data-team-access-review-filter>
          <AppListbox
            value={filter}
            options={[
              { value: "all", label: `All (${rows.length})` },
              { value: "internal", label: "Members only" },
              { value: "external", label: "External only" },
              { value: "pending", label: "Pending invites only" },
            ]}
            onChange={(v) => setFilter(v as typeof filter)}
            ariaLabel="Filter access review"
            id="team-access-review-filter"
          />
        </div>
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
                {r.kind === "EXTERNAL" ? null : (
                  <>
                    <RoleBadge role={r.role} />
                    <span aria-hidden style={{ color: "rgba(15,23,42,0.2)" }}>
                      ·
                    </span>
                  </>
                )}
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
        Everyone with access today. Internal members are managed in Members
        above; external collaborators hold case-scoped grants, so open the
        relevant case to change them; pending invitations can be resent or
        revoked from Pending invitations.
      </p>
    </>
  );
}

/**
 * THE CANONICAL METRIC CARD (§17).
 *
 * These were three filled pastel boxes with their own hex palettes — the
 * "giant tinted blocks" treatment, in miniature. They are `.app-metric-card`
 * now: the same near-white surface, semantic rail and tinted figure the
 * Notifications summary strip uses, so three small equal metrics read as a
 * summary rather than as three coloured buttons.
 */
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
  const metricTone =
    tone === "member" ? "success" : tone === "external" ? "warning" : "neutral";
  return (
    <div className="app-metric-card" data-app-metric-tone={metricTone} data-testid={testid}>
      <span className="app-metric-card__value" data-access-review-stat-value>
        {value}
      </span>
      <span className="app-metric-card__label">{label}</span>
    </div>
  );
}
