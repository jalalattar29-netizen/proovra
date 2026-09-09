"use client";

/**
 * CREATE ASSIGNMENT — the team's ONE assignment-creation implementation.
 *
 * It lived inside `AssignmentsTab`, private to it, which meant the Work tab
 * was the only place in the product that could delegate anything: an operator
 * reading a team's Overview or Members had to find the Work tab first. The
 * obvious repair — a second button in the team header with its own dialog —
 * would have produced two forms, two payloads and two places for the target
 * contract to drift, so the dialog moved OUT instead.
 *
 * The team detail page owns the open state and renders exactly one of these.
 * Both entry points — the Work tab's button and the header's — call the same
 * opener, so there is one component, one `createAssignment` call and one set
 * of validation rules. Neither entry point carries permission logic of its
 * own: the page computes `canAssign` once (role AND lifecycle, so an archived
 * team resolves both away together) and the server re-derives it regardless.
 */

import { useEffect, useState } from "react";

import { useToast } from "../../../../../components/ui";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import {
  AppSearchSelect,
  type AppSearchSelectOption,
} from "../../../../../components/app-primitives/AppSearchSelect";
import { ApiError } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import {
  ASSIGNEE_TEAM_LEVEL_LABEL,
  type AssignableTarget,
  type CollaborationTeamDetail,
  createAssignment,
  listAssignableTargets,
} from "../../../../../lib/api/collaboration-teams";
import {
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  type CollaborationTeamAssignmentPriority,
  type CollaborationTeamAssignmentTarget,
} from "@proovra/shared";

import { memberLabel, priorityLabel, targetLabel } from "./assignment-vocabulary";

/** The picker speaks in options; the API speaks in targets. One translation. */
function toOption(target: AssignableTarget): AppSearchSelectOption {
  return {
    id: target.id,
    label: target.label,
    sublabel: target.sublabel,
    status: target.status,
  };
}

