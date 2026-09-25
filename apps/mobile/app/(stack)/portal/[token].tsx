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
 *
 * The emailed-code step is the port of the web's PortalMfaCodeStep: it says
 * where the code went (the server's masked address), how long until another
 * may be requested, how many tries remain, and offers "Send a new code" —
 * which, exactly as on the web, is the same token exchange sent WITHOUT a code
 * (POST /v1/portal/auth issues a code on every code-less exchange; there is no
 * separate resend route).
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
  isPortalMfaStepDenial,
  normalizePortalMfaCode,
  parsePortalAuth,
  parsePortalDashboard,
  portalCredential,
  portalDenialMessage,
  portalMfaCooldownMessage,
  portalMfaProblemMessage,
  portalMfaSecondsLeft,
  portalMfaStatusMessage,
  readPortalDenialCode,
  readPortalMfaDetail,
  sortAssignments,
  type PortalDashboard,
  type PortalDenial,
  type PortalSession,
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

type MfaProblem = { denial: string | null; attemptsRemaining: number | null; fallback?: string };

type MfaState = {
  codeSent: boolean;
  destination: string | null;
  /** Epoch ms after which another code may be requested; 0 = now. */
  cooldownUntil: number;
  problem: MfaProblem | null;
};

const NO_MFA: MfaState = { codeSent: false, destination: null, cooldownUntil: 0, problem: null };

/** Not answered yet: tells "the exchange threw" apart from "it answered". */
const PENDING = Symbol("pending");

export default function PortalScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;

  const [phase, setPhase] = useState<Phase>({ kind: "authenticating" });
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState<"verify" | "resend" | null>(null);
  const [mfa, setMfa] = useState<MfaState>(NO_MFA);
  const [now, setNow] = useState<number>(() => Date.now());

  // The resend countdown: one tick a second while a cooldown is running on the
  // code step, and no longer — a timer left ticking behind the dashboard keeps
  // the JS thread busy for nothing.
  const onCodeStep = phase.kind === "mfa";
  useEffect(() => {
    if (!onCodeStep || mfa.cooldownUntil <= Date.now()) return;
    const t = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= mfa.cooldownUntil) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [onCodeStep, mfa.cooldownUntil]);

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

  /** POST /v1/portal/auth: a 200 keeps and returns the session; a refusal throws. */
  const exchange = useCallback(async (tok: string, code: string | null) => {
    setPortalToken(tok);
    const res = await publicFetch(
      PORTAL_AUTH_PATH,
      {
        method: "POST",
        body: JSON.stringify(
          buildPortalAuthBody({
            token: tok,
            mfaToken: code,
            existingSessionId: getPortalSessionId(),
          }),
        ),
      },
      portalCredential(tok, getPortalSessionId()),
    );
    const session = parsePortalAuth(res);
    if (session) setPortalSessionId(session.sessionId);
    return session;
  }, []);

  /** After a 200 exchange: open the dashboard, or say it could not be read. */
  const openPortal = useCallback(
    async (session: PortalSession | null) => {
      if (!session) {
        setPhase({ kind: "denied", denial: "UNKNOWN" });
        return;
      }
      try {
        await loadDashboard();
      } catch (err) {
        setPhase({ kind: "denied", denial: classifyPortalDenial(err) });
      }
    },
    [loadDashboard],
  );

  /**
   * What a refused exchange says about the code (the web's acceptFailure): a
   * live code's masked address and cooldown, and — after MFA_CODE_EXHAUSTED —
   * that the old email is worthless, because the server destroyed the challenge.
   */
  const acceptFailure = useCallback((err: unknown) => {
    const denial = readPortalDenialCode(err);
    const detail = readPortalMfaDetail(err);
    const at = Date.now();
    setMfa((m) => {
      let next = m;
      if (detail?.codeSent) {
        next = {
          ...next,
          codeSent: true,
          destination: detail.destination ?? next.destination,
          cooldownUntil: detail.resendAvailableInSeconds
            ? at + detail.resendAvailableInSeconds * 1000
            : next.cooldownUntil,
        };
      }
      if (denial === "MFA_CODE_EXHAUSTED") next = { ...next, codeSent: false, cooldownUntil: 0 };
      return next;
    });
    setNow(at);
    return { denial, detail };
  }, []);

  /** The first exchange, when the screen opens. */
  const start = useCallback(async () => {
    if (!token) {
      setPhase({ kind: "denied", denial: "NOT_FOUND" });
      return;
    }
    let session: PortalSession | null;
    try {
      session = await exchange(token, null);
    } catch (err) {
      const denial = readPortalDenialCode(err);
      if (isPortalMfaStepDenial(denial) || classifyPortalDenial(err) === "MFA") {
        setMfa(NO_MFA);
        const { detail } = acceptFailure(err);
        // MFA_REQUIRED is the step's normal opening, not a problem to report.
        const problem: MfaProblem | null =
          denial === "MFA_REQUIRED" || !isPortalMfaStepDenial(denial)
            ? null
            : { denial, attemptsRemaining: detail?.attemptsRemaining ?? null };
        setMfa((m) => ({ ...m, problem }));
        setPhase({ kind: "mfa" });
      } else {
        setPhase({ kind: "denied", denial: classifyPortalDenial(err) });
      }
      return;
    }
    await openPortal(session);
  }, [token, exchange, acceptFailure, openPortal]);

  const verify = useCallback(async () => {
    if (!token) return;
    setBusy("verify");
    setMfa((m) => ({ ...m, problem: null }));
    let session: PortalSession | null | typeof PENDING = PENDING;
    try {
      session = await exchange(token, mfaCode);
    } catch (err) {
      const { denial, detail } = acceptFailure(err);
      setMfaCode("");
      setMfa((m) => ({
        ...m,
        problem: {
          denial,
          attemptsRemaining: detail?.attemptsRemaining ?? null,
          fallback: "We couldn't check your code. Try again.",
        },
      }));
    } finally {
      setBusy(null);
    }
    if (session !== PENDING) await openPortal(session);
  }, [token, mfaCode, exchange, acceptFailure, openPortal]);

  /** "Send a new code": the same exchange with no code, exactly as the web sends it. */
  const resend = useCallback(async () => {
    if (!token) return;
    setBusy("resend");
    setMfa((m) => ({ ...m, problem: null }));
    let session: PortalSession | null | typeof PENDING = PENDING;
    try {
      // Nothing owed any more (satisfied elsewhere meanwhile) simply opens.
      session = await exchange(token, null);
    } catch (err) {
      const { denial, detail } = acceptFailure(err);
      // A fresh code on its way is the success case, not a problem.
      if (!(denial === "MFA_REQUIRED" && detail?.codeSent)) {
        setMfa((m) => ({
          ...m,
          problem: {
            denial,
            attemptsRemaining: null,
            fallback: "We couldn't send a new code. Try again.",
          },
        }));
      }
    } finally {
      setBusy(null);
    }
    if (session !== PENDING) await openPortal(session);
  }, [token, exchange, acceptFailure, openPortal]);

  useEffect(() => {
    void start();
    // The credential is forgotten when this screen goes away: a phone that is
    // shared or handed over must not carry access to somebody else's evidence.
    return () => clearPortalSession();
  }, [start]);

  const cooldownMessage = portalMfaCooldownMessage(portalMfaSecondsLeft(mfa.cooldownUntil, now));

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
        title={phase.kind === "mfa" ? "Confirm it is you" : "Review portal"}
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
          <ProovraText variant="h3" weight="semibold" accessibilityRole="header">
            Enter your sign-in code
          </ProovraText>
          <View accessibilityLiveRegion="polite">
            <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
              {portalMfaStatusMessage(mfa.codeSent, mfa.destination)}
            </ProovraText>
          </View>
          <ProovraFormField label="Six-digit code">
            <ProovraInput
              value={mfaCode}
              onChangeText={(t) => setMfaCode(normalizePortalMfaCode(t))}
              placeholder="123456"
              keyboardType="number-pad"
              accessibilityLabel="Six-digit code"
              onSubmitEditing={() => {
                if (mfaCode.length === 6 && busy === null) void verify();
              }}
            />
          </ProovraFormField>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Check your inbox and spam folder. Only the newest code works.
          </ProovraText>

          {mfa.problem ? (
            <View accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <ProovraText variant="label" color={theme.color.status.risk.fg}>
                {portalMfaProblemMessage(
                  mfa.problem.denial,
                  mfa.problem.attemptsRemaining,
                  mfa.problem.fallback,
                )}
              </ProovraText>
            </View>
          ) : null}

          <ProovraButton
            label={busy === "verify" ? "Checking code…" : "Verify code"}
            loading={busy === "verify"}
            disabled={busy !== null || mfaCode.length !== 6}
            onPress={() => void verify()}
          />
          <ProovraButton
            label={busy === "resend" ? "Sending…" : mfa.codeSent ? "Send a new code" : "Send a code"}
            variant="secondary"
            loading={busy === "resend"}
            disabled={busy !== null || cooldownMessage !== null}
            onPress={() => void resend()}
          />
          {cooldownMessage ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {cooldownMessage}
            </ProovraText>
          ) : null}
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
