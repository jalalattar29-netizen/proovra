/**
 * INTAKE LINKS (Native Convergence §9, Workstream F). View and revoke the
 * workspace's secure intake links: GET /v1/workflow/intake-links?teamId. The
 * intake URL is a server-side secret (delivered via /send), so it is never shown
 * or copied here — this is a view + revoke surface; creation is web-managed.
 * A 403 / feature-off / unresolved workspace renders an honest state.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDateTime } from "../../src/lib/date";
import { usePlatformContext } from "../../src/product/platform-context";
import { parseIntakeLinks, intakeStatusDisplay, type IntakeLinkItem } from "../../src/product/intake-links";
import { theme } from "../../src/theme/theme";
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
} from "../../src/ui";

type Phase = "loading" | "ready" | "error" | "unavailable";

export default function IntakeLinksScreen() {
  const router = useRouter();
  const { loading: ctxLoading, context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;
  const [items, setItems] = useState<IntakeLinkItem[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (ctxLoading) return;
    if (!teamId) {
      setPhase("ready");
      setItems([]);
      return;
    }
    setPhase("loading");
    setError(null);
    try {
      const data = await apiFetch(`/v1/workflow/intake-links?teamId=${encodeURIComponent(teamId)}`);
      setItems(parseIntakeLinks(data));
      setPhase("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "forbidden") setPhase("unavailable");
      else {
        setError(safe);
        setPhase("error");
      }
    }
  }, [teamId, ctxLoading]);

  useEffect(() => { void load(); }, [load]);

  const revoke = useCallback(
    (item: IntakeLinkItem) => {
      Alert.alert("Revoke intake link", `Revoke the link for ${item.templateName}? People with the link can no longer submit.`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusyId(item.id);
              try {
                await apiFetch(`/v1/workflow/intake-links/${item.id}/revoke`, { method: "POST", body: JSON.stringify({}) });
                await load();
              } catch (err) {
                Alert.alert("Could not revoke", toSafeUserError(err).message);
              } finally {
                setBusyId(null);
              }
            })();
          },
        },
      ]);
    },
    [load],
  );

  return (
    <ProovraScreen>
      <ProovraSection
        title="Intake links"
        action={<ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />}
      >
        {ctxLoading || phase === "loading" ? (
          <ProovraLoadingState label="Loading intake links" />
        ) : phase === "unavailable" ? (
          <ProovraEmptyState title="Not available" message="Secure intake links aren’t available for this workspace." />
        ) : phase === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={load} />
        ) : items.length === 0 ? (
          <ProovraEmptyState title="No intake links" message="Secure intake links you create appear here. Create and send links in the PROOVRA web app." />
        ) : (
          <ProovraCard>
            {items.map((item) => {
              const status = intakeStatusDisplay(item.status);
              const revocable = !["REVOKED", "EXPIRED"].includes(item.status.toUpperCase());
              return (
                <ProovraListRow
                  key={item.id}
                  title={item.templateName}
                  subtitle={[
                    item.recipientLabel,
                    item.maxUses ? `${item.usedCount}/${item.maxUses} used` : `${item.usedCount} used`,
                    item.expiresAtUtc ? `Expires ${formatUserDateTime(item.expiresAtUtc)}` : null,
                  ].filter(Boolean).join(" · ") || undefined}
                  trailing={
                    revocable ? (
                      <ProovraButton label="Revoke" variant="ghost" fullWidth={false} loading={busyId === item.id} onPress={() => revoke(item)} />
                    ) : (
                      <ProovraBadge tone={status.tone} label={status.label} />
                    )
                  }
                />
              );
            })}
          </ProovraCard>
        )}
        <View style={styles.note}>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Intake links are delivered securely to recipients. Create and send new links in the PROOVRA web app.
          </ProovraText>
        </View>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  note: { marginTop: theme.space.s3 },
});
