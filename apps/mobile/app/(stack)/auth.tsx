import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Card, TopBar } from "../../components/ui";
import { colors, spacing, typography } from "@proovra/ui";
import { useAuth } from "../../src/auth-context";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Google from "expo-auth-session/providers/google";
import * as AuthSession from "expo-auth-session";
import { apiFetch } from "../../src/api";
import { useRouter } from "expo-router";

export default function AuthScreen() {
  const { setSession } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const googleClientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? "";
  const [appleAvailable, setAppleAvailable] = useState(false);

  const redirectUri = AuthSession.makeRedirectUri({ scheme: "proovra" });
  if (__DEV__) {
    console.log("[Auth] Mobile redirectUri:", redirectUri, "scheme: proovra");
  }
  const [googleRequest, googleResponse, promptGoogle] = Google.useAuthRequest({
    clientId: googleClientId,
    responseType: AuthSession.ResponseType.IdToken,
    scopes: ["openid", "email", "profile"],
    redirectUri
  });

  useEffect(() => {
    void AppleAuthentication.isAvailableAsync()
      .then(setAppleAvailable)
      .catch(() => setAppleAvailable(false));
  }, []);

  useEffect(() => {
    if (!googleResponse) return;
    
    // Handle cancel/dismiss
    if (googleResponse.type === "dismiss") {
      setStatus(null);
      return;
    }
    
    if (googleResponse.type === "error") {
      setError(`Google login error: ${googleResponse.params?.error || "Unknown error"}`);
      setStatus(null);
      return;
    }

    if (googleResponse.type !== "success") return;
    
    const idToken = googleResponse.params?.id_token;
    if (!idToken) {
      setError("Google login failed: No ID token received.");
      setStatus(null);
      return;
    }
    
    void (async () => {
      setError(null);
      setStatus("Signing in with Google...");
      try {
        console.log("[Mobile Auth] Starting Google token exchange...");
        const data = await apiFetch("/v1/auth/google", {
          method: "POST",
          body: JSON.stringify({ idToken })
        });
        if (!data.token) throw new Error("Missing access token");
        console.log("[Mobile Auth] Got session token, fetching user...");
        const me = await apiFetch("/v1/auth/me", {
          headers: { authorization: `Bearer ${data.token}` }
        });
        if (!me?.user) throw new Error("Session not confirmed");
        console.log("[Mobile Auth] Google sign-in success, navigating...");
        setSession({ token: data.token, user: me.user ?? data.user ?? null, mode: "google" });
        setStatus(null);
        router.replace("/(tabs)");
      } catch (err) {
        console.error("[Mobile Auth] Google sign-in failed:", err);
        setError(err instanceof Error ? err.message : "Google login failed");
        setStatus(null);
      }
    })();
  }, [googleResponse, router, setSession]);

  const handleGuest = async () => {
    setError(null);
    setStatus("Signing in as guest...");
    try {
      const data = await apiFetch("/v1/auth/guest", { method: "POST" });
      setSession({ token: data.token, user: data.user ?? null, mode: "guest" });
      router.replace("/(tabs)");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Guest login failed");
    }
  };

  const handleApple = async () => {
    setError(null);
    setStatus("Signing in with Apple...");
    try {
      console.log("[Mobile Auth] Starting Apple sign-in...");
      const result = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL
        ]
      });
      
      console.log("[Mobile Auth] Apple sign-in completed, got identity token");
      
      if (!result.identityToken) {
        throw new Error("Apple login failed: No identity token received");
      }
      
      console.log("[Mobile Auth] Exchanging Apple identity token...");
      const data = await apiFetch("/v1/auth/apple", {
        method: "POST",
        body: JSON.stringify({ idToken: result.identityToken })
      });
      
      if (!data.token) throw new Error("Missing access token from server");
      
      console.log("[Mobile Auth] Got session token, fetching user...");
      const me = await apiFetch("/v1/auth/me", {
        headers: { authorization: `Bearer ${data.token}` }
      });
      
      if (!me?.user) throw new Error("Session not confirmed");
      
      console.log("[Mobile Auth] Apple sign-in success, navigating...");
      setSession({ token: data.token, user: me.user ?? data.user ?? null, mode: "apple" });
      setStatus(null);
      router.replace("/(tabs)");
    } catch (err) {
      // Distinguish between user cancel and real errors
      if (err instanceof Error && err.message === "User canceled the sign-in flow") {
        console.log("[Mobile Auth] Apple sign-in was cancelled by user");
        setError(null);
        setStatus(null);
        return;
      }
      console.error("[Mobile Auth] Apple sign-in failed:", err);
      setError(err instanceof Error ? err.message : "Apple login failed");
      setStatus(null);
    }
  };

  return (
    <View style={styles.container}>
      <TopBar title="Proovra" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card>
          <Text style={styles.title}>Sign in</Text>
          <View style={styles.stack}>
            <Button
              label="Continue with Google"
              variant="secondary"
              onPress={() => {
                if (!googleClientId) {
                  setError("Google client ID is missing.");
                  return;
                }
                if (!googleRequest) {
                  setError("Google login is not ready yet.");
                  return;
                }
                void promptGoogle();
              }}
            />
            {appleAvailable ? (
              <Button label="Continue with Apple" variant="secondary" onPress={handleApple} />
            ) : null}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>Or</Text>
              <View style={styles.dividerLine} />
            </View>
            <Button label="Continue as Guest" variant="secondary" onPress={handleGuest} />
            {status ? <Text style={styles.status}>{status}</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {process.env.EXPO_PUBLIC_API_BASE ? (
              <Text style={styles.debug}>API: {process.env.EXPO_PUBLIC_API_BASE}</Text>
            ) : null}
          </View>
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.lightBg
  },
  scroll: {
    padding: spacing.xl
  },
  title: {
    fontSize: typography.size.h3,
    marginBottom: spacing.md,
    color: colors.textDark
  },
  stack: {
    gap: 10
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: spacing.sm
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#E2E8F0"
  },
  dividerText: {
    color: "#64748b",
    fontSize: 12
  },
  status: {
    color: "#64748b",
    fontSize: 12
  },
  error: {
    color: "#ef4444",
    fontSize: 12
  },
  debug: {
    color: "#94a3b8",
    fontSize: 11
  }
});
