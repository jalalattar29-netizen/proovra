/**
 * VERIFIED CONTACT DEVICE (T-15) — see src/product/contact-factors.ts.
 * Touch adaptations: the channel <select> becomes chips; the web's once-a-
 * second countdown ticks only while a resend cooldown is running (and the
 * timer is unref'd so it never pins a Node test process).
 */
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  CONTACT_FACTOR_CHANNELS,
  CONTACT_FACTOR_COPY as COPY,
  CONTACT_FACTOR_ENROLL_START_PATH,
  CONTACT_FACTOR_ENROLL_VERIFY_PATH,
  CONTACT_FACTORS_PATH,
  RESEND_COOLDOWN_MS,
  buildContactFactorRevokePath,
  codeError,
  contactFactorFailure,
  contactFactorStatusLabel,
  destinationError,
  parseContactFactors,
  parseEnrolmentStart,
  verifyDeniedMessage,
  type ContactFactor,
  type ContactFactorKind,
  type EnrolmentAttempt,
} from "../product/contact-factors";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraText } from "./index";
import { ProovraFilterChips, ProovraPageSection } from "./patterns";

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "otp"; ctx: EnrolmentAttempt & { sentAt: number; replacing: boolean } }
  | { kind: "verifying"; ctx: EnrolmentAttempt & { sentAt: number; replacing: boolean } }
  | { kind: "done"; replaced: boolean; mask: string }
  | { kind: "revoked" };

const safe = (e: unknown, f: string) => toSafeUserError(e, { message: f }).message;

