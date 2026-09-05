"use client";

/**
 * PHASE 12B — External identity mappings (SSO / SCIM subject links).
 *
 *   GET    /v1/identity/external-mappings
 *   POST   /v1/identity/external-mappings
 *   DELETE /v1/identity/external-mappings/:id
 *
 * A mapping records which identity-provider subject corresponds to which
 * workspace member. It is record-keeping, NOT an authentication decision:
 * creating one never grants access, and removing one never signs anyone out.
 * The copy says so, because an operator must not believe otherwise.
 *
 * Both mutations are step-up gated and the subject must already be a member of
 * the SERVER-derived workspace — a subject from another organization is
 * concealed as "not part of this workspace", never confirmed to exist.
 */

import { useCallback, useEffect, useState } from "react";

import {
  EXTERNAL_IDENTITY_PROVIDERS,
  type ExternalIdentityProvider,
} from "@proovra/shared";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { useTenantGuard } from "../../../../../lib/platform-context";
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { DataTable, type DataTableColumn } from "../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { PageSection } from "../../../../../components/ui/PageShell";
import { StatusBadge } from "../../../../../components/ui/StatusBadge";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  classifyFailure,
  isStepUpCancel,
  shortId,
  type RowResult,
  type SurfaceFailure,
} from "./identity-admin-shared";

type StepUpControl = {
  runStepUpAction: <T>(action: (headers?: Record<string, string>) => Promise<T>) => Promise<T>;
};

type Mapping = {
  id: string;
  userId: string;
  provider: string;
  externalSubjectId: string;
  displayName: string | null;
  externalEmail: string | null;
  linkedAtUtc: string;
  unlinkedAtUtc: string | null;
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatUserDateTime(iso);
  } catch {
    return iso;
  }
}

