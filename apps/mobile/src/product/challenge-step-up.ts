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

export type ChallengeMethod = "TOTP" | "SMS" | "WHATSAPP";

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
  };
}

export interface StartedChallenge {
  readonly challengeId: string;
  readonly method: ChallengeMethod;
  readonly destinationMask: string | null;
}

/** The start response → the verifying state. Null when the id is missing. */
export function parseStartedChallenge(data: unknown): StartedChallenge | null {
  const d = obj(data);
  const id = obj(d["challenge"])["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  const m = d["method"];
  return {
    challengeId: id,
    method: m === "TOTP" || m === "SMS" || m === "WHATSAPP" ? m : "SMS",
    destinationMask: typeof d["destinationMask"] === "string" ? (d["destinationMask"] as string) : null,
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
};

export function purposeLabel(purpose: string): string {
  return PURPOSE_LABEL[purpose] ?? "Complete sensitive action";
}

export const CHALLENGE_COPY = {
  intro:
    "This action requires an additional step-up confirmation. The action will only proceed after you verify a one-time code.",
  preparing: "Preparing your verification…",
  enrollment:
    "This action needs a verified second factor — an authenticator app or a verified phone — and this account has neither yet. Set one up under Settings → Security, then start this action again.",
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

/** The code the flow rejects with when the person cancels. */
export const STEP_UP_CANCEL = "STEP_UP_CANCEL";
