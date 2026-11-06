/**
 * proovra://sso/complete — where an Organization single sign-on returns
 * (MOBILE-002).
 *
 * The system browser normally hands the return straight back to the waiting
 * sign-in screen. When a platform opens it as a deep link instead, this screen
 * finishes it: the single-use code is redeemed once with this attempt's
 * verifier (src/auth/use-sso-sign-in.ts) and the answer goes through the shared
 * sign-in completion, MFA and legal gates included.
 */
import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";

import { useCompleteLogin } from "../../src/auth/use-auth-flow";
import { finishSsoReturn } from "../../src/auth/use-sso-sign-in";
import { SSO_RETURN_URL } from "../../src/auth/sso-native";
import { ProovraButton, ProovraCard, ProovraLoadingState, ProovraPageHeader, ProovraScreen, ProovraText } from "../../src/ui";

export default function SsoCompleteScreen() {
  const router = useRouter();
  const completeLogin = useCompleteLogin();
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const [failure, setFailure] = useState<string | null>(null);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const query = new URLSearchParams();
    if (typeof params.code === "string") query.set("code", params.code);
    else query.set("error", typeof params.error === "string" ? params.error : "sso_failed");
    void finishSsoReturn(`${SSO_RETURN_URL}?${query.toString()}`, (result) =>
      completeLogin(result, "sso", { legalAcceptedSource: "login" }),
    ).then((message) => {
      if (message) setFailure(message);
    });
  }, [params.code, params.error, completeLogin]);

  return (
    <ProovraScreen width="form" backdrop="auth" testID="sso-complete">
      <ProovraPageHeader title="Single sign-on" eyebrow="Account access" />
      <ProovraCard>
        {failure ? (
          <>
            <ProovraText variant="bodySm" testID="sso-complete-failure">{failure}</ProovraText>
            <ProovraButton label="Back to sign in" onPress={() => router.replace("/(stack)/auth")} />
          </>
        ) : (
          <ProovraLoadingState label="Signing you in…" />
        )}
      </ProovraCard>
    </ProovraScreen>
  );
}
