/**
 * CHALLENGE STEP-UP — the one-time-code protocol sensitive workspace actions use.
 *
 * There are TWO step-up protocols in the API and native had only one:
 *
 *   1. Inline proof (`src/product/step-up.ts`): the retried request carries
 *      `stepUp: { method, currentPassword | code }` in its body. Account and
 *      organization actions use it.
 *   2. Challenge (`services/identity-security/step-up-middleware.ts`): the
 *      server answers 401 STEP_UP_REQUIRED with a purpose; the client STARTS a
 *      challenge (`POST /v1/identity-security/step-up/start`), the person enters
 *      a one-time code (`POST …/step-up/check`), and the ORIGINAL request is
 *      retried with `x-proovra-step-up-challenge-id`. The server consumes the
 *      challenge, bound to actor + workspace + purpose + resource.
 *
 * Operations bulk actions (`REVIEWER_OPS_BULK_ACTION`, ops.routes.ts:3006) use
 * protocol 2, which is why no native bulk action could ever succeed before
 * this module existed. This is the native port of the web's `useStepUpAction`
 * (components/identity-security/StepUpModal.tsx); copy is verbatim.
 *
 * PURE — the hook and sheet live in `src/ui/challenge-step-up.tsx`.
 */

export const STEP_UP_CHALLENGE_HEADER = "x-proovra-step-up-challenge-id";
export const STEP_UP_START_PATH = "/v1/identity-security/step-up/start";
export const STEP_UP_CHECK_PATH = "/v1/identity-security/step-up/check";

/**
 * 2026-10-28 — the authenticator ladder. A PASSKEY or IDP_REAUTH challenge
 * is answered in a SYSTEM BROWSER (`handoffUrl`, opened with
 * expo-web-browser's auth session): the web page completes it with the
 * passkey or the Organization's sign-in, then returns to
 * `proovra://step-up/complete`. The app then reads the challenge status and,
 * only when the server says APPROVED, retries the action — spending the
 * approval still needs this app's own session.
 */
export type ChallengeMethod = "PASSKEY" | "IDP_REAUTH" | "TOTP" | "SMS" | "WHATSAPP";

export const CHALLENGE_METHODS: ReadonlyArray<ChallengeMethod> = [
  "PASSKEY",
  "IDP_REAUTH",
  "TOTP",
  "SMS",
  "WHATSAPP",
];

/** Where the system browser returns when the handoff page is done. */
export const STEP_UP_RETURN_URL = "proovra://step-up/complete";

export function stepUpStatusPath(challengeId: string, teamId: string): string {
  return `/v1/identity-security/step-up/${encodeURIComponent(challengeId)}/status?teamId=${encodeURIComponent(teamId)}`;
}

/** Methods answered in the system browser rather than with a typed code. */
export function isBrowserMethod(method: ChallengeMethod): boolean {
  return method === "PASSKEY" || method === "IDP_REAUTH";
}

function asMethod(v: unknown): ChallengeMethod | null {
  return typeof v === "string" && (CHALLENGE_METHODS as ReadonlyArray<string>).includes(v)
    ? (v as ChallengeMethod)
    : null;
}

