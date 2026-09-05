"use client";

/**
 * PHASE 12B — Service accounts (machine identities).
 *
 * Restricted enterprise section of the identity administration console:
 *
 *   GET    /v1/identity/service-accounts
 *   POST   /v1/identity/service-accounts/:id/disable
 *   POST   /v1/identity/service-accounts/:id/enable
 *   PATCH  /v1/identity/service-accounts/:id/hardening
 *
 * SECRET DISCIPLINE: the projection carries the key PREFIX and the hardening
 * surface only. No secret, hash or token is returned by these endpoints, so
 * none can be rendered, copied, stored or logged here. Issuing a credential
 * (the only moment a secret exists in plaintext) lives in the integrations
 * surface, not in this console.
 *
 * Visibility is decided by the SERVER: an operator without
 * `identity.service_account.manage` gets a denial from the list endpoint and
 * this section renders that denial explicitly — it never silently hides.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { useTenantGuard } from "../../../../../lib/platform-context";
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
  type RowResult,
  type SurfaceFailure,
} from "./identity-admin-shared";

type StepUpControl = {
  runStepUpAction: <T>(action: (headers?: Record<string, string>) => Promise<T>) => Promise<T>;
};

type ServiceAccount = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  expiresAtUtc: string | null;
  disabledAtUtc: string | null;
  rotationRequired: boolean;
  ipAllowlist: string[];
  environment: string | null;
  lastUsedAtUtc: string | null;
  createdAt: string;
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatUserDateTime(iso);
  } catch {
    return iso;
  }
}

export function ServiceAccountsSection({ stepUp }: { stepUp: StepUpControl }) {
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();

  const [rows, setRows] = useState<ReadonlyArray<ServiceAccount> | null>(null);
  const [failure, setFailure] = useState<SurfaceFailure | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [rowResult, setRowResult] = useState<RowResult | null>(null);
  const [hardeningFor, setHardeningFor] = useState<string | null>(null);
  const [ipAllowlistDraft, setIpAllowlistDraft] = useState("");
  const [environmentDraft, setEnvironmentDraft] = useState("");
  const [expiryDraft, setExpiryDraft] = useState("");
  const [rotationDraft, setRotationDraft] = useState(false);

  const load = useCallback(async () => {
    const captured = stamp();
    setFailure(null);
    try {
      const res = await apiFetch("/v1/identity/service-accounts", {
        method: "GET",
      });
      if (isStale(captured)) return;
      setRows((res?.serviceAccounts ?? []) as ReadonlyArray<ServiceAccount>);
    } catch (err) {
      if (isStale(captured)) return;
      setRows([]);
      setFailure(classifyFailure(err, "Unable to load service accounts."));
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

  const setEnabled = useCallback(
    async (account: ServiceAccount, enabled: boolean) => {
      const ok = await confirm({
        title: enabled ? "Re-enable this service account?" : "Disable this service account?",
        description: enabled
          ? "The credential can act again immediately, without a human present. Step-up confirmation is required."
          : "Every integration using this credential stops working immediately. The credential is retained, so it can be re-enabled.",
        confirmLabel: enabled ? "Re-enable" : "Disable",
        tone: enabled ? "warning" : "danger",
        testId: `identity-service-account-${enabled ? "enable" : "disable"}`,
      });
      if (!ok) return;
      await run(
        account.id,
        enabled ? "Service account re-enabled." : "Service account disabled.",
        `Could not ${enabled ? "re-enable" : "disable"} the service account.`,
        (headers) =>
          apiFetch(
            `/v1/identity/service-accounts/${account.id}/${enabled ? "enable" : "disable"}`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({}),
            },
          ),
      );
    },
    [confirm, run],
  );

  const openHardening = useCallback((account: ServiceAccount) => {
    setHardeningFor(account.id);
    setIpAllowlistDraft(account.ipAllowlist.join(", "));
    setEnvironmentDraft(account.environment ?? "");
    setExpiryDraft(account.expiresAtUtc ? account.expiresAtUtc.slice(0, 10) : "");
    setRotationDraft(account.rotationRequired);
  }, []);

  const saveHardening = useCallback(
    async (account: ServiceAccount) => {
      const allowlist = ipAllowlistDraft
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const expiresAtUtc = expiryDraft
        ? new Date(`${expiryDraft}T00:00:00.000Z`).toISOString()
        : null;
      await run(
        account.id,
        "Hardening updated.",
        "Could not update the hardening settings.",
        (headers) =>
          apiFetch(`/v1/identity/service-accounts/${account.id}/hardening`, {
            method: "PATCH",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({
              ipAllowlist: allowlist,
              environment: environmentDraft.trim() ? environmentDraft.trim() : null,
              expiresAtUtc,
              rotationRequired: rotationDraft,
            }),
          }),
      );
      setHardeningFor(null);
    },
    [ipAllowlistDraft, environmentDraft, expiryDraft, rotationDraft, run],
  );

  const columns: DataTableColumn<ServiceAccount>[] = [
    {
      key: "name",
      header: "Service account",
      render: (a) => (
        <div data-identity-service-account-row={a.id}>
          <strong style={{ fontSize: 13 }}>{a.name}</strong>
          <div className="adm-help">
            key <code>{a.keyPrefix}…</code>
          </div>
          {rowResult && rowResult.rowId === a.id ? (
            <div
              data-identity-service-account-result={rowResult.ok ? "ok" : "failed"}
              className="adm-help" style={{ color: rowResult.ok ? "var(--success-strong)" : "var(--danger-strong)" }}
            >
              {rowResult.message}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "state",
      header: "State",
      render: (a) => (
        <StatusBadge
          status={
            a.status === "REVOKED"
              ? "REVOKED"
              : a.disabledAtUtc
                ? "DISABLED"
                : "ACTIVE"
          }
        />
      ),
    },
    {
      key: "scopes",
      header: "Scopes",
      render: (a) => (
        <span className="adm-help" style={{ fontSize: 11 }}>
          {a.scopes.length > 0 ? a.scopes.join(", ") : "—"}
        </span>
      ),
    },
    {
      key: "hardening",
      header: "Hardening",
      render: (a) => (
        <span className="adm-help" style={{ fontSize: 11 }}>
          {a.environment ? `${a.environment} · ` : ""}
          {a.ipAllowlist.length > 0
            ? `${a.ipAllowlist.length} IP rule${a.ipAllowlist.length === 1 ? "" : "s"}`
            : "no IP restriction"}
          {a.rotationRequired ? " · rotation due" : ""}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      nowrap: true,
      render: (a) => <span className="adm-help">{fmt(a.expiresAtUtc)}</span>,
    },
    {
      key: "lastused",
      header: "Last used",
      nowrap: true,
      render: (a) => <span className="adm-help">{fmt(a.lastUsedAtUtc)}</span>,
    },
  ];

  const editing = rows?.find((r) => r.id === hardeningFor) ?? null;

  return (
    <PageSection
      title="Service accounts"
      description="Machine identities that act without a person present. Secrets are never shown here — only the key prefix, the scopes and the hardening posture."
      action={
        <Button
          variant="secondary"
          size="sm"
          data-identity-service-accounts-refresh
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
          data-identity-service-accounts-failure={failure.kind}
        >
          <strong>
            {failure.kind === "denied"
              ? "Restricted section"
              : failure.kind === "blocked"
                ? "Refused"
                : "Could not load"}
          </strong>
          <div style={{ marginTop: 4 }}>{failure.message}</div>
        </Card>
      ) : null}

      <div data-identity-service-accounts-table>
        <DataTable<ServiceAccount>
          ariaLabel="Service accounts"
          columns={columns}
          rows={(rows ?? []) as ServiceAccount[]}
          getRowId={(a) => a.id}
          loading={rows === null}
          emptyState={
            failure ? (
              <EmptyState variant="inline"
                title="Service accounts unavailable"
                purpose={failure.message}
              />
            ) : (
              <EmptyState variant="inline"
                title="No service accounts"
                purpose="No machine credentials are issued for this workspace. They are created in the integrations surface, where the secret is shown exactly once."
              />
            )
          }
          rowActions={(a) => (
            <div
              style={{
                display: "flex",
                gap: 4,
                flexWrap: "wrap",
                justifyContent: "flex-end",
              }}
            >
              {a.status === "REVOKED" ? (
                <span className="adm-help">revoked</span>
              ) : (
                <>
                  {a.disabledAtUtc ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      data-identity-service-account-enable={a.id}
                      disabled={busyRow === a.id}
                      onClick={() => void setEnabled(a, true)}
                    >
                      Re-enable
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      size="sm"
                      data-identity-service-account-disable={a.id}
                      disabled={busyRow === a.id}
                      onClick={() => void setEnabled(a, false)}
                    >
                      Disable
                    </Button>
                  )}
                  <Button
                    variant={hardeningFor === a.id ? "enterprise" : "ghost"}
                    size="sm"
                    data-identity-service-account-harden={a.id}
                    onClick={() =>
                      hardeningFor === a.id
                        ? setHardeningFor(null)
                        : openHardening(a)
                    }
                  >
                    Hardening
                  </Button>
                </>
              )}
            </div>
          )}
        />
      </div>

      {editing ? (
        <Card
          variant="admin"
          padding="comfortable"
          title={`Hardening — ${editing.name}`}
          data-identity-service-account-hardening-form={editing.id}
          style={{ marginTop: 12 }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 10,
            }}
          >
            <label className="adm-help">
              IP allowlist (comma-separated)
              <input
                data-identity-hardening-ip
                className="adm-input"
                value={ipAllowlistDraft}
                onChange={(e) => setIpAllowlistDraft(e.target.value)}
                placeholder="203.0.113.0/24, 198.51.100.7"
              />
            </label>
            <label className="adm-help">
              Environment label
              <input
                data-identity-hardening-environment
                className="adm-input"
                value={environmentDraft}
                maxLength={32}
                onChange={(e) => setEnvironmentDraft(e.target.value)}
                placeholder="production"
              />
            </label>
            <label className="adm-help">
              Expires (UTC date, empty clears)
              <input
                data-identity-hardening-expiry
                type="date"
                className="adm-input"
                value={expiryDraft}
                onChange={(e) => setExpiryDraft(e.target.value)}
              />
            </label>
            <label className="adm-help" style={{ alignSelf: "end" }}>
              <input
                data-identity-hardening-rotation
                type="checkbox"
                checked={rotationDraft}
                onChange={(e) => setRotationDraft(e.target.checked)}
              />{" "}
              Rotation required
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Button
              variant="enterprise"
              size="sm"
              data-identity-hardening-save={editing.id}
              disabled={busyRow === editing.id}
              onClick={() => void saveHardening(editing)}
            >
              Save hardening
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHardeningFor(null)}
            >
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}
    </PageSection>
  );
}