export function ExternalMappingsSection({
  stepUp,
  memberOptions,
}: {
  stepUp: StepUpControl;
  /** Member user ids from the SAME server projection the members table renders. */
  memberOptions: ReadonlyArray<{ userId: string; role: string; status: string }>;
}) {
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();

  const [rows, setRows] = useState<ReadonlyArray<Mapping> | null>(null);
  const [failure, setFailure] = useState<SurfaceFailure | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [rowResult, setRowResult] = useState<RowResult | null>(null);
  const [subjectUserId, setSubjectUserId] = useState("");
  const [provider, setProvider] = useState<ExternalIdentityProvider>(
    EXTERNAL_IDENTITY_PROVIDERS[0] as ExternalIdentityProvider,
  );
  const [externalSubjectId, setExternalSubjectId] = useState("");
  const [displayName, setDisplayName] = useState("");

  const load = useCallback(async () => {
    const captured = stamp();
    setFailure(null);
    try {
      const res = await apiFetch("/v1/identity/external-mappings", {
        method: "GET",
      });
      if (isStale(captured)) return;
      setRows((res?.externalMappings ?? []) as ReadonlyArray<Mapping>);
    } catch (err) {
      if (isStale(captured)) return;
      setRows([]);
      setFailure(
        classifyFailure(err, "Unable to load external identity mappings."),
      );
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (
      rowId: string,
      successMessage: string,
      fallbackMessage: string,
      request: (headers?: Record<string, string>) => Promise<unknown>,
    ) => {
      const captured = stamp();
      setBusyRow(rowId);
      setRowResult(null);
      try {
        await stepUp.runStepUpAction(request);
        if (isStale(captured)) return;
        setRowResult({ rowId, ok: true, message: successMessage });
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        if (isStepUpCancel(err)) return;
        setRowResult({
          rowId,
          ok: false,
          message: classifyFailure(err, fallbackMessage).message,
        });
      } finally {
        if (!isStale(captured)) setBusyRow(null);
      }
    },
    [stepUp, load, stamp, isStale],
  );

  const link = useCallback(async () => {
    if (!subjectUserId || !externalSubjectId.trim()) return;
    await run(
      `new:${subjectUserId}`,
      "External identity linked.",
      "Could not link the external identity.",
      (headers) =>
        apiFetch("/v1/identity/external-mappings", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({
            userId: subjectUserId,
            provider,
            externalSubjectId: externalSubjectId.trim(),
            displayName: displayName.trim() ? displayName.trim() : null,
          }),
        }),
    );
    setExternalSubjectId("");
    setDisplayName("");
  }, [subjectUserId, provider, externalSubjectId, displayName, run]);

  const unlink = useCallback(
    async (mapping: Mapping) => {
      const ok = await confirm({
        title: "Unlink this external identity?",
        description:
          "The record of which provider subject maps to this member is closed. This does not sign anyone out and does not remove their workspace access — it only ends the mapping record.",
        confirmLabel: "Unlink",
        tone: "danger",
        testId: "identity-external-mapping-unlink",
      });
      if (!ok) return;
      await run(
        mapping.id,
        "External identity unlinked.",
        "Could not unlink the external identity.",
        (headers) =>
          apiFetch(`/v1/identity/external-mappings/${mapping.id}`, {
            method: "DELETE",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({}),
          }),
      );
    },
    [confirm, run],
  );

  const columns: DataTableColumn<Mapping>[] = [
    {
      key: "member",
      header: "Member",
      render: (m) => (
        <div data-identity-mapping-row={m.id}>
          <code style={{ fontSize: 12 }}>{shortId(m.userId)}</code>
          {rowResult && rowResult.rowId === m.id ? (
            <div
              data-identity-mapping-result={rowResult.ok ? "ok" : "failed"}
              className="adm-help" style={{ color: rowResult.ok ? "var(--success-strong)" : "var(--danger-strong)" }}
 >
              {rowResult.message}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      render: (m) => <Badge tone="governance">{m.provider}</Badge>,
    },
    {
      key: "subject",
      header: "Provider subject",
      render: (m) => (
        <span className="adm-help" style={{ fontSize: 11, wordBreak: "break-all" }}>
          {m.externalSubjectId}
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      render: (m) => (
        <StatusBadge status={m.unlinkedAtUtc ? "REVOKED" : "ACTIVE"} />
      ),
    },
    {
      key: "linked",
      header: "Linked",
      nowrap: true,
      render: (m) => <span className="adm-help">{fmt(m.linkedAtUtc)}</span>,
    },
  ];

  const activeMembers = memberOptions.filter((m) => m.status === "ACTIVE");

  return (
    <PageSection
      title="External identity mappings"
      description="Which identity-provider subject corresponds to which member. This is a record, not an authentication decision: linking grants no access and unlinking signs nobody out."
      action={
        <Button
          variant="secondary"
          size="sm"
          data-identity-mappings-refresh
          onClick={() => void load()}
 >
          Refresh
        </Button>
      }
 >
      {failure ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          data-identity-mappings-failure={failure.kind}
 >
          <strong>
            {failure.kind === "denied"
              ? "Not available to you"
              : failure.kind === "blocked"
                ? "Refused"
                : "Could not load"}
          </strong>
          <div style={{ marginTop: 4 }}>{failure.message}</div>
        </Card>
      ) : null}

      <Card
        variant="admin"
        padding="compact"
        data-identity-mapping-link-form
        style={{ marginBottom: 12 }}
 >
        <p className="adm-help" style={{ marginTop: 0 }}>
          The member is chosen from this workspace's own member list — there is
          no free-text organization or workspace field on this surface.
        </p>
        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
 >
          <select
            aria-label="Member"
            data-identity-mapping-member
            className="adm-select" style={{ maxWidth: 260 }}
            value={subjectUserId}
            onChange={(e) => setSubjectUserId(e.target.value)}
 >
            <option value="">Select a member…</option>
            {activeMembers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {shortId(m.userId)} · {m.role}
              </option>
            ))}
          </select>
          <select
            aria-label="Provider"
            data-identity-mapping-provider
            className="adm-select"
            value={provider}
            onChange={(e) =>
              setProvider(e.target.value as ExternalIdentityProvider)
            }
 >
            {EXTERNAL_IDENTITY_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            data-identity-mapping-subject
            aria-label="Provider subject id (NameID or sub claim) to link"
            className="adm-input" style={{ maxWidth: 280 }}
            value={externalSubjectId}
            maxLength={320}
            placeholder="Provider subject id (NameID / sub)"
            onChange={(e) => setExternalSubjectId(e.target.value)}
          />
          <input
            data-identity-mapping-display-name
            aria-label="Optional label for the new mapping"
            className="adm-input" style={{ maxWidth: 200 }}
            value={displayName}
            maxLength={180}
            placeholder="Label (optional)"
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Button
            variant="enterprise"
            size="sm"
            data-identity-mapping-link
            disabled={
              !subjectUserId ||
              !externalSubjectId.trim() ||
              busyRow === `new:${subjectUserId}`
            }
            onClick={() => void link()}
 >
            Link identity
          </Button>
        </div>
        {rowResult && rowResult.rowId.startsWith("new:") ? (
          <div
            data-identity-mapping-link-result={rowResult.ok ? "ok" : "failed"}
            className="adm-help" style={{ marginTop: 8,
              color: rowResult.ok ? "var(--success-strong)" : "var(--danger-strong)" }}
 >
            {rowResult.message}
          </div>
        ) : null}
      </Card>

      <div data-identity-mappings-table>
        <DataTable<Mapping>
          ariaLabel="External identity mappings"
          columns={columns}
          rows={(rows ?? []) as Mapping[]}
          getRowId={(m) => m.id}
          loading={rows === null}
          emptyState={
            failure ? (
              <EmptyState variant="inline"
                title="Mappings unavailable"
                purpose={failure.message}
              />
            ) : (
              <EmptyState variant="inline"
                title="No external identity mappings"
                purpose="Nobody in this workspace has a recorded identity-provider subject yet. Link one above, or let SSO/SCIM record them as people sign in."
              />
            )
          }
          rowActions={(m) =>
            m.unlinkedAtUtc ? (
              <span className="adm-help">unlinked {fmt(m.unlinkedAtUtc)}</span>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                data-identity-mapping-unlink={m.id}
                disabled={busyRow === m.id}
                onClick={() => void unlink(m)}
 >
                Unlink
              </Button>
            )
          }
        />
      </div>
    </PageSection>
  );
}
