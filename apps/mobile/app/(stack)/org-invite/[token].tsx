/**
 * ORGANIZATION INVITE ACCEPTANCE — the native port of
 * `apps/web/app/(app)/org-invites/[token]/accept/page.tsx`.
 *
 * A SEPARATE family from the collaboration-group invite in
 * `(stack)/invite/[token].tsx`: different token namespace, different endpoint
 * (`POST /v1/org-invites/:token/accept`), and a different outcome — joining an
 * ORGANIZATION, which may or may not come with explicit workspace grants.
 *
 * Two behaviours ported deliberately:
 *   - a 401 preserves the intent and routes through Sign In, so the token
 *     survives the round-trip. The web does this with `?next=`; native has the
 *     pending-route mechanism, which is the same idea without a URL.
 *   - when the accept returns workspace grants, the member CHOOSES where to
 *     go. The web stopped auto-redirecting for exactly that reason; a
 *     governance-only accept (no grants) still lands somewhere sensible.
 *
 * Accepting never merges or converts the account. Personal Space is untouched
 * server-side; the list of switchable spaces simply grows.
 */
import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { apiFetch, getAuthToken } from "../../../src/api";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { setPendingRoute } from "../../../src/deep-link/pending-intent";
import { usePlatformContext } from "../../../src/product/platform-context";
import { theme } from "../../../src/theme/theme";
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
import { parseOrgInviteAccept, type OrgInviteAccepted } from "../../../src/product/org-invite";

type Phase = "checking" | "ready" | "accepting" | "accepted" | "invalid" | "error";

export default function OrgInviteAcceptScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = params.token ?? "";
  const { refresh } = usePlatformContext();

  const [phase, setPhase] = useState<Phase>("checking");
  const [result, setResult] = useState<OrgInviteAccepted | null>(null);
  const [error, setError] = useState<SafeError | null>(null);

  useEffect(() => {
    if (!token) {
      setPhase("invalid");
      return;
    }
    if (!getAuthToken()) {
      // The web survives this with ?next=; native preserves the intent and
      // replays it after the full Sign In → MFA → Legal journey.
      setPendingRoute(`/org-invite/${token}`);
      router.replace("/(stack)/auth");
      return;
    }
    setPhase("ready");
  }, [token, router]);

  const accept = useCallback(async () => {
    setPhase("accepting");
    setError(null);
    try {
      const data = await apiFetch(`/v1/org-invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const accepted = parseOrgInviteAccept(data);
      setResult(accepted);
      setPhase("accepted");

      // Re-read the canonical platform context so the newly joined
      // organization appears in the workspace switcher without a relaunch.
      void refresh();
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.status === 401) {
        setPendingRoute(`/org-invite/${token}`);
        router.replace("/(stack)/auth");
        return;
      }
      // 400/404 = invalid, expired or already used — one answer for all three
      // (anti-enumeration).
      if (safe.status === 400 || safe.kind === "notFound") setPhase("invalid");
      else {
        setError(safe);
        setPhase("error");
      }
    }
  }, [token, router, refresh]);

  if (phase === "checking" || phase === "accepting") {
    return (
      <ProovraScreen scroll={false}>
        <ProovraLoadingState label={phase === "accepting" ? "Joining…" : "Checking invitation"} />
      </ProovraScreen>
    );
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
    return (
      <ProovraScreen scroll={false}>
        <ProovraErrorState message={error.message} onRetry={() => void accept()} />
      </ProovraScreen>
    );
  }

  if (phase === "accepted" && result) {
    return (
      <ProovraScreen width="form">
        <ProovraSection title="You've joined">
          <ProovraCard>
            <ProovraText variant="body">
              {result.role
                ? `You joined as ${result.role.replace(/_/g, " ").toLowerCase()}.`
                : "You joined the organization."}
            </ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              Your personal space is unchanged — this adds a workspace you can switch to.
            </ProovraText>

            {/*
              With explicit workspace grants the member chooses where to go.
              The web stopped auto-redirecting here for the same reason: an
              accept that lands you somewhere arbitrary is disorienting when
              several workspaces were granted at once.
            */}
            <View style={styles.actions}>
              {result.assignedWorkspaceIds.length > 0 ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {`${result.assignedWorkspaceIds.length} workspace(s) were shared with you.`}
                </ProovraText>
              ) : null}
              <ProovraButton label="Go to home" onPress={() => router.replace("/(tabs)")} />
              <ProovraButton
                label="See your teams"
                variant="ghost"
                onPress={() => router.replace("/(tabs)/teams")}
              />
            </View>
          </ProovraCard>
        </ProovraSection>
      </ProovraScreen>
    );
  }

  return (
    <ProovraScreen width="form">
      <ProovraSection title="Join organization">
        <ProovraCard>
          <ProovraText variant="body">
            You&apos;ve been invited to join an organization.
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Accepting adds the organization to the spaces you can switch between. Your personal
            space is not merged or converted.
          </ProovraText>
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
