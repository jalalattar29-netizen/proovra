/**
 * COLLABORATION INVITE ACCEPTANCE (Native Convergence §14, M7). A deep-link
 * target: proovra://invite/<token> (or the web invite link). If unauthenticated,
 * the intent is preserved and the user is sent through Sign In → MFA → Legal, then
 * replayed here to accept. Accept = POST /v1/collaboration-team-invites/:token/
 * accept → navigate to the team. Invalid / expired / already-accepted (400/404)
 * and unauthorized (403) fail safely.
 */
import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiFetch, getAuthToken } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { setPendingRoute } from "../../../src/deep-link/pending-intent";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../../src/ui";

type Phase = "checking" | "ready" | "accepting" | "accepted" | "invalid" | "error";

export default function InviteAcceptScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = params.token ?? "";
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<SafeError | null>(null);

  // Gate on auth. Unauthenticated → preserve this route and route to Sign In;
  // the pending intent replays here after the full auth journey.
  useEffect(() => {
    if (!token) {
      setPhase("invalid");
      return;
    }
    if (!getAuthToken()) {
      setPendingRoute(`/invite/${token}`);
      router.replace("/(stack)/auth");
      return;
    }
    setPhase("ready");
  }, [token, router]);

  const accept = useCallback(async () => {
    setPhase("accepting");
    setError(null);
    try {
      const res = await apiFetch(`/v1/collaboration-team-invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const teamId = typeof res?.teamId === "string" ? res.teamId : null;
      setPhase("accepted");
      if (teamId) router.replace(`/collaboration-team/${teamId}`);
      else router.replace("/teams");
    } catch (err) {
      const safe = toSafeUserError(err);
      // 400/404 = invalid / expired / already-accepted (anti-enumeration).
      if (safe.status === 400 || safe.kind === "notFound") setPhase("invalid");
      else {
        setError(safe);
        setPhase("error");
      }
    }
  }, [token, router]);

  if (phase === "checking" || phase === "accepting" || phase === "accepted") {
    return <ProovraScreen scroll={false}><ProovraLoadingState label={phase === "accepting" ? "Joining…" : "Checking invitation"} /></ProovraScreen>;
  }
  if (phase === "invalid") {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState
          title="Invitation unavailable"
          message="This invitation is invalid, has expired, or was already used."
          action={<ProovraButton label="Go to app" fullWidth={false} onPress={() => router.replace("/")} />}
        />
      </ProovraScreen>
    );
  }
  if (phase === "error" && error) {
    return <ProovraScreen scroll={false}><ProovraErrorState message={error.message} onRetry={() => void accept()} /></ProovraScreen>;
  }

  return (
    <ProovraScreen width="form">
      <ProovraSection title="Join collaboration group">
        <ProovraCard>
          <ProovraText variant="body">You’ve been invited to join a collaboration group.</ProovraText>
          <View style={styles.actions}>
            <ProovraButton label="Accept invitation" onPress={() => void accept()} />
            <ProovraButton label="Not now" variant="ghost" onPress={() => router.replace("/")} />
          </View>
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  actions: { marginTop: 16, gap: 8 },
});
