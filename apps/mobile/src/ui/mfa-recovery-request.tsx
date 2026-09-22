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
} from "../product/mfa-recovery";

type Eligibility = "checking" | "eligible" | "no_session";

export function MfaRecoveryRequestPanel({ teamId }: { teamId: string | null }) {
  const [eligibility, setEligibility] = useState<Eligibility>(
    teamId ? "eligible" : "checking",
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"info" | "error">("info");

  useEffect(() => {
    if (teamId) {
      setEligibility("eligible");
      return;
    }
    let alive = true;
    void apiFetch(SESSION_LIGHT_PATH)
      .then((d) => {
        if (alive) setEligibility(parseSessionProbe(d) ? "eligible" : "no_session");
      })
      .catch(() => {
        if (alive) setEligibility("no_session");
      });
    return () => {
      alive = false;
    };
  }, [teamId]);

  const file = useCallback(async () => {
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
  }, [teamId, reason]);

  const act = useCallback(
    async (kind: "resend" | "cancel") => {
      if (!requestId) return;
      setBusy(true);
      try {
        await apiFetch(
          kind === "resend"
            ? buildRecoveryResendPath(requestId)
            : buildRecoveryCancelPath(requestId),
          { method: "POST", body: JSON.stringify({}) },
        );
        setTone("info");
        setMessage(
          kind === "resend"
            ? "Verification email sent again."
            : "Recovery request cancelled. You can file a new one.",
        );
        if (kind === "cancel") setRequestId(null);
      } catch {
        setTone("error");
        setMessage(
          kind === "resend"
            ? "The email could not be sent again yet. Wait a little and try once more."
            : "The request could not be cancelled — an administrator may already have acted on it.",
        );
      } finally {
        setBusy(false);
      }
    },
    [requestId],
  );

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

      {eligibility === "eligible" && !requestId ? (
        <>
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
            disabled={!teamId || !isValidRecoveryReason(reason)}
            onPress={() => void file()}
          />
        </>
      ) : null}

      {requestId ? (
        <View style={{ flexDirection: "row", gap: theme.space.s2 }}>
          <ProovraButton
            label="Resend email"
            variant="secondary"
            fullWidth={false}
            loading={busy}
            onPress={() => void act("resend")}
          />
          <ProovraButton
            label="Cancel request"
            variant="ghost"
            fullWidth={false}
            loading={busy}
            onPress={() => void act("cancel")}
          />
        </View>
      ) : null}

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
