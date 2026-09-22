/**
 * CRITERIA DRAFT EDITOR — authoring the criterion rows of a DRAFT version.
 *
 * Ports the `DraftEditor` of
 * `apps/web/app/(app)/settings/reviewer-criteria/page.tsx` over
 * `PATCH /v1/reviewer-criteria/:setId/draft`.
 *
 * This was previously left off the device with the note "a draft half-written
 * on a phone is a draft nobody can publish". That describes the length of the
 * form, not the product: criteria are the only thing on this surface a person
 * actually writes, and leaving the writing out left the catalogue read-only
 * with three transitions attached to content it could not produce.
 *
 * TWO RULES CARRY OVER EXACTLY, BECAUSE THEY ARE WHY VERSIONS ARE WORTH
 * ANYTHING
 *
 *   Published is immutable. The editor renders only for a DRAFT, and the API
 *   refuses anything else with 409 `published_immutable`.
 *
 *   The save is optimistically concurrent. The editor holds the `updatedAt` it
 *   loaded and sends it as `expectedUpdatedAt`. A second admin who saved in
 *   the meantime makes this save a 409 `draft_conflict` in which NOTHING is
 *   written — and the recovery offered depends on what the other change was:
 *   reload and reconcile for an ordinary edit, duplicate-then-save when the
 *   other change was a publish.
 *
 * AI never writes here. Nothing in this component generates a criterion.
 */
import { useCallback, useEffect, useState } from "react";
import { Switch, View } from "react-native";

import { apiFetch } from "../api";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraInput,
  ProovraFormField,
  ProovraLoadingState,
} from "./index";
import {
  buildCriteriaActionPath,
  buildCriteriaDraftPath,
  buildCriteriaSetPath,
  buildDraftBody,
  canSaveAsNewDraft,
  classifyDraftFailure,
  diffDraftRows,
  draftFailureMessage,
  emptyCriterionRow,
  parseDraftState,
  validateDraft,
  CRITERIA_MAX,
  type CriterionRow,
  type DraftState,
} from "../product/reviewer-criteria";

/**
 * The criterion rows themselves.
 *
 * ONE editor, used by both the draft editor below and the "new criteria set"
 * form on the catalogue screen. They write to different endpoints but they
 * author the same thing, and two copies of a form is how one of them quietly
 * stops matching the route bounds.
 */
export function CriterionRowsEditor({
  list,
  onChange,
}: {
  list: CriterionRow[];
  onChange: (next: CriterionRow[]) => void;
}) {
  const patch = (index: number, next: Partial<CriterionRow>) =>
    onChange(list.map((r, i) => (i === index ? { ...r, ...next } : r)));

  return (
    <>
      {list.map((row, i) => (
        <ProovraCard key={`criterion-${i}`}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: theme.space.s2,
            }}
          >
            <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
              {`Criterion ${i + 1}`}
            </ProovraText>
            <ProovraButton
              label="Remove"
              variant="ghost"
              fullWidth={false}
              // The route requires at least one criterion, so the last row is
              // not removable — a form that could be emptied could not be saved.
              disabled={list.length === 1}
              onPress={() => onChange(list.filter((_, idx) => idx !== i))}
            />
          </View>

          <ProovraFormField label="Key">
            <ProovraInput
              value={row.key}
              onChangeText={(t) => patch(i, { key: t })}
              placeholder="short-stable-identifier"
              accessibilityLabel={`Criterion ${i + 1} key`}
            />
          </ProovraFormField>

          <ProovraFormField label="Title">
            <ProovraInput
              value={row.title}
              onChangeText={(t) => patch(i, { title: t })}
              placeholder="What the reviewer is being asked"
              autoCapitalize="sentences"
              accessibilityLabel={`Criterion ${i + 1} title`}
            />
          </ProovraFormField>

          <ProovraFormField label="Review guidance (optional)">
            <ProovraInput
              value={row.reviewGuidance}
              onChangeText={(t) => patch(i, { reviewGuidance: t })}
              placeholder="How a reviewer should judge this"
              autoCapitalize="sentences"
              multiline
              accessibilityLabel={`Criterion ${i + 1} guidance`}
            />
          </ProovraFormField>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: theme.space.s2,
            }}
          >
            <ProovraText variant="label">Required</ProovraText>
            <Switch
              value={row.required}
              onValueChange={(v) => patch(i, { required: v })}
              accessibilityLabel={`Criterion ${i + 1} is required`}
            />
          </View>
        </ProovraCard>
      ))}

      <ProovraButton
        label="Add a criterion"
        variant="ghost"
        disabled={list.length >= CRITERIA_MAX}
        onPress={() => onChange([...list, emptyCriterionRow()])}
      />
    </>
  );
}

