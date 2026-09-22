/**
 * REVIEWER CRITERIA — the native port of
 * `apps/web/app/(app)/settings/reviewer-criteria/page.tsx`.
 *
 * The human-authored, versioned criteria catalogue, complete: read, author a
 * draft, publish, duplicate, retire, and read how often each published version
 * has actually been used.
 *
 * Authoring used to be absent with the note "a draft half-written on a phone
 * is a draft nobody can publish". That described the length of the form, not
 * the product, and it left the catalogue read-only with three transitions
 * attached to content it could not produce. The editor lives in
 * src/ui/criteria-draft-editor.tsx.
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
  ProovraFormField,
  ProovraInput,
  ProovraSheet,
} from "../../../src/ui";
import {
  CriteriaDraftEditor,
  CriterionRowsEditor,
} from "../../../src/ui/criteria-draft-editor";
import {
  availableActions,
  buildCriteriaUsagePath,
  isEditable,
  parseCriteriaUsage,
  buildCreateSetBody,
  emptyCriterionRow,
  validateNewSet,
  CRITERIA_CREATE_PATH,
  type CriteriaUsage,
  type CriterionRow,
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
  const [editing, setEditing] = useState<string | null>(null);
  const [usage, setUsage] = useState<Record<string, CriteriaUsage[]>>({});

  // The new set. It creates the SET and its v1 DRAFT in one call, so the name
  // and the version title are both asked for — the route keeps them apart and
  // collapsing them would put the wrong text on the version record.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newRows, setNewRows] = useState<CriterionRow[]>([emptyCriterionRow()]);
  const [createError, setCreateError] = useState<string | null>(null);

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

  /**
   * Per-version usage: how often the Reviewer Copilot actually ran against
   * each published version, derived from existing defensibility records.
   *
   * Additive, and failure is silent by design — the catalogue is the point,
   * and a usage read that 404s or is unavailable must not take the sets with
   * it. The route says so itself with an `usageAvailable` flag.
   */
  const loadUsage = useCallback(
    async (setId: string) => {
      if (!teamId || usage[setId]) return;
      try {
        const data = await apiFetch(buildCriteriaUsagePath(setId, teamId));
        if ((data as { usageAvailable?: boolean }).usageAvailable === false) return;
        setUsage((prev) => ({ ...prev, [setId]: parseCriteriaUsage(data) }));
      } catch {
        /* additive */
      }
    },
    [teamId, usage],
  );

  const create = useCallback(async () => {
    if (!teamId) return;
    const invalid = validateNewSet(newName, newTitle, newRows);
    if (invalid) {
      setCreateError(invalid);
      return;
    }
    setBusy(true);
    setCreateError(null);
    try {
      await apiFetch(CRITERIA_CREATE_PATH, {
        method: "POST",
        body: JSON.stringify(
          buildCreateSetBody(teamId, newName, newDescription, newTitle, newRows),
        ),
      });
      setCreating(false);
      setNewName("");
      setNewDescription("");
      setNewTitle("");
      setNewRows([emptyCriterionRow()]);
      addToast("Criteria set created as a draft.", "success");
      await load();
    } catch (err) {
      setCreateError(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [teamId, newName, newDescription, newTitle, newRows, addToast, load]);

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
        primaryAction={
          state.phase === "loaded" ? (
            <ProovraButton
              label="New criteria set"
              fullWidth={false}
              onPress={() => setCreating(true)}
            />
          ) : undefined
        }
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
          purpose="A criteria set is a versioned list of what a reviewer must judge. Sets created for this workspace appear here."
          action={<ProovraButton label="New criteria set" onPress={() => setCreating(true)} />}
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
                  Editing is offered only for a DRAFT — see isEditable. On a
                  published set the API answers 409 published_immutable.
                */}
                {isEditable(set) && teamId ? (
                  <>
                    <ProovraButton
                      label={editing === set.id ? "Close editor" : "Edit draft"}
                      variant="ghost"
                      fullWidth={false}
                      onPress={() => setEditing((cur) => (cur === set.id ? null : set.id))}
                    />
                    {editing === set.id ? (
                      <CriteriaDraftEditor
                        teamId={teamId}
                        setId={set.id}
                        onSaved={() => {
                          addToast("Draft saved.", "success");
                          void load();
                        }}
                      />
                    ) : null}
                  </>
                ) : null}

                {set.versions.length > 0 ? (
                  <ProovraButton
                    label={usage[set.id] ? "Hide usage" : "Version usage"}
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => {
                      if (usage[set.id]) {
                        setUsage((prev) => {
                          const next = { ...prev };
                          delete next[set.id];
                          return next;
                        });
                      } else {
                        void loadUsage(set.id);
                      }
                    }}
                  />
                ) : null}

                {usage[set.id]
                  ? usage[set.id].map((u) => (
                      <ProovraText
                        key={u.version}
                        variant="label"
                        color={theme.color.ink.muted}
                      >
                        {[
                          `v${u.version}`,
                          `${u.runCount} run${u.runCount === 1 ? "" : "s"}`,
                          `${u.reviewCount} review${u.reviewCount === 1 ? "" : "s"}`,
                          `${u.reviewerCount} reviewer${u.reviewerCount === 1 ? "" : "s"}`,
                          u.lastUsedAtIso ? `last ${formatUserDateTime(u.lastUsedAtIso)}` : "never used",
                        ].join(" · ")}
                      </ProovraText>
                    ))
                  : null}

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

      <ProovraSheet
        visible={creating}
        title="New criteria set"
        onClose={() => setCreating(false)}
      >
        <ProovraFormField label="Set name">
          <ProovraInput
            value={newName}
            onChangeText={setNewName}
            placeholder="e.g. Insurance intake review"
            autoCapitalize="sentences"
            accessibilityLabel="Criteria set name"
          />
        </ProovraFormField>

        <ProovraFormField label="Description (optional)">
          <ProovraInput
            value={newDescription}
            onChangeText={setNewDescription}
            placeholder="What this set is for"
            autoCapitalize="sentences"
            multiline
            accessibilityLabel="Criteria set description"
          />
        </ProovraFormField>

        <ProovraFormField label="Version title">
          <ProovraInput
            value={newTitle}
            onChangeText={setNewTitle}
            placeholder="e.g. Baseline v1"
            autoCapitalize="sentences"
            accessibilityLabel="Version title"
          />
        </ProovraFormField>

        {/* The same row editor the draft editor uses — one form, one set of bounds. */}
        <CriterionRowsEditor list={newRows} onChange={setNewRows} />

        <ProovraButton label="Create draft" loading={busy} onPress={() => void create()} />
        {createError ? (
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {createError}
          </ProovraText>
        ) : null}
      </ProovraSheet>

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
