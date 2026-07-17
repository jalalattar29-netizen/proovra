"use client";

/**
 * Workspace closure card (lifecycle Phase 7, 2026-07-17).
 *
 * Workspace-OWNER-only lifecycle surface: typed confirmation phrase
 * validated server-side, step-up, stable-code blockers, 7-day
 * cancellation window, honest collaboration-consequence copy (how many
 * members lose access). Frontend visibility is NOT authorization — the
 * backend re-checks team.ownerUserId + step-up on every call.
 */

import { useCallback, useEffect, useState } from "react";

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
      try {
        await apiFetch(`/v1/teams/${teamId}/closure/${requestId}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
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
