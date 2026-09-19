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
  parseCollaborationTeams,
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

  return (
    <ProovraShell>
      <ProovraSection title="Collaboration">
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
            message="Groups you belong to in this workspace will appear here. Create and manage groups in the PROOVRA web app."
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
