/**
 * REVIEWER WORKFLOW — the state of the review, on the record.
 *
 * Three routes existed and none was called from a phone
 * (evidence.routes.ts:8167 read, :8179 update, :8352 events). A reviewer could
 * read every hash and custody event on a record and not see who it was
 * assigned to, when it was due, or what anyone had done to it — which is the
 * only part of a record that changes while it is being reviewed.
 *
 * THE VERDICT LINE. `status` carries routing states and verdict states, and
 * only the decision authority may produce a verdict
 * (review-status-vocabulary.ts). A current verdict is SHOWN, because it is the
 * record's real state and hiding it would be worse; it is not OFFERED, because
 * it is a reading of the decision log rather than a setting. The status picker
 * therefore lists routing states only, derived by subtraction from the schema
 * so a state added later cannot land on the wrong side of the line.
 */
import { formatLocalDueInput, parseLocalDueInput } from "../product/team-responsibility";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  ProovraBadge,
  ProovraButton,
  ProovraCard,
  ProovraEmpty,
  ProovraFormField,
  ProovraInput,
  ProovraListRow,
  ProovraLoadingState,
  ProovraSection,
  ProovraSheet,
  ProovraText,
} from "./index";
import {
  buildReviewerWorkflowPath,
  buildReviewerWorkflowEventsPath,
  buildWorkflowUpdateBody,
  workflowUpdateIsEmpty,
  isVerdictStatus,
  parseReviewerWorkflow,
  parseReviewerWorkflowEvents,
  workflowStatusLabel,
  workflowPriorityLabel,
  workflowEventLabel,
  validateWorkflowNote,
  ROUTING_WORKFLOW_STATUSES,
  WORKFLOW_PRIORITIES,
  WORKFLOW_NOTE_MAX,
  VERDICT_STATUS_NOTE,
  type ReviewerWorkflow,
  type ReviewerWorkflowEvent,
} from "../product/reviewer-workflow";

/** Loading, failed and "no workflow yet" are three different answers. */
type State<T> =
  | { status: "loading" }
  | { status: "failed"; reason: string }
  | { status: "ready"; value: T };

/**
 * `openRequest` — a counter the screen bumps to open the editor from outside
 * (the web opens this same modal from the Review hero's "Assign reviewer" and
 * the attention strip's "Review not started · Start", page.tsx:1306).
 */
