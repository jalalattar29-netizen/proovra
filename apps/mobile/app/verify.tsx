import { useCallback, useEffect, useState } from "react";
import { Linking, View, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { apiFetch } from "../src/api";
import { toSafeUserError, type SafeError } from "../src/errors/safe-error";
import { formatUserDateTime } from "../src/lib/date";
import { extractVerificationId } from "../src/deep-link";
import {
  PROOVRA_ALLOWED_CLAIMS,
  PROOVRA_FORBIDDEN_CLAIMS,
} from "@proovra/shared-evidence-presentation";

import { theme } from "../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraFormField,
  ProovraListRow,
  ProovraErrorState,
  ProovraLoadingState,
} from "../src/ui";
import { AuthBrandHeader } from "../src/ui/brand";

type CustodyEvent = { eventType: string; atUtc: string };
type VerifyData = {
  type?: string;
  createdAt?: string;
  fileSha256?: string;
  fingerprintHash?: string;
  publicUrl?: string;
  custodyEvents?: CustodyEvent[];
  verificationState?: string;
};

/**
 * Public verification (server-authoritative). Renders ONLY fields the server
 * returns for GET /public/verify/:id — no fabricated hashes, type, timestamp or
 * signature (the previous mock is gone). Honest loading/error/empty states.
 */
export default function VerifyScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const paramId = params.id ?? "";
  const [id, setId] = useState(paramId);
  const [manual, setManual] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error" | "empty">(paramId ? "loading" : "empty");
  const [error, setError] = useState<SafeError | null>(null);
  const [data, setData] = useState<VerifyData | null>(null);

  const verify = useCallback(async (verificationId: string) => {
    setState("loading");
    setError(null);
    try {
      const res = (await apiFetch(`/public/verify/${encodeURIComponent(verificationId)}`)) as VerifyData;
      setData(res);
      setState("ready");
    } catch (err) {
      setError(toSafeUserError(err));
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (paramId) void verify(paramId);
  }, [paramId, verify]);

  const submitManual = useCallback(() => {
    const extracted = extractVerificationId(manual);
    if (!extracted) {
      setError({ kind: "input", title: "Check the details", message: "Paste a PROOVRA verification link or id." });
      return;
    }
    setId(extracted);
    void verify(extracted);
  }, [manual, verify]);

  if (state === "loading") return <ProovraScreen scroll={false}><ProovraLoadingState label="Verifying" /></ProovraScreen>;
  // No id yet: let the user paste a public verification link/id (server-authoritative).
  if (state === "empty" || (state === "error" && !id)) {
    return (
      <ProovraScreen width="form">
        <AuthBrandHeader tagline="Verify the authenticity of a PROOVRA record." />
        <ProovraCard>
          <ProovraFormField label="Verification link or id" error={error ? error.message : null}>
            <ProovraInput value={manual} onChangeText={setManual} placeholder="https://proovra.com/verify/…" onSubmitEditing={submitManual} />
          </ProovraFormField>
          <ProovraButton label="Verify" onPress={submitManual} />
        </ProovraCard>
      </ProovraScreen>
    );
  }
  if (state === "error" && error) return <ProovraScreen scroll={false}><ProovraErrorState message={error.message} onRetry={() => void verify(id)} /></ProovraScreen>;

  const d = data ?? {};
  const events = Array.isArray(d.custodyEvents) ? d.custodyEvents : [];

  return (
    <ProovraScreen>
      <ProovraSection title="Verification">
        <ProovraCard style={styles.card}>
          <ProovraBadge tone="verified" label={d.verificationState ?? "Verified record"} />
          {d.type ? <ProovraText variant="h2" weight="bold" style={styles.gap}>{d.type}</ProovraText> : null}
          {d.createdAt ? <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{formatUserDateTime(d.createdAt)}</ProovraText> : null}
        </ProovraCard>

        {(d.fileSha256 || d.fingerprintHash) ? (
          <ProovraCard style={styles.card}>
            {d.fileSha256 ? (
              <View style={styles.hashRow}>
                <ProovraText variant="label" color={theme.color.ink.muted}>SHA-256</ProovraText>
                <ProovraText variant="bodySm" mono numberOfLines={2}>{d.fileSha256}</ProovraText>
              </View>
            ) : null}
            {d.fingerprintHash ? (
              <View style={styles.hashRow}>
                <ProovraText variant="label" color={theme.color.ink.muted}>Ed25519</ProovraText>
                <ProovraText variant="bodySm" mono numberOfLines={2}>{d.fingerprintHash}</ProovraText>
              </View>
            ) : null}
          </ProovraCard>
        ) : null}

        {events.length > 0 ? (
          <ProovraCard style={styles.card}>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>Chain of custody</ProovraText>
            {events.map((ev, i) => (
              <ProovraListRow key={`${ev.eventType}-${i}`} title={ev.eventType} subtitle={formatUserDateTime(ev.atUtc)} />
            ))}
          </ProovraCard>
        ) : null}

        {/*
          WHAT A VERIFICATION DOES AND DOES NOT ESTABLISH.

          The web's verify landing carries this as VerifyBoundariesSection, and
          the native screen had hashes, a custody list and a green badge with
          nothing to bound them. A verification surface that shows a tick and
          says nothing about its limits is making precisely the overclaim the
          safe-language contract forbids — the reader supplies the missing
          sentence themselves, and they supply the wrong one.

          The claims come from @proovra/shared-evidence-presentation's
          claims-matrix, which is the canonical list the contract tests grep
          against. Nothing is written here.
        */}
        <ProovraCard style={styles.card}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
            What this establishes
          </ProovraText>
          {PROOVRA_ALLOWED_CLAIMS.map((claim, i) => (
            <ProovraText key={`a${i}`} variant="label" color={theme.color.ink.secondary}>
              {`• ${claim}`}
            </ProovraText>
          ))}
        </ProovraCard>

        <ProovraCard style={styles.card}>
          <ProovraBadge tone="governance" label="Boundaries" />
          {/*
            The heading carries the negation ONCE and the claims are quoted
            verbatim. Rewriting each line into a denial would mean editing
            canonical text with string surgery on a legal-boundary surface —
            the one place where a clever transformation that mostly works is
            not good enough.
          */}
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
            PROOVRA does not claim any of the following:
          </ProovraText>
          {PROOVRA_FORBIDDEN_CLAIMS.map((claim, i) => (
            <ProovraText key={`f${i}`} variant="label" color={theme.color.ink.muted}>
              {`• ${claim}`}
            </ProovraText>
          ))}
        </ProovraCard>

        {d.publicUrl ? (
          <ProovraButton label="Open verification report" onPress={() => void Linking.openURL(d.publicUrl as string)} />
        ) : null}
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: theme.space.s4, gap: theme.space.s2 },
  gap: { marginTop: theme.space.s2 },
  hashRow: { paddingVertical: theme.space.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle, gap: 2 },
});
