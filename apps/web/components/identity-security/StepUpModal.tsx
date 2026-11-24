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

import {
  reauthRequiredSentence,
  stepUpEnrollmentSentence,
  stepUpReasonSentence,
} from "@proovra/shared/user-facing-errors";

import { apiFetch, setApiToken } from "../../lib/api";
import { getPasskeyAssertion } from "../../lib/identity/webauthn";
import { useDialogFocus } from "../../lib/ui/dialogFocus";

export type StepUpRequiredDetails = {
  purpose: string;
  resourceKind: string | null;
  resourceId: string | null;
  /**
   * T-028 (additive) — WHY the server asked: `policy_flag:<flag>`,
   * `elevated_session_risk`, `save_policy_requires_mfa`, … Rendered as a
   * sentence; absent on routes that name none.
   */
  reason?: string | null;
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

/** True when the person closed the challenge: nothing failed, so nothing is reported. */
export function isStepUpCancelled(err: unknown): boolean {
  return (err as ApiErrorLike | null | undefined)?.code === "STEP_UP_CANCEL";
}

/**
 * T-029 — a privileged action needs a RECENT sign-in (`401 reauth_required`).
 * The session is valid for everything else, so this is never "signed out".
 */
export function isReauthRequiredError(err: unknown): err is ApiErrorLike {
  if (!err || typeof err !== "object") return false;
  const e = err as ApiErrorLike;
  return e.code === "reauth_required" && e.statusCode === 401;
}

/** Which dialog state the person left when they closed it (T-027). */
export type StepUpCancelStage = "challenge" | "enrollment_required" | "reauth_required";

/**
 * T-027 — the inline line a caller shows after the dialog was closed. Closing
 * the enrolment or re-sign-in state is not "cancelling a confirmation": the
 * person had nothing to confirm with yet, so the sentence says what is needed
 * instead. `fallback` is the caller's own sentence for an ordinary cancel.
 */
export function stepUpCancelMessage(err: unknown, fallback: string): string {
  const stage = (err as { stage?: StepUpCancelStage } | null | undefined)?.stage;
  if (stage === "enrollment_required") {
    return "Nothing was recorded. This action needs a second factor: set one up under Settings → Security, then try again.";
  }
  if (stage === "reauth_required") {
    return "Nothing was recorded. Sign in again when you're ready, then try again — what you typed is still here.";
  }
  return fallback;
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
    reason: details && typeof details.reason === "string" ? details.reason : null,
  };
}

/** The current page, as the place a sign-in or enrolment returns to. */
function currentReturnPath(): string {
  if (typeof window === "undefined") return "/";
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

/** Settings → Security, remembering where to come back to (T-027). */
export function stepUpEnrollmentHref(returnTo: string = currentReturnPath()): string {
  return `/settings?returnTo=${encodeURIComponent(returnTo)}#security`;
}

/**
 * T-029 — the separate sign-in window. It ends on /auth/reauth-complete, which
 * tells the person to come back here; this page (and the text in its forms)
 * stays as it was.
 */
export const REAUTH_SIGN_IN_HREF = `/login?reauth=1&next=${encodeURIComponent("/auth/reauth-complete")}`;

/** Indirection so tests can observe the sign-in window without opening one. */
export const reauthWindow = {
  open(url: string): boolean {
    if (typeof window === "undefined") return false;
    return window.open(url, "proovra-reauth", "popup,width=520,height=760") !== null;
  },
};

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
      /**
       * 2026-10-28 — the authenticator ladder: every kind this person may
       * answer with (strongest first, policy-narrowed by the server), the
       * WebAuthn options for a passkey, and the system-browser URL for an
       * Organization sign-in.
       */
      availableMethods: StepUpMethod[];
      passkeyOptions: Record<string, unknown> | null;
      handoffUrl: string | null;
      /** A passkey ceremony or IdP window is in progress. */
      working: boolean;
    }
  | { kind: "enrollment_required"; reason: string | null }
  | {
      /**
       * T-029 — the action needs a recent sign-in. The page and its typed
       * text stay; the person signs in again in a separate window and then
       * chooses Continue, which re-runs the action ONCE. Nothing runs on its
       * own.
       */
      kind: "reauth_required";
      details: Record<string, unknown> | null;
      /** Who was signed in when the refusal came, so a different account never continues. */
      userId: string | null;
      signInOpened: boolean;
      notice: string | null;
      working: boolean;
    }
  | {
      kind: "failed";
      reason: string;
      /** Present when starting again can succeed (e.g. a rejected code). */
      restart: { details: StepUpRequiredDetails; teamId: string | null } | null;
    }
  | { kind: "retrying" };

