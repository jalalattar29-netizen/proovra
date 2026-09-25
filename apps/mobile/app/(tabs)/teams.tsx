/**
 * COLLABORATION TEAMS — the native port of
 * `apps/web/app/(app)/collaboration-teams/page.tsx`.
 *
 * GET /v1/collaboration-teams (the server resolves the active workspace from
 * the session) and GET /v1/collaboration-teams/entitlement. A workspace
 * without the collaboration capability answers 403 → an honest "not
 * available" state, never a fabricated list.
 *
 * The page is the counterpart of Members & Access: that surface decides WHO
 * can reach the workspace, this one how those members work together. Every
 * capacity figure and every create affordance is the SERVER's (the web
 * console records a user who "saw '1 of 2', got an enabled Create button, and
 * met a 409").
 *
 * Search and the archived filter go to the database; status, type and sort
 * apply to the page in hand, exactly as the web applies them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "../../src/api";
import { toSafeUserError, type SafeError } from "../../src/errors/safe-error";
import { formatUserDate } from "../../src/lib/date";
import { useToast } from "../../src/toast-context";
import {
  COLLABORATION_ENTITLEMENT_PATH,
  COLLABORATION_TEAMS_PATH,
  COLLABORATION_TEAM_TYPES,
  TEAMS_PLAN_LOCKED_COPY,
  buildCreateTeamBody,
  createDisabledReason,
  formatTeamLimitReachedMessage,
  isValidTeamName,
  parseCollaborationEntitlement,
  parseCollaborationTeams,
  parseCollaborationRollup,
  parseCreatedTeamId,
  parseGrantedScope,
  teamTypeHint,
  type CollaborationRollupCard,
  type CollaborationEntitlement,
  parseCollaborationNextCursor,
  collaborationTeamSubtitle,
  collaborationRoleLabel,
  type CollaborationTeamRow,
  TEAMS_SCOPE_OPTIONS,
  TEAMS_SORT_OPTIONS,
  TEAMS_STATUS_OPTIONS,
  TEAM_TYPE_LABELS,
  buildCollaborationTeamsPath,
  parseCanGovernWorkspace,
  visibleTeams,
  type TeamsScope,
  type TeamsSort,
  type TeamsStatusFilter,
} from "../../src/product/collaboration";
import { theme } from "../../src/theme/theme";
import {
  ProovraShell,
  ProovraCard,
  ProovraButton,
  ProovraBadge,
  ProovraText,
  ProovraInput,
  ProovraFormField,
  ProovraFilterChips,
  ProovraFilterSearch,
  ProovraEmpty,
  ProovraErrorState,
  ProovraLoadingState,
  ProovraPageHeader,
  ProovraSheet,
  ProovraSupportReference,
} from "../../src/ui";

type Phase = "loading" | "ready" | "error" | "unavailable";

export default function CollaborationScreen() {
  const router = useRouter();
  const { addToast } = useToast();
  const [teams, setTeams] = useState<CollaborationTeamRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [entitlement, setEntitlement] = useState<CollaborationEntitlement | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  // A failed create is said IN the form, with the support request id.
  const [createError, setCreateError] = useState<SafeError | null>(null);
  // Workspace-wide rollup; null on a participation-scoped response (band hidden).
  const [rollup, setRollup] = useState<CollaborationRollupCard[] | null>(null);
  const [newType, setNewType] = useState("GENERAL");
  const [scope, setScope] = useState<TeamsScope>("PARTICIPATING");
  const [grantedScope, setGrantedScope] = useState<TeamsScope>("PARTICIPATING");
  const [canGovern, setCanGovern] = useState(false);
  const governorDefaultApplied = useRef(false);
  // The web defaults to ALL: archived teams are rows too (page.tsx:153).
  const [statusFilter, setStatusFilter] = useState<TeamsStatusFilter>("ALL");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [sortKey, setSortKey] = useState<TeamsSort>("ACTIVITY_DESC");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [menuFor, setMenuFor] = useState<CollaborationTeamRow | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchText.trim()), 300);
    return () => clearTimeout(t);
  }, [searchText]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (nextCursor: string | null, existing: CollaborationTeamRow[]) => {
    if (nextCursor) setLoadingMore(true);
    else setPhase("loading");
    setError(null);
    try {
      const data = await apiFetch(
        buildCollaborationTeamsPath({
          scope,
          includeArchived: statusFilter === "ARCHIVED" || statusFilter === "ALL",
          q: search,
          cursor: nextCursor,
        }),
      );
      const rows = parseCollaborationTeams(data);
      const governs = parseCanGovernWorkspace(data);
      setCanGovern(governs);
      // A governor defaults to the workspace they govern — once; choosing
      // "My teams" afterwards sticks (page.tsx:250-265).
      if (governs && !governorDefaultApplied.current) {
        governorDefaultApplied.current = true;
        if (scope !== "ALL") setScope("ALL");
      }
      setGrantedScope(parseGrantedScope(data));
      setTeams(nextCursor ? [...existing, ...rows] : rows);
      // Identical on every page, so "load more" keeps it.
      if (!nextCursor) setRollup(parseCollaborationRollup(data));
      setCursor(parseCollaborationNextCursor(data));
      setPhase("ready");
    } catch (err) {
      const safe = toSafeUserError(err, { message: "Couldn't load Teams. Try again." });
      // 403 = this workspace has no collaboration capability (Personal/plan).
      if (safe.kind === "forbidden") setPhase("unavailable");
      else {
        setError(safe);
        setPhase("error");
      }
    } finally {
      setLoadingMore(false);
    }
  }, [scope, statusFilter, search]);

  useEffect(() => {
    void load(null, []);
  }, [load]);

  const shown = useMemo(
    () => visibleTeams(teams, { status: statusFilter, type: typeFilter, sort: sortKey }),
    [teams, statusFilter, typeFilter, sortKey],
  );
  const controlsActive = search.length > 0 || statusFilter !== "ALL" || typeFilter !== "ALL";

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

  const planLocked = entitlement?.planLocked === true;
  const disabledReason = entitlement ? createDisabledReason(entitlement) : null;
  const atCapacity = !!entitlement && !planLocked && !entitlement.canCreate;

  const closeCreate = () => {
    setCreating(false);
    setNewName("");
    setNewDescription("");
    setCreateError(null);
    setNewType("GENERAL");
  };

  const create = useCallback(async () => {
    if (!isValidTeamName(newName)) return;
    setBusy(true);
    setCreateError(null);
    try {
      const res = await apiFetch(COLLABORATION_TEAMS_PATH, {
        method: "POST",
        body: JSON.stringify(buildCreateTeamBody(newName, newType, newDescription)),
      });
      const id = parseCreatedTeamId(res);
      setNewName("");
      setNewDescription("");
      setNewType("GENERAL");
      setCreating(false);
      addToast("Team created.", "success");
      // The web opens the team it just made (page.tsx:649).
      if (id) router.push(`/collaboration-team/${id}` as never);
      await Promise.all([load(null, []), loadEntitlement()]);
    } catch (err) {
      const safe = toSafeUserError(err, { message: "We couldn't create the team. Please try again." });
      const e = err as { code?: string; details?: unknown };
      const limitCopy = e?.code === "TEAM_LIMIT_REACHED" ? formatTeamLimitReachedMessage(e.details) : null;
      setCreateError(limitCopy ? { ...safe, message: limitCopy } : safe);
    } finally {
      setBusy(false);
    }
  }, [newName, newType, newDescription, load, loadEntitlement, addToast, router]);

  const openTeam = (id: string, tab?: string) =>
    router.push((tab ? `/collaboration-team/${id}?tab=${tab}` : `/collaboration-team/${id}`) as never);

  const upgradeButton = (
    <ProovraButton
      label="Upgrade plan"
      accessibilityLabel={planLocked ? "Upgrade plan" : `Upgrade — ${disabledReason ?? "plan limit reached"}`}
      variant={planLocked ? "primary" : "secondary"}
      fullWidth={false}
      onPress={() => router.push("/billing" as never)}
    />
  );

  return (
    <ProovraShell>
      <ProovraPageHeader
        title="Collaboration Teams"
        subtitle="Organise workspace members into operational teams for cases, evidence, assignments, reviews and workload. Teams group members who already have access — they do not grant it."
        secondaryActions={
          <ProovraButton
            label="Manage members & access"
            variant="ghost"
            fullWidth={false}
            onPress={() => router.push("/(stack)/workspace-people" as never)}
          />
        }
        primaryAction={
          planLocked ? (
            // Plan-locked landing: no Create affordance known to be refused.
            upgradeButton
          ) : (
            <ProovraButton
              label="Create team"
              accessibilityLabel={disabledReason ? `Create Team — ${disabledReason}` : "Create Team"}
              fullWidth={false}
              disabled={entitlement === null || atCapacity}
              onPress={() => setCreating(true)}
            />
          )
        }
        contextStrip={
          entitlement && !planLocked && entitlement.teamsLimit !== null && entitlement.teamsUsed !== null && phase === "ready" ? (
            // The web PlanLimitBadge (components/billing/PlanLimitBadge.tsx) and its Upgrade at the limit.
            <View style={styles.inline} testID="teams-plan-limit">
              <ProovraText
                variant="label"
                weight="semibold"
                color={entitlement.teamsUsed >= entitlement.teamsLimit ? theme.color.status.risk.fg : theme.color.status.verified.fg}
              >
                {`${entitlement.plan ? `${entitlement.plan} plan · ` : ""}${entitlement.teamsUsed} of ${entitlement.teamsLimit} teams used`}
              </ProovraText>
              {entitlement.teamsUsed >= entitlement.teamsLimit ? (
                <ProovraButton label="Upgrade" variant="ghost" fullWidth={false} onPress={() => router.push("/billing" as never)} />
              ) : null}
              {atCapacity ? upgradeButton : null}
            </View>
          ) : undefined
        }
      />
      {atCapacity && disabledReason ? (
        <ProovraText variant="label" color={theme.color.status.pending.fg}>
          {disabledReason}
        </ProovraText>
      ) : null}

      {phase === "loading" ? (
        <ProovraLoadingState label="Loading Teams" />
      ) : phase === "unavailable" ? (
        <ProovraEmpty
          title="Collaboration isn’t available here"
          purpose="Collaboration groups are part of Team plans. Your evidence in Personal Space is unaffected."
        />
      ) : phase === "error" && error ? (
        <ProovraCard testID="teams-error">
          <View style={styles.inline}>
            <ProovraText variant="h3" weight="semibold">
              Couldn't load Teams
            </ProovraText>
            <ProovraBadge label="Error" tone="risk" />
          </View>
          <ProovraErrorState message={error.message} requestId={error.requestId} onRetry={() => void load(null, [])} />
        </ProovraCard>
      ) : teams.length === 0 && planLocked ? (
        // THE ONLY STATE THAT MAY HIDE THE CONTROLS: a plan with zero Teams has nothing to filter.
        <ProovraEmpty
          title={TEAMS_PLAN_LOCKED_COPY}
          purpose={`${entitlement?.plan ? `Your ${entitlement.plan} plan doesn't include Teams. ` : ""}Teams give you shared assignments, member invites, and collaborative review on cases and evidence. Upgrade to create one.`}
        />
      ) : (
        <>
          {planLocked ? (
            <ProovraCard testID="teams-plan-restricted-notice">
              <View style={styles.inline}>
                <ProovraBadge label="Plan-restricted — read-only membership" tone="pending" />
              </View>
              <ProovraText variant="label" color={theme.color.ink.secondary}>
                {`${TEAMS_PLAN_LOCKED_COPY} Existing Teams and their data remain accessible.`}
              </ProovraText>
            </ProovraCard>
          ) : null}

          {rollup ? (
            <View style={styles.rollup} testID="teams-rollup">
              {rollup.map((c) => (
                <ProovraCard key={c.key} style={styles.rollupCard}>
                  <View accessible accessibilityLabel={`${c.label}: ${c.value}. ${c.meta}`} style={{ gap: 2 }}>
                    <ProovraText
                      variant="h3"
                      weight="bold"
                      color={theme.color.status[c.tone].fg}
                    >
                      {String(c.value)}
                    </ProovraText>
                    <ProovraText variant="label" weight="semibold">{c.label}</ProovraText>
                    <ProovraText variant="label" color={theme.color.ink.muted}>{c.meta}</ProovraText>
                  </View>
                </ProovraCard>
              ))}
            </View>
          ) : null}
          {grantedScope === "ALL" ? (
            <ProovraText variant="label" color={theme.color.ink.secondary} testID="teams-governance-notice">
              Showing every Team in this workspace. You can see them because you administer this workspace; you are not a
              member of the ones without a role below, and opening one does not join it.
            </ProovraText>
          ) : null}

          <ProovraFilterSearch value={searchText} onChange={setSearchText} placeholder="Search teams…" />
          {canGovern ? (
            <ProovraFilterChips label="Which teams to show" value={scope} onChange={(v) => setScope(v as TeamsScope)} options={TEAMS_SCOPE_OPTIONS} />
          ) : null}
          <ProovraFilterChips label="Filter by status" value={statusFilter} onChange={(v) => setStatusFilter(v as TeamsStatusFilter)} options={TEAMS_STATUS_OPTIONS} />
          <ProovraFilterChips
            label="Filter by team type"
            value={typeFilter}
            onChange={setTypeFilter}
            options={[{ value: "ALL", label: "All types" }, ...Object.entries(TEAM_TYPE_LABELS).map(([value, label]) => ({ value, label }))]}
          />
          <ProovraFilterChips label="Sort teams" value={sortKey} onChange={(v) => setSortKey(v as TeamsSort)} options={TEAMS_SORT_OPTIONS} />

          {shown.length === 0 ? (
            controlsActive ? (
              <ProovraEmpty
                presence="inline"
                title="No teams match the current filters"
                purpose="Archived teams are excluded unless the status filter includes them — an archived team still exists, and still holds its history."
                action={
                  <ProovraButton
                    label="Show all teams"
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => {
                      setSearchText("");
                      setSearch("");
                      setStatusFilter("ALL");
                      setTypeFilter("ALL");
                    }}
                  />
                }
              />
            ) : (
              <ProovraEmpty
                title="No teams yet"
                purpose="A team is worth creating once more than one person is working the same cases: it gives that work one place to be assigned and discussed."
                action={
                  entitlement?.canCreate ? <ProovraButton label="Create team" fullWidth={false} onPress={() => setCreating(true)} /> : undefined
                }
              />
            )
          ) : (
            <View style={{ gap: theme.space.s2 }} testID="teams-list">
              {shown.map((team) => {
                const role = collaborationRoleLabel(team.viewerRole);
                const archived = team.status === "ARCHIVED";
                return (
                  <ProovraCard key={team.id} testID={`team-card-${team.id}`}>
                    <Pressable
                      onPress={() => openTeam(team.id)}
                      accessibilityRole="button"
                      accessibilityLabel={team.name}
                      style={{ gap: theme.space.s1 }}
                    >
                      <ProovraText variant="body" weight="semibold">
                        {team.name}
                      </ProovraText>
                      {team.description ? (
                        <ProovraText variant="bodySm" color={theme.color.ink.secondary} numberOfLines={2}>
                          {team.description}
                        </ProovraText>
                      ) : null}
                    </Pressable>
                    <View style={styles.inline}>
                      <ProovraBadge label={archived ? "Archived" : "Active"} tone={archived ? "pending" : "verified"} />
                      {team.teamType ? <ProovraBadge label={TEAM_TYPE_LABELS[team.teamType] ?? team.teamType} tone="neutral" /> : null}
                      {role ? <ProovraBadge tone="governance" label={role} /> : null}
                    </View>
                    <ProovraText variant="label" color={theme.color.ink.secondary}>
                      {collaborationTeamSubtitle(team)}
                    </ProovraText>
                    <View style={[styles.inline, { justifyContent: "space-between" }]}>
                      <ProovraText variant="label" color={theme.color.ink.muted}>
                        {team.lastActivityAt ? `Last activity ${formatUserDate(team.lastActivityAt)}` : "No activity yet"}
                      </ProovraText>
                      <View style={styles.inline}>
                        <ProovraButton label="Open" accessibilityLabel={`Open ${team.name}`} variant="secondary" fullWidth={false} onPress={() => openTeam(team.id)} />
                        <ProovraButton
                          label="More"
                          accessibilityLabel={`More actions for ${team.name}`}
                          variant="ghost"
                          fullWidth={false}
                          onPress={() => setMenuFor(team)}
                        />
                      </View>
                    </View>
                  </ProovraCard>
                );
              })}
            </View>
          )}
          {cursor ? (
            <View style={styles.more}>
              <ProovraButton label="Load more" variant="secondary" loading={loadingMore} onPress={() => void load(cursor, teams)} />
            </View>
          ) : null}
        </>
      )}

      {/* The web row's overflow menu (page.tsx:1084): Open team / Add people / Settings. */}
      <ProovraSheet visible={menuFor !== null} title={menuFor ? `Actions for ${menuFor.name}` : ""} onClose={() => setMenuFor(null)}>
        {menuFor ? (
          <View style={{ gap: theme.space.s2 }}>
            <ProovraButton label="Open team" variant="secondary" onPress={() => { const t = menuFor; setMenuFor(null); openTeam(t.id); }} />
            <ProovraButton label="Add people" variant="secondary" onPress={() => { const t = menuFor; setMenuFor(null); openTeam(t.id, "members"); }} />
            <ProovraButton label="Settings" variant="secondary" onPress={() => { const t = menuFor; setMenuFor(null); openTeam(t.id, "settings"); }} />
          </View>
        ) : null}
      </ProovraSheet>

      <ProovraSheet visible={creating} title="Create a team" onClose={closeCreate}>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
          A team groups people who already have access to this workspace, so you can assign work to them and keep the
          discussion together.
        </ProovraText>
        <ProovraFormField label="Name">
          <ProovraInput
            value={newName}
            onChangeText={(v) => setNewName(v.slice(0, 120))}
            placeholder="e.g. Claim Investigations"
            autoCapitalize="sentences"
            accessibilityLabel="Team name"
          />
        </ProovraFormField>
        <ProovraFormField label="Description (optional)">
          <ProovraInput
            value={newDescription}
            onChangeText={(v) => setNewDescription(v.slice(0, 600))}
            placeholder="What does this team work on?"
            autoCapitalize="sentences"
            accessibilityLabel="Description (optional)"
            multiline
          />
        </ProovraFormField>
        <ProovraFilterChips
          label="Template"
          value={newType}
          onChange={setNewType}
          options={COLLABORATION_TEAM_TYPES.map((v) => ({ value: v, label: TEAM_TYPE_LABELS[v] ?? v }))}
        />
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {`${teamTypeHint(newType)}. A label for what this team works on. It changes nothing about permissions or behaviour — it helps you find the team later.`}
        </ProovraText>
        {createError ? (
          <View style={{ gap: 2 }} testID="create-team-error">
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{createError.message}</ProovraText>
            <ProovraSupportReference reference={createError.requestId} />
          </View>
        ) : null}
        <View style={styles.inline}>
          <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={busy} onPress={closeCreate} />
          <ProovraButton
            label={busy ? "Creating…" : "Create team"}
            accessibilityLabel="Submit new team"
            fullWidth={false}
            loading={busy}
            disabled={!isValidTeamName(newName)}
            onPress={() => void create()}
          />
        </View>
      </ProovraSheet>
    </ProovraShell>
  );
}

const styles = StyleSheet.create({
  more: { marginTop: theme.space.s4 },
  inline: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.space.s2 },
  rollup: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginVertical: theme.space.s2 },
  rollupCard: { flexBasis: "47%", flexGrow: 1 },
});
