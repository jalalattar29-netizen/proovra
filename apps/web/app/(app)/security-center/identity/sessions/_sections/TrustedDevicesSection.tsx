"use client";

/**
 * PHASE 12B — Trusted devices section. Product surface for
 *
 *   GET  /v1/identity-security/devices?teamId       (inventory — had no consumer)
 *   POST /v1/identity-security/devices/trust        (worklist item — had no consumer)
 *   POST /v1/identity-security/devices/:id/revoke   (had no consumer)
 *
 * WHAT "TRUST THIS DEVICE" MEANS HERE
 *   The trust action is SELF-ONLY and applies to the browser you are using
 *   right now. The server derives BOTH the subject (your session) and the
 *   device correlation value (an HTTP-only cookie it mints and reads itself).
 *   This page therefore sends NO user id and NO device secret: there is no
 *   field for either, and there is nothing device-secret to leak into the
 *   DOM, a URL, localStorage or a log.
 *
 *   You cannot mark a device trusted on someone else's behalf — you were
 *   never holding their device. To clear another member's trusted devices,
 *   use "Reset trusted devices" in the Security Center.
 *
 * WHO MAY REMOVE TRUST (closure 2, "sem" item 3 — the server decides it)
 *   - Your OWN device: any member, no extra factor (it only takes a
 *     convenience away), so a "self" list offers "Remove trust" too.
 *   - ANOTHER member's device: an identity administrator who outranks them,
 *     with a step-up bound to that device; the server asks for it (401
 *     STEP_UP_REQUIRED) and the step-up modal answers it.
 *
 * The projection carries UA / network PREVIEWS only; the device id hash and
 * the IP hash are never returned by the server.
 */

import { identifierLabel } from "@proovra/shared";
import { useCallback, useEffect, useState } from "react";

import { describeClient } from "../../../../../../lib/ui/describeClient";
import { apiFetch } from "../../../../../../lib/api";
import { notifyApiError } from "../../../../../../lib/feedback/notify";
import { useTeamId, useTenantGuard } from "../../../../../../lib/platform-context";
import { useOptionalPlatformContext } from "../../../../../../lib/platform-context/PlatformContextProvider";
import { useToast } from "../../../../../../components/ui";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { Card } from "../../../../../../components/ui/Card";
import { useConfirmAction } from "../../../../../../components/ui/ConfirmActionModal";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../components/ui/DataTable";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import { PageSection } from "../../../../../../components/ui/PageShell";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../../components/identity-security/StepUpModal";
import {
  NoWorkspaceSelected,
  SectionDenied,
  SectionPlanGated,
  SectionError,
  SectionLoading,
  classifyError,
  sectionInputStyle,
  sectionLabelStyle,
  sectionMuted,
  type SectionState,
} from "../../../posture/_sections/section-state";
import { formatCellDateTime } from "../../../../../../lib/date";
import { shortId } from "../../_sections/identity-admin-shared";
import {
  readTelemetryScope,
  trustedDeviceOffersRemoveTrust,
  type TelemetryScope,
} from "../../../../../../lib/identity/telemetry-scope";

type TrustedDevice = {
  id: string;
  userId: string;
  uaPreview: string | null;
  ipPreview: string | null;
  status: string;
  trustedUntilUtc: string;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  revokedAtUtc: string | null;
};