export function ContactFactorSection({ teamId }: { teamId: string | null }) {
  const [factors, setFactors] = useState<ContactFactor[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const [channel, setChannel] = useState<ContactFactorKind>("SMS");
  const [destination, setDestination] = useState("");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [replaceIntent, setReplaceIntent] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadFactors = useCallback(async () => {
    try {
      setFactors(parseContactFactors(await apiFetch(CONTACT_FACTORS_PATH)));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => {
    void loadFactors();
  }, [loadFactors]);

  const ctx = phase.kind === "otp" || phase.kind === "verifying" ? phase.ctx : null;
  const cooldownLeft = ctx ? Math.max(0, ctx.sentAt + RESEND_COOLDOWN_MS - now) : 0;
  useEffect(() => {
    if (!ctx || cooldownLeft <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    (t as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
  }, [ctx, cooldownLeft]);

  const active = (factors ?? []).find((f) => f.status === "ACTIVE") ?? null;
  const showForm = !active || replaceIntent;

  const start = async (resend: boolean) => {
    if (!teamId || phase.kind === "sending" || phase.kind === "verifying") return;
    if (!resend) {
      const err = destinationError(destination);
      setFieldError(err);
      if (err) return;
    }
    const replacing = resend && ctx ? ctx.replacing : !!active;
    setPhase({ kind: "sending" });
    setNotice(null);
    try {
      const attempt = parseEnrolmentStart(
        await apiFetch(CONTACT_FACTOR_ENROLL_START_PATH, {
          method: "POST",
          body: JSON.stringify({ teamId, channel, destination: destination.trim(), ...(label.trim() ? { label: label.trim() } : {}) }),
        }),
      );
      if (!attempt) {
        setPhase({ kind: "idle" });
        setNotice(COPY.startUnusable);
        return;
      }
      setNow(Date.now());
      setPhase({ kind: "otp", ctx: { ...attempt, sentAt: Date.now(), replacing } });
      setCode("");
      void loadFactors();
    } catch (err) {
      setPhase({ kind: "idle" });
      setNotice(contactFactorFailure(err, COPY.startFailed, safe));
      void loadFactors();
    }
  };

  const verify = async () => {
    if (!teamId || phase.kind !== "otp") return;
    const c = phase.ctx;
    const err = codeError(code);
    setFieldError(err);
    if (err) return;
    setPhase({ kind: "verifying", ctx: c });
    setNotice(null);
    try {
      const res = await apiFetch(CONTACT_FACTOR_ENROLL_VERIFY_PATH, {
        method: "POST",
        body: JSON.stringify({ teamId, factorId: c.factorId, verificationAttemptId: c.verificationAttemptId, code: code.trim() }),
      });
      const mask = parseContactFactors({ factors: [(res as { factor?: unknown } | null)?.factor] })[0]?.destinationMask ?? c.destinationMask;
      // The full number and the code leave state the moment enrolment completes.
      setDestination("");
      setLabel("");
      setCode("");
      setReplaceIntent(false);
      setPhase({ kind: "done", replaced: c.replacing, mask });
      void loadFactors();
    } catch (e) {
      setPhase({ kind: "otp", ctx: c });
      const status = (e as { statusCode?: number } | null)?.statusCode;
      setNotice(status === 400 ? verifyDeniedMessage(c.codeExpiresAt, Date.now()) : contactFactorFailure(e, COPY.verifyFailed, safe));
    }
  };

  const revoke = async (factorId: string) => {
    if (revokingId) return;
    setRevokingId(factorId);
    setNotice(null);
    try {
      await apiFetch(buildContactFactorRevokePath(factorId), { method: "POST", body: JSON.stringify({}) });
      setPhase({ kind: "revoked" });
      setReplaceIntent(false);
      setCode("");
    } catch (err) {
      setNotice(contactFactorFailure(err, COPY.revokeFailed, safe));
    } finally {
      setRevokingId(null);
      void loadFactors();
    }
  };

  const expired = !!(ctx && ctx.codeExpiresAt !== null && ctx.codeExpiresAt <= now);

  return (
    <ProovraPageSection title={COPY.title} description={COPY.intro}>
      <ProovraCard>
        <View style={{ gap: theme.space.s3 }} testID="contact-factor-section">
          {loadFailed ? (
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{COPY.loadFailed}</ProovraText>
          ) : factors === null ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.loading}</ProovraText>
          ) : factors.filter((f) => f.status !== "REVOKED").length === 0 ? (
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.none}</ProovraText>
          ) : (
            factors
              .filter((f) => f.status !== "REVOKED")
              .map((f) => (
                <View key={f.factorId} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
                  {/* The mask, and only ever the mask. */}
                  <ProovraText variant="bodySm">{`${f.label ? `${f.label} · ` : ""}${f.destinationMask}`}</ProovraText>
                  <ProovraBadge tone={f.status === "ACTIVE" ? "verified" : "pending"} label={contactFactorStatusLabel(f.status)} />
                  <ProovraButton
                    label={revokingId === f.factorId ? "Revoking…" : "Revoke"}
                    accessibilityLabel={`Revoke ${f.destinationMask}`}
                    variant="ghost"
                    fullWidth={false}
                    disabled={!!revokingId}
                    onPress={() => void revoke(f.factorId)}
                  />
                </View>
              ))
          )}

          {active && !replaceIntent && !ctx ? (
            <ProovraButton label={COPY.replace} variant="secondary" fullWidth={false} onPress={() => setReplaceIntent(true)} />
          ) : null}

          {!loadFailed && factors !== null && showForm && !ctx ? (
            !teamId ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.noWorkspace}</ProovraText>
            ) : (
              <View style={{ gap: theme.space.s2 }}>
                <ProovraFilterChips<ContactFactorKind> label={COPY.channelQuestion} options={CONTACT_FACTOR_CHANNELS} value={channel} onChange={setChannel} />
                <ProovraFormField label={COPY.phone} error={fieldError}>
                  <ProovraInput value={destination} onChangeText={(v) => { setDestination(v); setFieldError(null); }} keyboardType="phone-pad" />
                </ProovraFormField>
                <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.phoneHelp}</ProovraText>
                <ProovraFormField label={COPY.labelField}>
                  <ProovraInput value={label} onChangeText={setLabel} placeholder={COPY.labelPlaceholder} autoCapitalize="words" />
                </ProovraFormField>
                <ProovraButton
                  label={phase.kind === "sending" ? COPY.sending : COPY.send}
                  accessibilityLabel={COPY.send}
                  fullWidth={false}
                  disabled={phase.kind === "sending"}
                  onPress={() => void start(false)}
                />
              </View>
            )
          ) : null}

          {ctx ? (
            <View style={{ gap: theme.space.s2 }} testID="contact-factor-otp">
              <ProovraText variant="bodySm">{`A code was sent to ${ctx.destinationMask}. Enter it below to finish enrolling this device.`}</ProovraText>
              <ProovraFormField label={COPY.codeField} error={fieldError}>
                <ProovraInput value={code} onChangeText={(v) => { setCode(v); setFieldError(null); }} keyboardType="number-pad" autoComplete="off" />
              </ProovraFormField>
              <ProovraText variant="label" color={theme.color.ink.muted}>{expired ? COPY.codeExpired : COPY.codeValid}</ProovraText>
              <ProovraButton
                label={phase.kind === "verifying" ? COPY.verifying : COPY.verify}
                accessibilityLabel={COPY.verify}
                fullWidth={false}
                disabled={phase.kind === "verifying"}
                onPress={() => void verify()}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                <ProovraButton
                  label={cooldownLeft > 0 ? `Resend in ${Math.ceil(cooldownLeft / 1000)}s` : COPY.resend}
                  accessibilityLabel={COPY.resend}
                  variant="ghost"
                  fullWidth={false}
                  disabled={cooldownLeft > 0 || phase.kind === "verifying"}
                  onPress={() => void start(true)}
                />
                <ProovraButton
                  label={COPY.startOver}
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => {
                    setPhase({ kind: "idle" });
                    setCode("");
                    setNotice(null);
                  }}
                />
              </View>
            </View>
          ) : null}

          {phase.kind === "done" ? (
            <ProovraText variant="bodySm" color={theme.color.status.verified.fg}>
              {`${phase.replaced ? COPY.replaced : COPY.enrolled} Codes for sensitive operations will be sent to ${phase.mask}.${phase.replaced ? " Any approval granted against the previous device no longer works." : ""}`}
            </ProovraText>
          ) : null}
          {phase.kind === "revoked" ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{COPY.revoked}</ProovraText> : null}
          {notice ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{notice}</ProovraText> : null}
        </View>
      </ProovraCard>
    </ProovraPageSection>
  );
}
