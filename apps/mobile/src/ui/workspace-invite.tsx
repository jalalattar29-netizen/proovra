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
  classifyWorkspaceEntryRefusal,
  resolveInvitationView,
  type InvitationAcceptOutcome,
  type InvitationAction,
  type InvitationEntryOutcome,
  type InvitationLookupOutcome,
} from "@proovra/shared";
import { isWellFormedWorkspaceInviteToken } from "@proovra/shared";

import { apiFetch } from "../api";
import { logout } from "../auth/auth-api";
import { useAuth } from "../auth-context";
import { teardownCaptureOnSignOut } from "../capture/capture-teardown";
import { setPendingRoute } from "../deep-link/pending-intent";
import { triggerLegalGate } from "../auth/legal-gate";
import { refreshPlatformContext } from "../product/platform-context";
import { SWITCH_WORKSPACE_PATH, buildSwitchWorkspaceBody } from "../product/spaces";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  WORKSPACE_INVITE_ACTION_LABEL,
  WORKSPACE_INVITE_COPY,
  WORKSPACE_INVITE_ENTRY_BLOCK_MESSAGE,
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
  const { token: session, authReady, setToken, user } = useAuth();
  const [lookup, setLookup] = useState<InvitationLookupOutcome>({ kind: "pending" });
  const [accept, setAccept] = useState<InvitationAcceptOutcome>({ kind: "idle" });
  const [entry, setEntry] = useState<InvitationEntryOutcome>({ kind: "idle" });
  const [verificationSent, setVerificationSent] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  /** The workspace the accept response named — what Open workspace switches into. */
  const acceptedWorkspaceId = useRef<string | null>(null);
  const openInFlight = useRef(false);

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
        acceptedWorkspaceId.current = res.workspaceId;
        setAccept({ kind: "accepted", alreadyMember: res.alreadyMember, destination: "/" });
      } catch (err) {
        const code = inviteRefusalCode(err);
        setAccept(code ? { kind: "refused", code } : { kind: "unreachable" });
      } finally {
        inFlight.current = false;
      }
    })();
  }, [token]);

  /**
   * F-07 (Free-user audit, 2026-11-13) — OPEN WORKSPACE OPENS THE WORKSPACE
   * JUST JOINED. It used to be `router.replace("/")` with no switch, so the
   * reader landed in whatever space the server pointer named (usually their own
   * Personal one) under "you now have access". The pointer is moved by the same
   * server switch Spaces uses (the server re-authorizes, organization session
   * rules included), the context is re-read, and only then does it navigate. A
   * refusal is classified from stable fields and shown, never swallowed.
   */
  const openWorkspace = useCallback(async () => {
    if (openInFlight.current) return;
    const workspaceId = acceptedWorkspaceId.current;
    if (!workspaceId) {
      router.replace("/");
      return;
    }
    openInFlight.current = true;
    setEntry({ kind: "opening" });
    try {
      await apiFetch(SWITCH_WORKSPACE_PATH, {
        method: "POST",
        body: JSON.stringify(buildSwitchWorkspaceBody(workspaceId)),
      });
      refreshPlatformContext();
      router.replace("/");
    } catch (err) {
      const e = (err ?? {}) as { statusCode?: unknown; code?: unknown; body?: { reason?: unknown } };
      setEntry({
        kind: "blocked",
        block: classifyWorkspaceEntryRefusal({
          statusCode: typeof e.statusCode === "number" ? e.statusCode : null,
          code: typeof e.code === "string" ? e.code : null,
          reason: typeof e.body?.reason === "string" ? e.body.reason : null,
        }),
      });
    } finally {
      openInFlight.current = false;
    }
  }, [router]);

  const view = resolveInvitationView({
    token,
    // Auth state follows the session, including the boot window ("resolving"),
    // so a signed-in reader is never shown the signed-out actions mid-boot.
    auth: !authReady ? { kind: "resolving" } : session ? { kind: "signed-in", email: null } : { kind: "signed-out" },
    lookup,
    accept,
    entry,
  });
  const baseCopy = WORKSPACE_INVITE_COPY[view.kind];
  const copy =
    view.kind === "accepted-not-opened" && view.entryBlock
      ? { ...baseCopy, message: WORKSPACE_INVITE_ENTRY_BLOCK_MESSAGE[view.entryBlock] }
      : baseCopy;

  const run = async (action: InvitationAction) => {
    switch (action) {
      case "accept":
        onAccept();
        return;
      case "retry":
        setAccept({ kind: "idle" });
        setEntry({ kind: "idle" });
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
        // Capture ends with the account session here too, while the token is
        // still valid. The invitation is set after sign-out, which clears intents.
        await teardownCaptureOnSignOut().catch(() => undefined);
        await logout();
        setToken(null);
        setPendingRoute(`/invite/${token}`);
        router.replace("/(stack)/auth");
        return;
      case "open-workspace":
      case "retry-open":
        await openWorkspace();
        return;
      case "go-dashboard":
      case "go-home":
        router.replace("/");
        return;
      case "send-verification": {
        // F-26e — EMAIL_NOT_VERIFIED. The invitation is queued as the pending
        // route, so the verification link's sign-in replays it here.
        const email = user?.email ?? "";
        if (!email || verificationSent) return;
        setVerificationSent(true);
        setPendingRoute(`/invite/${token}`);
        try {
          await apiFetch("/v1/auth/email/resend-verification", {
            method: "POST",
            body: JSON.stringify({ email, next: `/invite/${token}` }),
          });
        } catch {
          setVerificationSent(false);
        }
        return;
      }
      case "review-terms":
        // The app's legal-acceptance screen, which resumes afterwards.
        triggerLegalGate([]);
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
                  label={
                    a === "send-verification" && verificationSent
                      ? "Verification email sent"
                      : WORKSPACE_INVITE_ACTION_LABEL[a]
                  }
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