export function CriteriaDraftEditor({
  teamId,
  setId,
  onSaved,
}: {
  teamId: string;
  setId: string;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [list, setList] = useState<CriterionRow[] | null>(null);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DraftState | null>(null);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadServer = useCallback(async (): Promise<DraftState | null> => {
    return parseDraftState(await apiFetch(buildCriteriaSetPath(setId, teamId)));
  }, [setId, teamId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const server = await loadServer();
        if (cancelled || !server) return;
        setTitle(server.title);
        // A draft with no rows yet still needs somewhere to type: the route
        // requires at least one criterion, so the form starts at one.
        setList(server.rows.length > 0 ? server.rows : [emptyCriterionRow()]);
        setBaseUpdatedAt(server.updatedAtIso);
      } catch {
        if (!cancelled) setError("The draft could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadServer]);

  const save = useCallback(
    async (expected: string | null) => {
      if (busy || !list) return;
      const invalid = validateDraft(title, list);
      if (invalid) {
        setError(invalid);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await apiFetch(buildCriteriaDraftPath(setId), {
          method: "PATCH",
          body: JSON.stringify(buildDraftBody(teamId, title, list, expected)),
        });
        setConflict(null);
        onSaved();
      } catch (err) {
        // `draft_conflict` and `published_immutable` are BOTH 409 and call for
        // opposite recoveries, so the code decides, not the status.
        const failure = classifyDraftFailure(err);
        if (failure === "CONFLICT") {
          try {
            setConflict(await loadServer());
            setComparing(false);
          } catch {
            setError("This draft changed on the server and the latest state could not be loaded.");
            return;
          }
        }
        setError(draftFailureMessage(failure));
      } finally {
        setBusy(false);
      }
    },
    [busy, list, title, setId, teamId, onSaved, loadServer],
  );

  const reloadLatest = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const server = await loadServer();
      if (server) {
        setTitle(server.title);
        setList(server.rows.length > 0 ? server.rows : [emptyCriterionRow()]);
        setBaseUpdatedAt(server.updatedAtIso);
        setConflict(null);
        setComparing(false);
      }
    } catch {
      setError("The latest version could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, [loadServer]);

  const saveAsNewDraft = useCallback(async () => {
    // Offered ONLY when the conflicting change was a publish: duplicate makes
    // v(N+1) and this editor content is saved into it. After an ordinary edit
    // there is nothing to duplicate, and reconciling is the honest recovery.
    if (busy || !list || !canSaveAsNewDraft(conflict)) return;
    const invalid = validateDraft(title, list);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(buildCriteriaActionPath(setId, "duplicate"), {
        method: "POST",
        body: JSON.stringify({ teamId }),
      });
      // No `expectedUpdatedAt`: the duplicate was just created by this call, so
      // the token loaded earlier is the wrong one to guard with.
      await apiFetch(buildCriteriaDraftPath(setId), {
        method: "PATCH",
        body: JSON.stringify(buildDraftBody(teamId, title, list, null)),
      });
      setConflict(null);
      onSaved();
    } catch {
      setError("Saving as a new draft failed. Reload the latest version and try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, list, conflict, title, setId, teamId, onSaved]);

  if (!list) {
    return error ? (
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {error}
      </ProovraText>
    ) : (
      <ProovraLoadingState label="Loading draft" />
    );
  }

  const differences = conflict ? diffDraftRows(list, conflict.rows) : [];

  return (
    <View style={{ gap: theme.space.s3 }}>
      {conflict ? (
        <ProovraCard>
          <ProovraText variant="body" weight="semibold">
            Someone else changed this draft
          </ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {conflict.latestPublished
              ? "It was published while you were editing. Your changes were NOT saved."
              : "It was edited while you were editing. Your changes were NOT saved."}
          </ProovraText>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
            <ProovraButton
              label="Reload latest"
              variant="ghost"
              fullWidth={false}
              loading={busy}
              onPress={() => void reloadLatest()}
            />
            <ProovraButton
              label={comparing ? "Hide changes" : "Compare changes"}
              variant="ghost"
              fullWidth={false}
              onPress={() => setComparing((v) => !v)}
            />
            {canSaveAsNewDraft(conflict) ? (
              <ProovraButton
                label="Save as new draft"
                fullWidth={false}
                loading={busy}
                onPress={() => void saveAsNewDraft()}
              />
            ) : null}
          </View>

          {comparing ? (
            differences.length === 0 ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>
                The criterion titles are the same on both sides; the difference is
                elsewhere in the version.
              </ProovraText>
            ) : (
              differences.map((d) => (
                <View key={d.key} style={{ gap: 2 }}>
                  <ProovraText variant="label" weight="semibold">
                    {d.key}
                  </ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {`Yours: ${d.mine ?? "(removed)"}`}
                  </ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {`Theirs: ${d.theirs ?? "(removed)"}`}
                  </ProovraText>
                </View>
              ))
            )
          ) : null}
        </ProovraCard>
      ) : null}

      <ProovraFormField label="Version title">
        <ProovraInput
          value={title}
          onChangeText={setTitle}
          placeholder="What this version of the criteria is"
          autoCapitalize="sentences"
          accessibilityLabel="Version title"
        />
      </ProovraFormField>

      <CriterionRowsEditor list={list} onChange={(next) => setList(next)} />

      <ProovraButton
        label="Save draft"
        loading={busy}
        onPress={() => void save(baseUpdatedAt)}
      />

      {error ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {error}
        </ProovraText>
      ) : null}
    </View>
  );
}
