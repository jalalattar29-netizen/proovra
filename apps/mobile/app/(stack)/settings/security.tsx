/**
 * SETTINGS › SECURITY — the native port of the canonical personal security
 * surface (`apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`,
 * rendered by `/settings#security`).
 *
 * Before this, native Settings read one endpoint and the whole
 * `/v1/identity-security/*` + `/v1/identity/mfa/*` family had no native
 * consumer at all: no password change, no session inventory, no session
 * revocation, no MFA management, no security activity. On a device that can be
 * lost, those are not optional.
 *
 * The five canonical sections are ported in the same order the web renders
 * them. Composition comes from `src/ui/patterns` so this screen does not invent
 * a layout; the projections are in `src/product/account-security.ts` so the
 * logic is testable without a device.
 */
import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { StepUpSheet, useStepUp } from "../../../src/ui/step-up-sheet";
import { TotpEnrolment } from "../../../src/ui/totp-enrolment";
import { withStepUp } from "../../../src/product/step-up";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import { useToast } from "../../../src/toast-context";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraPageHeader,
  ProovraPageSection,
  ProovraEmpty,
  ProovraDetailRows,
  ProovraConfirmSheet,
  ProovraAsyncView,
} from "../../../src/ui";
import {
  parseSignInMethods,
  parseMfaStatus,
  parseSessions,
  parseSecurityEvents,
  passwordChecks,
  passwordFormBlocker,
  signInRisk,
  mfaFactorTone,
  type SignInMethods,
  type MfaStatus,
  type SessionInventory,
  type SecurityEvent,
} from "../../../src/product/account-security";

type Pending =
  | { kind: "revoke-session"; id: string; label: string }
  | { kind: "revoke-others"; count: number }
  | { kind: "remove-factor"; id: string; label: string }
  | null;

