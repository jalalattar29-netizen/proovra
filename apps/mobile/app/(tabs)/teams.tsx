/**
 * COLLABORATION (Native Convergence §15, N4). Replaces the old dead "managed on
 * web" stub with the real PRO/TEAM collaboration list: GET /v1/collaboration-
 * teams (the server resolves the active workspace from the session). A workspace
 * without the collaboration capability answers 403 → an honest "not available"
 * state, never a fabricated list. Personal-only capture is unaffected; this is a
 * read surface, not a workspace switcher (§4.8).
 */
import { useCallback, useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import {
  COLLABORATION_ENTITLEMENT_PATH,
  COLLABORATION_TEAMS_PATH,
  COLLABORATION_TEAM_TYPES,
  buildCreateTeamBody,
  createDisabledReason,
  isValidTeamName,
  parseCollaborationEntitlement,
  parseCollaborationTeams,
  type CollaborationEntitlement,
  parseCollaborationNextCursor,
  collaborationTeamSubtitle,
  collaborationRoleLabel,
  type CollaborationTeamRow,
} from "../../src/product/collaboration";
import { theme } from "../../src/theme/theme";
import {
  ProovraShell,
  ProovraCard,
  ProovraSection,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraText,
  ProovraInput,
  ProovraFormField,
  ProovraFilterChips,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../src/ui";

type Phase = "loading" | "ready" | "error" | "unavailable";

export default function CollaborationScreen() {
  const router = useRouter();
  const [teams, setTeams] = useState<CollaborationTeamRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [entitlement, setEntitlement] = useState<CollaborationEntitlement | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("GENERAL");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (nextCursor: string | null, existing: CollaborationTeamRow[]) => {
    if (nextCursor) setLoadingMore(true);
    else setPhase("loading");
    setError(null);
    try {
      const path = nextCursor
        ? `/v1/collaboration-teams?cursor=${encodeURIComponent(nextCursor)}`
        : "/v1/collaboration-teams";
      const data = await apiFetch(path);
      const rows = parseCollaborationTeams(data);
      setTeams(nextCursor ? [...existing, ...rows] : rows);
      setCursor(parseCollaborationNextCursor(data));
      setPhase("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      // 403 = this workspace has no collaboration capability (Personal/plan) —
      // an honest unavailable state, not a scary error.
      if (safe.kind === "forbidden") setPhase("unavailable");
      else {
        setError(safe);
        setPhase("error");
      }
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load(null, []);
  }, [load]);

  // The server decides whether this workspace may create a group. The envelope
  // says so: "Server-decided affordances. The browser renders these; it does
  // not derive them." The web console's own comment records what happens when
  // a client computes capacity itself — a user who "saw '1 of 2', got an
  // enabled Create button, and met a 409".
  const loadEntitlement = useCallback(async () => {
    try {
      setEntitlement(parseCollaborationEntitlement(await apiFetch(COLLABORATION_ENTITLEMENT_PATH)));
    } catch {
      setEntitlement(null);
    }
  }, []);

  useEffect(() => {
    void loadEntitlement();
  }, [loadEntitlement]);

  const create = useCallback(async () => {
    if (!isValidTeamName(newName)) return;
    setBusy(true);
    try {
      await apiFetch(COLLABORATION_TEAMS_PATH, {
        method: "POST",
        body: JSON.stringify(buildCreateTeamBody(newName, newType)),
      });
      setNewName("");
      setCreating(false);
      await Promise.all([load(null, []), loadEntitlement()]);
    } catch (err) {
      setError(toSafeUserError(err));
    } finally {
      setBusy(false);
    }
  }, [newName, newType, load, loadEntitlement]);

  return (
    <ProovraShell>
      <ProovraSection title="Collaboration">
        {/*
          Collaboration groups and the workspace roster are DIFFERENT things:
          a collaboration group is a shared working set inside a workspace,
          while People is the workspace's own membership, seats and invitations.
          Both are reachable, and neither is renamed into the other.
        */}
        <ProovraListRow
          title="People in this workspace"
          subtitle="Members, roles and invitations"
          onPress={() => router.push("/(stack)/workspace-people")}
        />
        {/*
          Rendered only when the SERVER says this workspace may create one, and
          the reason shown when it may not. The entitlement envelope's own
          words: "Server-decided affordances. The browser renders these; it
          does not derive them." The web console's comment records what
          happens otherwise — a user who "saw '1 of 2', got an enabled Create
          button, and met a 409".
        */}
        {entitlement && entitlement.canCreate ? (
          creating ? (
            <ProovraCard>
              <ProovraFormField label="Group name">
                <ProovraInput
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="What is this group for?"
                  autoCapitalize="sentences"
                  accessibilityLabel="Group name"
                />
              </ProovraFormField>
              <ProovraFilterChips
                label="Type"
                value={newType}
                onChange={setNewType}
                options={COLLABORATION_TEAM_TYPES.map((v) => ({
                  value: v,
                  label: v.charAt(0) + v.slice(1).toLowerCase(),
                }))}
              />
              <ProovraButton
                label="Create group"
                loading={busy}
                disabled={!isValidTeamName(newName)}
                onPress={() => void create()}
              />
              <ProovraButton
                label="Cancel"
                variant="ghost"
                onPress={() => { setCreating(false); setNewName(""); }}
              />
            </ProovraCard>
          ) : (
            <ProovraButton
              label="Create a group"
              variant="secondary"
              onPress={() => setCreating(true)}
            />
          )
        ) : entitlement ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {createDisabledReason(entitlement)}
          </ProovraText>
        ) : null}

        {phase === "loading" ? (
          <ProovraLoadingState label="Loading collaboration groups" />
        ) : phase === "unavailable" ? (
          <ProovraEmptyState
            title="Collaboration isn’t available here"
            message="Collaboration groups are part of Team plans. Your evidence in Personal Space is unaffected."
          />
        ) : phase === "error" && error ? (
          <ProovraErrorState message={error.message} onRetry={() => void load(null, [])} />
        ) : teams.length === 0 ? (
          <ProovraEmptyState
            title="No collaboration groups yet"
            message="Groups you belong to in this workspace will appear here."
          />
        ) : (
          <>
            <ProovraCard>
              {teams.map((team) => {
                const role = collaborationRoleLabel(team.viewerRole);
                return (
                  <ProovraListRow
                    key={team.id}
                    title={team.name}
                    subtitle={collaborationTeamSubtitle(team)}
                    trailing={role ? <ProovraBadge tone="governance" label={role} /> : undefined}
                    onPress={() => router.push(`/collaboration-team/${team.id}`)}
                  />
                );
              })}
            </ProovraCard>
            {cursor ? (
              <View style={styles.more}>
                <ProovraButton label="Load more" variant="secondary" loading={loadingMore} onPress={() => void load(cursor, teams)} />
              </View>
            ) : null}
          </>
        )}
      </ProovraSection>
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  more: { marginTop: theme.space.s4 },
});
