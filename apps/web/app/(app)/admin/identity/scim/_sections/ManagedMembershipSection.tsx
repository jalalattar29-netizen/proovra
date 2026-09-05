"use client";

/**
 * PHASE 12B — SCIM managed-membership OWNERSHIP visibility.
 *
 * Answers the question the SCIM console previously could not: who in this
 * workspace does the directory actually OWN, which identities are in conflict
 * (claimed by another Organization, unresolvable, or standard in an
 * org that requires managed identity), which have been RELEASED by a
 * deactivation, and what each SCIM group's mapped role actually grants.
 *
 * Backed by GET /v1/admin/identity/scim/managed-membership. Every
 * classification — including whether the organization requires managed
 * identity — is resolved server-side by the canonical authorities. No
 * ownership or policy decision is computed in the browser, and no token or raw
 * IdP payload is ever part of this projection.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../../../../lib/platform-context";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../components/ui/DataTable";

type Ownership =
  | "MANAGED_BY_THIS_ORGANIZATION"
  | "MANAGED_BY_ANOTHER_ORGANIZATION"
  | "STANDARD"
  | "UNRESOLVED";

type ManagedMember = {
  userId: string;
  email: string | null;
  displayName: string | null;
  externalSubjectId: string | null;
  directoryLink: "LINKED" | "RELEASED" | "NONE";
  membershipStatus: string | null;
  role: string | null;
  ownership: Ownership;
  conflict: boolean;
};

type ManagedMembershipProjection = {
  teamId: string;
  organizationId: string | null;
  managedIdentityRequired: boolean;
  summary: {
    total: number;
    managedByThisOrganization: number;
    managedByAnotherOrganization: number;
    standard: number;
    unresolved: number;
    released: number;
    conflicts: number;
  };
  members: ManagedMember[];
  groups: Array<{
    id: string;
    displayName: string;
    externalId: string | null;
    mappedRole: string;
    status: string;
    memberCount: number;
  }>;
  truncated: boolean;
};

const OWNERSHIP_COPY: Record<Ownership, { label: string; tone: "verified" | "risk" | "neutral" }> =
  {
    MANAGED_BY_THIS_ORGANIZATION: { label: "Owned by your directory", tone: "verified" },
    MANAGED_BY_ANOTHER_ORGANIZATION: {
      label: "Claimed by another organization",
      tone: "risk",
    },
    STANDARD: { label: "Self-managed account", tone: "neutral" },
    UNRESOLVED: { label: "Ownership could not be confirmed", tone: "risk" },
  };

const mutedStyle = {
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "var(--ink-secondary, #475569)",
} as const;

type Phase =
  | { kind: "loading" }
  | { kind: "denied"; title: string; detail: string }
  | { kind: "error"; detail: string }
  | { kind: "ready"; projection: ManagedMembershipProjection };

export function ManagedMembershipSection({ teamId }: { teamId: string }) {
  const { stamp, isStale } = useTenantGuard();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const load = useCallback(async () => {
    const captured = stamp();
    setPhase({ kind: "loading" });
    try {
      const r = (await apiFetch(
        `/v1/admin/identity/scim/managed-membership?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { projection: ManagedMembershipProjection };
      if (isStale(captured)) return;
      setPhase({ kind: "ready", projection: r.projection });
    } catch (err) {
      if (isStale(captured)) return;
      const e = (err ?? {}) as {
        status?: unknown;
        statusCode?: unknown;
        code?: unknown;
      };
      const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
      const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
      if (status === 402 || code.includes("enterprise_feature_required")) {
        setPhase({
          kind: "denied",
          title: "Not included in this plan",
          detail:
            "Directory provisioning is part of the Enterprise plan. The server declined to return managed-membership ownership for this workspace.",
        });
        return;
      }
      if (
        status === 403 ||
        status === 404 ||
        code === "forbidden" ||
        code === "not_found" ||
        code === "permission_denied"
      ) {
        setPhase({
          kind: "denied",
          title: "You don't have access to directory ownership",
          detail:
            "Your role in this workspace does not allow reading managed-membership ownership. Nothing was loaded and nothing was changed.",
        });
        return;
      }
      setPhase({
        kind: "error",
        detail: toSafeUserError(err, {
          message: "Could not load managed membership.",
        }).message,
      });
    }
  }, [teamId, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const memberColumns: DataTableColumn<ManagedMember>[] = [
    {
      key: "person",
      header: "Person",
      render: (m) => (
        <div style={{ fontSize: 12.5 }}>
          <div style={{ fontWeight: 600 }}>{m.displayName ?? m.email ?? "—"}</div>
          <div style={mutedStyle}>{m.email ?? "no email on record"}</div>
        </div>
      ),
    },
    {
      key: "ownership",
      header: "Ownership",
      render: (m) => {
        const copy = OWNERSHIP_COPY[m.ownership];
        return (
          <span data-ownership={m.ownership}>
            <Badge tone={copy.tone} subtle>
              {copy.label}
            </Badge>
          </span>
        );
      },
    },
    {
      key: "link",
      header: "Directory link",
      render: (m) => (
        <span style={mutedStyle} data-directory-link={m.directoryLink}>
          {m.directoryLink === "LINKED"
            ? "Linked"
            : m.directoryLink === "RELEASED"
              ? "Released by deactivation"
              : "Never linked"}
        </span>
      ),
    },
    {
      key: "access",
      header: "Workspace access",
      render: (m) => (
        <span style={mutedStyle}>
          {m.membershipStatus
            ? `${m.membershipStatus.toLowerCase()} · ${(m.role ?? "").toLowerCase()}`
            : "no membership"}
        </span>
      ),
    },
    {
      key: "subject",
      header: "Directory id",
      render: (m) => (
        <code style={{ fontFamily: "monospace", fontSize: 11 }}>
          {m.externalSubjectId ? `${m.externalSubjectId.slice(0, 24)}` : "—"}
        </code>
      ),
    },
  ];

  if (phase.kind === "loading") {
    return (
      <Card variant="summary" padding="comfortable" data-testid="scim-ownership-loading">
        <p style={mutedStyle}>Resolving directory ownership…</p>
      </Card>
    );
  }

  if (phase.kind === "denied") {
    return (
      <Card
        variant="status"
        tone="risk"
        padding="comfortable"
        data-testid="scim-ownership-denied"
      >
        <strong style={{ fontSize: 14 }}>{phase.title}</strong>
        <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 0, maxWidth: 620 }}>
          {phase.detail}
        </p>
      </Card>
    );
  }

  if (phase.kind === "error") {
    return (
      <Card
        variant="status"
        tone="risk"
        padding="comfortable"
        data-testid="scim-ownership-error"
      >
        <strong style={{ fontSize: 14 }}>Ownership didn&apos;t load</strong>
        <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 10 }}>{phase.detail}</p>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );
  }

  const { projection } = phase;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
      data-testid="scim-ownership"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <p style={{ ...mutedStyle, maxWidth: 720 }}>
          Who your identity provider actually owns in this workspace. A person
          your directory deactivated keeps their account and their evidence — the
          directory link is released and workspace access is suspended, never
          deleted.
        </p>
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <Card
        variant="status"
        tone={projection.summary.conflicts > 0 ? "risk" : "governance"}
        padding="comfortable"
      >
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div style={mutedStyle}>Owned by your directory</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {projection.summary.managedByThisOrganization}
            </div>
          </div>
          <div>
            <div style={mutedStyle}>Needs attention</div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: projection.summary.conflicts > 0 ? "var(--danger-strong)" : undefined,
              }}
              data-testid="scim-ownership-conflicts"
            >
              {projection.summary.conflicts}
            </div>
          </div>
          <div>
            <div style={mutedStyle}>Released by deactivation</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {projection.summary.released}
            </div>
          </div>
          <div>
            <div style={mutedStyle}>Managed identity</div>
            <div style={{ marginTop: 4 }}>
              <Badge
                tone={projection.managedIdentityRequired ? "governance" : "neutral"}
                subtle
              >
                {projection.managedIdentityRequired
                  ? "Required for every member"
                  : "Not required"}
              </Badge>
            </div>
          </div>
        </div>
      </Card>

      {projection.truncated ? (
        <p style={mutedStyle}>
          Showing the most recently linked identities only. Resolve the conflicts
          above, then refresh.
        </p>
      ) : null}

      <DataTable
        columns={memberColumns}
        rows={projection.members}
        getRowId={(m) => m.userId}
        ariaLabel="Directory-managed membership"
        emptyState={
          <EmptyState variant="inline"
            title="No directory identities linked yet"
            purpose="Once your identity provider pushes users over SCIM, each person it owns appears here with their ownership state, workspace access, and directory link."
          />
        }
      />

      <Card
        variant="admin"
        padding="comfortable"
        title="What your groups grant"
        data-testid="scim-group-effects"
      >
        {projection.groups.length === 0 ? (
          <EmptyState variant="inline"
            title="No SCIM groups"
            purpose="Groups pushed by your identity provider map to a workspace role. Each group's effect on access appears here."
          />
        ) : (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 10 }}>
            {projection.groups.map((g) => (
              <li key={g.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13 }}>{g.displayName}</strong>
                <Badge tone={g.status === "ACTIVE" ? "governance" : "neutral"} subtle>
                  {g.status === "ACTIVE" ? "Active" : "Archived"}
                </Badge>
                <span style={mutedStyle}>
                  grants the <strong>{g.mappedRole.toLowerCase()}</strong> role ·{" "}
                  {g.memberCount} member{g.memberCount === 1 ? "" : "s"} hold it
                  today
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
