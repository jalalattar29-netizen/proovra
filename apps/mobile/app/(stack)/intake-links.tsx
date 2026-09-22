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
import {
  parseIntakeLinks,
  intakeStatusDisplay,
  buildIntakeArchivePath,
  buildIntakeRevealPath,
  buildIntakeSubmissionsPath,
  parseIntakeSubmissions,
  parseRevealedContact,
  INTAKE_REVEAL_CONSEQUENCE,
  type IntakeLinkItem,
  type IntakeSubmission,
  type RevealedContact,
} from "../../src/product/intake-links";
import { theme } from "../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraSheet,
  ProovraInput,
  ProovraFormField,
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<IntakeSubmission[] | null>(null);
  const [revealing, setRevealing] = useState<IntakeLinkItem | null>(null);
  const [revealReason, setRevealReason] = useState("");
  const [revealed, setRevealed] = useState<RevealedContact | null>(null);

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


  /** Submissions for one link, loaded when it is opened. */
  const openSubmissions = useCallback(async (item: IntakeLinkItem) => {
    const next = openId === item.id ? null : item.id;
    setOpenId(next);
    setSubmissions(null);
    if (!next) return;
    try {
      setSubmissions(parseIntakeSubmissions(await apiFetch(buildIntakeSubmissionsPath(item.id))));
    } catch {
      setSubmissions([]);
    }
  }, [openId]);

  const toggleArchive = useCallback(
    async (item: IntakeLinkItem, archived: boolean) => {
      setBusyId(item.id);
      try {
        await apiFetch(buildIntakeArchivePath(item.id, archived), {
          method: "POST",
          body: JSON.stringify({}),
        });
        await load();
      } catch (err) {
        Alert.alert("Could not update", toSafeUserError(err).message);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /**
   * The ONE audited disclosure. Every projection ships the masked address for
   * everybody; this asks for the raw one, needs a capability, and is recorded
   * at WARNING severity with the reason. The user is told that before they
   * tap, not after it appears in an audit log.
   */
  const reveal = useCallback(async () => {
    const item = revealing;
    if (!item) return;
    setBusyId(item.id);
    try {
      const res = await apiFetch(buildIntakeRevealPath(item.id), {
        method: "POST",
        body: JSON.stringify({ reason: revealReason.trim() }),
      });
      setRevealed(parseRevealedContact(res));
    } catch (err) {
      Alert.alert("Could not reveal", toSafeUserError(err).message);
    } finally {
      setBusyId(null);
      setRevealing(null);
      setRevealReason("");
    }
  }, [revealing, revealReason]);

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
          <ProovraEmptyState title="No intake links" message="Secure intake links you create appear here." />
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
                  onPress={() => void openSubmissions(item)}
                />
              );
            })}
          </ProovraCard>
        )}

        {/* The opened link's submissions, archive control, and the reveal. */}
        {openId ? (
          <ProovraCard>
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
              Submissions
            </ProovraText>
            {submissions === null ? (
              <ProovraLoadingState label="Loading submissions" />
            ) : submissions.length === 0 ? (
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Nobody has used this link yet.
              </ProovraText>
            ) : (
              submissions.map((sub) => (
                <View key={sub.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
                  <ProovraText variant="bodySm">
                    {sub.submitterName ?? sub.pseudonym ?? "Anonymous contributor"}
                  </ProovraText>
                  {/*
                    Masked by the server, for everybody. Nothing here un-masks
                    them; the raw address has exactly one route out of the API
                    and it is the audited reveal below.
                  */}
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {[
                      sub.status,
                      sub.submitterEmailPreview,
                      sub.submitterPhonePreview,
                      sub.submittedAtIso ? formatUserDateTime(sub.submittedAtIso) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </ProovraText>
                </View>
              ))
            )}

            {(() => {
              const item = items.find((i) => i.id === openId);
              if (!item) return null;
              const archived = item.status.toUpperCase() === "ARCHIVED";
              return (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                  <ProovraButton
                    label={archived ? "Unarchive" : "Archive"}
                    variant="secondary"
                    fullWidth={false}
                    loading={busyId === item.id}
                    onPress={() => void toggleArchive(item, archived)}
                  />
                  <ProovraButton
                    label="Reveal recipient contact"
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => setRevealing(item)}
                  />
                </View>
              );
            })()}

            {revealed ? (
              <ProovraCard>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  Revealed, and recorded
                </ProovraText>
                <ProovraText variant="bodySm" mono>
                  {[revealed.email, revealed.phone].filter(Boolean).join("  ") || "No contact on file"}
                </ProovraText>
              </ProovraCard>
            ) : null}
          </ProovraCard>
        ) : null}

        <ProovraSheet
          visible={revealing !== null}
          title="Reveal recipient contact?"
          onClose={() => { setRevealing(null); setRevealReason(""); }}
        >
          {/*
            Said BEFORE the tap, not discovered in an audit log afterwards.
          */}
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {INTAKE_REVEAL_CONSEQUENCE}
          </ProovraText>
          <ProovraFormField label="Why do you need it?">
            <ProovraInput
              value={revealReason}
              onChangeText={setRevealReason}
              placeholder="Recorded with the disclosure"
              autoCapitalize="sentences"
              accessibilityLabel="Reason for revealing the contact"
            />
          </ProovraFormField>
          <ProovraButton
            label="Reveal and record"
            variant="danger"
            disabled={revealReason.trim().length < 3}
            onPress={() => void reveal()}
          />
        </ProovraSheet>

        <View style={styles.note}>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Intake links are delivered securely to recipients. Creating a new link, and resending one, stay in the PROOVRA web app: a resend needs the link's raw token, which the API never persists, so it can only be sent from the session that created it.
          </ProovraText>
        </View>
      </ProovraSection>
    </ProovraScreen>
  );
}

const styles = StyleSheet.create({
  note: { marginTop: theme.space.s3 },
});
