/**
 * RECOVERY CODES — shown once, acknowledged before they go.
 *
 * The web's MFA card (PersonalSecuritySections.tsx, phase "recovery-codes")
 * shows the codes after enrolment AND after regeneration, and will not let the
 * person leave until they tick "I saved these recovery codes in a safe place."
 * Both routes return the codes exactly once:
 *   POST /v1/identity/mfa/enroll/verify               → { factorId, recoveryCodes }
 *   POST /v1/identity/mfa/recovery-codes/regenerate   → { recoveryCodes }   (mfa.routes.ts:307)
 *
 * Native regenerated them and showed a toast, so the only copy of the new codes
 * was discarded while every old code had just stopped working.
 */
import { Share, Switch, View } from "react-native";
import { useEffect, useState } from "react";

import { theme } from "../theme/theme";
import { ProovraButton, ProovraCard, ProovraText, ProovraSheet } from "./index";

export function RecoveryCodesSheet({
  codes,
  context,
  onDone,
}: {
  /** null closes the sheet. */
  codes: string[] | null;
  context: "enroll" | "regenerate";
  onDone: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
  }, [codes]);

  return (
    <ProovraSheet
      visible={codes !== null}
      title="Save your recovery codes"
      // Dismissing is refused until acknowledged — the codes cannot be shown again.
      onClose={() => {
        if (acknowledged) onDone();
      }}
    >
      {codes ? (
        <>
          <ProovraText variant="bodySm" weight="semibold">
            {context === "enroll"
              ? "Two-factor authentication is now enabled."
              : "New recovery codes generated."}
          </ProovraText>
          <ProovraText variant="label" color={theme.color.status.risk.solid}>
            Store these recovery codes somewhere safe — each works once, and they will never be shown again.
          </ProovraText>
          <ProovraCard accessibilityLabel="Recovery codes — shown once">
            {codes.map((c) => (
              <ProovraText key={c} variant="bodySm" mono selectable>
                {c}
              </ProovraText>
            ))}
          </ProovraCard>
          <ProovraButton
            label="Share these codes"
            variant="secondary"
            onPress={() => void Share.share({ message: codes.join("\n") })}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s3 }}>
            <Switch
              value={acknowledged}
              onValueChange={setAcknowledged}
              accessibilityLabel="I saved these recovery codes in a safe place."
            />
            <ProovraText variant="bodySm" style={{ flex: 1 }}>
              I saved these recovery codes in a safe place.
            </ProovraText>
          </View>
          <ProovraButton label="Done" disabled={!acknowledged} onPress={onDone} />
          {!acknowledged ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              Confirm you have saved your recovery codes first.
            </ProovraText>
          ) : null}
        </>
      ) : null}
    </ProovraSheet>
  );
}