export type StepUpMethod = "PASSKEY" | "IDP_REAUTH" | "TOTP" | "SMS" | "WHATSAPP";

const METHOD_SWITCH_LABEL: Record<StepUpMethod, string> = {
  PASSKEY: "Use a passkey or security key instead",
  IDP_REAUTH: "Use your organization's sign-in instead",
  TOTP: "Use an authenticator app instead",
  SMS: "Use a text message instead",
  WHATSAPP: "Use WhatsApp instead",
};

const METHOD_MISSING_NOTICE: Record<StepUpMethod, string> = {
  PASSKEY: "This account has no passkey or security key set up.",
  IDP_REAUTH: "Your organization's sign-in can't be used for this.",
  TOTP: "This account has no authenticator app set up.",
  SMS: "This account has no verified phone set up.",
  WHATSAPP: "This account has no verified phone set up.",
};

/** The message the IdP completion page posts to its opener. */
const IDP_MESSAGE_TYPE = "proovra-step-up-idp";

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
  // Advanced by every cancel: a /step-up/start answer that lands after the
  // operator cancelled belongs to a flow that no longer exists and must not
  // reopen the dialog (or reach retryWithChallenge).
  const flowRef = useRef(0);

  const closeIdle = useCallback(() => {
    setState({ kind: "idle" });
  }, []);

  /**
   * Retry the original action exactly once with the challenge id in the
   * header. The middleware consumes it atomically.
   */
  const retryWithChallenge = useCallback(async (challengeId: string) => {
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
        "x-proovra-step-up-challenge-id": challengeId,
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
  }, []);

  const runStepUpAction = useCallback(
    /**
     * `options.teamId` binds the challenge to the RECORD's workspace when it
     * is not the active one — a list that spans workspaces (Cases) deletes a
     * case of workspace B while A is active, and a challenge minted for A is
     * refused for B. Defaults to the hook's workspace.
     */
    async <T,>(action: StepUpAction<T>, options?: { teamId?: string | null }): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (isReauthRequiredError(err)) {
          return new Promise<T>((resolve, reject) => {
            pendingActionRef.current = action as StepUpAction<unknown>;
            onSuccessRef.current = (value) => resolve(value as T);
            onFailureRef.current = (e) => reject(e);
            const flow = flowRef.current;
            setState({
              kind: "reauth_required",
              details: err.details ?? null,
              userId: null,
              signInOpened: false,
              notice: null,
              working: false,
            });
            // Who is signed in now, read with the same credential, so Continue
            // can refuse to run the action as a different account.
            void apiFetch("/v1/auth/me")
              .then((me) => {
                const id = (me as { user?: { id?: unknown } } | null)?.user?.id;
                if (flowRef.current !== flow || typeof id !== "string") return;
                setState((s) => (s.kind === "reauth_required" ? { ...s, userId: id } : s));
              })
              .catch(() => undefined);
          });
        }
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
          // PRO-A1Z-02 / PRO-O1Z-04 — the challenge is minted in the workspace
          // the server will consume it against: the caller's per-action
          // workspace, else the one the refusal names, else the page's.
          const refusalTeamId =
            err.details && typeof err.details.teamId === "string" ? err.details.teamId : null;
          setState({
            kind: "starting",
            details: extractDetails(err.details),
            teamId: options?.teamId ?? refusalTeamId ?? teamId,
          });
        });
      }
    },
    [teamId],
  );

  const stateKindRef = useRef<ModalState["kind"]>("idle");
  stateKindRef.current = state.kind;

  const cancel = useCallback(() => {
    const onFail = onFailureRef.current;
    const stage: StepUpCancelStage =
      stateKindRef.current === "enrollment_required"
        ? "enrollment_required"
        : stateKindRef.current === "reauth_required"
          ? "reauth_required"
          : "challenge";
    flowRef.current += 1;
    pendingActionRef.current = null;
    onSuccessRef.current = null;
    onFailureRef.current = null;
    setState({ kind: "idle" });
    if (onFail) {
      const cancelErr = new Error("Step-up cancelled by operator");
      (cancelErr as ApiErrorLike).code = "STEP_UP_CANCEL";
      // T-027 — which state was closed, so the caller's line can say what is
      // needed instead of "cancelled" when there was nothing to confirm with.
      (cancelErr as unknown as { stage: StepUpCancelStage }).stage = stage;
      onFail(cancelErr);
    }
  }, []);

  /** T-029 — open the separate sign-in window; the page stays as it is. */
  const openReauthSignIn = useCallback(() => {
    const opened = reauthWindow.open(REAUTH_SIGN_IN_HREF);
    setState((s) =>
      s.kind === "reauth_required"
        ? {
            ...s,
            signInOpened: true,
            notice: opened
              ? null
              : "Your browser blocked the sign-in window. Use the link below to sign in in a new tab, then come back and choose Continue.",
          }
        : s,
    );
  }, []);

  /**
   * T-029 — the person says they have signed in again. The fresh session is
   * the browser's session cookie; the in-memory credential this tab started
   * with is the old one and would win, so it is dropped. The action runs once,
   * now, because the person asked — never on its own. A different account, or
   * no fresh sign-in yet, does not run it.
   */
  const continueAfterReauth = useCallback(async () => {
    if (state.kind !== "reauth_required") return;
    const current = state;
    setState({ ...current, working: true, notice: null });
    setApiToken(null);
    let meId: string | null = null;
    try {
      const me = (await apiFetch("/v1/auth/me")) as { user?: { id?: unknown } } | null;
      meId = typeof me?.user?.id === "string" ? me.user.id : null;
    } catch {
      meId = null;
    }
    if (!meId) {
      setState({ ...current, working: false, notice: "We couldn't confirm the new sign-in. Sign in again, then choose Continue." });
      return;
    }
    if (current.userId && meId !== current.userId) {
      setState({
        ...current,
        working: false,
        notice: "A different account signed in, so nothing was run. Reload the page to continue as that account.",
      });
      return;
    }
    const action = pendingActionRef.current;
    if (!action) {
      setState({ kind: "idle" });
      return;
    }
    try {
      const value = await action();
      const onSuccess = onSuccessRef.current;
      pendingActionRef.current = null;
      onSuccessRef.current = null;
      onFailureRef.current = null;
      setState({ kind: "idle" });
      if (onSuccess) onSuccess(value);
    } catch (err) {
      if (isReauthRequiredError(err)) {
        setState({
          ...current,
          working: false,
          notice: "That sign-in is not recent enough yet. Sign in again, then choose Continue.",
        });
        return;
      }
      if (isStepUpRequiredError(err)) {
        // The fresh sign-in passed the window; the action still needs a
        // second factor (flag or risk): the ordinary challenge takes over.
        const refusalTeamId =
          err.details && typeof err.details.teamId === "string" ? err.details.teamId : null;
        setState({ kind: "starting", details: extractDetails(err.details), teamId: refusalTeamId ?? teamId });
        return;
      }
      const onFail = onFailureRef.current;
      pendingActionRef.current = null;
      onSuccessRef.current = null;
      onFailureRef.current = null;
      setState({
        kind: "failed",
        reason: toSafeUserError(err, { message: "The action could not be completed." }).message,
        restart: null,
      });
      if (onFail) onFail(err);
    }
  }, [state, teamId]);

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
      // PRO-A1Z-02 — the stored per-action workspace, not the hook's.
      const challengeTeamId = from.teamId ?? teamId;
      if (!challengeTeamId) {
        setState({
          kind: "failed",
          reason: "Workspace context required.",
          restart: null,
        });
        return;
      }
      const flow = flowRef.current;
      try {
        // `apiFetch` returns the PARSED body and throws on non-2xx.
        const json = (await apiFetch(
          "/v1/identity-security/step-up/start",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              teamId: challengeTeamId,
              purpose: from.details.purpose,
              resourceKind: from.details.resourceKind,
              resourceId: from.details.resourceId,
              ...(preferred ? { channel: preferred } : {}),
            }),
          },
        )) as {
          challenge: { id: string; status?: string };
          method?: StepUpMethod;
          destinationMask?: string | null;
          availableMethods?: StepUpMethod[];
          passkeyOptions?: Record<string, unknown> | null;
          handoffUrl?: string | null;
        };
        if (flowRef.current !== flow) return;
        // A recent, sufficient Organization sign-in in THIS session can
        // satisfy the step-up outright: the server returns it approved.
        if (json.challenge.status === "APPROVED") {
          await retryWithChallenge(json.challenge.id);
          return;
        }
        setState({
          kind: "verifying",
          details: from.details,
          teamId: challengeTeamId,
          challengeId: json.challenge.id,
          method: json.method ?? "SMS",
          destinationMask:
            typeof json.destinationMask === "string"
              ? json.destinationMask
              : null,
          notice: null,
          availableMethods: Array.isArray(json.availableMethods)
            ? json.availableMethods
            : [],
          passkeyOptions: json.passkeyOptions ?? null,
          handoffUrl: json.handoffUrl ?? null,
          working: false,
        });
      } catch (err) {
        if (flowRef.current !== flow) return;
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
              ? METHOD_MISSING_NOTICE[preferred ?? previous.method]
              : toSafeUserError(e, {
                  message: "Could not switch verification method.",
                }).message,
          });
          return;
        }
        if (enrollment) {
          setState({ kind: "enrollment_required", reason: from.details.reason ?? null });
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
    [state, teamId, retryWithChallenge],
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
      await retryWithChallenge(state.challengeId);
    },
    [state, retryWithChallenge],
  );

  /**
   * 2026-10-28 — answer a PASSKEY challenge: the browser asks the
   * authenticator to sign the server's challenge (user verification
   * required), and the assertion is checked server-side. Cancelling the
   * system prompt changes nothing and leaves the challenge to try again.
   */
  const verifyPasskey = useCallback(async () => {
    if (state.kind !== "verifying" || state.method !== "PASSKEY" || !state.passkeyOptions) {
      return;
    }
    const current = state;
    const restartFrom = { details: current.details, teamId: current.teamId };
    setState({ ...current, working: true, notice: null });
    const result = await getPasskeyAssertion(current.passkeyOptions as Record<string, unknown>);
    if (result.status === "cancelled") {
      setState({
        ...current,
        working: false,
        notice: "The passkey prompt was closed. Try again, or use another method.",
      });
      return;
    }
    if (result.status !== "ok") {
      setState({
        ...current,
        working: false,
        notice:
          result.status === "unsupported"
            ? "This browser can't use passkeys. Use another method."
            : "The passkey couldn't be used. Try again, or use another method.",
      });
      return;
    }
    try {
      const json = (await apiFetch("/v1/identity-security/step-up/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId: current.teamId,
          challengeId: current.challengeId,
          assertion: result.assertion,
        }),
      })) as { status: string };
      if (json.status !== "approved") throw new Error("not approved");
    } catch {
      setState({
        kind: "failed",
        reason: "That passkey was not accepted. Start again to try once more.",
        restart: restartFrom,
      });
      return;
    }
    await retryWithChallenge(current.challengeId);
  }, [state, retryWithChallenge]);

  /**
   * 2026-10-28 — answer an IDP_REAUTH challenge: the Organization's own
   * sign-in runs in a popup (forced, assurance-checked by the server). The
   * popup's completion page posts back to this window; the challenge's
   * status is then read from the server, which is the only authority on
   * whether it was approved. A blocked popup falls back to a link and a
   * "check again" button.
   */
  const startIdpReauth = useCallback(() => {
    if (state.kind !== "verifying" || state.method !== "IDP_REAUTH" || !state.handoffUrl) {
      return;
    }
    const current = state;
    const url = state.handoffUrl;
    const popup = window.open(url, "proovra-idp-step-up", "popup,width=520,height=720");
    setState({
      ...current,
      working: true,
      notice: popup
        ? null
        : "Your browser blocked the sign-in window. Use the link below, then choose “Check again”.",
    });
  }, [state]);

  const checkIdpStatus = useCallback(async () => {
    if (state.kind !== "verifying" || state.method !== "IDP_REAUTH") return;
    const current = state;
    try {
      const json = (await apiFetch(
        `/v1/identity-security/step-up/${encodeURIComponent(current.challengeId)}/status?teamId=${encodeURIComponent(current.teamId ?? "")}`,
      )) as { status: string };
      if (json.status === "APPROVED") {
        await retryWithChallenge(current.challengeId);
        return;
      }
      setState({
        ...current,
        working: false,
        notice:
          json.status === "PENDING"
            ? "Sign-in isn't finished yet. Complete it in the sign-in window, then check again."
            : "Your organization's sign-in didn't confirm it's you. Start again to retry.",
      });
    } catch {
      setState({
        ...current,
        working: false,
        notice: "Couldn't check the sign-in. Try again.",
      });
    }
  }, [state, retryWithChallenge]);

  useEffect(() => {
    if (state.kind !== "verifying" || state.method !== "IDP_REAUTH") return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string } | null;
      if (data?.type !== IDP_MESSAGE_TYPE) return;
      void checkIdpStatus();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [state, checkIdpStatus]);


  return useMemo(
    () => ({
      state,
      runStepUpAction,
      cancel,
      closeIdle,
      startChallenge,
      restart,
      verifyAndRetry,
      verifyPasskey,
      startIdpReauth,
      checkIdpStatus,
      openReauthSignIn,
      continueAfterReauth,
    }),
    [
      state,
      runStepUpAction,
      cancel,
      closeIdle,
      startChallenge,
      restart,
      verifyAndRetry,
      verifyPasskey,
      startIdpReauth,
      checkIdpStatus,
      openReauthSignIn,
      continueAfterReauth,
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
  // Members audit SEC-03 / ROLE-05 — irreversible deletes and published identity.
  CASE_DELETE: "Delete this case",
  COLLABORATION_TEAM_ARCHIVE: "Archive this Collaboration Team",
  PASSKEY_REGISTER: "Add a passkey or security key",
  PASSKEY_REMOVE: "Remove a passkey or security key",
  ORG_SECURITY_POLICY_UPDATE: "Change the organization security policy",
  WORKSPACE_IDENTITY_UPDATE: "Change the workspace legal contact or logo",
  PUBLIC_VERIFY_PUBLISH: "Show more on the verification page",
  PUBLIC_VERIFY_SUSPEND: "Withdraw the verification page",
  PUBLIC_VERIFY_RESTORE: "Reinstate the verification page",
  // Decision G / OBS-INTAKE-REVEAL-STEPUP — the stepped-up contact reveals.
  EVIDENCE_REQUEST_CONTACT_REVEAL: "Reveal the recipient contact",
  INTAKE_LINK_CONTACT_REVEAL: "Reveal the recipient contact",
  SUBMITTER_CONTACT_REVEAL: "Reveal the submitter contact",
};

export function StepUpModal({
  control,
}: {
  control: ReturnType<typeof useStepUpAction>;
}) {
  const {
    state,
    cancel,
    startChallenge,
    restart,
    verifyAndRetry,
    verifyPasskey,
    startIdpReauth,
    checkIdpStatus,
    openReauthSignIn,
    continueAfterReauth,
  } = control;
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
    } else if (state.kind === "verifying" && isCodeMethod(state.method)) {
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

  // F-P1-07 — the trap the header promises: focus moves in on open (unless the
  // code field already took it), Tab stays inside, and focus returns on close.
  // Escape keeps its own handler above.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(dialogRef, state.kind !== "idle");

  if (state.kind === "idle") return null;

  const purposeLabel =
    state.kind === "starting" || state.kind === "verifying"
      ? PURPOSE_LABEL[state.details.purpose] ?? "Complete sensitive action"
      : state.kind === "reauth_required"
        ? "Sign in again to continue"
        : state.kind === "enrollment_required"
          ? "Set up two-factor authentication to continue"
          : "Step-up required";
  // T-028 — why the server asked, when it said.
  const reasonSentence =
    state.kind === "starting" || state.kind === "verifying"
      ? stepUpReasonSentence(state.details.reason)
      : null;
  const intro =
    state.kind === "reauth_required"
      ? "You're still signed in. Nothing happens until you sign in again and choose Continue."
      : state.kind === "enrollment_required"
        ? "Nothing has been changed. What you entered on this page stays as it is."
        : "This action requires an additional step-up confirmation. Nothing happens until you confirm it's you.";

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
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
            {intro}
          </p>
          {reasonSentence ? (
            <p data-step-up-reason style={{ margin: "6px 0 0", fontSize: 13, color: "#334155", lineHeight: 1.5 }}>
              {reasonSentence}
            </p>
          ) : null}
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
            <p data-step-up-enrollment-reason style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
              {stepUpEnrollmentSentence(state.reason)}
            </p>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
              Set one up under{" "}
              <a href={stepUpEnrollmentHref()} data-step-up-enroll-link>
                Settings → Security
              </a>
              ; a link there brings you back here to try again. Lost every
              factor?{" "}
              <a href="/auth/mfa-challenge" data-step-up-recovery-link>
                Use account recovery
              </a>
              .
            </p>
            <div style={actionsRow}>
              <button
                type="button"
                onClick={cancel}
                data-step-up-cancel
                style={secondaryButtonStyle}
              >
                Not now
              </button>
              {/*
               * T-027 — enrolment always offers an actionable path, never
               * only Close: set one up now, then come back to this page.
               */}
              <a
                href={stepUpEnrollmentHref()}
                data-step-up-enroll-now
                style={{ ...primaryButtonStyle, textDecoration: "none", display: "inline-block" }}
              >
                Set up two-factor
              </a>
            </div>
          </div>
        ) : null}

        {state.kind === "reauth_required" ? (
          <div data-step-up-reauth-required>
            <p data-step-up-reauth-reason style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
              {reauthRequiredSentence(state.details as { reason?: unknown; windowHours?: unknown } | null)}
            </p>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
              {state.signInOpened
                ? "Finish signing in in the other window, then come back and choose Continue. This page and what you typed stay as they are."
                : "Sign in again in a separate window. This page and what you typed stay as they are."}
            </p>
            {state.notice ? (
              <p role="status" data-step-up-reauth-notice style={noticeStyle}>
                {state.notice}
              </p>
            ) : null}
            {state.signInOpened ? (
              <p style={noticeStyle}>
                <a href={REAUTH_SIGN_IN_HREF} target="_blank" rel="noopener" data-step-up-reauth-link>
                  Open the sign-in page in a new tab
                </a>
              </p>
            ) : null}
            <div style={actionsRow}>
              <button type="button" onClick={cancel} data-step-up-cancel style={secondaryButtonStyle}>
                Not now
              </button>
              {state.signInOpened ? (
                <button
                  type="button"
                  data-step-up-reauth-continue
                  style={primaryButtonStyle}
                  disabled={state.working}
                  onClick={() => void continueAfterReauth()}
                >
                  {state.working ? "Checking…" : "Continue"}
                </button>
              ) : (
                <button
                  type="button"
                  data-step-up-reauth-sign-in
                  style={primaryButtonStyle}
                  onClick={openReauthSignIn}
                >
                  Sign in again
                </button>
              )}
            </div>
          </div>
        ) : null}

        {state.kind === "verifying" && state.method === "PASSKEY" ? (
          <div data-step-up-form="passkey">
            <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>
              Use your passkey or security key to confirm it&apos;s you.
            </p>
            {state.notice ? (
              <p role="status" data-step-up-switch-notice style={noticeStyle}>
                {state.notice}
              </p>
            ) : null}
            <MethodSwitches state={state} onSwitch={(m) => void startChallenge(m)} />
            <div style={actionsRow}>
              <button type="button" onClick={cancel} data-step-up-cancel style={secondaryButtonStyle}>
                Cancel
              </button>
              <button
                type="button"
                data-step-up-passkey
                style={primaryButtonStyle}
                disabled={state.working}
                onClick={() => void verifyPasskey()}
              >
                {state.working ? "Waiting for your passkey…" : "Use passkey"}
              </button>
            </div>
          </div>
        ) : null}

        {state.kind === "verifying" && state.method === "IDP_REAUTH" ? (
          <div data-step-up-form="idp">
            <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>
              Sign in again with your organization to confirm it&apos;s you. A
              sign-in window will open.
            </p>
            {state.notice ? (
              <p role="status" data-step-up-switch-notice style={noticeStyle}>
                {state.notice}
              </p>
            ) : null}
            {state.working && state.handoffUrl ? (
              <p style={noticeStyle}>
                <a href={state.handoffUrl} target="_blank" rel="noopener" data-step-up-idp-link>
                  Open your organization&apos;s sign-in
                </a>
              </p>
            ) : null}
            <MethodSwitches state={state} onSwitch={(m) => void startChallenge(m)} />
            <div style={actionsRow}>
              <button type="button" onClick={cancel} data-step-up-cancel style={secondaryButtonStyle}>
                Cancel
              </button>
              {state.working ? (
                <button
                  type="button"
                  data-step-up-idp-check
                  style={primaryButtonStyle}
                  onClick={() => void checkIdpStatus()}
                >
                  Check again
                </button>
              ) : (
                <button
                  type="button"
                  data-step-up-idp-start
                  style={primaryButtonStyle}
                  onClick={startIdpReauth}
                >
                  Continue to sign-in
                </button>
              )}
            </div>
          </div>
        ) : null}

        {state.kind === "verifying" && isCodeMethod(state.method) ? (
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
            <MethodSwitches state={state} onSwitch={(m) => void startChallenge(m)} />
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

function isCodeMethod(method: StepUpMethod): boolean {
  return method === "TOTP" || method === "SMS" || method === "WHATSAPP";
}

/**
 * "Use another method" — only the kinds the server says this person may use
 * here (policy-narrowed, strongest first). Before the ladder the switch was a
 * fixed TOTP <-> SMS toggle; an account the server reports nothing else for
 * gets the toggle it had, so older responses keep working.
 */
function MethodSwitches({
  state,
  onSwitch,
}: {
  state: { method: StepUpMethod; availableMethods: StepUpMethod[] };
  onSwitch: (method: StepUpMethod) => void;
}) {
  const others =
    state.availableMethods.length > 0
      ? state.availableMethods.filter((m) => m !== state.method && m !== "WHATSAPP")
      : ([state.method === "TOTP" ? "SMS" : "TOTP"] as StepUpMethod[]);
  if (others.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
      {others.map((m) => (
        <button
          key={m}
          type="button"
          data-step-up-switch
          data-step-up-switch-to={m}
          onClick={() => onSwitch(m)}
          style={switchButtonStyle}
        >
          {METHOD_SWITCH_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

const noticeStyle = { margin: "8px 0 0", fontSize: 12, color: "#475569" } as const;

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
  color: "var(--btn-primary-color)",
  background: "var(--btn-primary-bg)",
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
