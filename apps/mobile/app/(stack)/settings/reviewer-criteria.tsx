/**
 * REVIEWER CRITERIA — the native port of
 * `apps/web/app/(app)/settings/reviewer-criteria/page.tsx`.
 *
 * The human-authored, versioned criteria catalogue. Read, publish, duplicate
 * and retire. Authoring the criterion rows themselves stays on the web: it is
 * a multi-row editor, and a draft half-written on a phone is a draft nobody
 * can publish.
 *
 * A PUBLISHED set is immutable — the API answers 409 `published_immutable` —
 * so this screen offers no edit on one. To change it you duplicate it, which
 * creates a new draft. Publishing states its own consequence before it
 * happens, because it cannot be undone.
 *
 * Gated on REVIEWER_OPS_VIEW, which a personal workspace does not hold at all.
 * A 403 is that gate answering, not a failure.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../../../src/api";
import { formatUserDateTime } from "../../../src/lib/date";
import { toSafeUserError } from "../../../src/errors/safe-error";
import { usePlatformContext } from "../../../src/product/platform-context";
import { useToast } from "../../../src/toast-context";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraPageHeader,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
  ProovraConfirmSheet,
} from "../../../src/ui";
import {
  availableActions,
  buildCriteriaActionPath,
  buildCriteriaPath,
  criteriaActionConsequence,
  criteriaActionLabel,
  criteriaStatusLabel,
  criteriaStatusTone,
  parseCriteriaSets,
  type CriteriaAction,
  type CriteriaSet,
} from "../../../src/product/reviewer-criteria";

type State =
  | { phase: "loading" }
  | { phase: "loaded"; sets: CriteriaSet[] }
  | { phase: "denied" }
  | { phase: "failed" };

export default function ReviewerCriteriaScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const { context } = usePlatformContext();
  const teamId = context?.activeTeamId ?? null;

  const [state, setState] = useState<State>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ set: CriteriaSet; action: CriteriaAction } | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setState({ phase: "loading" });
    try {
      setState({ phase: "loaded", sets: parseCriteriaSets(await apiFetch(buildCriteriaPath(teamId))) });
    } catch (err) {
      const status = (err as { statusCode?: number } | undefined)?.statusCode;
      setState({ phase: status === 403 ? "denied" : "failed" });
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async () => {
    if (!pending) return;
    const { set, action } = pending;
    setPending(null);
    setBusy(true);
    try {
      await apiFetch(buildCriteriaActionPath(set.id, action), {
        method: "POST",
        body: JSON.stringify({ teamId }),
      });
      addToast(`${criteriaActionLabel(action)} done.`, "success");
      await load();
    } catch (err) {
      addToast(toSafeUserError(err).message, "error");
    } finally {
      setBusy(false);
    }
  }, [pending, teamId, addToast, load]);

  return (
    <ProovraScreen testID="reviewer-criteria">
      <ProovraPageHeader
        title="Reviewer criteria"
        eyebrow="Settings"
        subtitle="Human-authored, versioned criteria. A published version can never change."
        secondaryActions={
          <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        }
      />

      {!teamId ? <ProovraLoadingState label="Resolving workspace" /> : null}
      {teamId && state.phase === "loading" ? <ProovraLoadingState label="Loading criteria" /> : null}

      {state.phase === "denied" ? (
        // REVIEWER_OPS_VIEW is not granted in a personal workspace at all, so
        // this is a statement about the workspace, not a failure to retry.
        <ProovraEmpty
          presence="page"
          title="Reviewer criteria are part of reviewer workflows"
          purpose="This workspace has no reviewer workflow, so there are no criteria to manage here."
        />
      ) : null}

      {state.phase === "failed" ? (
        <ProovraErrorState message="Criteria could not be loaded." onRetry={() => void load()} />
      ) : null}

      {state.phase === "loaded" && state.sets.length === 0 ? (
        <ProovraEmpty
          presence="page"
          title="No criteria sets yet"
          purpose="Criteria sets are authored in the PROOVRA web app, then published here for reviewers to work against."
        />
      ) : null}

      {state.phase === "loaded" && state.sets.length > 0
        ? state.sets.map((set) => {
            const latest = set.versions[0];
            return (
              <ProovraCard key={set.id}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: theme.space.s2,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <ProovraText variant="body" weight="semibold">
                      {set.name}
                    </ProovraText>
                    {set.description ? (
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {set.description}
                      </ProovraText>
                    ) : null}
                  </View>
                  <ProovraBadge
                    label={criteriaStatusLabel(set.status)}
                    tone={criteriaStatusTone(set.status)}
                  />
                </View>

                {latest ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {[
                      `v${latest.version}`,
                      `${latest.criteriaCount} criteri${latest.criteriaCount === 1 ? "on" : "a"}`,
                      latest.publishedAtIso
                        ? `published ${formatUserDateTime(latest.publishedAtIso)}`
                        : "not published",
                    ].join(" · ")}
                  </ProovraText>
                ) : null}

                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                  {availableActions(set).map((action) => (
                    <ProovraButton
                      key={action}
                      label={criteriaActionLabel(action)}
                      variant={action === "publish" ? "primary" : "ghost"}
                      fullWidth={false}
                      disabled={busy}
                      onPress={() => setPending({ set, action })}
                    />
                  ))}
                </View>

                {/*
                  No edit control on a published set. The API answers 409
                  published_immutable, and offering an action that cannot
                  succeed implies the record could be rewritten — which is
                  exactly what versioned criteria exist to prevent.
                */}
                {set.status.toUpperCase() === "PUBLISHED" ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    Published criteria cannot be edited. Duplicate this set to make changes.
                  </ProovraText>
                ) : null}
              </ProovraCard>
            );
          })
        : null}

      <ProovraConfirmSheet
        visible={pending !== null}
        title={pending ? `${criteriaActionLabel(pending.action)} "${pending.set.name}"?` : ""}
        consequence={pending ? (criteriaActionConsequence(pending.action) ?? "") : ""}
        confirmLabel={pending ? criteriaActionLabel(pending.action) : "Confirm"}
        tone={pending?.action === "retire" ? "danger" : "warning"}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setPending(null)}
      />
    </ProovraScreen>
  );
}
