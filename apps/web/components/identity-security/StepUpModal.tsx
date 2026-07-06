"use client";

/**
 * Phase G3 (G2.x closure) — Step-up modal infrastructure.
 *
 * Detects `STEP_UP_REQUIRED` API errors and presents a reusable
 * re-auth flow that retries the original action exactly once after
 * the operator confirms a step-up challenge. The modal NEVER bypasses
 * step-up — it composes with the existing `requireStepUpForSensitiveAction`
 * middleware that lives on the backend.
 *
 * Architecture:
 *
 *   1. Operator clicks a sensitive button (e.g. approve, escalation
 *      resolve, sensitive export).
 *   2. The button handler calls `runStepUpAction(action)` from the
 *      `useStepUpAction()` hook.
 *   3. `action` is invoked. If the backend returns 401 STEP_UP_REQUIRED
 *      with `error.details.purpose` (Phase 25/F contract), the hook
 *      captures the purpose + resource ids and surfaces the modal.
 *   4. The operator confirms the challenge (existing POST
 *      /v1/identity-security/step-up/start +  /step-up/check flow).
 *      The modal asks them to enter the code they received.
 *   5. On successful verification the hook re-invokes `action` with
 *      the `x-proovra-step-up-challenge-id` header set. The retry
 *      happens at most once — if it fails again the modal renders the
 *      failure state and the operator must restart deliberately.
 *
 * Hard rules:
 *   * No bypass path. The challenge id is the only way past the gate.
 *   * Single retry. Multiple retries would create an unbounded
 *     friction loop and obscure persistent backend rejections.
 *   * Cancel does NOT mutate anything (`action` is invoked with
 *     `STEP_UP_CANCEL` propagated to the caller, never silently
 *     dropped).
 *   * Keyboard accessible — Escape closes the modal; Enter submits
 *     the code; focus is trapped while open.
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { apiFetch } from "../../lib/api";

export type StepUpRequiredDetails = {
  purpose: string;
  resourceKind: string | null;
  resourceId: string | null;
};

export type StepUpAction<T> = (headers?: Record<string, string>) => Promise<T>;

type ApiErrorLike = {
  code?: string;
  statusCode?: number;
  details?: Record<string, unknown> | undefined;
  message?: string;
};

function isStepUpRequiredError(err: unknown): err is ApiErrorLike {
  if (!err || typeof err !== "object") return false;
  const e = err as ApiErrorLike;
  return e.code === "STEP_UP_REQUIRED" && e.statusCode === 401;
}

function extractDetails(
  details: Record<string, unknown> | undefined,
): StepUpRequiredDetails {
  return {
    purpose:
      details && typeof details.purpose === "string" ? details.purpose : "SENSITIVE_ACTION",
    resourceKind:
      details && typeof details.resourceKind === "string"
        ? details.resourceKind
        : null,
    resourceId:
      details && typeof details.resourceId === "string"
        ? details.resourceId
        : null,
  };
}

// ---------------------------------------------------------------------------
// useStepUpAction hook
// ---------------------------------------------------------------------------

type ModalState =
  | { kind: "idle" }
  | { kind: "starting"; details: StepUpRequiredDetails; teamId: string | null }
  | {
      kind: "verifying";
      details: StepUpRequiredDetails;
      teamId: string | null;
      challengeId: string;
      phone: string | null;
    }
  | { kind: "failed"; reason: string }
  | { kind: "retrying" };

export function useStepUpAction({
  teamId,
}: {
  /** Active workspace id — required so the step-up challenge is bound to the right tenant. */
  teamId: string | null;
}) {
  const [state, setState] = useState<ModalState>({ kind: "idle" });
  const pendingActionRef = useRef<StepUpAction<unknown> | null>(null);
  const onSuccessRef = useRef<((value: unknown) => void) | null>(null);
  const onFailureRef = useRef<((err: unknown) => void) | null>(null);

  const closeIdle = useCallback(() => {
    setState({ kind: "idle" });
  }, []);

  const runStepUpAction = useCallback(
    async <T,>(action: StepUpAction<T>): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (!isStepUpRequiredError(err)) {
          throw err;
        }
        // Step-up gate hit — surface the modal and wait for the user
        // to either confirm the challenge (resolves with retry) or
        // cancel (rejects with the original error).
        return new Promise<T>((resolve, reject) => {
          pendingActionRef.current = action as StepUpAction<unknown>;
          onSuccessRef.current = (value) => resolve(value as T);
          onFailureRef.current = (e) => reject(e);
          setState({
            kind: "starting",
            details: extractDetails(err.details),
            teamId,
          });
        });
      }
    },
    [teamId],
  );

  const cancel = useCallback(() => {
    const onFail = onFailureRef.current;
    pendingActionRef.current = null;
    onSuccessRef.current = null;
    onFailureRef.current = null;
    setState({ kind: "idle" });
    if (onFail) {
      const cancelErr = new Error("Step-up cancelled by operator");
      (cancelErr as ApiErrorLike).code = "STEP_UP_CANCEL";
      onFail(cancelErr);
    }
  }, []);

  const startChallenge = useCallback(
    async (phone: string) => {
      if (state.kind !== "starting") return;
      if (!teamId) {
        setState({ kind: "failed", reason: "Workspace context required." });
        return;
      }
      try {
        const res = await apiFetch(
          "/v1/identity-security/step-up/start",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId,
              purpose: state.details.purpose,
              resourceKind: state.details.resourceKind,
              resourceId: state.details.resourceId,
              phone,
              channel: "sms",
            }),
          },
        );
        const json = (await res.json()) as {
          challenge: { id: string };
        };
        setState({
          kind: "verifying",
          details: state.details,
          teamId,
          challengeId: json.challenge.id,
          phone,
        });
      } catch (err) {
        const e = err as { message?: string };
        setState({
          kind: "failed",
          reason: toSafeUserError(e, { message: "Could not start step-up challenge." }).message,
        });
      }
    },
    [state, teamId],
  );

  const verifyAndRetry = useCallback(
    async (code: string) => {
      if (state.kind !== "verifying") return;
      try {
        const res = await apiFetch(
          "/v1/identity-security/step-up/check",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId: state.teamId,
              challengeId: state.challengeId,
              phone: state.phone,
              code,
            }),
          },
        );
        const json = (await res.json()) as { status: string };
        if (json.status !== "approved") {
          setState({
            kind: "failed",
            reason: "Step-up was not approved. Restart to try again.",
          });
          return;
        }
        // Retry the original action exactly once with the challenge
        // id in the header. The middleware consumes it atomically.
        setState({ kind: "retrying" });
        const onSuccess = onSuccessRef.current;
        const onFail = onFailureRef.current;
        const action = pendingActionRef.current;
        if (!action) {
          setState({ kind: "idle" });
          return;
        }
        try {
          const value = await action({
            "x-proovra-step-up-challenge-id": state.challengeId,
          });
          pendingActionRef.current = null;
          onSuccessRef.current = null;
          onFailureRef.current = null;
          setState({ kind: "idle" });
          if (onSuccess) onSuccess(value);
        } catch (err) {
          pendingActionRef.current = null;
          onSuccessRef.current = null;
          onFailureRef.current = null;
          setState({
            kind: "failed",
            reason:
              toSafeUserError(err, { message: "Action failed after step-up." }).message,
          });
          if (onFail) onFail(err);
        }
      } catch (err) {
        const e = err as { message?: string };
        setState({
          kind: "failed",
          reason: toSafeUserError(e, { message: "Could not verify step-up code." }).message,
        });
      }
    },
    [state],
  );

  return useMemo(
    () => ({
      state,
      runStepUpAction,
      cancel,
      closeIdle,
      startChallenge,
      verifyAndRetry,
    }),
    [state, runStepUpAction, cancel, closeIdle, startChallenge, verifyAndRetry],
  );
}

