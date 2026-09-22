/**
 * EXTERNAL REVIEWER PORTAL — the native port of `apps/web/app/portal/[token]`.
 *
 * The reader is NOT a PROOVRA user. Their credential is the portal token from
 * their invitation, exchanged here for a portal session. The app's own
 * `authToken` is never attached — a review decision attributed to whichever
 * account happens to be signed in on the device is a false custody record — so
 * every call goes through `publicFetch` with the portal's own bearer.
 *
 * Denials are the product, not errors. Expired, revoked, throttled and
 * MFA-pending are states a reviewer must be able to read and act on; "your
 * access expired" is actionable and "something went wrong" sends them to email
 * somebody to find out which of four things happened.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { publicFetch } from "../../../src/api";
import { formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraListRow,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraLoadingState,
  ProovraEmpty,
} from "../../../src/ui";
import {
  PORTAL_AUTH_PATH,
  PORTAL_DASHBOARD_PATH,
  PORTAL_LOGOUT_PATH,
  assignmentTone,
  buildPortalAuthBody,
  classifyPortalDenial,
  parsePortalAuth,
  parsePortalDashboard,
  portalCredential,
  portalDenialMessage,
  sortAssignments,
  type PortalDashboard,
  type PortalDenial,
} from "../../../src/product/portal";
import {
  clearPortalSession,
  getPortalSessionId,
  getPortalToken,
  setPortalSessionId,
  setPortalToken,
} from "../../../src/portal/portal-session";

type Phase =
  | { kind: "authenticating" }
  | { kind: "mfa" }
  | { kind: "ready"; dashboard: PortalDashboard }
  | { kind: "denied"; denial: PortalDenial };

export default function PortalScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;

  const [phase, setPhase] = useState<Phase>({ kind: "authenticating" });
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);

  const loadDashboard = useCallback(async () => {
    const data = await publicFetch(
      PORTAL_DASHBOARD_PATH,
      { method: "GET" },
      portalCredential(getPortalToken(), getPortalSessionId()),
    );
    const dashboard = parsePortalDashboard(data);
    if (!dashboard) {
      setPhase({ kind: "denied", denial: "UNKNOWN" });
      return;
    }
    setPhase({ kind: "ready", dashboard });
  }, []);

  const authenticate = useCallback(
    async (code?: string) => {
      if (!token) {
        setPhase({ kind: "denied", denial: "NOT_FOUND" });
        return;
      }
      setBusy(true);
      setPortalToken(token);
      try {
        const res = await publicFetch(
          PORTAL_AUTH_PATH,
          {
            method: "POST",
            body: JSON.stringify(
              buildPortalAuthBody({
                token,
                mfaToken: code ?? null,
                existingSessionId: getPortalSessionId(),
              }),
            ),
          },
          portalCredential(token, getPortalSessionId()),
        );

        const session = parsePortalAuth(res);
        if (!session) {
          setPhase({ kind: "denied", denial: "UNKNOWN" });
          return;
        }
        setPortalSessionId(session.sessionId);
        await loadDashboard();
      } catch (err) {
        const denial = classifyPortalDenial(err);
        setPhase(denial === "MFA" ? { kind: "mfa" } : { kind: "denied", denial });
      } finally {
        setBusy(false);
      }
    },
    [token, loadDashboard],
  );

  useEffect(() => {
    void authenticate();
    // The credential is forgotten when this screen goes away: a phone that is
    // shared or handed over must not carry access to somebody else's evidence.
    return () => clearPortalSession();
  }, [authenticate]);

  const signOut = useCallback(async () => {
    try {
      await publicFetch(
        PORTAL_LOGOUT_PATH,
        { method: "POST", body: JSON.stringify({}) },
        portalCredential(getPortalToken(), getPortalSessionId()),
      );
    } catch {
      // Forgetting locally is the part that matters.
    } finally {
      clearPortalSession();
      router.replace("/");
    }
  }, [router]);

  return (
    <ProovraScreen testID="portal">
      <ProovraPageHeader
        title="Review portal"
        eyebrow="External review"
        subtitle={
          phase.kind === "ready"
            ? (phase.dashboard.reviewerEmail ?? undefined)
            : undefined
        }
      />

      {phase.kind === "authenticating" ? (
        <ProovraLoadingState label="Opening your review access" />
      ) : null}

      {phase.kind === "mfa" ? (
        <ProovraCard>
          <ProovraText variant="body">{portalDenialMessage("MFA")}</ProovraText>
          <ProovraFormField label="Verification code">
            <ProovraInput
              value={mfaCode}
              onChangeText={setMfaCode}
              placeholder="123456"
              keyboardType="number-pad"
              accessibilityLabel="Verification code"
            />
          </ProovraFormField>
          <ProovraButton
            label="Continue"
            loading={busy}
            disabled={mfaCode.trim().length === 0}
            onPress={() => void authenticate(mfaCode.trim())}
          />
        </ProovraCard>
      ) : null}

      {phase.kind === "denied" ? (
        <ProovraEmpty
          presence="page"
          title="This review access is not open"
          purpose={portalDenialMessage(phase.denial)}
        />
      ) : null}

      {phase.kind === "ready" ? (
        <>
          <ProovraCard>
            <ProovraText variant="body" weight="semibold">
              {phase.dashboard.reviewerName ?? phase.dashboard.reviewerEmail ?? "Reviewer"}
            </ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {[phase.dashboard.organization, phase.dashboard.role].filter(Boolean).join(" · ")}
            </ProovraText>
            <View style={{ flexDirection: "row", gap: theme.space.s2, flexWrap: "wrap" }}>
              {phase.dashboard.scopeLabel ? (
                <ProovraBadge label={phase.dashboard.scopeLabel} tone="governance" />
              ) : null}
              {phase.dashboard.scopeExpiresAtIso ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {`Access ends ${formatUserDateTime(phase.dashboard.scopeExpiresAtIso)}`}
                </ProovraText>
              ) : null}
            </View>
          </ProovraCard>

          <ProovraPageSection title="Assigned to you">
            {phase.dashboard.assigned.length === 0 ? (
              <ProovraEmpty presence="inline" title="Nothing is assigned to you right now." />
            ) : (
              <ProovraCard>
                {sortAssignments(phase.dashboard.assigned).map((a) => (
                  <ProovraListRow
                    key={a.workflowId}
                    title={a.title}
                    subtitle={
                      a.submittedDecisionAtIso
                        ? `Decided ${formatUserDateTime(a.submittedDecisionAtIso)}`
                        : a.dueAtIso
                          ? `Due ${formatUserDateTime(a.dueAtIso)}`
                          : undefined
                    }
                    onPress={() => router.push(`/portal/work/${a.workflowId}`)}
                    trailing={
                      <ProovraBadge
                        label={a.submittedDecisionAtIso ? "Done" : "To review"}
                        tone={assignmentTone(a)}
                      />
                    }
                  />
                ))}
              </ProovraCard>
            )}
          </ProovraPageSection>

          {/*
            The bounded limitations footer, from the server. A review portal is
            exactly where a claim about truth or admissibility would look most
            authoritative, so what the platform does NOT establish is stated
            here rather than left for the reviewer to assume.
          */}
          {phase.dashboard.limitations.length > 0 ? (
            <ProovraCard>
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
                What this review does not establish
              </ProovraText>
              {phase.dashboard.limitations.map((l, i) => (
                <ProovraText key={i} variant="label" color={theme.color.ink.muted}>
                  {`• ${l}`}
                </ProovraText>
              ))}
            </ProovraCard>
          ) : null}

          <ProovraButton label="Sign out of the portal" variant="ghost" onPress={() => void signOut()} />
        </>
      ) : null}
    </ProovraScreen>
  );
}
