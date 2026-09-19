import { useCallback, useEffect, useState } from "react";
import { Linking, View, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { apiFetch } from "../src/api";
import { toSafeUserError, type SafeError } from "../src/errors/safe-error";
import { formatUserDateTime } from "../src/lib/date";
import { theme } from "../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../src/ui";

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
  const id = params.id ?? "";
  const [state, setState] = useState<"loading" | "ready" | "error" | "empty">("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [data, setData] = useState<VerifyData | null>(null);

  const load = useCallback(async () => {
    if (!id) { setState("empty"); return; }
    setState("loading");
    setError(null);
    try {
      const res = (await apiFetch(`/public/verify/${id}`)) as VerifyData;
      setData(res);
      setState("ready");
    } catch (err) {
      setError(toSafeUserError(err));
      setState("error");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (state === "loading") return <ProovraScreen scroll={false}><ProovraLoadingState label="Verifying" /></ProovraScreen>;
  if (state === "empty") return <ProovraScreen scroll={false}><ProovraEmptyState title="No verification link" message="Open a PROOVRA verification link to view a record's authenticity." /></ProovraScreen>;
  if (state === "error" && error) return <ProovraScreen scroll={false}><ProovraErrorState message={error.message} onRetry={load} /></ProovraScreen>;

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
