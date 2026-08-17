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
    }
  | { kind: "enrollment_required" }
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
    async () => {
      if (state.kind !== "starting") return;
      if (!teamId) {
        setState({ kind: "failed", reason: "Workspace context required." });
        return;
      }
      /**
       * PHASE 13 (NEW-058) — resolve the enrolled factor BEFORE minting a
       * challenge, for two reasons.
       *
       * The mask is the only thing this modal can honestly tell the operator
       * about where the code went, and an account with no ACTIVE factor cannot
       * elevate at all — so asking the server for a challenge it must refuse
       * would spend a rate-limit slot to reach a denial we can already name.
       * The server's own `STEP_UP_ENROLLMENT_REQUIRED` remains the authority;
       * this is the same answer, one round-trip earlier.
       */
      let destinationMask: string | null = null;
      try {
        const roster = (await apiFetch(
          "/v1/identity-security/contact-factors",
          { method: "GET" },
        )) as { factors?: Array<{ status?: string; destinationMask?: string }> };
        const active = Array.isArray(roster?.factors)
          ? roster.factors.find((f) => f?.status === "ACTIVE")
          : undefined;
        if (!active) {
          setState({ kind: "enrollment_required" });
          return;
        }
        destinationMask =
          typeof active.destinationMask === "string"
            ? active.destinationMask
            : null;
      } catch {
        // A roster we could not read is NOT proof of "no factor" — fall
        // through and let the server decide, which is the authority anyway.
        destinationMask = null;
      }
      try {
        // `apiFetch` returns the PARSED body and throws on non-2xx. It has no
        // `.json()` — calling one threw a TypeError that this catch reported as
        // "Could not start step-up challenge", so the flow could never begin.
        const json = (await apiFetch(
          "/v1/identity-security/step-up/start",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId,
              purpose: state.details.purpose,
              resourceKind: state.details.resourceKind,
              resourceId: state.details.resourceId,
              /**
               * PHASE 13 (NEW-058) — `phone` IS GONE FROM THIS BODY, AND ITS
               * ABSENCE IS THE FIX.
               *
               * `StartBody` is `.strict()` and no longer declares the field, so
               * a request that still carried it was rejected at validation —
               * which meant the step-up gate was unreachable from the product
               * for a SECOND reason on top of the one NEW-057 fixed. The
               * destination is now resolved server-side from the account's
               * ACTIVE, verified factor; there is nothing for a caller to
               * choose, which is exactly the property that makes an approved
               * challenge mean something.
               *
               * PHASE 13 (NEW-057) — the server's enum is UPPERCASE.
               *
               * This sent `"sms"`. `StartBody` declares
               * `z.enum(["SMS", "WHATSAPP"])`, and Zod does not case-fold an
               * enum, so every start request was rejected at validation and
               * this modal dropped straight to its failed state with "Could
               * not start step-up challenge."
               *
               * The blast radius is the whole step-up gate, not one surface:
               * evidence publication and withdrawal, reviewer approve/reject,
               * escalation resolve, bulk reviewer operations, evidence
               * destruction approve and execute, governance policy update, and
               * department membership grant/revoke are ALL reached through this
               * modal. Every one of them was unreachable.
               */
              channel: "SMS",
            }),
          },
        )) as { challenge: { id: string } };
        setState({
          kind: "verifying",
          details: state.details,
          teamId,
          challengeId: json.challenge.id,
          destinationMask,
        });
      } catch (err) {
        const e = err as ApiErrorLike;
        // The server's stable, actionable denial for an account with nothing
        // to send a code to. It is deliberately NOT bucketed with "that code
        // was wrong": one means "enrol a device", the other means "try again",
        // and collapsing them leaves every gated feature looking broken with
        // no way for this modal to offer the one thing that fixes it.
        if (e?.code === "STEP_UP_ENROLLMENT_REQUIRED" || e?.statusCode === 403) {
          setState({ kind: "enrollment_required" });
          return;
        }
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
        // Same contract as `startChallenge`: the parsed body IS the result.
        const json = (await apiFetch(
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
  const { state, cancel, startChallenge, verifyAndRetry } = control;
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
    if (state.kind === "idle") startedRef.current = false;
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
              Sending a one-time code to your enrolled device…
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
              This action needs a verified device, and this account does not
              have one yet. Enrol a phone under{" "}
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
              {state.destinationMask
                ? `Verification code (sent to ${state.destinationMask})`
                : "Verification code (sent to your enrolled device)"}
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