export default function SecuritySettingsScreen() {
  const router = useRouter();
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SafeError | null>(null);
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [sessions, setSessions] = useState<SessionInventory | null>(null);
  const [events, setEvents] = useState<SecurityEvent[]>([]);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [pending, setPending] = useState<Pending>(null);
  const [acting, setActing] = useState(false);
  const stepUp = useStepUp();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      /*
       * Four independent reads, settled together. `allSettled` rather than
       * `all` because one unavailable section must not blank the other four —
       * a user who cannot load their security ACTIVITY can still need to revoke
       * a session right now.
       */
      const [linksRes, mfaRes, sessionsRes, eventsRes] = await Promise.allSettled([
        apiFetch("/v1/identity/links"),
        apiFetch("/v1/identity/mfa/factors"),
        apiFetch("/v1/identity-security/my-sessions"),
        apiFetch("/v1/identity-security/security-events"),
      ]);

      if (linksRes.status === "rejected" && sessionsRes.status === "rejected") {
        throw linksRes.reason;
      }
      setMethods(linksRes.status === "fulfilled" ? parseSignInMethods(linksRes.value) : null);
      setMfa(mfaRes.status === "fulfilled" ? parseMfaStatus(mfaRes.value) : null);
      setSessions(sessionsRes.status === "fulfilled" ? parseSessions(sessionsRes.value) : null);
      setEvents(eventsRes.status === "fulfilled" ? parseSecurityEvents(eventsRes.value) : []);
    } catch (err) {
      setError(toSafeUserError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const blocker = passwordFormBlocker({ current, next, confirm });

  const changePassword = useCallback(async () => {
    if (blocker) return;
    setSavingPassword(true);
    // A step-up challenge is answered and the SAME request is retried, rather
    // than being reported as a failure the user cannot act on.
    await stepUp.start(
      async (proof) => {
        await apiFetch("/v1/identity-security/password", {
          method: "POST",
          body: JSON.stringify(
            withStepUp({ currentPassword: current, newPassword: next }, proof),
          ),
        });
        setCurrent("");
        setNext("");
        setConfirm("");
        addToast("Password changed", "success");
        // The change is itself a security event, and it may end other sessions.
        void load();
      },
      (err) => addToast(toSafeUserError(err).message, "error"),
    );
    setSavingPassword(false);
  }, [blocker, current, next, addToast, load, stepUp]);

  const runPending = useCallback(async () => {
    if (!pending) return;
    setActing(true);
    await stepUp.start(
      async (proof) => {
        const body = JSON.stringify(withStepUp({}, proof));
        if (pending.kind === "revoke-session") {
          await apiFetch(`/v1/identity-security/my-sessions/${pending.id}/revoke`, {
            method: "POST",
            body,
          });
          addToast("Session signed out", "success");
        } else if (pending.kind === "revoke-others") {
          await apiFetch("/v1/identity-security/my-sessions/revoke-others", {
            method: "POST",
            body,
          });
          addToast("Other sessions signed out", "success");
        } else if (pending.kind === "remove-factor") {
          // The route reads `req.body.stepUp` on a DELETE, so this one
          // carries a body too — removing an ACTIVE factor is step-up guarded,
          // and a DELETE sent bodyless could never satisfy it.
          await apiFetch(`/v1/identity/mfa/factors/${pending.id}`, {
            method: "DELETE",
            body,
          });
          addToast("Two-factor method removed", "success");
        }
        setPending(null);
        await load();
      },
      (err) => addToast(toSafeUserError(err).message, "error"),
    );
    setActing(false);
  }, [pending, addToast, load, stepUp]);

  const regenerateRecoveryCodes = useCallback(async () => {
    await stepUp.start(
      async (proof) => {
        await apiFetch("/v1/identity/mfa/recovery-codes/regenerate", {
          method: "POST",
          body: JSON.stringify(withStepUp({}, proof)),
        });
        addToast("New recovery codes issued", "success");
        await load();
      },
      (err) => addToast(toSafeUserError(err).message, "error"),
    );
  }, [addToast, load, stepUp]);

  const risk = methods && mfa ? signInRisk(methods, mfa) : null;

  return (
    <ProovraScreen testID="settings-security">
      <ProovraPageHeader
        title="Security"
        eyebrow="Account"
        subtitle="How you sign in, where you are signed in, and what has changed."
        contextStrip={risk ? <ProovraBadge label={risk.label} tone={risk.tone} /> : null}
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      <ProovraAsyncView
        loading={loading}
        error={error ? { title: error.title, message: error.message } : null}
        onRetry={() => void load()}
        empty={null}
      >
        <>
          {/* ------------------------------------------------ Change password */}
          <ProovraPageSection
            title="Change password"
            description="You will stay signed in on this device."
          >
            <ProovraCard>
              <ProovraFormField label="Current password">
                <ProovraInput
                  value={current}
                  onChangeText={setCurrent}
                  secureTextEntry
                  autoCapitalize="none"
                  testID="current-password"
                />
              </ProovraFormField>
              <ProovraFormField label="New password">
                <ProovraInput
                  value={next}
                  onChangeText={setNext}
                  secureTextEntry
                  autoCapitalize="none"
                  testID="new-password"
                />
              </ProovraFormField>
              {/* The requirements are shown as they are typed rather than as a
                  refusal after submitting. */}
              <View style={styles.checks}>
                {passwordChecks(next).map((c) => (
                  <ProovraText
                    key={c.id}
                    variant="label"
                    color={c.met ? theme.color.status.verified.fg : theme.color.ink.muted}
                  >
                    {c.met ? "✓" : "•"} {c.label}
                  </ProovraText>
                ))}
              </View>
              <ProovraFormField
                label="Confirm new password"
                error={confirm.length > 0 && confirm !== next ? "The two new passwords do not match." : null}
              >
                <ProovraInput
                  value={confirm}
                  onChangeText={setConfirm}
                  secureTextEntry
                  autoCapitalize="none"
                  testID="confirm-password"
                />
              </ProovraFormField>
              {blocker && (current || next || confirm) ? (
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {blocker}
                </ProovraText>
              ) : null}
              <ProovraButton
                label="Change password"
                loading={savingPassword}
                disabled={blocker !== null}
                onPress={() => void changePassword()}
              />
            </ProovraCard>
          </ProovraPageSection>

          {/* ------------------------------------------------ Sign-in methods */}
          <ProovraPageSection
            title="Sign-in methods"
            description="Every way this account can be reached."
          >
            {methods && methods.methods.length > 0 ? (
              <ProovraCard>
                <ProovraDetailRows
                  rows={methods.methods.map((m) => ({
                    label: m.label,
                    value: m.linkedAtIso ? `Linked ${formatUserDateTime(m.linkedAtIso)}` : "Configured",
                  }))}
                />
                {methods.usableMethods <= 1 ? (
                  <ProovraText variant="label" color={theme.color.status.risk.fg}>
                    This is the only way into your account. Adding a second method means losing one
                    does not lock you out.
                  </ProovraText>
                ) : null}
              </ProovraCard>
            ) : (
              <ProovraEmpty
                presence="inline"
                title="Sign-in methods unavailable"
                purpose="This section could not be loaded. The rest of the page is unaffected."
              />
            )}
          </ProovraPageSection>

          {/* --------------------------------------------------- Two-factor */}
          <ProovraPageSection
            title="Two-factor authentication"
            description="A second factor for sign-in and for high-risk actions."
          >
            {mfa ? (
              <ProovraCard>
                {mfa.factors.length === 0 ? (
                  <ProovraEmpty
                    presence="inline"
                    framed={false}
                    title="No second factor"
                    purpose="Your password alone can sign in to this account."
                  />
                ) : (
                  mfa.factors.map((f) => (
                    <View key={f.id} style={styles.factorRow}>
                      <View style={styles.flex1}>
                        <ProovraText variant="bodySm" weight="semibold">
                          {f.label}
                        </ProovraText>
                        {f.lastUsedAtIso ? (
                          <ProovraText variant="label" color={theme.color.ink.muted}>
                            Last used {formatUserDateTime(f.lastUsedAtIso)}
                          </ProovraText>
                        ) : null}
                      </View>
                      <ProovraBadge label={f.status} tone={mfaFactorTone(f.status)} />
                      <ProovraButton
                        label="Remove"
                        variant="ghost"
                        fullWidth={false}
                        onPress={() => setPending({ kind: "remove-factor", id: f.id, label: f.label })}
                      />
                    </View>
                  ))
                )}
                {mfa.hasMfa ? (
                  <View style={styles.recoveryRow}>
                    <ProovraText
                      variant="label"
                      color={mfa.recoveryCodesLow ? theme.color.status.risk.fg : theme.color.ink.secondary}
                    >
                      {mfa.recoveryCodesRemaining} recovery code
                      {mfa.recoveryCodesRemaining === 1 ? "" : "s"} left
                      {mfa.recoveryCodesLow ? " — regenerate before you run out" : ""}
                    </ProovraText>
                    <ProovraButton
                      label="Regenerate"
                      variant="secondary"
                      fullWidth={false}
                      onPress={() => void regenerateRecoveryCodes()}
                    />
                  </View>
                ) : null}
              </ProovraCard>
            ) : (
              <ProovraEmpty
                presence="inline"
                title="Two-factor status unavailable"
                purpose="This section could not be loaded."
              />
            )}

            {/*
              Adding a factor, not only removing one. Until this existed the
              app could weaken the account and not strengthen it: removal and
              status were here, enrolment was not.
            */}
            <TotpEnrolment onEnrolled={() => void load()} />
          </ProovraPageSection>

          {/* ----------------------------------------------------- Sessions */}
          <ProovraPageSection
            title="Where you are signed in"
            actions={
              sessions && sessions.otherCount > 0 ? (
                <ProovraButton
                  label="Sign out others"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => setPending({ kind: "revoke-others", count: sessions.otherCount })}
                />
              ) : null
            }
          >
            {sessions && sessions.sessions.length > 0 ? (
              <ProovraCard>
                {sessions.sessions.map((s) => (
                  <View key={s.id} style={styles.factorRow}>
                    <View style={styles.flex1}>
                      <ProovraText variant="bodySm" weight="semibold">
                        {s.deviceLabel}
                      </ProovraText>
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {s.lastSeenAtIso ? `Last active ${formatUserDateTime(s.lastSeenAtIso)}` : "Active"}
                        {s.viaSso ? " · via SSO" : ""}
                      </ProovraText>
                    </View>
                    {s.isCurrent ? (
                      <ProovraBadge label="This device" tone="verified" />
                    ) : s.quarantined ? (
                      <ProovraBadge label="Quarantined" tone="risk" />
                    ) : null}
                    {s.isCurrent ? null : (
                      <ProovraButton
                        label="Sign out"
                        variant="ghost"
                        fullWidth={false}
                        onPress={() =>
                          setPending({ kind: "revoke-session", id: s.id, label: s.deviceLabel })
                        }
                      />
                    )}
                  </View>
                ))}
              </ProovraCard>
            ) : (
              <ProovraEmpty
                presence="inline"
                title="Session inventory unavailable"
                purpose="This section could not be loaded."
              />
            )}
          </ProovraPageSection>

          {/* --------------------------------------------- Security activity */}
          <ProovraPageSection title="Account & security activity">
            {events.length > 0 ? (
              <ProovraCard>
                {events.slice(0, 20).map((e) => (
                  <View key={e.id} style={styles.eventRow}>
                    <View style={styles.flex1}>
                      <ProovraText variant="bodySm">{e.label}</ProovraText>
                      {e.detail ? (
                        <ProovraText variant="label" color={theme.color.ink.muted}>
                          {e.detail}
                        </ProovraText>
                      ) : null}
                    </View>
                    <ProovraText variant="label" color={theme.color.ink.muted}>
                      {e.atIso ? formatUserDateTime(e.atIso) : ""}
                    </ProovraText>
                  </View>
                ))}
              </ProovraCard>
            ) : (
              <ProovraEmpty
                presence="inline"
                title="No security events in the recent window"
                purpose="Password changes, sign-ins and session activity appear here."
              />
            )}
          </ProovraPageSection>
        </>
      </ProovraAsyncView>

      <ProovraConfirmSheet
        visible={pending !== null}
        busy={acting}
        tone="danger"
        title={
          pending?.kind === "revoke-others"
            ? `Sign out ${pending.count} other session${pending.count === 1 ? "" : "s"}?`
            : pending?.kind === "revoke-session"
              ? "Sign out this session?"
              : "Remove this two-factor method?"
        }
        consequence={
          pending?.kind === "remove-factor"
            ? "Your password alone will be enough to sign in to this account."
            : "Anyone using that session will have to sign in again. This device stays signed in."
        }
        /*
         * The confirm button RESTATES the specific action rather than saying
         * "Sign out", which is also the label on every session row behind the
         * sheet. Two controls a gesture apart with the same name is ambiguous
         * to anyone navigating by label, and it is the kind of ambiguity that
         * matters most on a destructive security action.
         */
        confirmLabel={
          pending?.kind === "remove-factor"
            ? "Remove two-factor method"
            : pending?.kind === "revoke-others"
              ? "Sign out other sessions"
              : "Sign out this session"
        }
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />
      <StepUpSheet
        challenge={stepUp.challenge}
        title="Confirm it is you"
        busy={acting || savingPassword}
        onSubmit={(proof) =>
          void stepUp.retry(proof, (err) => addToast(toSafeUserError(err).message, "error"))
        }
        onCancel={stepUp.dismiss}
      />

    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  checks: { gap: 2, marginBottom: theme.space.s2 },
  factorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s2,
    paddingVertical: theme.space.s2,
  },
  recoveryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s3,
    paddingTop: theme.space.s2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border.subtle,
  },
  eventRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s3,
    paddingVertical: theme.space.s2,
  },
});
