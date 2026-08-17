"use client";

/**
 * PHASE 13 — Trusted CAPTURE devices (registry + revocation).
 *
 * The "Trusted devices" table on the Security Center manages the
 * identity-security step-up registry (`/v1/identity-security/devices`).
 * The CAPTURE trust registry is a different set of rows entirely — the
 * signing devices registered by `POST /v1/capture/devices`, whose keys
 * sign at-source capture payloads — and nothing in the web app addressed
 * it, so a lost or compromised capture device could never be revoked from
 * the product.
 *
 *   GET  /v1/capture/devices?includeRevoked=true
 *          → { devices: [{ id, label, deviceModel, osVersion, appVersion,
 *                          signatureAlgorithm, attestationProvider,
 *                          registeredAtUtc, lastSeenAtUtc,
 *                          revokedAtUtc, revocationReason }] }
 *   POST /v1/capture/devices/:id/revoke
 *          body { reason: OPERATOR_REQUESTED | LOST | STOLEN | COMPROMISED
 *                        | DECOMMISSIONED | ATTESTATION_FAILED | POLICY }
 *          200 { revokedAtUtc }
 *          409 { denial: DEVICE_NOT_FOUND | DEVICE_ALREADY_REVOKED }
 *          404 no active workspace context / not a member (anti-enumeration)
 *
 * Both routes resolve the workspace SERVER-side from the caller's active
 * workspace pointer, so no teamId travels in the request; the section is
 * still gated on an active workspace client-side so it is never shown in a
 * context where it could not act.
 *
 * Revocation is irreversible — the row can never return to ACTIVE — so it
 * requires an explicit typed confirmation, and the reason is a required
 * field validated before the confirm dialog opens.
 *
 * Privacy: `publicKeyFingerprint` is deliberately NOT rendered.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { formatUtcAuditDateTime } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { PageSection } from "../../../../components/ui/PageShell";
import { StatusBadge } from "../../../../components/ui/StatusBadge";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";

type CaptureDevice = {
  id: string;
  label: string;
  deviceModel: string;
  osVersion: string;
  appVersion: string;
  signatureAlgorithm: string;
  attestationProvider: string;
  registeredAtUtc: string;
  lastSeenAtUtc: string | null;
  revokedAtUtc: string | null;
  revocationReason: string | null;
};

/** Mirrors `RevokeDeviceBody` in services/api/src/routes/capture-trust.routes.ts. */
const REVOCATION_REASONS = [
  { value: "LOST", label: "Lost" },
  { value: "STOLEN", label: "Stolen" },
  { value: "COMPROMISED", label: "Compromised" },
  { value: "DECOMMISSIONED", label: "Decommissioned" },
  { value: "ATTESTATION_FAILED", label: "Attestation failed" },
  { value: "POLICY", label: "Policy" },
  { value: "OPERATOR_REQUESTED", label: "Operator requested" },
] as const;

type LoadState = "loading" | "ready" | "denied" | "failed";

type ErrorLike = { statusCode?: number; details?: Record<string, unknown> };

function statusOf(err: unknown): number {
  const e = err as ErrorLike | null;
  return typeof e?.statusCode === "number" ? e.statusCode : 0;
}

function denialOf(err: unknown): string | null {
  const e = err as ErrorLike | null;
  const d = e?.details?.["denial"];
  return typeof d === "string" ? d : null;
}