export function ReviewerWorkflowPanel({ evidenceId, openRequest = 0 }: { evidenceId: string; openRequest?: number }) {
  const [workflow, setWorkflow] = useState<State<ReviewerWorkflow | null>>({ status: "loading" });
  const [events, setEvents] = useState<State<ReviewerWorkflowEvent[]>>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [statusPicker, setStatusPicker] = useState(false);
  const [priorityPicker, setPriorityPicker] = useState(false);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [draftPriority, setDraftPriority] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [dueDraft, setDueDraft] = useState("");

  const load = useCallback(async () => {
    setWorkflow({ status: "loading" });
    setEvents({ status: "loading" });
    // Independent: a refusal on the history must not hide the state.
    await Promise.all([
      apiFetch(buildReviewerWorkflowPath(evidenceId))
        .then((d) => setWorkflow({ status: "ready", value: parseReviewerWorkflow(d) }))
        .catch((err) => setWorkflow({ status: "failed", reason: toSafeUserError(err).message })),
      apiFetch(buildReviewerWorkflowEventsPath(evidenceId))
        .then((d) => setEvents({ status: "ready", value: parseReviewerWorkflowEvents(d) }))
        .catch((err) => setEvents({ status: "failed", reason: toSafeUserError(err).message })),
    ]);
  }, [evidenceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = workflow.status === "ready" ? workflow.value : null;

  const openEditor = useCallback(() => {
    setDraftStatus(current?.status ?? null);
    setDraftPriority(current?.priority ?? null);
    setDueDraft(formatLocalDueInput(current?.dueAtIso ?? null));
    setNote("");
    setMessage(null);
    setEditing(true);
  }, [current]);

  // Opened from outside once the workflow is read, so the drafts start from it.
  const handledRequest = useRef(0);
  useEffect(() => {
    if (openRequest > handledRequest.current && workflow.status !== "loading") {
      handledRequest.current = openRequest;
      openEditor();
    }
  }, [openRequest, workflow.status, openEditor]);

  const save = useCallback(async () => {
    const invalidNote = validateWorkflowNote(note);
    if (invalidNote) {
      setMessage(invalidNote);
      return;
    }
    // The web modal's Due date (page.tsx:1548): local wall time, sent as that instant; cleared = null.
    const dueIso = parseLocalDueInput(dueDraft);
    if (dueIso === undefined) {
      setMessage("Use YYYY-MM-DD HH:MM, in your local time.");
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = buildWorkflowUpdateBody({
        status: draftStatus,
        priority: draftPriority,
        dueAtIso: dueIso,
        note,
        current,
      });
    } catch (err) {
      // A verdict reached the builder: the surface has offered something it
      // should not have, and swallowing that would hide the mistake.
      setMessage(err instanceof Error ? err.message : "That status cannot be set here.");
      return;
    }
    if (workflowUpdateIsEmpty(body)) {
      // Re-sending the current values would append an event saying they were
      // set, on the one feed whose purpose is to be an accurate account.
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await apiFetch(buildReviewerWorkflowPath(evidenceId), {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setEditing(false);
      await load();
    } catch (err) {
      setMessage(toSafeUserError(err).message);
    } finally {
      setBusy(false);
    }
  }, [evidenceId, draftStatus, draftPriority, dueDraft, note, current, load]);

  if (workflow.status === "loading") {
    return <ProovraLoadingState label="Loading review state" />;
  }

  if (workflow.status === "failed") {
    return (
      <ProovraSection title="Review">
        <ProovraEmpty
          presence="inline"
          title="The review state could not be loaded."
          purpose={workflow.reason}
          action={
            <ProovraButton
              label="Try again"
              variant="secondary"
              fullWidth={false}
              onPress={() => void load()}
            />
          }
        />
      </ProovraSection>
    );
  }

  return (
    <ProovraSection title="Review">
      {message ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {message}
        </ProovraText>
      ) : null}

      {current === null ? (
        <ProovraEmpty
          presence="inline"
          title="This record has no review yet."
          purpose="Setting a status starts one."
          action={
            <ProovraButton
              label="Start a review"
              variant="secondary"
              fullWidth={false}
              onPress={openEditor}
            />
          }
        />
      ) : (
        <ProovraCard>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: theme.space.s2,
            }}
          >
            <ProovraBadge
              label={workflowStatusLabel(current.status)}
              tone={isVerdictStatus(current.status) ? "verified" : "info"}
            />
            <ProovraBadge label={workflowPriorityLabel(current.priority)} tone="neutral" />
          </View>
          {isVerdictStatus(current.status) ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {VERDICT_STATUS_NOTE}
            </ProovraText>
          ) : null}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {[
              // A raw user id is not a person.
              current.assignedToLabel ? `Assigned to ${current.assignedToLabel}` : "Unassigned",
              current.assignedByLabel ? `Assigned by ${current.assignedByLabel}` : null,
              current.dueAtIso ? `Due ${formatUserDateTime(current.dueAtIso)}` : null,
              current.lastReviewedAtIso
                ? `Last reviewed ${formatUserDateTime(current.lastReviewedAtIso)}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </ProovraText>
          <ProovraButton
            label="Update review state"
            variant="secondary"
            fullWidth={false}
            onPress={openEditor}
          />
        </ProovraCard>
      )}

      {/* The workflow's own history. */}
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
        Review history
      </ProovraText>
      {events.status === "ready" ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {`${events.value.length} recorded event${events.value.length === 1 ? "" : "s"}`}
        </ProovraText>
      ) : null}
      {events.status === "loading" ? null : events.status === "failed" ? (
        <ProovraEmpty
          presence="inline"
          title="The review history could not be loaded."
          purpose={events.reason}
          action={
            <ProovraButton
              label="Try again"
              variant="secondary"
              fullWidth={false}
              onPress={() => void load()}
            />
          }
        />
      ) : events.value.length === 0 ? (
        <ProovraEmpty presence="inline" title="Nothing has happened to this review yet." />
      ) : (
        <ProovraCard>
          {events.value.map((e) => (
            <View key={e.id} style={{ gap: 2, paddingVertical: theme.space.s2 }}>
              <ProovraText variant="bodySm" weight="semibold">
                {workflowEventLabel(e.eventType)}
              </ProovraText>
              {e.note ? <ProovraText variant="bodySm">{e.note}</ProovraText> : null}
              <ProovraText variant="label" color={theme.color.ink.muted}>
                {[e.actorLabel, e.createdAtIso ? formatUserDateTime(e.createdAtIso) : null]
                  .filter(Boolean)
                  .join(" · ")}
              </ProovraText>
            </View>
          ))}
        </ProovraCard>
      )}

      <ProovraSheet
        visible={editing}
        title="Update review state"
        onClose={() => setEditing(false)}
      >
        <ProovraListRow
          title="Status"
          subtitle={workflowStatusLabel(draftStatus)}
          onPress={() => setStatusPicker(true)}
        />
        <ProovraListRow
          title="Priority"
          subtitle={workflowPriorityLabel(draftPriority)}
          onPress={() => setPriorityPicker(true)}
        />
        <ProovraFormField label="Due date (optional)">
          <ProovraInput value={dueDraft} onChangeText={setDueDraft} placeholder="YYYY-MM-DD HH:MM" autoCapitalize="none" accessibilityLabel="Due date" />
        </ProovraFormField>
        <ProovraFormField label="Note (optional)">
          <ProovraInput
            value={note}
            onChangeText={setNote}
            placeholder={`Up to ${WORKFLOW_NOTE_MAX} characters`}
            autoCapitalize="sentences"
            multiline
            accessibilityLabel="Review note"
          />
        </ProovraFormField>
        <ProovraButton label="Save" loading={busy} onPress={() => void save()} />
      </ProovraSheet>

      <ProovraSheet
        visible={statusPicker}
        title="Review status"
        onClose={() => setStatusPicker(false)}
      >
        {/*
          Routing states only. A verdict is a reading of the decision log, and
          offering one here would be offering to forge it.
        */}
        {ROUTING_WORKFLOW_STATUSES.map((s) => (
          <ProovraListRow
            key={s}
            title={workflowStatusLabel(s)}
            subtitle={s === draftStatus ? "Current" : undefined}
            onPress={() => {
              setDraftStatus(s);
              setStatusPicker(false);
            }}
          />
        ))}
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {VERDICT_STATUS_NOTE}
        </ProovraText>
      </ProovraSheet>

      <ProovraSheet
        visible={priorityPicker}
        title="Priority"
        onClose={() => setPriorityPicker(false)}
      >
        {WORKFLOW_PRIORITIES.map((p) => (
          <ProovraListRow
            key={p}
            title={workflowPriorityLabel(p)}
            subtitle={p === draftPriority ? "Current" : undefined}
            onPress={() => {
              setDraftPriority(p);
              setPriorityPicker(false);
            }}
          />
        ))}
      </ProovraSheet>
    </ProovraSection>
  );
}