export function CreateAssignmentModal({
  team,
  onClose,
  onCreated,
}: {
  team: CollaborationTeamDetail;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const { addToast } = useToast();
  const [targetType, setTargetType] =
    useState<CollaborationTeamAssignmentTarget>("CASE");
  /*
   * THE WHOLE RECORD, NOT JUST ITS ID.
   *
   * The id alone was the defect. The results list is the server's answer to
   * the current query, so the chosen record routinely is not in it — and a
   * field that renders its label by looking the id up in `options` shows
   * nothing the moment the query moves on. Holding the record means the field
   * can state what was chosen, and `targetId` below is derived from it rather
   * than tracked in parallel with it.
   */
  const [selectedTarget, setSelectedTarget] =
    useState<AppSearchSelectOption | null>(null);
  const targetId = selectedTarget?.id ?? "";
  const [targetSearch, setTargetSearch] = useState("");
  const [targetOptions, setTargetOptions] = useState<
    ReadonlyArray<AppSearchSelectOption>
  >([]);
  const [targetsLoading, setTargetsLoading] = useState(false);

  // Debounced so a keystroke is not a request. The FIRST load is immediate
  // because the field opens on focus and an empty list under a fresh field
  // reads as "there is nothing", not as "still loading".
  useEffect(() => {
    let cancelled = false;
    setTargetsLoading(true);
    const handle = setTimeout(() => {
      void listAssignableTargets(team.id, targetType, { search: targetSearch })
        .then((res) => {
          if (!cancelled) setTargetOptions(res.targets.map(toOption));
        })
        .catch(() => {
          if (!cancelled) setTargetOptions([]);
        })
        .finally(() => {
          if (!cancelled) setTargetsLoading(false);
        });
    }, targetSearch ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [team.id, targetType, targetSearch]);

  // An id from one kind is meaningless for another, so changing the kind
  // clears the choice rather than carrying a case id into an evidence
  // assignment.
  useEffect(() => {
    setSelectedTarget(null);
    setTargetSearch("");
  }, [targetType]);

  const [assigneeUserId, setAssigneeUserId] = useState<string>("");
  const [priority, setPriority] =
    useState<CollaborationTeamAssignmentPriority>("NORMAL");
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetId || busy) return;
    setBusy(true);
    try {
      await createAssignment(team.id, {
        targetType,
        targetId,
        assigneeUserId: assigneeUserId || null,
        priority,
        dueAtUtc: dueAt ? new Date(dueAt).toISOString() : null,
        note: note || null,
      });
      await onCreated();
    } catch (err) {
      if (err instanceof ApiError) {
        notifyApiError(addToast, err);
      } else {
        addToast("Couldn't create assignment.", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const targetTypeOptions = COLLABORATION_TEAM_ASSIGNMENT_TARGETS.map((t) => ({
    value: t,
    label: targetLabel(t),
  }));

  const assigneeOptions = [
    { value: "", label: ASSIGNEE_TEAM_LEVEL_LABEL },
    ...team.members
      .filter((m) => m.status === "ACTIVE")
      .map((m) => ({
        value: m.userId,
        label: memberLabel(m),
        description: m.user.email ?? undefined,
      })),
  ];

  const priorityOptions = COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.map((p) => ({
    value: p,
    label: priorityLabel(p),
  }));

  const kind = targetLabel(targetType);

  return (
    <div
      role="presentation"
      className="app-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        data-testid="create-assignment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-assignment-title"
        className="app-dialog"
      >
        <div className="app-dialog__head">
          <div>
            <h2 id="create-assignment-title" className="app-dialog__title">
              Create assignment
            </h2>
            <p className="app-dialog__subtitle">
              Delegate a case, evidence item, or evidence review to a teammate
              or to the team.
            </p>
          </div>
        </div>

        <div className="app-dialog__body">
          <div data-testid="assignment-target-type">
            <label className="app-field-label" id="assignment-target-type-label">
              Target type
            </label>
            <AppListbox
              value={targetType}
              options={targetTypeOptions}
              onChange={(v) =>
                setTargetType(v as CollaborationTeamAssignmentTarget)
              }
              ariaLabelledby="assignment-target-type-label"
              id="assignment-target-type"
            />
          </div>

          <div>
            <label
              className="app-field-label"
              htmlFor="assignment-target-search"
            >
              {kind}
            </label>
            {/*
              A PICKER, NOT A PASTE BOX — AND NOW ONE THAT SHOWS ITS ANSWER.

              This began as a uuid the operator had to copy out of another
              page's URL. It became a search box over a list of the workspace's
              own records, which was the right shape and the wrong build: the
              rows carried class names no stylesheet defined, so choosing a
              case changed nothing anybody could see, and the list was a
              sibling inside the scrolling dialog body, so it was clipped.

              `AppSearchSelect` is that pattern built once, in shared UI. The
              value submitted is still chosen rather than transcribed; what is
              new is that the field says which record was chosen, the menu
              closes when it is, and the whole thing works from the keyboard.
            */}
            <AppSearchSelect
              id="assignment-target-search"
              testid="assignment-target-search"
              selected={selectedTarget}
              onSelect={setSelectedTarget}
              search={targetSearch}
              onSearchChange={setTargetSearch}
              options={targetOptions}
              loading={targetsLoading}
              placeholder={`Search ${kind.toLowerCase()}s in this workspace`}
              emptyLabel={`No ${kind.toLowerCase()}s in this workspace match that.`}
              ariaLabel={`${kind} to assign`}
            />
            <p className="app-field-help">
              {selectedTarget ? (
                <>
                  Assigning{" "}
                  <strong data-testid="assignment-target-selected">
                    {selectedTarget.label}
                  </strong>
                  . Search again to choose a different {kind.toLowerCase()}.
                </>
              ) : (
                `Choose the ${kind.toLowerCase()} this team becomes responsible for.`
              )}
            </p>
            {/*
              The chosen id, where an end-to-end probe can read it. The payload
              is built from the same `selectedTarget`, so this cannot report a
              selection the submit would not send.
            */}
            <input
              type="hidden"
              name="targetId"
              value={targetId}
              data-testid="assignment-target-id"
            />
          </div>

          <div data-testid="assignment-assignee">
            <label className="app-field-label" id="assignment-assignee-label">
              Assignee
            </label>
            <AppListbox
              value={assigneeUserId}
              options={assigneeOptions}
              onChange={(v) => setAssigneeUserId(v)}
              ariaLabelledby="assignment-assignee-label"
              id="assignment-assignee"
              placeholder={ASSIGNEE_TEAM_LEVEL_LABEL}
            />
          </div>

          <div data-testid="assignment-priority">
            <label className="app-field-label" id="assignment-priority-label">
              Priority
            </label>
            <AppListbox
              value={priority}
              options={priorityOptions}
              onChange={(v) =>
                setPriority(v as CollaborationTeamAssignmentPriority)
              }
              ariaLabelledby="assignment-priority-label"
              id="assignment-priority"
            />
          </div>

          <div>
            <label className="app-field-label" htmlFor="assignment-due">
              Due date <span className="app-field-optional">(optional)</span>
            </label>
            <input
              id="assignment-due"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              data-testid="assignment-due"
              className="app-form-input"
            />
          </div>

          <div>
            <label className="app-field-label" htmlFor="assignment-note">
              Description <span className="app-field-optional">(optional)</span>
            </label>
            <textarea
              id="assignment-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={600}
              rows={3}
              data-testid="assignment-note"
              className="app-form-input"
              placeholder="Add context so the assignee knows what's expected."
            />
          </div>
        </div>

        <div className="app-dialog__footer">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="app-secondary-action"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!targetId || busy}
            className="app-primary-action"
            data-testid="assignment-submit"
          >
            {busy ? "Creating…" : "Create assignment"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default CreateAssignmentModal;
