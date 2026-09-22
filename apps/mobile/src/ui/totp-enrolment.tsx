/**
 * TOTP ENROLMENT — adding an authenticator from the device.
 *
 * Native could REMOVE a two-factor method and report whether one existed, but
 * a person could not ADD one from the phone. That is the wrong half of a
 * security control to ship: the app could weaken the account and not
 * strengthen it.
 *
 * WHY THERE IS NO QR CODE HERE
 * The web shows one because the authenticator is on a different device. On a
 * phone it is usually the SAME device, and you cannot photograph your own
 * screen. So the `otpauth://` URI is handed to whichever authenticator is
 * installed, and the base32 secret stays visible for a phone with none — the
 * endpoint, the secret, the verification and the recovery codes are the web's,
 * unchanged.
 *
 * RECOVERY CODES ARE SHOWN ONCE
 * The route says so itself: "Recovery codes returned ONCE here. The client
 * must surface them immediately; we never return them again." They are shown
 * in a step the user has to acknowledge, with a share action, rather than in a
 * toast that can be missed.
 */
import { useCallback, useState } from "react";
import { Linking, Share, View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
  ProovraSheet,
} from "./index";
import {
  MFA_ENROLL_START_PATH,
  MFA_ENROLL_VERIFY_PATH,
  RECOVERY_CODES_WARNING,
  buildEnrollStartBody,
  buildEnrollVerifyBody,
  classifyEnrollFailure,
  enrollFailureMessage,
  parseRecoveryCodes,
  parseTotpEnrollment,
  validateTotpCode,
  type TotpEnrollment,
} from "../product/account-security";

type Stage =
  | { kind: "idle" }
  | { kind: "enrolling"; enrollment: TotpEnrollment }
  | { kind: "codes"; codes: string[] };

export function TotpEnrolment({ onEnrolled }: { onEnrolled: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const enrollment = parseTotpEnrollment(
        await apiFetch(MFA_ENROLL_START_PATH, {
          method: "POST",
          body: JSON.stringify(buildEnrollStartBody(label)),
        }),
      );
      if (!enrollment) {
        setMessage("Enrolment could not be started.");
        return;
      }
      setCode("");
      setStage({ kind: "enrolling", enrollment });
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [label]);

  const verify = useCallback(async () => {
    if (stage.kind !== "enrolling") return;
    const invalid = validateTotpCode(code);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const payload = await apiFetch(MFA_ENROLL_VERIFY_PATH, {
        method: "POST",
        body: JSON.stringify(buildEnrollVerifyBody(stage.enrollment.factorId, code)),
      });
      const codes = parseRecoveryCodes(payload);
      // The codes exist exactly once. Moving to a step the user must dismiss
      // is the only way not to lose the only copy there is.
      setStage({ kind: "codes", codes });
      setLabel("");
      setCode("");
      onEnrolled();
    } catch (err) {
      // A wrong code and an expired enrolment call for different next steps.
      setMessage(enrollFailureMessage(classifyEnrollFailure(err)));
    } finally {
      setBusy(false);
    }
  }, [stage, code, onEnrolled]);

  return (
    <>
      <ProovraCard>
        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
          Add an authenticator
        </ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>
          A code from an authenticator app, asked for when you sign in on a new device.
        </ProovraText>
        <ProovraFormField label="Name it (optional)">
          <ProovraInput
            value={label}
            onChangeText={setLabel}
            placeholder="e.g. Personal phone"
            autoCapitalize="sentences"
            accessibilityLabel="Authenticator name"
          />
        </ProovraFormField>
        <ProovraButton
          label="Set up"
          fullWidth={false}
          loading={busy && stage.kind === "idle"}
          onPress={() => void start()}
        />
        {message && stage.kind === "idle" ? (
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {message}
          </ProovraText>
        ) : null}
      </ProovraCard>

      <ProovraSheet
        visible={stage.kind === "enrolling"}
        title="Set up your authenticator"
        onClose={() => setStage({ kind: "idle" })}
      >
        {stage.kind === "enrolling" ? (
          <>
            {stage.enrollment.otpauthUri ? (
              <>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {/*
                    No QR code: the authenticator is usually on this same
                    phone, and you cannot photograph your own screen.
                  */}
                  Open this in your authenticator app, then type the code it shows.
                </ProovraText>
                <ProovraButton
                  label="Open in authenticator"
                  onPress={() => {
                    const uri = stage.enrollment.otpauthUri;
                    if (uri) void Linking.openURL(uri).catch(() => {
                      setMessage(
                        "No authenticator app could open that. Use the setup key below instead.",
                      );
                    });
                  }}
                />
              </>
            ) : null}

            {stage.enrollment.secretBase32 ? (
              <View style={{ gap: theme.space.s2 }}>
                <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
                  Setup key
                </ProovraText>
                {/*
                  Selectable, for a phone with no authenticator installed that
                  needs to enrol one somewhere else.
                */}
                <ProovraText variant="bodySm" mono selectable>
                  {stage.enrollment.secretBase32}
                </ProovraText>
                <ProovraButton
                  label="Share the setup key"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => {
                    const secret = stage.enrollment.secretBase32;
                    if (secret) void Share.share({ message: secret });
                  }}
                />
              </View>
            ) : null}

            <ProovraFormField label="Code from your authenticator">
              <ProovraInput
                value={code}
                onChangeText={setCode}
                placeholder="6-digit code"
                keyboardType="number-pad"
                accessibilityLabel="Authenticator code"
              />
            </ProovraFormField>

            <ProovraButton
              label="Turn on two-factor"
              loading={busy}
              disabled={validateTotpCode(code) !== null}
              onPress={() => void verify()}
            />

            {message ? (
              <ProovraText variant="label" color={theme.color.status.risk.solid}>
                {message}
              </ProovraText>
            ) : null}
          </>
        ) : null}
      </ProovraSheet>

      <ProovraSheet
        visible={stage.kind === "codes"}
        title="Save your recovery codes"
        onClose={() => setStage({ kind: "idle" })}
      >
        {stage.kind === "codes" ? (
          <>
            <ProovraText variant="label" color={theme.color.status.risk.solid}>
              {RECOVERY_CODES_WARNING}
            </ProovraText>
            <ProovraCard>
              {stage.codes.map((c) => (
                <ProovraText key={c} variant="bodySm" mono selectable>
                  {c}
                </ProovraText>
              ))}
            </ProovraCard>
            <ProovraButton
              label="Share these codes"
              onPress={() => void Share.share({ message: stage.codes.join("\n") })}
            />
            <ProovraButton
              label="I have saved them"
              variant="ghost"
              onPress={() => setStage({ kind: "idle" })}
            />
          </>
        ) : null}
      </ProovraSheet>
    </>
  );
}
