/**
 * SETTINGS › SECURITY — the native port of the canonical personal security
 * surface (`apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`,
 * rendered by `/settings#security`).
 *
 * The sections are the web's, in the web's order:
 *   summary strip → sign-in methods → change password → two-factor →
 *   contact factor → your active sessions → account & security activity.
 *
 * Composition comes from `src/ui/patterns`; the projections (device naming,
 * sign-in rows, session paging) are in `src/product/account-security.ts` so the
 * logic is testable without a device.
 */
import { presentOutcome, presentSecurityEvent } from "@proovra/shared";
import { useCallback, useEffect, useState } from "react";
import { Switch, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { StepUpSheet, useStepUp } from "../../../src/ui/step-up-sheet";
import { TotpEnrolment } from "../../../src/ui/totp-enrolment";
import { RecoveryCodesSheet } from "../../../src/ui/recovery-codes-sheet";
import { withStepUp } from "../../../src/product/step-up";
import { useOAuth } from "../../../src/auth/use-oauth";
import { ContactFactorSection } from "../../../src/ui/contact-factor-section";
import { usePlatformContext } from "../../../src/product/platform-context";
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
  ProovraConfirmSheet,
  ProovraAsyncView,
} from "../../../src/ui";
import {
  parseSignInMethods,
  passwordMeetsPolicy,
  ADD_PASSWORD_PATH,
  ADD_PASSWORD_COPY,
  buildIdentityLinkPath,
  buildIdentityUnlinkPath,
  identityLinkRefusal,
  IDENTITY_LINK_COPY,
  parseMfaStatus,
  parseRecoveryCodes,
  parseSessions,
  parseSecurityEvents,
  passwordChecks,
  passwordFormBlocker,
  passwordChangedMessage,
  PASSWORD_CHANGE_ERRORS,
  presentSignInRows,
  summarizeSignInMethods,
  signInRisk,
  visibleSessions,
  EVENTS_FIRST,
  EVENTS_PAGE,
  SECURITY_EVENTS_PATH,
  type SignInMethods,
  type MfaStatus,
  type SessionInventory,
  type SecurityEvent,
  type AccountSession,
} from "../../../src/product/account-security";

type Pending =
  | { kind: "revoke-session"; id: string; label: string }
  | { kind: "revoke-others"; count: number }
  | { kind: "remove-factor"; id: string; label: string }
  | { kind: "unlink"; id: string; label: string }
  | { kind: "regenerate" }
  | null;

