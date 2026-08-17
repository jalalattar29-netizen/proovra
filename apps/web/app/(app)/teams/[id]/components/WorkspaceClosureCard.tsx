"use client";

/**
 * Workspace closure card (lifecycle Phase 7, 2026-07-17).
 *
 * Workspace-OWNER-only lifecycle surface: typed confirmation phrase
 * validated server-side, step-up, stable-code blockers, 7-day
 * cancellation window, honest collaboration-consequence copy (how many
 * members lose access). Frontend visibility is NOT authorization — the
 * backend re-checks team.ownerUserId + step-up on every call.
 *
 * PHASE 13 — the REVERSE leg is wired here too:
 *
 *   POST /v1/teams/:id/reopen  (services/api/src/routes/teams.routes.ts:3164)
 *
 * A completed closure was a one-way door in the product even though the
 * service (reopenClosedWorkspace) has always been able to undo it. The
 * control appears only where it can work — when this card's own read says
 * the latest closure request COMPLETED — and states plainly what reopening
 * does NOT bring back.
 *
 *   200  { reopened: { teamId } }
 *   403  owner_required | NOT_WORKSPACE_OWNER
 *   404  TEAM_NOT_FOUND
 *   409  CLOSURE_IN_PROGRESS | WORKSPACE_NOT_CLOSED
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDate } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import {
  StepUpVerify,
  extractStepUp,
  type StepUpMethods,
  type StepUpProof,
} from "../../../security-center/components/PersonalSecuritySections";

type ClosureBlocker = { code: string; message: string; count: number };

type ClosureRequestRow = {
  id: string;
  status: string;
  blockersJson: string | null;
  requestedAtUtc: string;
  coolingOffEndsAtUtc: string | null;
  failureCode: string | null;
};

type ClosureState = {
  request: ClosureRequestRow | null;
  blockers: ClosureBlocker[];
  confirmationPhrase: string;
  coolingOffDays: number;
  membersLosingAccess: number;
};

const STATUS_LABEL: Record<string, string> = {
  BLOCKED: "Blocked — action needed",
  COOLING_OFF: "Scheduled — cancellation window open",
  SCHEDULED: "Scheduled",
  PROCESSING: "Closing…",
  COMPLETED: "Closed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

export function WorkspaceClosureCard({ teamId }: { teamId: string }) {
  const [state, setState] = useState<ClosureState | null>(null);
  const [phrase, setPhrase] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");
  /**
   * PHASE 13 (NEW-048) — the closure legs announce their outcome.
   *
   * Requesting and cancelling a closure both changed durable state and told a
   * screen-reader user nothing: the request outcome re-rendered a plain `div`
   * with no role, and CANCELLING rendered no confirmation AT ALL — the card
   * simply returned to its initial state, so a sighted user could not tell the
   * cancellation had landed either. The reopen leg below already does this
   * correctly, which is what makes the other two an omission rather than a
   * house style.
   */
  const [closureNotice, setClosureNotice] = useState<string | null>(null);
  // PHASE 13 — reopen leg.
  const [reopenBusy, setReopenBusy] = useState(false);
  const [reopenNotice, setReopenNotice] = useState<string | null>(null);
  const [reopenError, setReopenError] = useState<string | null>(null);

  // Stale-response protection: a response is applied only when it belongs to
  // the newest request AND this card is still mounted.
  const mountedRef = useRef(true);
  const reopenSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = (await apiFetch(`/v1/teams/${teamId}/closure`)) as ClosureState;
      setState(res);
    } catch {
      // Non-owners get 403 — render nothing rather than a fake control.
      setState(null);
    }
  }, [teamId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const requestClosure = useCallback(
    async (proof?: StepUpProof) => {
      setBusy(true);
      setError(null);
      setClosureNotice(null);
      try {
        await apiFetch(`/v1/teams/${teamId}/closure`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmation: phrase,
            ...(proof ? { stepUp: proof } : {}),
          }),
        });
        setStepUpOpen(false);
        setShowForm(false);
        setPhrase("");
        setClosureNotice("Closure requested. The cancellation window is now open.");
        await reload();
      } catch (err) {
        const su = extractStepUp(err);
        if (su) {
          setStepUpOpen(true);
          setStepUpMethods(su.methods);
          setStepUpMsg(su.message);
          return;
        }
        const e = err as { body?: { error?: { code?: string; message?: string } } };
        const code = e.body?.error?.code;
        if (code === "closure_blocked") {
          setError("Closure is blocked — resolve the listed items and try again.");
          await reload();
        } else if (code === "confirmation_mismatch") {
          setError(e.body?.error?.message ?? "The confirmation phrase does not match.");
        } else if (code === "closure_request_active") {
          setError("A closure request for this workspace is already open.");
          await reload();
        } else {
          setError(
            toSafeUserError(err, { message: "Could not request closure." }).message,
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [teamId, phrase, reload],
  );

  const cancelClosure = useCallback(
    async (requestId: string) => {
      setBusy(true);
      setError(null);
      setClosureNotice(null);
      try {
        await apiFetch(`/v1/teams/${teamId}/closure/${requestId}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        setClosureNotice("Closure request cancelled. This workspace stays open.");
        await reload();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Could not cancel the request." }).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [teamId, reload],
  );

  const reopenWorkspace = useCallback(async () => {
    setReopenBusy(true);
    setReopenError(null);
    setReopenNotice(null);
    const seq = ++reopenSeqRef.current;
    try {
      await apiFetch(`/v1/teams/${teamId}/reopen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!mountedRef.current || seq !== reopenSeqRef.current) return;
      setReopenNotice(
        "Workspace reopened. Your owner access is back; other members, API credentials and webhooks stay revoked until you restore them explicitly.",
      );
      await reload();
    } catch (err) {
      if (!mountedRef.current || seq !== reopenSeqRef.current) return;
      const status = (err as { statusCode?: number }).statusCode ?? 0;
      if (status === 403) {
        setReopenError(
          "You don't have permission to reopen this workspace. Only its owner can.",
        );
      } else if (status === 404) {
        setReopenError("This workspace no longer exists.");
      } else if (status === 409) {
        setReopenError(
          "There is nothing to reopen: either a closure request is still open — cancel that instead — or this workspace was never closed.",
        );
        await reload();
      } else {
        setReopenError(
          toSafeUserError(err, {
            message: "Could not reopen this workspace. Nothing was changed.",
          }).message,
        );
      }
    } finally {
      if (mountedRef.current && seq === reopenSeqRef.current) setReopenBusy(false);
    }
  }, [teamId, reload]);

  if (state === null) return null;

  const req = state.request;
  const open =
    req !== null &&
    ["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED", "PROCESSING"].includes(
      req.status,
    );
  const phraseExpected = state.confirmationPhrase;
  const muted: React.CSSProperties = { color: "#6a777b", fontSize: 13 };

  return (
    <Card
      className="team-card rounded-[30px] border p-6"
      data-workspace-closure-card
    >
      <div className="team-card-header">
        <div className="team-card-title">Close workspace</div>
        <div className="team-card-copy">
          Archives access to this workspace after a {state.coolingOffDays}-day
          cancellation window.{" "}
          {state.membersLosingAccess > 0
            ? `${state.membersLosingAccess} other member${
                state.membersLosingAccess === 1 ? "" : "s"
              } will lose access. `
            : ""}
          Evidence is never deleted by workspace closure — it stays governed
          by retention and legal-hold rules.
        </div>
      </div>

      {/*
        PHASE 13 (NEW-048) — the outcome region, rendered OUTSIDE the
        open/closed branch below.
        Placing it inside would have reintroduced the defect it fixes:
        cancelling flips `open` to false, so a notice living in the open branch
        would unmount at the exact moment it had something to say. This region
        survives the transition, which is why a cancellation can be announced
        at all.
      */}
      {closureNotice ? (
        <div
          role="status"
          aria-live="polite"
          data-workspace-closure-notice
          style={{ ...muted, color: "#21353a", marginTop: 10 }}
        >
          {closureNotice}
        </div>
      ) : null}

      {open && req ? (
        <div data-workspace-closure-status={req.status} style={{ marginTop: 10 }}>
          <p style={{ ...muted, color: "#21353a", margin: 0 }}>
            {STATUS_LABEL[req.status] ?? req.status}
            {req.status === "COOLING_OFF" && req.coolingOffEndsAtUtc
              ? ` — closes after ${formatUserDate(req.coolingOffEndsAtUtc)} unless cancelled.`
              : ""}
          </p>
          {req.status === "BLOCKED" && req.blockersJson ? (
            <ul style={{ ...muted, margin: "6px 0 0", paddingLeft: 18 }}>
              {(JSON.parse(req.blockersJson) as ClosureBlocker[]).map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : null}
          {["REQUESTED", "BLOCKED", "COOLING_OFF", "SCHEDULED"].includes(req.status) ? (
            <div style={{ marginTop: 10 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void cancelClosure(req.id)}
                loading={busy}
                disabled={busy}
                data-action="cancel-workspace-closure"
              >
                Cancel closure request
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {state.blockers.length > 0 ? (
            <ul
              data-workspace-closure-blockers
              style={{ ...muted, margin: "10px 0 0", paddingLeft: 18 }}
            >
              {state.blockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : null}
          {!showForm ? (
            <div style={{ marginTop: 10 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowForm(true)}
                disabled={busy}
                data-action="open-workspace-closure"
              >
                Close this workspace…
              </Button>
            </div>
          ) : (
            <div style={{ marginTop: 10 }} data-workspace-closure-form>
              <label
                htmlFor="workspace-closure-confirm"
                style={{ ...muted, display: "block", marginBottom: 6 }}
              >
                Type <strong>{phraseExpected}</strong> to confirm.
              </label>
              <input
                id="workspace-closure-confirm"
                type="text"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
                style={{
                  fontSize: 13,
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(15,23,42,0.15)",
                  width: "100%",
                  maxWidth: 340,
                }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void requestClosure()}
                  loading={busy}
                  disabled={busy || phrase.trim().toLowerCase() !== phraseExpected}
                  data-action="request-workspace-closure"
                >
                  Request closure
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowForm(false);
                    setPhrase("");
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Keep this workspace
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* PHASE 13 — reopen. Rendered only when this card's own read says the
          workspace is actually closed, so the control can always work. */}
      {!open && req && req.status === "COMPLETED" ? (
        <div
          data-workspace-reopen
          aria-busy={reopenBusy}
          style={{ marginTop: 12, borderTop: "1px solid rgba(15,23,42,0.08)", paddingTop: 12 }}
        >
          <div style={{ ...muted, color: "#21353a", fontWeight: 600 }}>
            Reopen this workspace
          </div>
          <p style={{ ...muted, margin: "4px 0 0" }}>
            Restores your owner access so you can work in it again. Other
            members, API credentials and webhooks are NOT restored — re-invite
            people and re-issue credentials deliberately.
          </p>
          <div style={{ marginTop: 10 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void reopenWorkspace()}
              loading={reopenBusy}
              disabled={reopenBusy}
              data-action="reopen-workspace"
            >
              Reopen workspace
            </Button>
          </div>
          <div
            role="status"
            aria-live="polite"
            data-workspace-reopen-status
            style={{ ...muted, marginTop: 8, color: reopenError ? "#8f1d16" : "#6a777b" }}
          >
            {reopenBusy
              ? "Reopening…"
              : reopenError
                ? reopenError
                : reopenNotice
                  ? reopenNotice
                  : ""}
          </div>
        </div>
      ) : null}

      {stepUpOpen ? (
        <StepUpVerify
          title="Confirm closing this workspace."
          methods={stepUpMethods}
          initialError={stepUpMsg}
          busy={busy}
          onSubmit={(proof) => void requestClosure(proof)}
          onCancel={() => {
            setStepUpOpen(false);
            setStepUpMsg("");
          }}
        />
      ) : null}

      {error ? (
        <div
          role="alert"
          // PHASE 13 (NEW-048): `role="alert"` carries an implicit assertive
          // live region in most implementations, but not all announce a region
          // that MOUNTS with content already in it. Stating it removes the
          // dependence on that behaviour.
          aria-live="assertive"
          data-workspace-closure-error
          style={{
            marginTop: 10,
            borderRadius: 8,
            border: "1px solid rgba(179,38,30,0.35)",
            background: "rgba(179,38,30,0.06)",
            color: "#8f1d16",
            padding: "8px 12px",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      ) : null}
    </Card>
  );
}
