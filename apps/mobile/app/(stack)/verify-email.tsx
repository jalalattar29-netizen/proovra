import { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { verifyEmail } from "../../src/auth/auth-api";
import { useCompleteLogin } from "../../src/auth/use-auth-flow";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import { ProovraScreen, ProovraCard, ProovraButton, ProovraSection, ProovraLoadingState, ProovraErrorState, ProovraText } from "../../src/ui";

/** Email verification — reached via the emailed deep link (carries ?token=). */
export default function VerifyEmailScreen() {
  const router = useRouter();
  const completeLogin = useCompleteLogin();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === "string" ? params.token : "";
  const [state, setState] = useState<"verifying" | "error">("verifying");
  const [error, setError] = useState<SafeError | null>(null);

  useEffect(() => {
    void (async () => {
      if (!token) {
        setError({ kind: "input", title: "Link invalid", message: "This verification link is missing or expired." });
        setState("error");
        return;
      }
      try {
        const session = await verifyEmail(token);
        await completeLogin({ kind: "session", token: session.token, user: session.user }, "email");
      } catch (err) {
        setError(toSafeUserError(err));
        setState("error");
      }
    })();
  }, [token, completeLogin]);

  return (
    <ProovraScreen scroll={false} width="form">
      <ProovraSection title="Verifying your email">
        <ProovraCard>
          {state === "verifying" ? (
            <ProovraLoadingState label="Confirming your account" />
          ) : (
            <>
              <ProovraErrorState message={error?.message ?? "Verification failed."} />
              <View style={styles.actions}>
                <ProovraButton label="Back to sign in" onPress={() => router.replace("/(stack)/auth")} />
              </View>
            </>
          )}
          <ProovraText variant="label" color={theme.color.ink.muted} center style={styles.hint}>
            Open the verification link on the device where you are signing in.
          </ProovraText>
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({ actions: { marginTop: theme.space.s3 }, hint: { marginTop: theme.space.s4 } });
