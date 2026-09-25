/**
 * MFA RECOVERY — the CREATE leg, as a panel.
 *
 * The verify leg and the admin approve/reject legs were wired long before
 * anything in the product could FILE a request. Native had neither half: it
 * could not file one and could not land on the emailed link. Both exist now,
 * and this is the half a locked-out user reaches first.
 *
 * `POST /v1/identity/mfa-admin/recovery-requests` sits behind `requireAuth`,
 * and `requireAuth` REFUSES an MFA-pending token — a client sitting on the
 * login-time challenge has no session yet. So the panel resolves its own
 * eligibility with `GET /v1/auth/session-light` and renders the submit control
 * DISABLED with the reason spelled out, rather than offering a control that
 * would 401 on tap.
 *
 * A 409 is not a failure: it means a request is already in flight and it
 * carries that request's id, which is the only route to the resend control for
 * a user whose verification email never arrived.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
} from "./index";
import {
  MFA_RECOVERY_CREATE_PATH,
  SESSION_LIGHT_PATH,
  buildRecoveryCancelPath,
  buildRecoveryRequestBody,
  buildRecoveryResendPath,
  classifyCreateFailure,
  createFailureMessage,
  inFlightRequestIdFrom,
  isValidRecoveryReason,
  parseRecoveryRequest,
  parseSessionProbe,
  recoveryReasonHint,
  parseRecoveryWorkspaces,
  RECOVERY_WORKSPACES_PATH,
  buildRecoveryDetailPath,
  parseRecoveryDetail,
  recoveryStatusLine,
  recoveryResendBlocked,
  recoveryCancelBlocked,
  recoveryResendFailure,
  recoveryCancelFailure,
  type RecoveryDetail,
  NO_RECOVERY_WORKSPACE,
  type RecoveryWorkspace,
} from "../product/mfa-recovery";
import { ProovraConfirmSheet, ProovraFilterChips } from "./patterns";
import { formatUserDateTime } from "../lib/date";

type Eligibility = "checking" | "eligible" | "no_session" | "no_workspace";

export function MfaRecoveryRequestPanel({ teamId }: { teamId: string | null }) {
  const [eligibility, setEligibility] = useState<Eligibility>(
    teamId ? "eligible" : "checking",
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"info" | "error">("info");
  // Without an active workspace (the MFA challenge), the caller chooses one —
  // the workspace whose administrator reviews the request.
  const [workspaces, setWorkspaces] = useState<RecoveryWorkspace[]>([]);
  const [chosenTeamId, setChosenTeamId] = useState<string | null>(null);
  const effectiveTeamId = teamId ?? chosenTeamId;

  useEffect(() => {
    if (teamId) {
      setEligibility("eligible");
      return;
    }
    let alive = true;
    void (async () => {
      let authenticated = false;
      try {
        authenticated = parseSessionProbe(await apiFetch(SESSION_LIGHT_PATH));
      } catch {
        authenticated = false;
      }
      if (!alive) return;
      if (!authenticated) {
        setEligibility("no_session");
        return;
      }
      try {
        const rows = parseRecoveryWorkspaces(await apiFetch(RECOVERY_WORKSPACES_PATH));
        if (!alive) return;
        setWorkspaces(rows);
        if (rows.length === 0) {
          setEligibility("no_workspace");
          return;
        }
        setChosenTeamId((prev) => prev ?? rows[0]!.id);
        setEligibility("eligible");
      } catch {
        if (alive) setEligibility("no_workspace");
      }
    })();
    return () => {
      alive = false;
    };
  }, [teamId]);

  const file = useCallback(async () => {
    const teamId = effectiveTeamId;
    if (!teamId || !isValidRecoveryReason(reason)) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch(MFA_RECOVERY_CREATE_PATH, {
        method: "POST",
        body: JSON.stringify(buildRecoveryRequestBody(teamId, reason)),
      });
      const ref = parseRecoveryRequest(res);
      setRequestId(ref?.id ?? null);
      setReason("");
      setTone("info");
      setMessage(
        "Request filed. Check your email for a verification link, then an administrator will review it.",
      );
    } catch (err) {
      // A 409 carries the id of the request already in flight. Dropping it
      // would leave a user with a lost verification email blocked with no way
      // forward — the exact state this family exists to get them out of.
      const existing = inFlightRequestIdFrom(err);
      if (existing) {
        setRequestId(existing);
        setTone("info");
        setMessage("You already have a recovery request in flight.");
      } else {
        setTone("error");
        setMessage(createFailureMessage(classifyCreateFailure(err)));
      }
    } finally {
      setBusy(false);
    }
  }, [effectiveTeamId, reason]);

  /**
   * The filed request, read back (T-15). Every change is confirmed by a
   * reread before it is announced — the server, not the tap, decides whether
   * the email went out or the request is cancelled.
   */
  const [detail, setDetail] = useState<
    { kind: "loading" } | { kind: "ready"; d: RecoveryDetail } | { kind: "gone" } | { kind: "failed" }
  >({ kind: "loading" });
  const [nextResendAfter, setNextResendAfter] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const readDetail = useCallback(async (id: string): Promise<RecoveryDetail | null | undefined> => {
    try {
      const d = parseRecoveryDetail(await apiFetch(buildRecoveryDetailPath(id)));
      setDetail(d ? { kind: "ready", d } : { kind: "gone" });
      return d;
    } catch (err) {
      if ((err as { statusCode?: number } | null)?.statusCode === 404) {
        setDetail({ kind: "gone" });
        return null;
      }
      setDetail({ kind: "failed" });
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (!requestId) return;
    setDetail({ kind: "loading" });
    void readDetail(requestId);
  }, [requestId, readDetail]);

  const resend = useCallback(async () => {
    if (!requestId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      let after: string | null = null;
      try {
        const res = await apiFetch(buildRecoveryResendPath(requestId), { method: "POST", body: JSON.stringify({}) });
        const n = (res as { nextResendAfter?: unknown } | null)?.nextResendAfter;
        after = typeof n === "string" ? n : null;
      } catch (err) {
        const f = recoveryResendFailure(err, formatUserDateTime);
        if (f.until) setNextResendAfter(f.until);
        setTone("error");
        setMessage(f.message);
        await readDetail(requestId);
        return;
      }
      const reread = await readDetail(requestId);
      setNextResendAfter(after);
      if (reread && reread.status === "EMAIL_VERIFICATION_PENDING") {
        setTone("info");
        setMessage(
          after
            ? `A new verification link was sent to your email. You can request another after ${formatUserDateTime(after)}.`
            : "A new verification link was sent to your email.",
        );
      } else {
        setTone("error");
        setMessage(
          reread === undefined
            ? "The email was requested, but your request could not be reloaded to confirm it. Refresh before trying again."
            : "The email was requested, but your request is no longer waiting for email confirmation.",
        );
      }
    } finally {
      setBusy(false);
    }
  }, [requestId, busy, readDetail]);

  const cancel = useCallback(async () => {
    if (!requestId || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      try {
        await apiFetch(buildRecoveryCancelPath(requestId), { method: "POST", body: JSON.stringify({}) });
      } catch (err) {
        setTone("error");
        setMessage(recoveryCancelFailure(err));
        await readDetail(requestId);
        return;
      }
      const reread = await readDetail(requestId);
      if (reread && reread.status === "CANCELLED") {
        // Back to idle: a new request can be filed.
        setRequestId(null);
        setNextResendAfter(null);
        setTone("info");
        setMessage("Your recovery request was cancelled. You can file a new one below.");
      } else {
        setTone("error");
        setMessage(
          reread === undefined
            ? "The cancellation was sent, but your request could not be reloaded to confirm it. Refresh before filing a new one."
            : "The cancellation was sent, but your request does not show as cancelled yet. Refresh before filing a new one.",
        );
      }
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  }, [requestId, busy, readDetail]);

  const hint = recoveryReasonHint(reason);

  return (
    <ProovraCard>
      <ProovraText variant="body" weight="semibold">
        Lost your authenticator?
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.muted}>
        File a recovery request for an administrator in your organization to review. It does not
        sign you in or reset your second factor by itself.
      </ProovraText>

      {eligibility === "no_session" ? (
        // Stated, not a control that would 401 on tap.
        <ProovraText variant="label" color={theme.color.status.pending.fg}>
          {createFailureMessage("not_eligible")}
        </ProovraText>
      ) : null}

      {eligibility === "no_workspace" ? (
        <ProovraText variant="label" color={theme.color.status.pending.fg}>
          {NO_RECOVERY_WORKSPACE}
        </ProovraText>
      ) : null}

      {eligibility === "eligible" && !requestId ? (
        <>
          {!teamId && workspaces.length > 0 ? (
            <ProovraFilterChips<string>
              label="Workspace"
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
              value={chosenTeamId ?? ""}
              onChange={setChosenTeamId}
              disabled={busy}
            />
          ) : null}
          <ProovraFormField label="What happened">
            <ProovraInput
              value={reason}
              onChangeText={setReason}
              placeholder="Describe how you lost access to your authenticator"
              multiline
              autoCapitalize="sentences"
              accessibilityLabel="What happened"
            />
          </ProovraFormField>
          {hint ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {hint}
            </ProovraText>
          ) : null}
          <ProovraButton
            label="File recovery request"
            loading={busy}
            disabled={!effectiveTeamId || !isValidRecoveryReason(reason)}
            onPress={() => void file()}
          />
        </>
      ) : null}

      {requestId ? (
        <View style={{ gap: theme.space.s2 }} testID="mfa-recovery-status">
          <ProovraText variant="bodySm" weight="semibold">Your recovery request</ProovraText>
          {detail.kind === "loading" ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>Loading your recovery request…</ProovraText>
          ) : detail.kind === "gone" ? (
            <ProovraText variant="label" color={theme.color.ink.secondary}>This recovery request is no longer available.</ProovraText>
          ) : detail.kind === "failed" ? (
            <>
              <ProovraText variant="label" color={theme.color.status.risk.fg}>
                Your recovery request could not be loaded. Refresh to try again.
              </ProovraText>
              <ProovraButton label="Retry" variant="secondary" fullWidth={false} onPress={() => void readDetail(requestId)} />
            </>
          ) : (
            (() => {
              const d = detail.d;
              const resendBlocked = recoveryResendBlocked(d, nextResendAfter, Date.now(), formatUserDateTime);
              const cancelBlocked = recoveryCancelBlocked(d);
              return (
                <>
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {`${recoveryStatusLine(d)}${d.expiresAt ? ` Expires ${formatUserDateTime(d.expiresAt)}.` : ""}`}
                  </ProovraText>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                    <ProovraButton
                      label={busy ? "Sending…" : "Resend verification email"}
                      accessibilityLabel="Resend verification email"
                      variant="secondary"
                      fullWidth={false}
                      disabled={busy || resendBlocked !== null}
                      onPress={() => void resend()}
                    />
                    <ProovraButton
                      label="Cancel request"
                      variant="ghost"
                      fullWidth={false}
                      disabled={busy || cancelBlocked !== null}
                      onPress={() => setConfirmCancel(true)}
                    />
                  </View>
                  {resendBlocked ? <ProovraText variant="label" color={theme.color.ink.muted}>{resendBlocked}</ProovraText> : null}
                  {cancelBlocked ? <ProovraText variant="label" color={theme.color.ink.muted}>{cancelBlocked}</ProovraText> : null}
                </>
              );
            })()
          )}
        </View>
      ) : null}

      <ProovraConfirmSheet
        visible={confirmCancel}
        title="Cancel this recovery request?"
        consequence="The request is withdrawn and any verification link stops working. You can file a new request afterwards."
        confirmLabel="Cancel request"
        cancelLabel="Keep request"
        tone="danger"
        busy={busy}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => void cancel()}
      />

      {message ? (
        <ProovraText
          variant="label"
          color={tone === "error" ? theme.color.status.risk.fg : theme.color.ink.secondary}
        >
          {message}
        </ProovraText>
      ) : null}
    </ProovraCard>
  );
}
