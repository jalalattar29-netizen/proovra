"use client";

/**
 * OPERATIONS ASSIGNMENT CONTROL (Attention Architecture closure pass).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `OPERATIONS_ASSIGN` was granted, `POST /v1/ops/incidents/:id/assign` was
 * implemented and audited, and `assignedOperatorUserId` was persisted — and
 * there was no control anywhere in the product. The capability was a promise
 * nothing could keep.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not render a person picker where there are no people. In a
 * single-operator workspace the server grants no `OPERATIONS_ASSIGN`, so the
 * console never mounts this — and even if it did, the eligible-operator list
 * would contain only the caller, and "assign this to yourself" is not a
 * decision worth a dialog. That behaviour falls out of the capability and the
 * resolver; there is no plan branch here and no `isPersonal` check.
 *
 * ---------------------------------------------------------------------------
 * ACCESSIBILITY
 * ---------------------------------------------------------------------------
 * A native `<select>` over a custom listbox, deliberately: it is keyboard
 * operable, screen-reader announced and mobile-native for free, and the
 * repository's own vocabulary test bans reinventing one. The current owner is
 * announced as text, not colour. Busy and error states are announced through
 * `role="status"` / `role="alert"` rather than only shown.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { Button } from "../ui/Button";

export type AssignableOperator = {
  userId: string;
  displayName: string | null;
  email: string | null;
  role: string;
};

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; operators: AssignableOperator[]; selfUserId: string }
  | { kind: "error"; message: string };

function operatorLabel(operator: AssignableOperator): string {
  const name = operator.displayName?.trim() || operator.email?.trim() || operator.userId.slice(0, 8);
  return `${name} · ${operator.role}`;
}

export function IncidentAssignmentControl({
  incidentId,
  teamId,
  assignedOperatorUserId,
  canAssign,
  busy,
  onAssigned,
}: {
  incidentId: string;
  teamId: string;
  assignedOperatorUserId: string | null;
  /** Resolved server-side. Presentation only — the server re-checks. */
  canAssign: boolean;
  busy: boolean;
  onAssigned: () => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The eligible set is fetched ONCE per workspace, on first interaction —
  // not per row. A console showing fifty conditions must not make fifty
  // identical membership queries.
  const loadOperators = useCallback(async () => {
    if (state.kind === "ready" || state.kind === "loading") return;
    setState({ kind: "loading" });
    try {
      const res = (await apiFetch(
        `/v1/ops/assignable-operators?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { operators: AssignableOperator[]; selfUserId: string };
      setState({
        kind: "ready",
        operators: res.operators ?? [],
        selfUserId: res.selfUserId,
      });
    } catch (err) {
      setState({
        kind: "error",
        message: toSafeUserError(err, {
          message: "Could not load the people who can take this.",
        }).message,
      });
    }
  }, [state.kind, teamId]);

  useEffect(() => {
    if (!canAssign) return;
    void loadOperators();
  }, [canAssign, loadOperators]);

  const assign = useCallback(
    async (assigneeUserId: string | null) => {
      if (pending || busy) return;
      setPending(true);
      setError(null);
      try {
        await apiFetch(
          `/v1/ops/incidents/${encodeURIComponent(incidentId)}/assign`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            // null is UNASSIGN — the same route, because it is the same
            // column and the same authorization decision.
            body: JSON.stringify({ teamId, assigneeUserId }),
          },
        );
        onAssigned();
      } catch (err) {
        setError(
          toSafeUserError(err, {
            message: "Could not change who owns this.",
          }).message,
        );
      } finally {
        setPending(false);
      }
    },
    [busy, incidentId, onAssigned, pending, teamId],
  );

  const operators = state.kind === "ready" ? state.operators : [];
  const selfUserId = state.kind === "ready" ? state.selfUserId : null;
  const current = operators.find((o) => o.userId === assignedOperatorUserId);

  // ---------------------------------------------------------------------
  // READ-ONLY. A viewer may see WHO owns a condition — that is part of
  // understanding the workspace — and may not change it.
  // ---------------------------------------------------------------------
  if (!canAssign) {
    return (
      <span data-ops-assignee-readonly data-assigned={assignedOperatorUserId ? "true" : "false"}>
        {assignedOperatorUserId
          ? `Owner: ${current ? operatorLabel(current) : assignedOperatorUserId.slice(0, 8)}`
          : "Unassigned"}
      </span>
    );
  }

  const disabled = pending || busy || state.kind === "loading";

  return (
    <span data-ops-assignment-control className="ops-assignment">
      <label className="ops-assignment__label" htmlFor={`assign-${incidentId}`}>
        {/* The label names BOTH the action and the condition, so a screen
            reader announcing it out of context still identifies which row
            is being changed. */}
        <span className="ops-visually-hidden">
          Assign this condition to an operator
        </span>
        <span aria-hidden="true">Owner</span>
      </label>

      <select
        id={`assign-${incidentId}`}
        className="ops-assignment__select"
        data-ops-assignment-select
        value={assignedOperatorUserId ?? ""}
        disabled={disabled}
        onFocus={() => void loadOperators()}
        onChange={(e) => void assign(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">Unassigned</option>
        {operators.map((operator) => (
          <option key={operator.userId} value={operator.userId}>
            {operatorLabel(operator)}
          </option>
        ))}
      </select>

      {/* Self-assign is the single most common action on a triage surface and
          deserves one click rather than a search. Hidden when the caller
          already owns it, because a button that does nothing is worse than
          no button. */}
      {selfUserId && assignedOperatorUserId !== selfUserId ? (
        <Button
          size="sm"
          variant="secondary"
          data-ops-action="self-assign"
          disabled={disabled}
          onClick={() => void assign(selfUserId)}
        >
          Take it
        </Button>
      ) : null}

      {assignedOperatorUserId ? (
        <Button
          size="sm"
          variant="ghost"
          data-ops-action="unassign"
          disabled={disabled}
          onClick={() => void assign(null)}
        >
          Unassign
        </Button>
      ) : null}

      {pending ? (
        <span role="status" data-ops-assignment-busy>
          Saving…
        </span>
      ) : null}
      {state.kind === "error" ? (
        <span role="alert" data-ops-assignment-error>
          {state.message}
        </span>
      ) : null}
      {error ? (
        <span role="alert" data-ops-assignment-error>
          {error}
        </span>
      ) : null}
    </span>
  );
}
