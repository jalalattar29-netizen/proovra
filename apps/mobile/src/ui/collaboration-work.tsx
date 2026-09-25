/**
 * WORK — the group's operational assignments.
 *
 * Ports `_tabs/AssignmentsTab.tsx`: what work this group is responsible for,
 * who is carrying it, and what is late.
 *
 * EVERY FILTER GOES TO THE SERVER
 * The web tab's own comment records why: "The surface used to narrow the page
 * it already held, which on a group with more work than one page hides rows
 * and counts only what happened to be loaded." Status, target type, priority,
 * assignee and search compose into ONE query and page on one keyset cursor.
 *
 * The count beside the list is the SERVER's total for the current filter, not
 * the number of rows in hand — the endpoint used to truncate silently, and a
 * surface that counted its own page would report an incomplete list as if it
 * were complete.
 *
 * `overdue` is the server's, computed against the server's clock, so this list,
 * the filter and Overview agree. Nothing here recomputes it from a due date.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { formatUserDateTime } from "../lib/date";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import {
  ProovraCard,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraInput,
  ProovraListRow,
  ProovraSection,
  ProovraSheet,
  ProovraFilterChips,
  ProovraLoadingState,
  ProovraErrorState,
  ProovraEmpty,
} from "./index";
import {
  ASSIGNEE_UNASSIGNED,
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  assignmentIsTerminal,
  assignmentPageSummary,
  assignmentPriorityLabel,
  assignmentStatusLabel,
  assignmentStatusTone,
  assignmentTargetLabel,
  buildAssignmentPath,
  buildAssignmentUpdateBody,
  buildAssignmentsPath,
  parseAssignmentPage,
  showsOverdue,
  targetTypeLabel,
  type CollaborationMember,
  type TeamAssignment,
} from "../product/collaboration";

type Phase = "loading" | "ready" | "failed";

const ALL = "ALL";

/** `ASSIGNEE_TEAM_LEVEL_LABEL`, apps/web/lib/api/collaboration-teams.ts:215. */
export const ASSIGNEE_TEAM_LEVEL_LABEL = "Team-level (no specific assignee)";