export interface ChallengeDetails {
  readonly purpose: string;
  readonly resourceKind: string | null;
  readonly resourceId: string | null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** A 401 STEP_UP_REQUIRED from the challenge middleware. */
export function isChallengeStepUpRequired(err: unknown): boolean {
  const e = obj(err);
  return e["code"] === "STEP_UP_REQUIRED" && e["statusCode"] === 401;
}

/** `extractDetails`, StepUpModal.tsx:74-91. */
export function challengeDetailsFrom(err: unknown): ChallengeDetails {
  const d = obj(obj(err)["details"]);
  return {
    purpose: typeof d["purpose"] === "string" ? (d["purpose"] as string) : "SENSITIVE_ACTION",
    resourceKind: typeof d["resourceKind"] === "string" ? (d["resourceKind"] as string) : null,
    resourceId: typeof d["resourceId"] === "string" ? (d["resourceId"] as string) : null,
  };
}

export function buildStartBody(teamId: string, details: ChallengeDetails, channel?: ChallengeMethod) {
  return {
    teamId,
    purpose: details.purpose,
    // The route's schema is .optional(), not .nullable(): an absent resource is omitted, never null.
    ...(details.resourceKind ? { resourceKind: details.resourceKind } : {}),
    ...(details.resourceId ? { resourceId: details.resourceId } : {}),
    ...(channel ? { channel } : {}),
    // The app answers a passkey in the system browser, so it always asks for
    // a handoff; the server ignores it for the code kinds.
    handoff: true,
  };
}

export interface StartedChallenge {
  readonly challengeId: string;
  readonly method: ChallengeMethod;
  readonly destinationMask: string | null;
  /** Every kind the server says this person may answer with, strongest first. */
  readonly availableMethods: ReadonlyArray<ChallengeMethod>;
  /** PASSKEY / IDP_REAUTH: the page that completes it in the system browser. */
  readonly handoffUrl: string | null;
  /** Approved at start (a recent, sufficient Organization sign-in). */
  readonly approved: boolean;
}

/** The start response → the verifying state. Null when the id is missing. */
export function parseStartedChallenge(data: unknown): StartedChallenge | null {
  const d = obj(data);
  const id = obj(d["challenge"])["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  const available = Array.isArray(d["availableMethods"])
    ? (d["availableMethods"] as unknown[]).map(asMethod).filter((m): m is ChallengeMethod => m !== null)
    : [];
  return {
    challengeId: id,
    method: asMethod(d["method"]) ?? "SMS",
    destinationMask: typeof d["destinationMask"] === "string" ? (d["destinationMask"] as string) : null,
    availableMethods: available,
    handoffUrl: typeof d["handoffUrl"] === "string" ? (d["handoffUrl"] as string) : null,
    approved: obj(d["challenge"])["status"] === "APPROVED",
  };
}

/** Enrollment required: the web treats STEP_UP_ENROLLMENT_REQUIRED or any 403 as such. */
export function isEnrollmentRequired(err: unknown): boolean {
  const e = obj(err);
  return e["code"] === "STEP_UP_ENROLLMENT_REQUIRED" || e["statusCode"] === 403;
}

/** StepUpModal.tsx PURPOSE_LABEL, verbatim. */
export const PURPOSE_LABEL: Readonly<Record<string, string>> = {
  REVIEW_APPROVAL_HIGH_RISK: "Approve this review",
  REVIEWER_OPS_REJECT: "Reject this review",
  REVIEWER_OPS_ESCALATION_RESOLVE: "Resolve this escalation",
  REVIEWER_OPS_BULK: "Perform a bulk reviewer action",
  EVIDENCE_DESTRUCTION_APPROVE: "Approve evidence destruction",
  EVIDENCE_DESTRUCTION_EXECUTE: "Execute evidence destruction",
  GOVERNANCE_POLICY_UPDATE: "Change the workspace governance policy",
  DEPARTMENT_MEMBERSHIP_GRANT: "Grant this department membership",
  DEPARTMENT_MEMBERSHIP_REVOKE: "Revoke this department membership",
  // Members audit SEC-03 / ROLE-05 — irreversible deletes and published identity.
  CASE_DELETE: "Delete this case",
  COLLABORATION_TEAM_ARCHIVE: "Archive this Collaboration Team",
  WORKSPACE_IDENTITY_UPDATE: "Change the workspace legal contact or logo",
};

export function purposeLabel(purpose: string): string {
  return PURPOSE_LABEL[purpose] ?? "Complete sensitive action";
}

export const CHALLENGE_COPY = {
  intro:
    "This action requires an additional step-up confirmation. Nothing happens until you confirm it's you.",
  preparing: "Preparing your verification…",
  enrollment:
    "This action needs a verified way to confirm it's you — a passkey or security key, your organization's sign-in, an authenticator app, or (where allowed) a verified phone — and this account has none it can use here. Set one up under Settings → Security, then start this action again. Lost every factor? Use account recovery from the sign-in screen.",
  passkeyPrompt: "Use your passkey or security key to confirm it's you. A secure browser window will open.",
  idpPrompt: "Sign in again with your organization to confirm it's you. A secure browser window will open.",
  passkeyAction: "Use passkey",
  idpAction: "Continue to sign-in",
  browserPending: "Confirmation isn't finished yet. Complete it in the browser window, then try again.",
  browserDenied: "That didn't confirm it's you. Start again to retry.",
  switchTo: {
    PASSKEY: "Use a passkey or security key instead",
    IDP_REAUTH: "Use your organization's sign-in instead",
    TOTP: "Use an authenticator app instead",
    SMS: "Use a text message instead",
    WHATSAPP: "Use WhatsApp instead",
  } as Readonly<Record<ChallengeMethod, string>>,
  missing: {
    PASSKEY: "This account has no passkey or security key set up.",
    IDP_REAUTH: "Your organization's sign-in can't be used for this.",
    TOTP: "This account has no authenticator app set up.",
    SMS: "This account has no verified phone set up.",
    WHATSAPP: "This account has no verified phone set up.",
  } as Readonly<Record<ChallengeMethod, string>>,
  codeLabelTotp: "Code from your authenticator app",
  codeLabelPhone: (mask: string | null) =>
    mask ? `Verification code (sent to ${mask})` : "Verification code (sent to your verified phone)",
  switchToSms: "Use a text message instead",
  switchToTotp: "Use an authenticator app instead",
  retrying: "Confirmed — retrying the original action…",
  rejectedTotp:
    "That code was not accepted. Each authenticator code works once — wait for the next one, then start again.",
  rejectedPhone: "That code was not accepted. Start again to receive a new code.",
  noWorkspace: "Workspace context required.",
  startFailed: "Could not start step-up challenge.",
  checkFailed: "Could not verify step-up code.",
  actionFailed: "Action failed after step-up.",
  noTotp: "This account has no authenticator app set up.",
  noPhone: "This account has no verified phone set up.",
  switchFailed: "Could not switch verification method.",
} as const;

/** What proovra://step-up/complete says, from the browser's reported result. */
export function describeStepUpReturn(result: string | null): { title: string; body: string } {
  if (result === "approved") {
    return {
      title: "Confirmed",
      body: "You confirmed it's you. Go back to finish the action — it continues only after the app checks the confirmation.",
    };
  }
  return {
    title: "Not confirmed",
    body: "This didn't confirm it's you, so nothing was changed. Go back and try again, or choose another method.",
  };
}

/** The code the flow rejects with when the person cancels. */
export const STEP_UP_CANCEL = "STEP_UP_CANCEL";
