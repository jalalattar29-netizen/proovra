"use client";

import { useCallback, useEffect, useState } from "react";

import type { CrossOrgReviewGrantProjection } from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import {
  CrossOrgAcceptForm,
  CrossOrgInviteForm,
} from "../../../../components/governance/CrossOrgReviewForms";
import { apiFetch } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";

export default function CrossOrgPage() {
  return (
    <PageRouteGate routeId="workspace.governance_platform">
      <Shell />
    </PageRouteGate>
  );
}

function Shell() {
  const [rows, setRows] = useState<ReadonlyArray<CrossOrgReviewGrantProjection>>([]);
  const [busy, setBusy] = useState(false);
  // PHASE 13 — the row currently being accepted. `POST …/:id/accept` carries a
  // body (accepting organization + optional external grant binding), so the
  // action opens a form rather than firing from the row.
  const [acceptFor, setAcceptFor] = useState<CrossOrgReviewGrantProjection | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/v1/governance/cross-org-review", { method: "GET" });
      setRows((res?.grants ?? []) as ReadonlyArray<CrossOrgReviewGrantProjection>);
    } catch {
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const decline = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await apiFetch(`/v1/governance/cross-org-review/${id}/decline`, { method: "POST" });
      await refresh();
    } catch {
      /* swallow */
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const revoke = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await apiFetch(`/v1/governance/cross-org-review/${id}/revoke`, { method: "POST" });
      await refresh();
    } catch {
      /* swallow */
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const columns: DataTableColumn<CrossOrgReviewGrantProjection>[] = [
    {
      key: "invitedOrg",
      header: "Invited org",
      render: (g) => (
        <span data-cross-org-row={g.id} data-cross-org-state={g.state}>
          <code>{g.invitedOrgSlug}</code>
        </span>
      ),
    },
    { key: "inviting", header: "Inviting", render: (g) => <code>{g.invitingOrganizationId.slice(0, 8)}…</code> },
    {
      key: "scope",
      header: "Scope",
      render: (g) => `${g.scope.slice(0, 80)}${g.scope.length > 80 ? "…" : ""}`,
    },
    { key: "state", header: "State", render: (g) => <Badge tone="governance">{g.state}</Badge> },
    {
      key: "externalGrant",
      header: "External grant",
      render: (g) =>
        g.externalReviewGrantId ? <code>{g.externalReviewGrantId.slice(0, 8)}…</code> : "—",
    },
    {
      key: "expires",
      header: "Expires",
      render: (g) => (g.expiresAtUtc ? formatUserDate(g.expiresAtUtc) : "—"),
    },
  ];

  return (
    <PageShell
      data-cross-org-page
      header={
        <PageHeader
          eyebrow="Governance"
          title="Cross-Org Review"
          subtitle="Org-to-org review grants. Integrates with the existing External Reviewer Portal — bound by `externalReviewGrantId` on accept."
          contextStrip={
            <a href="/governance-platform" style={{ fontSize: 12 }}>← Back to Governance Platform</a>
          }
          primaryAction={
            <Button
              variant="enterprise"
              data-cross-org-refresh
              disabled={busy}
              loading={busy}
              onClick={() => void refresh()}
            >
              {busy ? "Loading…" : "Refresh"}
            </Button>
          }
        />
      }
    >
      {/* PHASE 13 — POST /v1/governance/cross-org-review. The list could show
          grants and refuse them; it could never create one. */}
      <CrossOrgInviteForm onCreated={refresh} />

      {/* PHASE 13 — POST /v1/governance/cross-org-review/:id/accept. The
          decline branch already existed for this same state; accept did not,
          so an INVITED grant had exactly one exit. */}
      {acceptFor ? (
        <PageSection title="Accept invitation">
          <CrossOrgAcceptForm
            grant={acceptFor}
            /**
             * PHASE 13 (NEW-067) — DO NOT UNMOUNT THE FORM THAT IS ANNOUNCING
             * THE OUTCOME.
             *
             * This used to `setAcceptFor(null)` immediately, which removed
             * `CrossOrgAcceptForm` — and with it the `role="status"` /
             * `aria-live="polite"` region (`[data-cross-org-accept-status]`)
             * that had just been handed "Invitation accepted. The grant is now
             * ACCEPTED." A live region that is detached in the same tick it
             * receives text announces nothing: a screen-reader user completed a
             * cross-organization review binding and was told only that a form
             * had disappeared.
             *
             * Same defect and same remedy as NEW-048 (workspace closure) and
             * NEW-049 (ownership transfer): the outcome has to outlive the
             * action. Here the form itself can survive — unlike the transfer
             * card, accepting does not revoke the actor's authority — so the
             * cheapest correct fix is to leave it mounted with its success
             * state showing and let the operator dismiss it. The list below
             * still refreshes, so the row is visibly ACCEPTED underneath.
             */
            onAccepted={async () => {
              await refresh();
            }}
            onCancel={() => setAcceptFor(null)}
          />
        </PageSection>
      ) : null}

      <div data-cross-org-table>
        <DataTable<CrossOrgReviewGrantProjection>
          ariaLabel="Cross-org review grants"
          columns={columns}
          rows={rows as CrossOrgReviewGrantProjection[]}
          getRowId={(g) => g.id}
          loading={busy && rows.length === 0}
          emptyState={
            <EmptyState
              title="No cross-org links"
              purpose="Org-to-org review grants — invitations and active cross-organization review relationships — appear here."
            />
          }
          rowActions={(g) => (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              {g.state === "INVITED" ? (
                <>
                  <Button
                    variant="enterprise"
                    size="sm"
                    data-cross-org-accept={g.id}
                    disabled={busy}
                    aria-expanded={acceptFor?.id === g.id}
                    onClick={() => setAcceptFor(g)}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-cross-org-decline={g.id}
                    disabled={busy}
                    onClick={() => void decline(g.id)}
                  >
                    Decline
                  </Button>
                </>
              ) : null}
              {g.state !== "REVOKED" && g.state !== "DECLINED" ? (
                <Button
                  variant="destructive"
                  size="sm"
                  data-cross-org-revoke={g.id}
                  onClick={() => void revoke(g.id)}
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          )}
        />
      </div>
    </PageShell>
  );
}