export function CollaborationWorkSection({
  teamId,
  members,
  reloadToken = 0,
}: {
  teamId: string;
  members: CollaborationMember[];
  /** Bumped by the screen after it creates an assignment. */
  reloadToken?: number;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [items, setItems] = useState<TeamAssignment[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [status, setStatus] = useState<string>(ALL);
  const [targetType, setTargetType] = useState<string>(ALL);
  // T-12 / RC-13 — the web's two other filters (AssignmentsTab.tsx:375-394).
  // The query builder already sent both; no screen let anyone set them.
  const [assignee, setAssignee] = useState<string>(ALL);
  const [priority, setPriority] = useState<string>(ALL);
  const [search, setSearch] = useState("");

  const [editing, setEditing] = useState<TeamAssignment | null>(null);

  const query = useCallback(
    (next?: string | null) => ({
      status: status === ALL ? null : status,
      targetType: targetType === ALL ? null : targetType,
      assignee: assignee === ALL ? null : assignee,
      priority: priority === ALL ? null : priority,
      search,
      limit: 25,
      cursor: next ?? null,
    }),
    [status, targetType, assignee, priority, search],
  );

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const page = parseAssignmentPage(await apiFetch(buildAssignmentsPath(teamId, query())));
      setItems(page.assignments);
      setTotal(page.total);
      setCursor(page.nextCursor);
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
  }, [teamId, query]);

  useEffect(() => {
    void load();
    // reloadToken: a new assignment was created elsewhere on the screen.
  }, [load, reloadToken]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = parseAssignmentPage(
        await apiFetch(buildAssignmentsPath(teamId, query(cursor))),
      );
      setItems((prev) => [...prev, ...page.assignments]);
      setCursor(page.nextCursor);
      setTotal(page.total);
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [teamId, cursor, query]);

  const update = useCallback(
    async (assignment: TeamAssignment, patch: Parameters<typeof buildAssignmentUpdateBody>[0]) => {
      setEditing(null);
      setBusy(true);
      setMessage(null);
      try {
        await apiFetch(buildAssignmentPath(teamId, assignment.id), {
          method: "PATCH",
          body: JSON.stringify(buildAssignmentUpdateBody(patch)),
        });
        await load();
      } catch (err) {
        setMessage(toSafeUserError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [teamId, load],
  );

  const memberName = useCallback(
    (userId: string | null) => {
      if (!userId) return "Team-level";
      const m = members.find((x) => x.id === userId);
      // An id is not a person. When the member is not in the loaded roster the
      // row says so rather than printing the id where a name belongs.
      return m ? m.displayName : "Another member";
    },
    [members],
  );

  return (
    <ProovraSection title="Work">
      <ProovraInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search this group's work"
        onSubmitEditing={() => void load()}
        accessibilityLabel="Search assignments"
      />

      <ProovraFilterChips
        label="Status"
        options={[
          { value: ALL, label: "All" },
          ...COLLABORATION_TEAM_ASSIGNMENT_STATUSES.map((v) => ({
            value: v as string,
            label: assignmentStatusLabel(v),
          })),
        ]}
        value={status}
        onChange={setStatus}
      />
      <ProovraFilterChips
        label="Record"
        options={[
          { value: ALL, label: "All" },
          ...COLLABORATION_TEAM_ASSIGNMENT_TARGETS.map((v) => ({
            value: v as string,
            label: targetTypeLabel(v),
          })),
        ]}
        value={targetType}
        onChange={setTargetType}
      />
      <ProovraFilterChips
        label="Assignee"
        options={[
          { value: ALL, label: "All assignees" },
          // The sentinel the SERVER understands for team-level work.
          { value: ASSIGNEE_UNASSIGNED, label: ASSIGNEE_TEAM_LEVEL_LABEL },
          ...members
            .filter((m) => m.status === "ACTIVE")
            .map((m) => ({ value: m.id, label: m.displayName })),
        ]}
        value={assignee}
        onChange={setAssignee}
      />
      <ProovraFilterChips
        label="Priority"
        options={[
          { value: ALL, label: "All priorities" },
          ...COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.map((v) => ({
            value: v as string,
            label: assignmentPriorityLabel(v),
          })),
        ]}
        value={priority}
        onChange={setPriority}
      />

      {phase === "loading" ? <ProovraLoadingState label="Loading work" /> : null}
      {phase === "failed" ? (
        <ProovraErrorState
          message="This group's work could not be loaded."
          onRetry={() => void load()}
        />
      ) : null}

      {message ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {message}
        </ProovraText>
      ) : null}

      {phase === "ready" && items.length === 0 ? (
        <ProovraEmpty
          presence="inline"
          title={
            status === ALL && targetType === ALL && search.trim().length === 0
              ? "This group has no assignments yet."
              : "No work matches those filters."
          }
        />
      ) : null}

      {phase === "ready" && items.length > 0 ? (
        <>
          {/* The SERVER's total for this filter, never the page length. */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {assignmentPageSummary(items.length, total)}
          </ProovraText>

          <ProovraCard>
            {items.map((a) => (
              <ProovraListRow
                key={a.id}
                title={assignmentTargetLabel(a)}
                subtitle={[
                  targetTypeLabel(a.targetType),
                  memberName(a.assigneeUserId),
                  assignmentPriorityLabel(a.priority),
                  a.dueAtIso ? `due ${formatUserDateTime(a.dueAtIso)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onPress={assignmentIsTerminal(a.status) ? undefined : () => setEditing(a)}
                trailing={
                  <View style={{ flexDirection: "row", gap: theme.space.s1, alignItems: "center" }}>
                    {/*
                      Overdue stays a badge: it is an exception state, not a
                      value every row carries. And it is only shown while the
                      work is open — a completed assignment that was late is
                      history, not an alert.
                    */}
                    {showsOverdue(a) ? <ProovraBadge label="Overdue" tone="risk" /> : null}
                    <ProovraBadge
                      label={assignmentStatusLabel(a.status)}
                      tone={assignmentStatusTone(a.status)}
                    />
                  </View>
                }
              />
            ))}
          </ProovraCard>

          {cursor ? (
            <ProovraButton
              label="Load more"
              variant="secondary"
              loading={busy}
              onPress={() => void loadMore()}
            />
          ) : null}
        </>
      ) : null}

      <ProovraSheet
        visible={editing !== null}
        title={editing ? assignmentTargetLabel(editing) : ""}
        onClose={() => setEditing(null)}
      >
        {editing?.note ? (
          <ProovraText variant="label" color={theme.color.ink.secondary}>
            {editing.note}
          </ProovraText>
        ) : null}

        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
          Status
        </ProovraText>
        {COLLABORATION_TEAM_ASSIGNMENT_STATUSES.map((s) => (
          <ProovraListRow
            key={s}
            title={assignmentStatusLabel(s)}
            subtitle={editing && s === editing.status ? "Current" : undefined}
            onPress={() => {
              if (editing) void update(editing, { status: s });
            }}
          />
        ))}

        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
          Priority
        </ProovraText>
        {COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.map((p) => (
          <ProovraListRow
            key={p}
            title={assignmentPriorityLabel(p)}
            subtitle={editing && p === editing.priority ? "Current" : undefined}
            onPress={() => {
              if (editing) void update(editing, { priority: p });
            }}
          />
        ))}

        <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
          Who is carrying it
        </ProovraText>
        <ProovraListRow
          title="Team-level"
          subtitle={
            editing && editing.assigneeUserId === null
              ? "Current — the group is responsible, not one person"
              : "The group is responsible, not one person"
          }
          onPress={() => {
            // `null` is meaningful, not "leave it alone": it makes the work
            // team-level, so it is sent explicitly.
            if (editing) void update(editing, { assigneeUserId: null });
          }}
        />
        {/* ACTIVE members only, as the web's editor offers (AssignmentsTab.tsx:913-915). */}
        {members.filter((m) => m.status === "ACTIVE").map((m) => (
          <ProovraListRow
            key={m.id}
            title={m.displayName}
            subtitle={editing && m.id === editing.assigneeUserId ? "Current" : (m.email ?? undefined)}
            onPress={() => {
              if (editing) void update(editing, { assigneeUserId: m.id });
            }}
          />
        ))}
      </ProovraSheet>
    </ProovraSection>
  );
}

export { ASSIGNEE_UNASSIGNED };
