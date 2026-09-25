/**
 * INVITE ACCEPTANCE — workspace invitations (T-15, src/ui/workspace-invite.tsx)
 * and COLLABORATION invites (Native Convergence §14, M7). A deep-link
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
import { theme } from "../../../src/theme/theme";
import { setPendingRoute } from "../../../src/deep-link/pending-intent";
import { isWellFormedWorkspaceInviteToken } from "@proovra/shared";
import { WorkspaceInvite } from "../../../src/ui/workspace-invite";
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

type Phase = "checking" | "ready" | "accepting" | "accepted" | "invalid" | "refused" | "error";

/**
 * T-15 — /invite/<token> carries TWO invitation kinds, told apart by token
 * shape as on the web: a WORKSPACE invitation (wsit_v1_…, emailed by
 * sendTeamInvitation) and a collaboration-team invitation. Before this, every
 * token went to the collaboration endpoint, so a workspace invitation opened
 * in the app was reported as invalid.
 */
export default function InviteScreen() {
  const params = useLocalSearchParams<{ token?: string }>();
  const token = params.token ?? "";
  if (isWellFormedWorkspaceInviteToken(token)) return <WorkspaceInvite token={token} />;
  return <CollaborationInviteScreen />;
}

function CollaborationInviteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = params.token ?? "";
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<SafeError | null>(null);
  const [refused, setRefused] = useState<{ title: string; body: string } | null>(null);

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
      /*
       * THE TOKEN TRAVELS IN THE BODY.
       *
       * This used to POST to `/v1/collaboration-team-invites/:token/accept`,
       * the legacy path form. The route dispositions mark that form
       * SUPERSEDED_REMOVE and the web's client records why it moved (D9):
       * "a path token is written to access logs by every intermediary."
       *
       * The API keeps the path form only for links already sitting in
       * mailboxes. A client written today has no reason to use it, and a
       * native client putting a credential in a URL is the same leak on a
       * phone as in a browser.
       */
      const res = await apiFetch("/v1/collaboration-team-invites/accept", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      const teamId = typeof res?.teamId === "string" ? res.teamId : null;
      setPhase("accepted");
      if (teamId) router.replace(`/collaboration-team/${teamId}`);
      else router.replace("/teams");
    } catch (err) {
      const safe = toSafeUserError(err);
      // T-12 — the two PLAN refusals are not errors to retry: the web shows a
      // panel with "View billing" and "Back to Teams" (accept/page.tsx:130-156,
      // 405, 440). Retrying cannot change the owner's plan.
      const refusal = inviteRefusal(err);
      if (refusal) {
        setRefused(refusal);
        setPhase("refused");
        return;
      }
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
  if (phase === "refused" && refused) {
    return (
      <ProovraScreen scroll={false}>
        <ProovraEmptyState
          title={refused.title}
          message={refused.body}
          action={
            <View style={styles.actions}>
              <ProovraButton
                label="View billing"
                accessibilityLabel="View billing and upgrade options"
                fullWidth={false}
                onPress={() => router.push("/billing")}
              />
              <ProovraButton label="Back to Teams" variant="ghost" fullWidth={false} onPress={() => router.replace("/teams")} />
            </View>
          }
        />
      </ProovraScreen>
    );
  }
  if (phase === "error" && error) {
    return <ProovraScreen scroll={false}><ProovraErrorState message={error.message} requestId={error.requestId ?? null} onRetry={() => void accept()} /></ProovraScreen>;
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
        {/* The web invite TrustLine (invite/[token]/page.tsx:494-502). */}
        <ProovraText variant="label" color={theme.color.ink.muted} testID="invite-trust-line">
          {"Invitation links are single-use and expire. Never share this link. "}
          <ProovraText variant="label" color={theme.color.accent.a600} accessibilityRole="link" accessibilityLabel="Privacy" onPress={() => router.push("/legal/privacy")}>Privacy</ProovraText>
          {" · "}
          <ProovraText variant="label" color={theme.color.accent.a600} accessibilityRole="link" accessibilityLabel="Terms" onPress={() => router.push("/legal/terms")}>Terms</ProovraText>
          {" · "}
          <ProovraText variant="label" color={theme.color.accent.a600} accessibilityRole="link" accessibilityLabel="Support" onPress={() => router.push("/support")}>Support</ProovraText>
        </ProovraText>
      </ProovraSection>
    </ProovraScreen>
  );
}

/**
 * The owner's-plan refusals (accept/page.tsx:130-156, 203-224). Seat counts
 * come ONLY from the error's details; nothing is invented when they are absent.
 */
export function inviteRefusal(err: unknown): { title: string; body: string } | null {
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown; details?: Record<string, unknown> };
  if (e.code === "TEAM_MEMBER_LIMIT_REACHED") {
    const d = e.details ?? {};
    const plan = typeof d.plan === "string" ? d.plan : null;
    const max = typeof d.maxMembersPerTeam === "number" ? d.maxMembersPerTeam : null;
    const current = typeof d.currentMemberCount === "number" ? d.currentMemberCount : null;
    const suffix =
      plan && max !== null && current !== null
        ? ` (${current} of ${max} seats in use on plan ${plan})`
        : plan
          ? ` (plan ${plan})`
          : "";
    return {
      title: "This team is at capacity for the owner's plan",
      body: `The team owner needs to free a seat or upgrade their plan before you can join.${suffix}`,
    };
  }
  if (e.code === "TEAM_INVITES_NOT_INCLUDED") {
    return {
      title: "This invitation is unavailable",
      body: "The Team owner's current plan no longer supports this invitation.",
    };
  }
  return null;
}

const styles = StyleSheet.create({
  actions: { marginTop: 16, gap: 8 },
});