export function TrustedDevicesSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });
  const viewerUserId = useOptionalPlatformContext()?.envelope?.user?.id ?? null;

  const [state, setState] = useState<SectionState<TrustedDevice[]>>({
    kind: "loading",
  });
  const [ttlDays, setTtlDays] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);
  // B1-F-003 — a read-only role reads only its own devices (`scope: "self"`);
  // trusting needs the administrator permission; removing trust from one's
  // OWN device does not (closure 2, "sem" item 3).
  const [scope, setScope] = useState<TelemetryScope>("legacy");

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ kind: "loading" });
    const captured = stamp();
    try {
      const res = (await apiFetch(
        `/v1/identity-security/devices?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { devices?: TrustedDevice[]; scope?: unknown } | null;
      if (isStale(captured)) return;
      setScope(readTelemetryScope(res));
      setState({ kind: "ready", data: res?.devices ?? [] });
    } catch (err) {
      if (isStale(captured)) return;
      setState(
        classifyError<TrustedDevice[]>(err, "We couldn't load the trusted devices."),
      );
    }
  }, [teamId, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const trustThisDevice = useCallback(async () => {
    if (!teamId) return;
    const ok = await confirm({
      title: "Trust the browser you are using now?",
      // PRO-A1Z-03 — trust is recorded and listed; no sign-in or step-up
      // decision reads it today, so the copy says only what it does.
      description: `This browser is recorded as one you recognise for ${ttlDays} day${
        ttlDays === 1 ? "" : "s"
      }. You will still be asked for your second factor as usual. It applies to your own account only.`,
      confirmLabel: "Trust this browser",
      tone: "warning",
      testId: "trusted-device-trust-self",
    });
    if (!ok) return;
    const captured = stamp();
    setBusy("trust-self");
    try {
      await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/identity-security/devices/trust", {
          method: "POST",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          // No userId, no device secret — the server derives both.
          body: JSON.stringify({ teamId, ttlDays }),
        }),
      );
      if (isStale(captured)) return;
      addToast("This browser is now a trusted device for your account.", "success");
      await load();
    } catch (err) {
      if (isStale(captured)) return;
      const code = ((err as { code?: string }).code ?? "").toUpperCase();
      if (code === "STEP_UP_CANCEL") return;
      notifyApiError(addToast, err, {
        message: "We couldn't trust this browser.",
      });
    } finally {
      setBusy(null);
    }
  }, [teamId, ttlDays, confirm, stepUp, stamp, isStale, addToast, load]);

  const revokeDevice = useCallback(
    async (device: TrustedDevice) => {
      if (!teamId) return;
      const own = scope === "self" || device.userId === viewerUserId;
      const ok = await confirm({
        title: own ? "Stop trusting your device?" : "Stop trusting this device?",
        description: own
          ? "You will be asked for your second factor again on that device the next time the policy requires one."
          : "The member using this device will be asked for their second factor again the next time the policy requires one. You will confirm with your own second factor first.",
        confirmLabel: "Remove trust",
        tone: "danger",
        testId: `trusted-device-revoke-${device.id}`,
      });
      if (!ok) return;
      const captured = stamp();
      setBusy(`revoke-${device.id}`);
      try {
        // Another member's device needs the operator's step-up (the server
        // answers 401 STEP_UP_REQUIRED and the modal retries once); one's own
        // device is removed straight away.
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(
            `/v1/identity-security/devices/${encodeURIComponent(device.id)}/revoke`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({
                teamId,
                reason: own ? "Member removed trust from their own device" : "Operator removed device trust",
              }),
            },
          ),
        );
        if (isStale(captured)) return;
        addToast("Device trust removed.", "success");
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        const code = ((err as { code?: string }).code ?? "").toUpperCase();
        if (code === "STEP_UP_CANCEL") return;
        notifyApiError(addToast, err, {
          message: "We couldn't remove trust from that device.",
        });
      } finally {
        setBusy(null);
      }
    },
    [teamId, scope, viewerUserId, confirm, stepUp, stamp, isStale, addToast, load],
  );

  const description =
    "Browsers recorded as recognised in this workspace, and until when. Recording a browser does not skip any second-factor prompt. Only network and browser PREVIEWS are stored — no device fingerprint, no raw address, no secret. Trusting a device applies to your own account and the browser you are using now; it can never be done on another member's behalf.";

  if (!teamId) {
    return (
      <PageSection title="Trusted devices" description={description}>
        <NoWorkspaceSelected purpose="Switch to a workspace to review its trusted devices." />
      </PageSection>
    );
  }
  if (state.kind === "loading") {
    return (
      <PageSection title="Trusted devices" description={description}>
        <SectionLoading label="Reading trusted devices…" />
      </PageSection>
    );
  }
  if (state.kind === "denied") {
    return (
      <PageSection title="Trusted devices" description={description}>
        <SectionDenied message={state.message} />
      </PageSection>
    );
  }
  if (state.kind === "plan_gated") {
    return (
      <PageSection title="Trusted devices" description={description}>
        <SectionPlanGated
            message={state.message}
            feature={state.feature}
            upgradeCta={state.upgradeCta}
          />
      </PageSection>
    );
  }
  if (state.kind === "error") {
    return (
      <PageSection title="Trusted devices" description={description}>
        <SectionError message={state.message} onRetry={() => void load()} />
      </PageSection>
    );
  }

  const columns: DataTableColumn<TrustedDevice>[] = [
    {
      key: "user",
      header: "Member",
      render: (d) => (
        <code className="adm-mono" title={d.userId}>
          {shortId(d.userId)}
        </code>
      ),
    },
    {
      key: "device",
      header: "Device",
      render: (d) => (
        <div style={{ fontSize: 11 }}>
          <div title={d.uaPreview ?? undefined}>
            {describeClient(d.uaPreview) ?? "Unrecognised client"}
          </div>
          <div style={sectionMuted}>{d.ipPreview ?? "no network preview"}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (d) => (
        <Badge tone={d.status === "ACTIVE" ? "verified" : "neutral"}>{identifierLabel(d.status)}</Badge>
      ),
    },
    {
      key: "until",
      header: "Trusted until",
      nowrap: true,
      render: (d) => <span style={sectionMuted}>{formatCellDateTime(d.trustedUntilUtc)}</span>,
    },
    {
      key: "seen",
      header: "Last seen",
      nowrap: true,
      render: (d) => <span style={sectionMuted}>{formatCellDateTime(d.lastSeenAtUtc)}</span>,
    },
  ];

  const selfScope = scope === "self";
  return (
    <PageSection
      title={selfScope ? "Your trusted devices" : "Trusted devices"}
      description={
        selfScope
          ? "Your own trusted devices in this workspace. You can remove trust from any of them. Workspace owners and admins manage every member's devices."
          : description
      }
      data-trusted-devices-section
      data-trusted-devices-scope={scope}
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      {selfScope ? null : (
      <Card padding="comfortable" style={{ marginBottom: 12 }}>
        <div
          style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}
        >
          <label style={{ maxWidth: 200 }}>
            <span style={sectionLabelStyle}>Trust this browser for (days)</span>
            <input
              type="number"
              min={1}
              max={180}
              value={ttlDays}
              onChange={(e) =>
                setTtlDays(
                  Math.min(180, Math.max(1, Number.parseInt(e.target.value, 10) || 1)),
                )
              }
              style={sectionInputStyle}
            />
          </label>
          <Button
            variant="secondary"
            loading={busy === "trust-self"}
            disabled={busy !== null}
            onClick={() => void trustThisDevice()}
            data-trusted-device-trust-self
          >
            Trust this browser
          </Button>
        </div>
        <p style={{ ...sectionMuted, margin: "8px 0 0" }}>
          A browser can be recorded for at most 180 days.
        </p>
      </Card>
      )}

      <DataTable
        columns={columns}
        rows={state.data}
        getRowId={(d) => d.id}
        ariaLabel="Trusted devices"
        emptyState={
          selfScope ? (
            <EmptyState variant="inline"
              title="You have no trusted devices"
              purpose="Your second factor is requested every time the policy calls for one."
            />
          ) : (
            <EmptyState variant="inline"
              title="No trusted devices"
              purpose="Nobody in this workspace has a trusted device, so the second factor is requested every time the policy calls for one."
            />
          )
        }
        rowActions={(d) =>
          d.status === "ACTIVE" && trustedDeviceOffersRemoveTrust(scope) ? (
            <Button
              variant="destructive"
              size="sm"
              loading={busy === `revoke-${d.id}`}
              disabled={busy !== null}
              onClick={() => void revokeDevice(d)}
            >
              Remove trust
            </Button>
          ) : null
        }
      />

      <StepUpModal control={stepUp} />
    </PageSection>
  );
}

export default TrustedDevicesSection;
