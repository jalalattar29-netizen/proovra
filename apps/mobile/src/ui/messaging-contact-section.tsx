/**
 * MESSAGING CONTACT (T-15) — see src/product/messaging-contact.ts.
 * Touch adaptation: the channel listbox becomes chips. Responses issued under
 * a previous workspace are discarded, and a workspace switch resets the
 * journey, exactly as on the web.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  MESSAGING_CHANNELS,
  MESSAGING_COPY as COPY,
  MESSAGING_PREFERENCES_PATH,
  MESSAGING_VERIFY_CHECK_PATH,
  MESSAGING_VERIFY_START_PATH,
  buildPreferenceBody,
  checkFailure,
  codeReady,
  messagingChannelLabel,
  parseSavedPreference,
  parseVerifyCheck,
  parseVerifyStart,
  phoneReady,
  preferenceFailure,
  startFailure,
  type MessagingChannel,
  type SavedMessagingPreference,
  type VerificationAttemptView,
} from "../product/messaging-contact";
import { ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraText } from "./index";
import { ProovraFilterChips, ProovraPageSection } from "./patterns";

type Stage =
  | { kind: "IDLE" }
  | { kind: "CODE_SENT"; attempt: VerificationAttemptView }
  | { kind: "RATE_LIMITED" }
  | { kind: "VERIFIED"; recipientPreview: string | null };

const safe = (e: unknown, f: string) => toSafeUserError(e, { message: f }).message;

export function MessagingContactSection({ teamId }: { teamId: string | null }) {
  const activeTeamRef = useRef<string | null>(teamId);
  useEffect(() => {
    activeTeamRef.current = teamId;
  }, [teamId]);

  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<MessagingChannel>("SMS");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "IDLE" });
  const [busy, setBusy] = useState<null | "START" | "CHECK" | "SAVE_IN" | "SAVE_OUT">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedMessagingPreference | null>(null);

  const resetJourney = useCallback(() => {
    setStage({ kind: "IDLE" });
    setCode("");
    setSaved(null);
    setError(null);
    setNotice(null);
  }, []);
  // A workspace switch invalidates the whole journey.
  useEffect(() => {
    resetJourney();
  }, [teamId, resetJourney]);

  const start = async () => {
    if (!teamId || busy) return;
    const requestTeamId = teamId;
    setBusy("START");
    setError(null);
    setNotice(null);
    try {
      const out = parseVerifyStart(
        await apiFetch(MESSAGING_VERIFY_START_PATH, {
          method: "POST",
          body: JSON.stringify({ teamId: requestTeamId, channel, phone, purpose: "OTP" }),
        }),
      );
      if (requestTeamId !== activeTeamRef.current) return;
      if (out.kind === "rate_limited") setStage({ kind: "RATE_LIMITED" });
      else if (out.kind === "started") {
        setStage({ kind: "CODE_SENT", attempt: out.attempt });
        setCode("");
      } else setError(COPY.startUnusable);
    } catch (err) {
      if (requestTeamId !== activeTeamRef.current) return;
      setError(startFailure(err, safe));
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (!teamId || busy || stage.kind !== "CODE_SENT") return;
    const requestTeamId = teamId;
    const preview = stage.attempt.recipientPreview;
    setBusy("CHECK");
    setError(null);
    setNotice(null);
    try {
      // Forwarded verbatim; no copy kept beyond this call.
      const res = parseVerifyCheck(
        await apiFetch(MESSAGING_VERIFY_CHECK_PATH, {
          method: "POST",
          body: JSON.stringify({ teamId: requestTeamId, phone, code }),
        }),
      );
      if (requestTeamId !== activeTeamRef.current) return;
      setCode("");
      if (res.approved) {
        setStage({ kind: "VERIFIED", recipientPreview: preview });
        setNotice(COPY.confirmed);
      } else setError(COPY.denied);
    } catch (err) {
      if (requestTeamId !== activeTeamRef.current) return;
      setCode("");
      setError(checkFailure(err, safe));
    } finally {
      setBusy(null);
    }
  };

  const save = async (optIn: boolean) => {
    if (!teamId || busy) return;
    const requestTeamId = teamId;
    setBusy(optIn ? "SAVE_IN" : "SAVE_OUT");
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(MESSAGING_PREFERENCES_PATH, {
        method: "POST",
        body: JSON.stringify(buildPreferenceBody(requestTeamId, phone, channel, optIn)),
      });
      if (requestTeamId !== activeTeamRef.current) return;
      setSaved(parseSavedPreference(res, optIn, new Date().toISOString()));
      setNotice(optIn ? COPY.savedIn : COPY.savedOut);
    } catch (err) {
      if (requestTeamId !== activeTeamRef.current) return;
      setError(preferenceFailure(err, safe));
    } finally {
      setBusy(null);
    }
  };

  if (!teamId) {
    return (
      <ProovraPageSection title={COPY.title}>
        <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.noWorkspace}</ProovraText>
      </ProovraPageSection>
    );
  }

  const locked = stage.kind !== "IDLE";
  return (
    <ProovraPageSection title={COPY.title} description={COPY.intro}>
      <ProovraCard>
        <View style={{ gap: theme.space.s3 }} testID="messaging-contact-section">
          <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.intro2}</ProovraText>
          {error ? (
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{error}</ProovraText>
          ) : null}
          {notice ? <ProovraText variant="bodySm" color={theme.color.status.verified.fg}>{notice}</ProovraText> : null}

          {locked ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>{`${COPY.channel}: ${messagingChannelLabel(channel)}`}</ProovraText>
          ) : (
            <ProovraFilterChips<MessagingChannel> label={COPY.channel} options={MESSAGING_CHANNELS} value={channel} onChange={setChannel} />
          )}
          <ProovraFormField label={COPY.phone}>
            <ProovraInput
              value={phone}
              onChangeText={setPhone}
              editable={!locked}
              keyboardType="phone-pad"
              autoComplete="off"
              placeholder={COPY.phonePlaceholder}
            />
          </ProovraFormField>
          <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.phoneHelp}</ProovraText>

          {stage.kind === "IDLE" ? (
            <ProovraButton
              label={busy === "START" ? COPY.sending : COPY.send}
              accessibilityLabel={COPY.send}
              fullWidth={false}
              disabled={busy !== null || !phoneReady(phone)}
              onPress={() => void start()}
            />
          ) : null}

          {stage.kind === "RATE_LIMITED" ? (
            <View style={{ gap: theme.space.s2 }}>
              <ProovraText variant="bodySm" weight="semibold">{COPY.rateLimitedTitle}</ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.rateLimitedBody}</ProovraText>
              <ProovraButton label={COPY.startOver} variant="ghost" fullWidth={false} onPress={resetJourney} />
            </View>
          ) : null}

          {stage.kind === "CODE_SENT" ? (
            <View style={{ gap: theme.space.s2 }}>
              <ProovraText variant="bodySm" weight="semibold">{`Code sent to ${stage.attempt.recipientPreview}.`}</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {`${stage.attempt.expiresAtUtc ? `The code expires ${formatUserDateTime(stage.attempt.expiresAtUtc)}.` : "The code expires shortly."} Checks used: ${stage.attempt.checkAttemptCount}.`}
              </ProovraText>
              <ProovraFormField label={COPY.code}>
                <ProovraInput value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="off" />
              </ProovraFormField>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                <ProovraButton
                  label={busy === "CHECK" ? COPY.checking : COPY.confirm}
                  accessibilityLabel={COPY.confirm}
                  fullWidth={false}
                  disabled={busy !== null || !codeReady(code)}
                  onPress={() => void check()}
                />
                <ProovraButton label={COPY.differentNumber} variant="ghost" fullWidth={false} disabled={busy !== null} onPress={resetJourney} />
              </View>
            </View>
          ) : null}

          {stage.kind === "VERIFIED" ? (
            <View style={{ gap: theme.space.s2 }}>
              <ProovraText variant="bodySm" weight="semibold">
                {`Contact confirmed${stage.recipientPreview ? ` (${stage.recipientPreview})` : ""}.`}
              </ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                {`Confirmation was recorded by the server. Choose whether this workspace may message the contact on ${messagingChannelLabel(channel)}.`}
              </ProovraText>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                <ProovraButton
                  label={busy === "SAVE_IN" ? COPY.saving : COPY.allow}
                  accessibilityLabel={COPY.allow}
                  fullWidth={false}
                  disabled={busy !== null}
                  onPress={() => void save(true)}
                />
                <ProovraButton
                  label={busy === "SAVE_OUT" ? COPY.saving : COPY.deny}
                  accessibilityLabel={COPY.deny}
                  variant="secondary"
                  fullWidth={false}
                  disabled={busy !== null}
                  onPress={() => void save(false)}
                />
                <ProovraButton label={COPY.another} variant="ghost" fullWidth={false} disabled={busy !== null} onPress={resetJourney} />
              </View>
            </View>
          ) : null}

          {saved ? (
            <View style={{ gap: theme.space.s1 }}>
              <ProovraText variant="bodySm">
                {`Saved preference — SMS: ${saved.smsOptOut ? "blocked" : "allowed"}; WhatsApp: ${saved.whatsappOptOut ? "blocked" : "allowed"}${saved.preferredChannel ? `; preferred: ${saved.preferredChannel}` : ""}.`}
              </ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>{`Updated ${formatUserDateTime(saved.updatedAt)}`}</ProovraText>
            </View>
          ) : null}
        </View>
      </ProovraCard>
    </ProovraPageSection>
  );
}