export function CaptureDevicesSection({ teamId }: { teamId: string | null }) {
  const { confirm } = useConfirmAction();

  const [devices, setDevices] = useState<ReadonlyArray<CaptureDevice>>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Stale-response protection for BOTH the list read and the mutation.
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const actionSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!teamId) return;
    const seq = ++loadSeqRef.current;
    setLoadState("loading");
    try {
      const res = await apiFetch("/v1/capture/devices?includeRevoked=true", {
        method: "GET",
      });
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setDevices(Array.isArray(res?.devices) ? (res.devices as CaptureDevice[]) : []);
      setLoadState("ready");
    } catch (err) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      const status = statusOf(err);
      setDevices([]);
      setLoadState(status === 403 || status === 404 ? "denied" : "failed");
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async (device: CaptureDevice) => {
      if (revokingId) return;
      const reason = reasons[device.id] ?? "";
      if (!reason) {
        setFieldError((prev) => ({
          ...prev,
          [device.id]: "Choose why this device is being revoked.",
        }));
        return;
      }
      setFieldError((prev) => {
        const next = { ...prev };
        delete next[device.id];
        return next;
      });

      // Irreversible — an explicit, typed confirmation.
      const ok = await confirm({
        title: "Revoke this capture device?",
        description:
          "Signatures produced by this device stop being accepted for new capture immediately. Evidence already ingested keeps its recorded provenance. A revoked device cannot be reinstated — a replacement must be registered.",
        confirmLabel: "Revoke device",
        cancelLabel: "Keep device",
        tone: "danger",
        requireConfirmText: "REVOKE",
        testId: "capture-device-revoke",
      });
      if (!ok || !mountedRef.current) return;

      const seq = ++actionSeqRef.current;
      setRevokingId(device.id);
      setNotice(null);
      setProblem(null);
      try {
        await apiFetch(
          `/v1/capture/devices/${encodeURIComponent(device.id)}/revoke`,
          { method: "POST", body: JSON.stringify({ reason }) },
        );
        if (!mountedRef.current || seq !== actionSeqRef.current) return;
        setNotice(`Capture device "${device.label}" is revoked.`);
        // Success refreshes the underlying data.
        await load();
      } catch (err) {
        if (!mountedRef.current || seq !== actionSeqRef.current) return;
        const status = statusOf(err);
        const denial = denialOf(err);
        if (status === 403) {
          /**
           * PHASE 13 (NEW-053) — the workspace resolver answers 403 with
           * `WORKSPACE_NOT_FOUND` for BOTH "you lack the permission" and "this
           * is a Personal Space, which has no device registry". Telling the
           * second user they lack a permission sends them to ask an admin for
           * something no admin can grant. The denial code separates them.
           */
          setProblem(
            denial === "WORKSPACE_NOT_FOUND"
              ? "Capture devices belong to a shared workspace. Switch out of your Personal Space, or ask an admin for access to this workspace."
              : "You do not have permission to revoke capture devices in this workspace.",
          );
        } else if (status === 404) {
          setProblem(
            "This workspace context could not be confirmed. Switch workspace and try again.",
          );
        } else if (status === 409 && denial === "DEVICE_ALREADY_REVOKED") {
          setProblem("That device was already revoked. Refreshing the list.");
          await load();
        } else if (status === 409) {
          setProblem("That device is no longer in this workspace registry.");
          await load();
        } else if (status === 400) {
          setFieldError((prev) => ({
            ...prev,
            [device.id]: "That revocation reason was not accepted.",
          }));
        } else {
          setProblem(
            toSafeUserError(err, {
              message:
                "The device could not be revoked. Nothing was changed — try again shortly.",
            }).message,
          );
        }
      } finally {
        if (mountedRef.current && seq === actionSeqRef.current) {
          setRevokingId(null);
        }
      }
    },
    [confirm, load, reasons, revokingId],
  );

  if (!teamId) return null;

  return (
    <PageSection title="Capture devices">
      <Card variant="admin" data-cc-capture-devices-card>
        <p style={mutedStyle}>
          Devices whose keys sign evidence at the moment of capture. Revoking
          one stops new signatures from being accepted; already-ingested
          evidence keeps the provenance it was recorded with.
        </p>

        {/* Screen-reader status channel for load + mutation outcomes. */}
        <div
          role="status"
          aria-live="polite"
          data-cc-capture-devices-status
          style={notice || problem ? statusStyle : srOnlyStyle}
        >
          {revokingId ? "Revoking capture device…" : null}
          {!revokingId && problem ? problem : null}
          {!revokingId && !problem && notice ? notice : null}
        </div>

        {loadState === "loading" ? (
          <p style={mutedStyle} aria-busy>
            Loading capture devices…
          </p>
        ) : loadState === "denied" ? (
          <p style={mutedStyle} data-cc-capture-devices-denied>
            Capture device administration is not available for your role in
            this workspace.
          </p>
        ) : loadState === "failed" ? (
          <p style={mutedStyle} data-cc-capture-devices-failed>
            The capture device registry could not be read. Reload the page to
            try again.
          </p>
        ) : devices.length === 0 ? (
          <EmptyState
            compact
            title="No capture devices registered"
            purpose="Devices registered through the mobile capture flow appear here. Revoke one to stop accepting its at-source signatures."
          />
        ) : (
          <ul style={listStyle} aria-label="Capture devices">
            {devices.map((d) => {
              const active = d.revokedAtUtc === null;
              const busy = revokingId === d.id;
              return (
                <li
                  key={d.id}
                  style={rowStyle}
                  data-cc-capture-device-row
                  data-cc-capture-device-status={active ? "ACTIVE" : "REVOKED"}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {d.label}{" "}
                      <StatusBadge status={active ? "ACTIVE" : "REVOKED"} />
                    </div>
                    <div style={mutedStyle}>
                      {d.deviceModel} · {d.osVersion} · app {d.appVersion} ·{" "}
                      {d.signatureAlgorithm}
                    </div>
                    <div style={mutedStyle}>
                      registered {formatUtcAuditDateTime(d.registeredAtUtc)}
                      {d.lastSeenAtUtc
                        ? ` · last seen ${formatUtcAuditDateTime(d.lastSeenAtUtc)}`
                        : null}
                      {d.revokedAtUtc
                        ? ` · revoked ${formatUtcAuditDateTime(d.revokedAtUtc)}${
                            d.revocationReason ? ` (${d.revocationReason})` : ""
                          }`
                        : null}
                    </div>
                  </div>

                  {active ? (
                    <div style={actionCellStyle} aria-busy={busy}>
                      <label
                        htmlFor={`capture-revoke-reason-${d.id}`}
                        style={srOnlyStyle}
                      >
                        Revocation reason for {d.label}
                      </label>
                      <select
                        id={`capture-revoke-reason-${d.id}`}
                        data-cc-capture-device-reason
                        value={reasons[d.id] ?? ""}
                        disabled={busy}
                        aria-invalid={fieldError[d.id] ? true : undefined}
                        onChange={(e) => {
                          const value = e.target.value;
                          setReasons((prev) => ({ ...prev, [d.id]: value }));
                          setFieldError((prev) => {
                            const next = { ...prev };
                            delete next[d.id];
                            return next;
                          });
                        }}
                        style={selectStyle}
                      >
                        <option value="">Reason…</option>
                        {REVOCATION_REASONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      {/*
                        PHASE 13 (NEW-069) — A BUSY CONTROL KEEPS ITS NAME.

                        This button used `disabled={busy}` and swapped its
                        children to "Revoking…". Both halves of that are wrong
                        against the contract of the component it is using —
                        `Button`'s own docblock: "Both keep an accessible name
                        and `aria-busy` while loading."

                          * `disabled` alone never sets `aria-busy`, so nothing
                            told assistive technology the action was in flight.
                            (`loading` is what sets it; `Button.tsx:154`.)
                          * Replacing the children replaced the control's
                            ACCESSIBLE NAME mid-action. A screen-reader user
                            asking "what is focused?" got a different control
                            name than the one they activated, and any consumer
                            addressing the button by name lost it entirely the
                            moment it became busy.

                        `loading` fixes both: it renders the spinner (so the
                        visual busy cue survives), sets `aria-busy="true"`, and
                        disables the button — while the name stays "Revoke".
                      */}
                      <Button
                        variant="destructive"
                        size="sm"
                        loading={busy}
                        disabled={busy}
                        onClick={() => void revoke(d)}
                      >
                        Revoke
                      </Button>
                      {fieldError[d.id] ? (
                        <p
                          role="alert"
                          data-cc-capture-device-reason-error
                          style={errorTextStyle}
                        >
                          {fieldError[d.id]}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </PageSection>
  );
}

const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 8px",
  borderBottom: "1px solid #e2e8f0",
  flexWrap: "wrap",
};
const actionCellStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};
const selectStyle: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 12,
};
const errorTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "#b91c1c",
  flexBasis: "100%",
};
const statusStyle: React.CSSProperties = {
  margin: "8px 0",
  padding: "8px 10px",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 13,
  color: "#0f172a",
};
const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
