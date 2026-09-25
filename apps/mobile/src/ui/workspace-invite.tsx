/**
 * WORKSPACE INVITATION SCREEN BODY (T-15) — see src/product/workspace-invite.ts.
 * Renders exactly the view `resolveInvitationView` (shared with the web)
 * returns; it decides nothing itself. Touch adaptation: "Go to homepage" and
 * "Go to dashboard" both land on native Home — there is no marketing page.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import {
  resolveInvitationView,
  type InvitationAcceptOutcome,
  type InvitationAction,
  type InvitationLookupOutcome,
} from "@proovra/shared";
import { isWellFormedWorkspaceInviteToken } from "@proovra/shared";

import { apiFetch } from "../api";
import { logout } from "../auth/auth-api";
import { useAuth } from "../auth-context";
import { setPendingRoute } from "../deep-link/pending-intent";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  WORKSPACE_INVITE_ACTION_LABEL,
  WORKSPACE_INVITE_COPY,
  WORKSPACE_INVITE_LOOKUP_PATH,
  buildWorkspaceInviteAcceptPath,
  formatInviteRole,
  inviteRefusalCode,
  isInviteNotFound,
  parseWorkspaceInviteAccept,
  parseWorkspaceInviteLookup,
} from "../product/workspace-invite";
import { ProovraButton, ProovraCard, ProovraScreen, ProovraSection, ProovraText } from "./index";
import { ProovraDetailRows } from "./patterns";

export function WorkspaceInvite({ token }: { token: string }) {
  const router = useRouter();
  const { token: session, authReady, setToken } = useAuth();
  const [lookup, setLookup] = useState<InvitationLookupOutcome>({ kind: "pending" });
  const [accept, setAccept] = useState<InvitationAcceptOutcome>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);

  // READ — never consumes the invitation. A malformed token is never sent.
  useEffect(() => {
    if (!isWellFormedWorkspaceInviteToken(token)) {
      setLookup({ kind: "not-available" });
      return;
    }
    let cancelled = false;
    setLookup({ kind: "pending" });
    void (async () => {
      try {
        const parsed = parseWorkspaceInviteLookup(
          await apiFetch(WORKSPACE_INVITE_LOOKUP_PATH, { method: "POST", body: JSON.stringify({ token }) }),
        );
        if (!cancelled) setLookup(parsed ? { kind: "resolved", lookup: parsed } : { kind: "not-available" });
      } catch (err) {
        // A 404 is a verdict; everything else is an interruption, never "invalid".
        if (!cancelled) setLookup(isInviteNotFound(err) ? { kind: "not-available" } : { kind: "unreachable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  // WRITE — only on purpose.
  const onAccept = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAccept({ kind: "submitting" });
    void (async () => {
      try {
        const res = parseWorkspaceInviteAccept(
          await apiFetch(buildWorkspaceInviteAcceptPath(token), { method: "POST", body: JSON.stringify({}) }),
        );
        setAccept({ kind: "accepted", alreadyMember: res.alreadyMember, destination: "/" });
      } catch (err) {
        const code = inviteRefusalCode(err);
        setAccept(code ? { kind: "refused", code } : { kind: "unreachable" });
      } finally {
        inFlight.current = false;
      }
    })();
  }, [token]);

  const view = resolveInvitationView({
    token,
    // Auth state follows the session, including the boot window ("resolving"),
    // so a signed-in reader is never shown the signed-out actions mid-boot.
    auth: !authReady ? { kind: "resolving" } : session ? { kind: "signed-in", email: null } : { kind: "signed-out" },
    lookup,
    accept,
  });
  const copy = WORKSPACE_INVITE_COPY[view.kind];

  const run = async (action: InvitationAction) => {
    switch (action) {
      case "accept":
        onAccept();
        return;
      case "retry":
        setAccept({ kind: "idle" });
        setAttempt((a) => a + 1);
        return;
      case "sign-in":
        // The invitation replays here after the whole sign-in journey.
        setPendingRoute(`/invite/${token}`);
        router.push("/(stack)/auth");
        return;
      case "create-account":
        setPendingRoute(`/invite/${token}`);
        router.push("/(stack)/register");
        return;
      case "switch-account":
        setPendingRoute(`/invite/${token}`);
        await logout();
        setToken(null);
        router.replace("/(stack)/auth");
        return;
      case "open-workspace":
      case "go-dashboard":
      case "go-home":
        router.replace("/");
        return;
    }
  };

  const ctx = view.context;
  const expires = ctx?.expiresAtUtc && !Number.isNaN(Date.parse(ctx.expiresAtUtc)) ? formatUserDateTime(ctx.expiresAtUtc) : null;

  return (
    <ProovraScreen width="form">
      <ProovraSection title="Invitation">
        <ProovraCard>
          <View style={{ gap: theme.space.s3 }} testID={`workspace-invite-${view.kind}`}>
            <ProovraText variant="h3" weight="semibold">{copy.title}</ProovraText>
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{copy.message}</ProovraText>
            {ctx ? (
              <ProovraDetailRows
                rows={[
                  { label: "Workspace", value: ctx.workspaceName },
                  ...(ctx.organizationName ? [{ label: "Organization", value: ctx.organizationName }] : []),
                  { label: "Role", value: formatInviteRole(ctx.role) },
                  ...(ctx.invitedEmailMasked ? [{ label: "Invited as", value: ctx.invitedEmailMasked }] : []),
                  ...(expires ? [{ label: "Expires", value: expires }] : []),
                ]}
              />
            ) : null}
            <View style={{ gap: theme.space.s2 }}>
              {view.actions.map((a, i) => (
                <ProovraButton
                  key={a}
                  label={WORKSPACE_INVITE_ACTION_LABEL[a]}
                  variant={i === 0 ? "primary" : "secondary"}
                  onPress={() => void run(a)}
                />
              ))}
            </View>
          </View>
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}