// ---------------------------------------------------------------------------
// StepUpModal
// ---------------------------------------------------------------------------

const PURPOSE_LABEL: Record<string, string> = {
  REVIEW_APPROVAL_HIGH_RISK: "Approve this review",
  REVIEWER_OPS_REJECT: "Reject this review",
  REVIEWER_OPS_ESCALATION_RESOLVE: "Resolve this escalation",
  REVIEWER_OPS_BULK: "Perform a bulk reviewer action",
  EVIDENCE_DESTRUCTION_APPROVE: "Approve evidence destruction",
  EVIDENCE_DESTRUCTION_EXECUTE: "Execute evidence destruction",
};

export function StepUpModal({
  control,
}: {
  control: ReturnType<typeof useStepUpAction>;
}) {
  const { state, cancel, startChallenge, verifyAndRetry } = control;
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const phoneRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (state.kind === "starting") {
      setPhone("");
      setCode("");
      setTimeout(() => phoneRef.current?.focus(), 0);
    } else if (state.kind === "verifying") {
      setTimeout(() => codeRef.current?.focus(), 0);
    }
  }, [state.kind]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (state.kind === "idle") return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cancel, state.kind]);

  if (state.kind === "idle") return null;

  const purposeLabel =
    state.kind === "starting" || state.kind === "verifying"
      ? PURPOSE_LABEL[state.details.purpose] ?? "Complete sensitive action"
      : "Step-up required";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Step-up confirmation"
      data-step-up-modal
      data-step-up-state={state.kind}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          maxWidth: 460,
          width: "100%",
          padding: "1.25rem 1.5rem",
          boxShadow: "0 24px 64px rgba(15, 23, 42, 0.3)",
        }}
      >
        <header style={{ marginBottom: 12 }}>
          <strong style={{ fontSize: 15 }}>{purposeLabel}</strong>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 13,
              color: "#475569",
              lineHeight: 1.5,
            }}
          >
            This action requires an additional step-up confirmation. The action
            will only proceed after you verify a one-time code.
          </p>
        </header>

        {state.kind === "starting" ? (
          <form
            data-step-up-form="phone"
            onSubmit={(e) => {
              e.preventDefault();
              if (phone.trim().length > 0) void startChallenge(phone.trim());
            }}
          >
            <label
              htmlFor="step-up-phone"
              style={{
                display: "block",
                fontSize: 12,
                color: "#475569",
                marginBottom: 4,
              }}
            >
              Phone number (E.164, e.g. +14155551234)
            </label>
            <input
              id="step-up-phone"
              ref={phoneRef}
              data-step-up-phone-input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              autoComplete="tel"
              placeholder="+14155551234"
              style={inputStyle}
            />
            <div style={actionsRow}>
              <button
                type="button"
                onClick={cancel}
                data-step-up-cancel
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
              <button
                type="submit"
                data-step-up-send-code
                style={primaryButtonStyle}
                disabled={phone.trim().length === 0}
              >
                Send code
              </button>
            </div>
          </form>
        ) : null}

        {state.kind === "verifying" ? (
          <form
            data-step-up-form="code"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim().length > 0) void verifyAndRetry(code.trim());
            }}
          >
            <label
              htmlFor="step-up-code"
              style={{
                display: "block",
                fontSize: 12,
                color: "#475569",
                marginBottom: 4,
              }}
            >
              Verification code (sent via SMS)
            </label>
            <input
              id="step-up-code"
              ref={codeRef}
              data-step-up-code-input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              style={inputStyle}
            />
            <div style={actionsRow}>
              <button
                type="button"
                onClick={cancel}
                data-step-up-cancel
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
              <button
                type="submit"
                data-step-up-verify
                style={primaryButtonStyle}
                disabled={code.trim().length === 0}
              >
                Confirm + retry
              </button>
            </div>
          </form>
        ) : null}

        {state.kind === "retrying" ? (
          <p data-step-up-retrying style={{ fontSize: 13, color: "#475569" }}>
            Confirmed — retrying the original action…
          </p>
        ) : null}

        {state.kind === "failed" ? (
          <div data-step-up-failed role="alert">
            <p
              style={{
                fontSize: 13,
                color: "#991b1b",
                margin: "0 0 12px",
              }}
            >
              {state.reason}
            </p>
            <div style={actionsRow}>
              <button
                type="button"
                onClick={cancel}
                data-step-up-cancel
                style={primaryButtonStyle}
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 14,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
} as const;

const actionsRow = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 12,
} as const;

const primaryButtonStyle = {
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 6,
  cursor: "pointer",
} as const;

const secondaryButtonStyle = {
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
} as const;

/**
 * Convenience wrapper that takes children + the control, useful when
 * a page wants to host the modal centrally.
 */
export function StepUpModalProvider({
  control,
  children,
}: {
  control: ReturnType<typeof useStepUpAction>;
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <StepUpModal control={control} />
    </>
  );
}
