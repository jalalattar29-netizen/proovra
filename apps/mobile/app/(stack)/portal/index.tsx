/**
 * PORTAL TOKEN ENTRY — the native port of `apps/web/app/portal/page.tsx`.
 *
 * The bounded surface where an external reviewer pastes the raw invitation
 * token, for the case where the link did not open the app: a reviewer who has
 * the app but whose email client stripped or rewrote the link still has the
 * token in front of them.
 *
 * It exchanges nothing itself — it hands the token to `/portal/[token]`, which
 * is the one place the exchange happens. Two screens that both authenticate
 * would be two places for the MFA and denial behaviour to drift apart.
 */
import { useState } from "react";
import { useRouter } from "expo-router";

import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
  ProovraPageHeader,
} from "../../../src/ui";

/** POST /v1/portal/auth's PortalAuthBody bounds the raw token at 8..256; refuse outside that here. */
function looksLikePortalToken(value: string): boolean {
  const v = value.trim();
  return v.length >= 8 && v.length <= 256;
}

export default function PortalEntryScreen() {
  const router = useRouter();
  const [token, setToken] = useState("");

  return (
    <ProovraScreen width="form" testID="portal-entry">
      <ProovraPageHeader
        title="Open a review"
        eyebrow="External review"
        subtitle="Paste the access token from your invitation email."
      />

      <ProovraCard>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          You do not need a PROOVRA account. The token in your invitation is
          what grants access, and it is used only while this screen is open.
        </ProovraText>
        <ProovraFormField label="Access token">
          <ProovraInput
            value={token}
            onChangeText={setToken}
            placeholder="Paste the token from your email"
            autoCapitalize="none"
            accessibilityLabel="Access token"
          />
        </ProovraFormField>
        <ProovraButton
          label="Open my reviews"
          disabled={!looksLikePortalToken(token)}
          // The exchange lives in ONE place. Two screens that both
          // authenticate would be two places for the MFA and denial behaviour
          // to drift apart.
          onPress={() => router.push(`/portal/${encodeURIComponent(token.trim())}`)}
        />
      </ProovraCard>
    </ProovraScreen>
  );
}
