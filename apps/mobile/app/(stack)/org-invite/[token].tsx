/**
 * ORGANIZATION INVITE ACCEPTANCE — the native port of
 * `apps/web/app/(app)/org-invites/[token]/accept/page.tsx`.
 *
 * A SEPARATE family from the collaboration-group invite in
 * `(stack)/invite/[token].tsx`: different token namespace, different endpoint
 * (`POST /v1/org-invites/:token/accept`), and a different outcome — joining an
 * ORGANIZATION, which may or may not come with explicit workspace grants.
 *
 * The web page (:180-305): "Accept organization invite", the scope note,
 * "Accept invite"; on success the role sentence and — with workspace grants —
 * one explicit "Open <name>" per grant plus "Open organization"; without grants
 * it lands on the organization after a moment ("Redirecting…"). A refusal is
 * "We couldn't accept this invite" with the status-specific reason
 * (organizations.routes.ts:1065-1086: 404 not found, 410 revoked / accepted /
 * expired / closed, 403 email mismatch) and two ways on.
 *
 * A 401 preserves the intent and routes through Sign In, so the token survives
 * the round-trip. The web does this with `?next=`; native has the pending-route
 * mechanism, which is the same idea without a URL.
 *
 * Accepting never merges or converts the account. Personal Space is untouched
 * server-side; the list of switchable spaces simply grows.
 */
import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { apiFetch, getAuthToken } from "../../../src/api";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { setPendingRoute } from "../../../src/deep-link/pending-intent";
import { usePlatformContext } from "../../../src/product/platform-context";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraLoadingState,
} from "../../../src/ui";
import {
  acceptedHeadline,
  grantedWorkspaceName,
  orgInviteFailureMessage,
  orgInviteLanding,
  parseOrgInviteAccept,
  type OrgInviteAccepted,
} from "../../../src/product/org-invite";
import { SWITCH_WORKSPACE_PATH, buildSwitchWorkspaceBody } from "../../../src/product/spaces";

type Phase = "checking" | "ready" | "accepting" | "accepted" | "error";

/** How long a governance-only accept shows its confirmation before landing (web: 1500 ms). */
const REDIRECT_MS = 1500;

export default function OrgInviteAcceptScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = params.token ?? "";
  const { refresh, envelope } = usePlatformContext();

  const [phase, setPhase] = useState<Phase>("checking");
  const [result, setResult] = useState<OrgInviteAccepted | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setFailure(orgInviteFailureMessage(400));
      setPhase("error");
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
    setFailure(null);
    try {
      const data = await apiFetch(`/v1/org-invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setResult(parseOrgInviteAccept(data));
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
      setFailure(orgInviteFailureMessage(safe.status ?? 0));
      setPhase("error");
    }
  }, [token, router, refresh]);

  // A governance-only accept (no grants) lands on the organization after a
  // moment, as the web does (:106-121). With grants the member chooses.
  const landing = result ? orgInviteLanding(result) : null;
  useEffect(() => {
    if (phase !== "accepted" || !result || result.assignedWorkspaceIds.length > 0 || !landing) return;
    const t = setTimeout(() => router.replace(landing as never), REDIRECT_MS);
    return () => clearTimeout(t);
  }, [phase, result, landing, router]);

  const openWorkspace = async (workspaceId: string) => {
    try {
      await apiFetch(SWITCH_WORKSPACE_PATH, { method: "POST", body: JSON.stringify(buildSwitchWorkspaceBody(workspaceId)) });
      void refresh();
      router.replace("/(tabs)");
    } catch {
      // The server kept the previous context; the organization landing is the way on.
      router.replace("/organizations");
    }
  };

  if (phase === "checking") {
    return (
      <ProovraScreen scroll={false}>
        <ProovraLoadingState label="Checking invitation" />
      </ProovraScreen>
    );
  }

  return (
    <ProovraScreen width="form" testID="org-invite-accept">
      <ProovraSection title="Accept organization invite">
        <ProovraCard>
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            Accepting will add you to the organization at the role the inviter chose. This does NOT grant you access to workspace evidence, cases, or reviewer queues — those remain workspace-scoped.
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Your personal space is not merged or converted — this adds a space you can switch to.
          </ProovraText>

          {phase === "ready" ? (
            <View style={styles.actions}>
              <ProovraButton label="Accept invite" onPress={() => void accept()} />
              <ProovraButton label="Not now" variant="ghost" onPress={() => router.replace("/")} />
            </View>
          ) : null}

          {phase === "accepting" ? (
            <ProovraText variant="bodySm" color={theme.color.ink.muted} style={styles.actions}>
              Accepting…
            </ProovraText>
          ) : null}

          {phase === "accepted" && result ? (
            <View style={[styles.panel, styles.panelOk]} accessibilityLiveRegion="polite" testID="org-invite-accepted">
              <ProovraText variant="body" weight="semibold">{acceptedHeadline(result)}</ProovraText>
              {/* An explicit, per-workspace switch (web :244-268) — never automatic. */}
              {result.assignedWorkspaceIds.map((wsId) => (
                <ProovraButton
                  key={wsId}
                  label={`Open ${grantedWorkspaceName(envelope, wsId)}`}
                  variant="secondary"
                  onPress={() => void openWorkspace(wsId)}
                />
              ))}
              {landing ? (
                <ProovraButton
                  label="Open organization"
                  variant="ghost"
                  fullWidth={false}
                  onPress={() => router.replace(landing as never)}
                />
              ) : null}
            </View>
          ) : null}

          {phase === "error" ? (
            <View style={[styles.panel, styles.panelError]} accessibilityRole="alert" testID="org-invite-error">
              <ProovraText variant="body" weight="semibold" color={theme.color.status.risk.fg}>
                {"We couldn't accept this invite"}
              </ProovraText>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{failure}</ProovraText>
              <View style={styles.errorActions}>
                <ProovraButton label="Go to organizations" onPress={() => router.replace("/organizations")} />
                <ProovraButton label="Return to dashboard" variant="secondary" onPress={() => router.replace("/(tabs)")} />
              </View>
            </View>
          ) : null}
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  actions: { marginTop: 16, gap: 8 },
  panel: { marginTop: theme.space.s4, padding: theme.space.s3, borderRadius: theme.radius.md, borderWidth: 1, gap: theme.space.s2 },
  panelOk: { borderColor: theme.color.status.verified.border, backgroundColor: theme.color.status.verified.bg },
  panelError: { borderColor: theme.color.status.risk.border, backgroundColor: theme.color.status.risk.bg },
  errorActions: { gap: theme.space.s2, marginTop: theme.space.s1 },
});
