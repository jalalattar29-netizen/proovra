import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { getLegalStatus, recordLegalAcceptance } from "../../src/auth/auth-api";
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
export default function LegalAcceptanceScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ next?: string }>();
  const next = typeof params.next === "string" && params.next.startsWith("/") ? params.next : "/(tabs)";
  const [state, setState] = useState<"loading" | "ready" | "error" | "saving">("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [missing, setMissing] = useState<Array<{ policyKey: string; version: string }>>([]);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const status = await getLegalStatus();
      if (status.ok) {
        router.replace(next as never);
        return;
      }
      setMissing(status.missingPolicies.map((p) => ({ policyKey: p, version: status.requiredVersions[p] ?? "" })));
      setState("ready");
    } catch (err) {
      setError(toSafeUserError(err));
      setState("error");
    }
  }, [router, next]);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = useCallback(async () => {
    setState("saving");
    setError(null);
    try {
      await recordLegalAcceptance(missing);
      router.replace(next as never);
    } catch (err) {
      setError(toSafeUserError(err));
      setState("ready");
    }
  }, [missing, router, next]);

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
              {missing.map((m) => (
                <ProovraListRow key={m.policyKey} title={POLICY_LABELS[m.policyKey] ?? m.policyKey} subtitle={`Version ${m.version}`} />
              ))}
              <View style={styles.actions}>
                <ProovraButton label="Accept and continue" loading={state === "saving"} onPress={() => void accept()} />
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
