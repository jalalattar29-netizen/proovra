import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { getLegalStatus, recordLegalAcceptance, type LegalStatus } from "../../src/auth/auth-api";
import { LEGAL_GATE_RESUME_RECORD_LINK, safeLegalGateNext } from "../../src/auth/legal-gate";
import { takePendingRecordLink } from "../../src/deep-link/pending-intent";
import { replayRecordLinkAfterSignIn } from "../../src/deep-link/open-record-link";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraSection,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraListRow,
} from "../../src/ui";

const POLICY_LABELS: Record<string, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Policy",
  cookies: "Cookie Policy",
};

/**
 * Legal acceptance gate (Phase 4, audit §Z13). Server-authoritative: fetches
 * the required versions and records acceptance. Reached at bootstrap when
 * acceptance is missing, or from the runtime 428 interceptor. `next` carries an
 * optional destination to resume after acceptance.
 */
/** NAT-LEGAL-01 — the POST names this when a policy was re-issued after the list was read. */
const VERSION_NOT_CURRENT = "LEGAL_POLICY_VERSION_NOT_CURRENT";
const VERSION_CHANGED_COPY =
  "The terms changed while this screen was open. The list now shows the current versions — review them and accept again.";

function toMissing(status: LegalStatus): Array<{ policyKey: string; version: string }> {
  return status.missingPolicies.map((p) => ({ policyKey: p, version: status.requiredVersions[p] ?? "" }));
}

export default function LegalAcceptanceScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ next?: string; resume?: string }>();
  const next = safeLegalGateNext(params.next);
  const resumeRecordLink = params.resume === LEGAL_GATE_RESUME_RECORD_LINK;
  const [state, setState] = useState<"loading" | "ready" | "error" | "saving">("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [missing, setMissing] = useState<Array<{ policyKey: string; version: string }>>([]);

  /**
   * NAT-LEGAL-02 — leaving the gate. The sign-in bootstrap names where to go
   * (`next`, and nothing is beneath it). The runtime 428 interceptor and
   * Settings open the gate OVER the current screen with no `next`: going back
   * resumes that screen with everything on it, as the web step closes and keeps
   * the page (B1-F-010) — the refused write was never persisted and the person
   * retries it. Replacing with Home threw the interrupted screen away.
   */
  const leave = useCallback(() => {
    if (next) {
      router.replace(next as never);
      // PRO-NA-04 — the record link opened before sign-in resumes through the
      // same resolve + workspace switch as a signed-in tap, not as a raw route.
      if (resumeRecordLink) {
        const url = takePendingRecordLink();
        if (url) void replayRecordLinkAfterSignIn(url, (route) => router.push(route as never));
      }
    } else if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, [router, next, resumeRecordLink]);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const status = await getLegalStatus();
      if (status.ok) {
        leave();
        return;
      }
      setMissing(toMissing(status));
      setState("ready");
    } catch (err) {
      setError(toSafeUserError(err));
      setState("error");
    }
  }, [leave]);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = useCallback(async () => {
    setState("saving");
    setError(null);
    try {
      await recordLegalAcceptance(missing);
      leave();
    } catch (err) {
      // NAT-LEGAL-01 — a policy re-issued after the list was read is refused
      // with the versions now required. Re-posting the stale list could never
      // succeed, so the list is re-read and the person accepts what is current.
      if ((err as { code?: unknown } | null)?.code === VERSION_NOT_CURRENT) {
        try {
          const status = await getLegalStatus();
          if (status.ok) {
            leave();
            return;
          }
          setMissing(toMissing(status));
          setError({ ...toSafeUserError(err), message: VERSION_CHANGED_COPY });
        } catch (reloadErr) {
          setError(toSafeUserError(reloadErr));
        }
        setState("ready");
        return;
      }
      setError(toSafeUserError(err));
      setState("ready");
    }
  }, [missing, leave]);

  return (
    <ProovraScreen scroll={false} width="form">
      <ProovraSection title="Review the updated terms">
        <ProovraCard>
          {state === "loading" ? (
            <ProovraLoadingState label="Loading the latest terms" />
          ) : state === "error" ? (
            <ProovraErrorState message={error?.message ?? "Could not load the terms."} onRetry={load} />
          ) : (
            <>
              <ProovraText variant="body" color={theme.color.ink.secondary} style={styles.intro}>
                To continue, please accept the following:
              </ProovraText>
              {/*
                R1-F-04 — an informed acceptance: each listed document opens in the
                in-app legal reader (/legal/<policyKey>, the route the sign-in
                screen uses), as the web gate links /legal/terms, /legal/privacy
                and /legal/cookies. The reader returns here with Back.
              */}
              <ProovraText variant="label" color={theme.color.ink.muted} style={styles.intro}>
                Tap a document to read it first.
              </ProovraText>
              {missing.map((m) => (
                <ProovraListRow
                  key={m.policyKey}
                  title={POLICY_LABELS[m.policyKey] ?? m.policyKey}
                  subtitle={`Version ${m.version} · Read the document`}
                  accessibilityHint="Opens the document"
                  testID={`legal-gate-open-${m.policyKey}`}
                  onPress={() => router.push(`/legal/${encodeURIComponent(m.policyKey)}` as never)}
                />
              ))}
              <View style={styles.actions}>
                <ProovraButton label="Accept and continue" loading={state === "saving"} onPress={() => void accept()} />
                {/*
                  NAT-LEGAL-03 — the gate must not trap the person (A1-06; the web
                  step's "Not now", LegalAcceptanceStep.tsx:55-60). Reads stay open
                  and the server keeps refusing every non-exempt write with 428,
                  which brings this screen back; signing out, exporting, closing
                  the account and revoking stay reachable without agreeing.
                */}
                <ProovraButton
                  label="Not now"
                  variant="ghost"
                  disabled={state === "saving"}
                  onPress={leave}
                />
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Until you accept, PROOVRA cannot save changes. You can still read your records, export your data, sign out or close your account.
                </ProovraText>
                {error ? (
                  <ProovraText variant="label" color={theme.color.status.risk.fg}>
                    {error.message}
                  </ProovraText>
                ) : null}
              </View>
            </>
          )}
        </ProovraCard>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({ intro: { marginBottom: theme.space.s3 }, actions: { marginTop: theme.space.s4, gap: theme.space.s2 } });