export default function SecuritySettingsScreen() {
  const router = useRouter();
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SafeError | null>(null);
  const [linksRaw, setLinksRaw] = useState<unknown>(null);
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [sessions, setSessions] = useState<SessionInventory | null>(null);
  // null = the read FAILED; [] = it succeeded and there is nothing (PersonalSecuritySections).
  const [events, setEvents] = useState<SecurityEvent[] | null>([]);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [eventsVisible, setEventsVisible] = useState(EVENTS_FIRST);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revokeOthersOnChange, setRevokeOthersOnChange] = useState(true);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [pending, setPending] = useState<Pending>(null);
  const [acting, setActing] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const stepUp = useStepUp();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      /*
       * Four independent reads, settled together. `allSettled` rather than
       * `all` because one unavailable section must not blank the others — a
       * user who cannot load their security ACTIVITY can still need to revoke
       * a session right now.
       */
      const [linksRes, mfaRes, sessionsRes, eventsRes] = await Promise.allSettled([
        apiFetch("/v1/identity/links"),
        apiFetch("/v1/identity/mfa/factors"),
        apiFetch("/v1/identity-security/my-sessions"),
        // The web reads the bounded window of fifty and pages through it locally.
        apiFetch(SECURITY_EVENTS_PATH),
      ]);

      if (linksRes.status === "rejected" && sessionsRes.status === "rejected") {
        throw linksRes.reason;
      }
      setLinksRaw(linksRes.status === "fulfilled" ? linksRes.value : null);
      setMethods(linksRes.status === "fulfilled" ? parseSignInMethods(linksRes.value) : null);
      setMfa(mfaRes.status === "fulfilled" ? parseMfaStatus(mfaRes.value) : null);
      setSessions(sessionsRes.status === "fulfilled" ? parseSessions(sessionsRes.value) : null);
      // A failed read used to become [] and render "No security events" —
      // an outage reading as a quiet account.
      setEvents(
        eventsRes.status === "fulfilled"
          ? parseSecurityEvents(eventsRes.value, { title: presentSecurityEvent, outcome: presentOutcome })
          : null,
      );
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
    setPasswordNotice(null);
    // A step-up challenge is answered and the SAME request is retried, rather
    // than being reported as a failure the user cannot act on.
    await stepUp.start(
      async (proof) => {
        const res = await apiFetch("/v1/identity-security/password", {
          method: "POST",
          body: JSON.stringify(
            withStepUp(
              { currentPassword: current, newPassword: next, revokeOtherSessions: revokeOthersOnChange },
              proof,
            ),
          ),
        });
        setCurrent("");
        setNext("");
        setConfirm("");
        setPasswordNotice({ tone: "ok", text: passwordChangedMessage(revokeOthersOnChange, res) });
        // The change is itself a security event, and it may end other sessions.
        void load();
      },
      (err) => {
        const code = (err as { code?: string } | null)?.code ?? "";
        setPasswordNotice({
          tone: "error",
          text:
            PASSWORD_CHANGE_ERRORS[code] ??
            toSafeUserError(err, { message: "We could not change your password. Please try again." }).message,
        });
      },
    );
    setSavingPassword(false);
  }, [blocker, current, next, revokeOthersOnChange, load, stepUp]);

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
          addToast("Session signed out.", "success");
        } else if (pending.kind === "revoke-others") {
          const res = (await apiFetch("/v1/identity-security/my-sessions/revoke-others", {
            method: "POST",
            body,
          })) as { revoked?: unknown } | null;
          const n = typeof res?.revoked === "number" ? res.revoked : pending.count;
          addToast(`${n} other session(s) signed out.`, "success");
        } else if (pending.kind === "unlink") {
          await apiFetch(buildIdentityUnlinkPath(pending.id), { method: "DELETE", body });
          addToast(IDENTITY_LINK_COPY.disconnected, "success");
        } else if (pending.kind === "remove-factor") {
          // The route reads `req.body.stepUp` on a DELETE, so this one
          // carries a body too — removing an ACTIVE factor is step-up guarded,
          // and a DELETE sent bodyless could never satisfy it.
          await apiFetch(`/v1/identity/mfa/factors/${pending.id}`, {
            method: "DELETE",
            body,
          });
          addToast("Two-factor authentication removed.", "success");
        } else if (pending.kind === "regenerate") {
          // The route returns the new codes ONCE (mfa.routes.ts:307). They are
          // shown and must be acknowledged — a toast here lost the only copy.
          const res = await apiFetch("/v1/identity/mfa/recovery-codes/regenerate", {
            method: "POST",
            body,
          });
          setNewCodes(parseRecoveryCodes(res));
        }
        setPending(null);
        await load();
      },
      (err) =>
        addToast(
          (pending.kind === "unlink" ? identityLinkRefusal(err, IDENTITY_LINK_COPY.unlinkFailed) : null) ??
            toSafeUserError(err).message,
          "error",
        ),
    );
    setActing(false);
  }, [pending, addToast, load, stepUp]);

  /**
   * T-15 — CONNECT Google / Apple to this account. The provider hands back an
   * ID token (link mode — never exchanged for a new session), which is posted
   * through the same re-auth step-up every other security change uses.
   */
  const linkIdentity = useCallback(
    async (mode: "google" | "apple", idToken: string) => {
      await stepUp.start(
        async (proof) => {
          await apiFetch(buildIdentityLinkPath(mode), {
            method: "POST",
            body: JSON.stringify(withStepUp({ idToken }, proof)),
          });
          addToast(IDENTITY_LINK_COPY.connected(mode), "success");
          await load();
        },
        (err) => addToast(identityLinkRefusal(err, IDENTITY_LINK_COPY.linkFailed) ?? toSafeUserError(err, { message: IDENTITY_LINK_COPY.linkFailed }).message, "error"),
      );
    },
    [addToast, load, stepUp],
  );
  const oauth = useOAuth({ onResult: () => undefined, onIdToken: linkIdentity });
  const securityTeamId = usePlatformContext().context?.activeTeamId ?? null;

  // T-15 — first password for an OAuth-only account (the web's "Add password" row action).
  const [addPasswordOpen, setAddPasswordOpen] = useState(false);
  const [firstPassword, setFirstPassword] = useState("");
  const [addingPassword, setAddingPassword] = useState(false);
  const addPassword = useCallback(async () => {
    if (!passwordMeetsPolicy(firstPassword)) return;
    setAddingPassword(true);
    await stepUp.start(
      async (proof) => {
        await apiFetch(ADD_PASSWORD_PATH, {
          method: "POST",
          body: JSON.stringify(withStepUp({ newPassword: firstPassword }, proof)),
        });
        setFirstPassword("");
        setAddPasswordOpen(false);
        addToast(ADD_PASSWORD_COPY.added, "success");
        await load();
      },
      (err) => addToast(toSafeUserError(err, { message: ADD_PASSWORD_COPY.failed }).message, "error"),
    );
    setAddingPassword(false);
  }, [firstPassword, stepUp, addToast, load]);

  const risk = methods && mfa ? signInRisk(methods, mfa) : null;
  const signInRows = linksRaw ? presentSignInRows(linksRaw) : null;
  const activeFactors = (mfa?.factors ?? []).filter((f) => f.status === "ACTIVE");

  const sessionRow = (s: AccountSession) => (
    <View
      key={s.id}
      style={[styles.sessionRow, s.isCurrent ? styles.sessionRowCurrent : null]}
      testID={`session-${s.id}`}
    >
      <View style={styles.rowHead}>
        <View style={[styles.flex1, styles.inline]}>
          <ProovraText variant="bodySm" weight="semibold">
            {s.deviceLabel}
          </ProovraText>
          {s.isCurrent ? <ProovraBadge label="Current session" tone="verified" /> : null}
          {s.quarantined ? <ProovraBadge label="Restricted" tone="pending" /> : null}
        </View>
        {/* The current session carries no individual revoke — signing out of
            THIS device is the product sign-out action, not a session mutation. */}
        {s.isCurrent ? null : (
          <ProovraButton
            label="Sign out"
            variant="secondary"
            fullWidth={false}
            accessibilityLabel={`Sign out ${s.deviceLabel}`}
            onPress={() => setPending({ kind: "revoke-session", id: s.id, label: s.deviceLabel })}
          />
        )}
      </View>
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {`${s.location ?? "Location unavailable"} · last active ${s.lastSeenAtIso ? formatUserDateTime(s.lastSeenAtIso) : "—"}`}
        {s.viaSso ? " · via SSO" : ""}
      </ProovraText>
      {s.issuedAtIso ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {`Signed in ${formatUserDateTime(s.issuedAtIso)}`}
        </ProovraText>
      ) : null}
      <ProovraText
        variant="label"
        color={theme.color.accent.a600}
        accessibilityRole="link"
        accessibilityLabel={`Technical details: ${s.deviceLabel}`}
        onPress={() => setOpenSession((cur) => (cur === s.id ? null : s.id))}
      >
        Technical details
      </ProovraText>
      {openSession === s.id ? (
        <View style={styles.technical}>
          {s.uaPreview ? <ProovraText variant="label" color={theme.color.ink.muted} selectable>{`User agent: ${s.uaPreview}`}</ProovraText> : null}
          {s.ipPreview ? <ProovraText variant="label" color={theme.color.ink.muted} selectable>{`IP (masked): ${s.ipPreview}`}</ProovraText> : null}
          <ProovraText variant="label" color={theme.color.ink.muted} selectable>{`Session reference: ${s.id}`}</ProovraText>
          {s.issuedAtIso && s.expiresAtIso ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`Issued ${formatUserDateTime(s.issuedAtIso)} · expires ${formatUserDateTime(s.expiresAtIso)}`}
            </ProovraText>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  const paged = sessions ? visibleSessions(sessions, sessionsExpanded) : null;

  return (
    <ProovraScreen shell testID="settings-security">
      <ProovraPageHeader
        title="Security"
        eyebrow="Settings"
        subtitle="Sign-in methods, two-factor authentication, active sessions and recent security activity."
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
          {/* ------------------------------------------------ Summary strip */}
          <ProovraCard testID="security-summary">
            <View style={styles.summary}>
              {[
                { label: "Login method", value: linksRaw ? summarizeSignInMethods(linksRaw) : "…" },
                { label: "Two-factor", value: mfa === null ? "…" : mfa.hasMfa ? "Enabled" : "Not configured" },
                { label: "Active sessions", value: sessions === null ? "…" : String(sessions.sessions.length) },
              ].map((it) => (
                <View key={it.label} style={styles.summaryItem}>
                  <ProovraText variant="label" color={theme.color.ink.muted}>{it.label}</ProovraText>
                  <ProovraText variant="bodySm" weight="semibold">{it.value}</ProovraText>
                </View>
              ))}
            </View>
          </ProovraCard>

          {/* ------------------------------------------------ Sign-in methods */}
          <ProovraPageSection
            title="Sign-in methods"
            description={
              "Choose which verified methods can sign in to this same PROOVRA account. Connecting Google or Apple does not create a second account. " +
              "Organization single sign-on is managed by your organization and never appears here."
            }
          >
            {signInRows ? (
              <ProovraCard>
              {methods && !methods.passwordConfigured ? (
  <ProovraText variant="h3" weight="semibold">
    Add a password
  </ProovraText>
) : null}
                {signInRows.map((row) => (
                  <View key={row.key} style={styles.methodRow} testID={`sign-in-${row.key}`}>
                    <View style={styles.flex1}>
                      <View style={styles.inline}>
                        <ProovraText variant="bodySm" weight="semibold">{row.label}</ProovraText>
                        <ProovraText
                          variant="label"
                          weight="semibold"
                          color={row.status === "not_connected" ? theme.color.ink.muted : theme.color.status.verified.fg}
                        >
                          {row.statusLabel}
                        </ProovraText>
                      </View>
                      {row.lastUsedAtIso ? (
                        <ProovraText variant="label" color={theme.color.ink.muted}>
                          {`last used ${formatUserDateTime(row.lastUsedAtIso)}`}
                        </ProovraText>
                      ) : null}
                      {row.disconnectBlocked && row.blockedReason ? (
                        <ProovraText variant="label" color={theme.color.ink.muted}>{row.blockedReason}</ProovraText>
                      ) : null}
                    </View>
                    {row.action === "add_password" ? (
                      <ProovraButton
                        label="Add password"
                        variant="secondary"
                        fullWidth={false}
                        onPress={() => setAddPasswordOpen((v) => !v)}
                      />
                    ) : row.action === "connect" ? (
                      row.key === "google" || oauth.appleAvailable ? (
                        <ProovraButton
                          label="Connect"
                          variant="secondary"
                          fullWidth={false}
                          accessibilityLabel={`Connect ${row.label}`}
                          loading={oauth.busy === row.key}
                          onPress={row.key === "google" ? oauth.promptGoogle : oauth.signInApple}
                        />
                      ) : null
                    ) : row.action === "disconnect" ? (
                      // Rendered DISABLED when blocked — the web's control, with
                      // the reason beside it (above) — never silently removed.
                      <ProovraButton
                        label="Disconnect"
                        variant="secondary"
                        fullWidth={false}
                        accessibilityLabel={`Disconnect ${row.label}`}
                        disabled={acting || row.disconnectBlocked}
                        onPress={() =>
                          row.linkId ? setPending({ kind: "unlink", id: row.linkId, label: row.label }) : undefined
                        }
                      />
                    ) : null}
                  </View>
                ))}

                {addPasswordOpen && methods && !methods.passwordConfigured ? (
                  <View style={styles.addPassword}>
                    <ProovraFormField label={ADD_PASSWORD_COPY.label}>
                      <ProovraInput value={firstPassword} onChangeText={setFirstPassword} secureTextEntry autoCapitalize="none" />
                    </ProovraFormField>
                    <View style={styles.checks}>
                      {passwordChecks(firstPassword).map((c) => (
                        <ProovraText key={c.id} variant="label" color={c.met ? theme.color.status.verified.fg : theme.color.ink.muted}>
                          {c.met ? "✓" : "•"} {c.label}
                        </ProovraText>
                      ))}
                    </View>
                    <ProovraButton
                      label={ADD_PASSWORD_COPY.action}
                      accessibilityLabel="Save the new password"
                      loading={addingPassword}
                      disabled={!passwordMeetsPolicy(firstPassword)}
                      onPress={() => void addPassword()}
                    />
                  </View>
                ) : null}

                {oauth.error ? (
                  <ProovraText variant="label" color={theme.color.status.risk.fg}>{oauth.error.message}</ProovraText>
                ) : null}
                {methods && methods.usableMethods <= 1 ? (
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

          {/* ------------------------------------------------ Change password
              Only for an account that HAS a password to change; one without
              adds it from the sign-in methods above (the web's rule). */}
          {methods?.passwordConfigured ? (
            <ProovraPageSection
              title="Change password"
              description="Use at least 12 characters with upper- and lower-case letters and a number. Your current password is required."
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
                <View style={styles.switchRow}>
                  <Switch
                    value={revokeOthersOnChange}
                    onValueChange={setRevokeOthersOnChange}
                    disabled={savingPassword}
                    accessibilityLabel="Sign out my other sessions after the change"
                  />
                  <ProovraText variant="bodySm" style={styles.flex1}>
                    Sign out my other sessions after the change
                  </ProovraText>
                </View>
                {blocker && (current || next || confirm) ? (
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {blocker}
                  </ProovraText>
                ) : null}
                {passwordNotice ? (
                  <ProovraText
                    variant="label"
                    color={passwordNotice.tone === "ok" ? theme.color.status.verified.fg : theme.color.status.risk.fg}
                    testID="password-notice"
                  >
                    {passwordNotice.text}
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
          ) : null}

          {/* --------------------------------------------------- Two-factor */}
          <ProovraPageSection title="Two-factor authentication">
            {mfa === null ? (
              <ProovraEmpty
                presence="inline"
                title="Two-factor status unavailable"
                purpose="This section could not be loaded."
              />
            ) : activeFactors.length === 0 ? (
              <>
                <ProovraEmpty
                  presence="inline"
                  framed={false}
                  title="No second factor"
                  purpose="Your password alone can sign in to this account."
                />
                {/* Adding a factor, not only removing one. */}
                <TotpEnrolment onEnrolled={() => void load()} />
              </>
            ) : (
              <ProovraCard>
                <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                  {`Two-factor authentication is enabled. Recovery codes remaining: ${mfa.recoveryCodesRemaining}.`}
                </ProovraText>
                {mfa.recoveryCodesLow ? (
                  <ProovraText variant="label" color={theme.color.status.risk.fg}>
                    Regenerate before you run out.
                  </ProovraText>
                ) : null}
                {activeFactors.map((f) => (
                  <View key={f.id} style={styles.factorRow}>
                    <View style={[styles.flex1, styles.inline]}>
                      <ProovraText variant="bodySm" weight="semibold">
                        {f.label || "Authenticator app"}
                      </ProovraText>
                      <ProovraBadge label="Active" tone="verified" />
                    </View>
                    <ProovraButton
                      label="Remove"
                      variant="secondary"
                      fullWidth={false}
                      disabled={acting}
                      onPress={() => setPending({ kind: "remove-factor", id: f.id, label: f.label })}
                    />
                  </View>
                ))}
                <ProovraButton
                  label="Regenerate recovery codes"
                  variant="secondary"
                  fullWidth={false}
                  disabled={acting}
                  onPress={() => setPending({ kind: "regenerate" })}
                />
              </ProovraCard>
            )}
          </ProovraPageSection>

          {/* T-15 — the device the step-up gate sends one-time codes to. The
              enrolment ATTEMPT is tenant-scoped, so like the web it only
              renders where a workspace exists. */}
          {securityTeamId ? <ContactFactorSection teamId={securityTeamId} /> : null}

          {/* ----------------------------------------------------- Sessions */}
          <ProovraPageSection
            title="Your active sessions"
            description="Sessions you are signed into right now. Your current session is listed first and is never revoked by “Sign out other sessions”."
            actions={
              sessions && sessions.otherCount > 0 ? (
                <ProovraButton
                  label="Sign out other sessions"
                  variant="secondary"
                  fullWidth={false}
                  onPress={() => setPending({ kind: "revoke-others", count: sessions.otherCount })}
                />
              ) : null
            }
          >
            {sessions === null ? (
              <ProovraEmpty presence="inline" title="Could not load sessions." />
            ) : sessions.sessions.length === 0 || !paged ? (
              <ProovraEmpty
                presence="inline"
                title="Session inventory unavailable"
                purpose="Your current sign-in is active, but no session records could be listed right now. Try again shortly."
              />
            ) : (
              <ProovraCard>
                {paged.current.map(sessionRow)}
                {sessions.otherCount > 0 ? (
                  paged.others.map(sessionRow)
                ) : (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    No other active sessions.
                  </ProovraText>
                )}
                {paged.hiddenCount > 0 ? (
                  <ProovraButton
                    label={
                      sessionsExpanded
                        ? "Show fewer sessions"
                        : `Show ${paged.hiddenCount} more ${paged.hiddenCount === 1 ? "session" : "sessions"}`
                    }
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => setSessionsExpanded((v) => !v)}
                  />
                ) : null}
              </ProovraCard>
            )}
          </ProovraPageSection>

          {/* --------------------------------------------- Security activity */}
          <ProovraPageSection
            title="Account & security activity"
            description="Bounded timeline of authentication, profile, preference, and membership events tied to your account. Older events live in the platform audit log."
          >
            {events === null ? (
              <ProovraEmpty presence="inline" title="Could not load security events." />
            ) : events.length > 0 ? (
              <ProovraCard>
                {events.slice(0, eventsVisible).map((e) => (
                  <View key={e.id} style={styles.eventRow}>
                    <View style={styles.flex1}>
                      <ProovraText variant="bodySm" weight="semibold">{e.label}</ProovraText>
                      {e.detail ? (
                        <ProovraText
                          variant="label"
                          color={e.tone === "risk" ? theme.color.status.risk.fg : theme.color.ink.muted}
                        >
                          {e.detail}
                        </ProovraText>
                      ) : null}
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {e.atIso ? formatUserDateTime(e.atIso) : ""}
                      </ProovraText>
                      {/* Forensic detail preserved behind a deliberate disclosure, as on the web. */}
                      {e.technical.length > 0 ? (
                        <ProovraText
                          variant="label"
                          color={theme.color.accent.a600}
                          accessibilityRole="link"
                          accessibilityLabel={`Technical details: ${e.label}`}
                          onPress={() => setOpenEvent((cur) => (cur === e.id ? null : e.id))}
                        >
                          Technical details
                        </ProovraText>
                      ) : null}
                      {openEvent === e.id
                        ? e.technical.map((line) => (
                            <ProovraText key={line} variant="label" color={theme.color.ink.muted} selectable>
                              {line}
                            </ProovraText>
                          ))
                        : null}
                    </View>
                  </View>
                ))}
                {events.length > eventsVisible ? (
                  <ProovraButton
                    label={`View more (${events.length - eventsVisible} older)`}
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => setEventsVisible((v) => v + EVENTS_PAGE)}
                  />
                ) : null}
              </ProovraCard>
            ) : (
              <ProovraEmpty
                presence="inline"
                title="No security events in the recent window"
                purpose="Identity and auth events tied to your account appear here as they occur."
              />
            )}
          </ProovraPageSection>
        </>
      </ProovraAsyncView>

      <ProovraConfirmSheet
        visible={pending !== null}
        busy={acting}
        tone={pending?.kind === "revoke-others" || pending?.kind === "regenerate" || pending?.kind === "revoke-session" ? "warning" : "danger"}
        title={
          pending?.kind === "unlink"
            ? `Disconnect ${pending.label}?`
            : pending?.kind === "revoke-others"
              ? "Sign out other sessions?"
              : pending?.kind === "revoke-session"
                ? `Sign out ${pending.label}?`
                : pending?.kind === "regenerate"
                  ? "Regenerate recovery codes?"
                  : "Remove two-factor authentication?"
        }
        consequence={
          pending?.kind === "unlink"
            ? IDENTITY_LINK_COPY.unlinkConsequence
            : pending?.kind === "remove-factor"
              ? "Your account will no longer require a second factor at sign-in. If your organization requires MFA, you will be asked to re-enroll on your next sign-in."
              : pending?.kind === "regenerate"
                ? "Your existing recovery codes stop working immediately. New codes are shown once — store them in a safe place."
                : pending?.kind === "revoke-others"
                  ? `Every active session except this one will be terminated (${pending.count} session(s)). You will not be signed out from this device.`
                  : "That session ends immediately. You stay signed in on this device."
        }
        /*
         * The confirm button RESTATES the specific action and never repeats
         * the label of the control that opened the sheet — the web's labels.
         */
        confirmLabel={
          pending?.kind === "unlink"
            ? "Disconnect"
            : pending?.kind === "remove-factor"
              ? "Remove factor"
              : pending?.kind === "regenerate"
                ? "Regenerate"
                : pending?.kind === "revoke-others"
                  ? "Sign out others"
                  : "Sign out session"
        }
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />
      <StepUpSheet
        challenge={stepUp.challenge}
        title="Verify it's you"
        busy={acting || savingPassword}
        onSubmit={(proof) =>
          void stepUp.retry(proof, (err) => addToast(toSafeUserError(err).message, "error"))
        }
        onCancel={stepUp.dismiss}
      />
      <RecoveryCodesSheet codes={newCodes} context="regenerate" onDone={() => setNewCodes(null)} />
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  inline: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 },
  summary: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s3 },
  summaryItem: { minWidth: 120, flexGrow: 1, gap: 2 },
  methodRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s2,
    paddingVertical: theme.space.s2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border.subtle,
  },
  addPassword: { gap: theme.space.s2, paddingTop: theme.space.s2 },
  checks: { gap: 2, marginBottom: theme.space.s2 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s3, marginVertical: theme.space.s2 },
  factorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s2,
    paddingVertical: theme.space.s2,
  },
  rowHead: { flexDirection: "row", alignItems: "center", gap: theme.space.s2 },
  sessionRow: {
    gap: 2,
    padding: theme.space.s3,
    marginBottom: theme.space.s2,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border.default,
  },
  sessionRowCurrent: {
    borderColor: theme.color.status.verified.fg,
    backgroundColor: theme.color.status.verified.bg,
  },
  technical: { gap: 2, marginTop: 2 },
  eventRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s3,
    paddingVertical: theme.space.s2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border.subtle,
  },
});
