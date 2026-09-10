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
      /**
       * PHASE 13 (NEW-058) — the MASK of the enrolled factor the code went to,
       * replacing the `phone` this state used to carry.
       *
       * The old field was the destination the OPERATOR typed, and it was sent
       * back to `/step-up/check` as if it were authoritative. It never was:
       * the whole defect NEW-058 closes is that a caller-chosen destination
       * proves possession of nothing. This is display-only — the server
       * re-resolves the destination from the factor the challenge was minted
       * against, and there is no route that would return the full value.
       */
      destinationMask: string | null;
      /**
       * PV-STEPUP-001 — which factor this challenge is answered with. The
       * server chooses (an authenticator app when the account has one, else
       * the enrolled phone) and says which, so the label never claims a code
       * was sent when none was.
       */
      method: StepUpMethod;
      /** A switch to the other factor was refused; shown beside the form. */
      notice: string | null;
    }
  | { kind: "enrollment_required" }
  | {
      kind: "failed";
      reason: string;
      /** Present when starting again can succeed (e.g. a rejected code). */
      restart: { details: StepUpRequiredDetails; teamId: string | null } | null;
    }
  | { kind: "retrying" };

export type StepUpMethod = "TOTP" | "SMS" | "WHATSAPP";

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

  /**
   * Start a challenge — on entry, or to SWITCH factor while one is in hand.
   *
   * PV-STEPUP-001 — the server chooses the factor (an authenticator app when
   * the account holds one, otherwise the enrolled phone), subject to the
   * purpose's factor policy, and answers WHICH, with the phone's mask when a
   * code was sent. The modal no longer pre-reads the contact-factor roster:
   * that roster knows nothing of authenticator apps, so it told an account
   * holding only TOTP that it had "no verified device" — the exact denial
   * PV-OD-011 retires. The server's `STEP_UP_ENROLLMENT_REQUIRED` is the
   * authority and the only source of that answer.
   *
   * The body never carries a destination (NEW-058): `channel` names a factor
   * KIND the account already holds, never a number, and is sent only when the
   * operator asked to switch.
   */
  const startChallenge = useCallback(
    async (preferred?: StepUpMethod) => {
      const previous = state.kind === "verifying" ? state : null;
      const from =
        state.kind === "starting"
          ? { details: state.details, teamId: state.teamId }
          : previous && preferred
            ? { details: previous.details, teamId: previous.teamId }
            : null;
      if (!from) return;
      if (!teamId) {
        setState({
          kind: "failed",
          reason: "Workspace context required.",
          restart: null,
        });
        return;
      }
      try {
        // `apiFetch` returns the PARSED body and throws on non-2xx.
        const json = (await apiFetch(
          "/v1/identity-security/step-up/start",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId,
              purpose: from.details.purpose,
              resourceKind: from.details.resourceKind,
              resourceId: from.details.resourceId,
              ...(preferred ? { channel: preferred } : {}),
            }),
          },
        )) as {
          challenge: { id: string };
          method?: StepUpMethod;
          destinationMask?: string | null;
        };
        setState({
          kind: "verifying",
          details: from.details,
          teamId,
          challengeId: json.challenge.id,
          method: json.method ?? "SMS",
          destinationMask:
            typeof json.destinationMask === "string"
              ? json.destinationMask
              : null,
          notice: null,
        });
      } catch (err) {
        const e = err as ApiErrorLike;
        // The server's stable, actionable denial for an account with no
        // second factor it can use here. It is deliberately NOT bucketed with
        // "that code was wrong": one means "set up a factor", the other means
        // "try again".
        const enrollment =
          e?.code === "STEP_UP_ENROLLMENT_REQUIRED" || e?.statusCode === 403;
        if (previous) {
          // A refused SWITCH leaves the challenge already in hand usable.
          setState({
            ...previous,
            notice: enrollment
              ? preferred === "TOTP"
                ? "This account has no authenticator app set up."
                : "This account has no verified phone set up."
              : toSafeUserError(e, {
                  message: "Could not switch verification method.",
                }).message,
          });
          return;
        }
        if (enrollment) {
          setState({ kind: "enrollment_required" });
          return;
        }
        setState({
          kind: "failed",
          reason: toSafeUserError(e, {
            message: "Could not start step-up challenge.",
          }).message,
          restart: null,
        });
      }
    },
    [state, teamId],
  );

  /** Start over after a refusal that another attempt can overcome. */
  const restart = useCallback(() => {
    if (state.kind !== "failed" || !state.restart) return;
    setState({
      kind: "starting",
      details: state.restart.details,
      teamId: state.restart.teamId,
    });
  }, [state]);

  const verifyAndRetry = useCallback(
    async (code: string) => {
      if (state.kind !== "verifying") return;
      const restartFrom = { details: state.details, teamId: state.teamId };
      // A rejected code is recoverable by starting again, so the failure
      // offers exactly that. An authenticator code is single-use: the likeliest
      // cause of a rejection straight after a sign-in is re-entering the code
      // that sign-in already spent.
      const rejected: ModalState = {
        kind: "failed",
        reason:
          state.method === "TOTP"
            ? "That code was not accepted. Each authenticator code works once — wait for the next one, then start again."
            : "That code was not accepted. Start again to receive a new code.",
        restart: restartFrom,
      };
      let json: { status: string };
      try {
        // Same contract as `startChallenge`: the parsed body IS the result.
        json = (await apiFetch(
          "/v1/identity-security/step-up/check",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              // PHASE 13 (NEW-058) — no `phone`. `CheckBody` is `.strict()`
              // and the destination is re-resolved from the factor the
              // challenge was minted against, so a caller cannot verify
              // against a different number than the one that was sent to.
              teamId: state.teamId,
              challengeId: state.challengeId,
              code,
            }),
          },
        )) as { status: string };
      } catch (err) {
        const e = err as ApiErrorLike;
        if (e?.statusCode === 400) {
          setState(rejected);
          return;
        }
        setState({
          kind: "failed",
          reason: toSafeUserError(e, {
            message: "Could not verify step-up code.",
          }).message,
          restart: restartFrom,
        });
        return;
      }
      if (json.status !== "approved") {
        setState(rejected);
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
          // The elevation was spent on this attempt; there is nothing to
          // restart from inside the modal.
          restart: null,
        });
        if (onFail) onFail(err);
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
      restart,
      verifyAndRetry,
    }),
    [
      state,
      runStepUpAction,
      cancel,
      closeIdle,
      startChallenge,
      restart,
      verifyAndRetry,
    ],
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
  GOVERNANCE_POLICY_UPDATE: "Change the workspace governance policy",
  // PHASE 12B CLUSTER 14 — department membership governance.
  DEPARTMENT_MEMBERSHIP_GRANT: "Grant this department membership",
  DEPARTMENT_MEMBERSHIP_REVOKE: "Revoke this department membership",
};

export function StepUpModal({
  control,
}: {
  control: ReturnType<typeof useStepUpAction>;
}) {
  const { state, cancel, startChallenge, restart, verifyAndRetry } = control;
  const [code, setCode] = useState("");
  const codeRef = useRef<HTMLInputElement | null>(null);
  /**
   * The challenge is started exactly once per entry into `starting`.
   *
   * `startChallenge` closes over `state`, so it changes identity on every
   * render — putting it in the dependency array would re-fire the effect and
   * mint a second challenge, burning the account's rate limit on a modal the
   * operator has not touched. The guard keys on the transition, not the
   * callback.
   */
  const startedRef = useRef(false);

  useEffect(() => {
    if (state.kind === "starting") {
      setCode("");
      if (!startedRef.current) {
        startedRef.current = true;
        void startChallenge();
      }
    } else if (state.kind === "verifying") {
      setTimeout(() => codeRef.current?.focus(), 0);
    }
    // Re-armed on every exit from `starting`, so "Start again" after a
    // rejected code (failed -> starting) mints exactly one new challenge.
    if (state.kind !== "starting") startedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

        {/*
         * PHASE 13 (NEW-058) — THERE IS NO DESTINATION FIELD HERE ANY MORE.
         *
         * This step used to ask the operator to type the number the code
         * should go to, which is the defect in one control: a challenge
         * answered on a handset the caller named proves possession of nothing,
         * so a stolen session supplied its own number and approved its own
         * elevation. The destination now comes from the account's enrolled
         * factor and the step is purely informational.
         */}
        {state.kind === "starting" ? (
          <div data-step-up-form="sending" role="status" aria-live="polite">
            <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>
              Preparing your verification…
            </p>
            <div style={actionsRow}>
              <button
                type="button"
                onClick={cancel}
                data-step-up-cancel
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {/*
         * The one denial that names its own remedy. Without this branch an
         * account with no enrolled factor sees a generic failure on every
         * step-up-gated operation and has no way to discover that enrolling a
         * device is what unblocks it.
         */}
        {state.kind === "enrollment_required" ? (
          <div data-step-up-enrollment-required>
            <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>
              This action needs a verified second factor — an authenticator
              app or a verified phone — and this account has neither yet. Set
              one up under{" "}
              <a href="/settings#security" data-step-up-enroll-link>
                Settings → Security
              </a>
              , then start this action again.
            </p>
            <div style={actionsRow}>
              <button
                type="button"
                onClick={cancel}
                data-step-up-cancel
                style={secondaryButtonStyle}
              >
                Close
              </button>
            </div>
          </div>
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
              {state.method === "TOTP"
                ? "Code from your authenticator app"
                : state.destinationMask
                  ? `Verification code (sent to ${state.destinationMask})`
                  : "Verification code (sent to your verified phone)"}
            </label>
            <input
              id="step-up-code"
              ref={codeRef}
              data-step-up-code-input
              data-step-up-method={state.method}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              style={inputStyle}
            />
            {/*
             * PV-STEPUP-001 — both factor kinds satisfy step-up, so the
             * operator can answer with whichever is at hand. A switch that
             * the account cannot make (nothing enrolled of that kind) keeps
             * the current challenge and says why.
             */}
            {state.notice ? (
              <p
                role="status"
                data-step-up-switch-notice
                style={{ margin: "8px 0 0", fontSize: 12, color: "#475569" }}
              >
                {state.notice}
              </p>
            ) : null}
            <button
              type="button"
              data-step-up-switch
              onClick={() =>
                void startChallenge(state.method === "TOTP" ? "SMS" : "TOTP")
              }
              style={switchButtonStyle}
            >
              {state.method === "TOTP"
                ? "Use a text message instead"
                : "Use an authenticator app instead"}
            </button>
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
                style={state.restart ? secondaryButtonStyle : primaryButtonStyle}
              >
                Close
              </button>
              {state.restart ? (
                <button
                  type="button"
                  onClick={restart}
                  data-step-up-restart
                  style={primaryButtonStyle}
                >
                  Start again
                </button>
              ) : null}
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

const switchButtonStyle = {
  marginTop: 8,
  padding: 0,
  fontSize: 12,
  color: "#1d4ed8",
  background: "none",
  border: 0,
  textDecoration: "underline",
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
