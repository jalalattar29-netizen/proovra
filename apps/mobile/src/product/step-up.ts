/**
 * STEP-UP — one place that understands "prove it is you, then retry".
 *
 * The API guards its most consequential account and organization actions with
 * `verifyAccountStepUp`. When the proof is missing or wrong it answers:
 *
 *   401 { error: { code: "STEP_UP_REQUIRED" | "STEP_UP_INVALID",
 *                  methods: ["password" | "mfa" | "reauth", ...],
 *                  message } }
 *   429 { error: { code: "rate_limited", ... } }
 *
 * and the caller retries the SAME request with `stepUp` in the body.
 *
 * ===========================================================================
 * A CHALLENGE IS NOT A REFUSAL
 * ===========================================================================
 * A 401 here does not mean "you may not do this" and it does not mean the
 * session has expired. It means one more proof is needed. Rendering it as a
 * permission error tells a user they are not allowed to manage their own
 * account; rendering it as a session error sends them to sign in again, which
 * does not help and loses what they were doing.
 *
 * `methods` decides WHICH proof, and it is the server's answer, not a guess:
 * an account with no password (OAuth only) cannot be asked for one, and an
 * account with no active factor cannot be asked for a code. An earlier native
 * helper matched on the code alone and never read `methods`, so the app could
 * say "confirm it is you" without being able to ask for anything.
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export const STEP_UP_METHODS = ["password", "mfa", "reauth"] as const;
export type StepUpMethod = (typeof STEP_UP_METHODS)[number];

/** What the retry sends back, exactly as the route's schema accepts it. */
export type StepUpProof =
  | { method: "password"; currentPassword: string }
  | { method: "mfa"; code: string };

export interface StepUpChallenge {
  methods: StepUpMethod[];
  /** Populated only on a RETRY that failed; empty on the first challenge. */
  message: string;
}

/**
 * The challenge inside an error, or null when the error is something else.
 *
 * Reads `error.methods` where the server actually puts it. The mobile client
 * keeps the parsed payload on `err.body`, so both the flattened `code` and the
 * nested shape are understood.
 */
export function extractStepUp(err: unknown): StepUpChallenge | null {
  const e = obj(err);
  const nested = obj(obj(e.body).error);
  const code = str(nested.code) ?? str(e.code);
  if (code !== "STEP_UP_REQUIRED" && code !== "STEP_UP_INVALID") return null;

  const raw = Array.isArray(nested.methods) ? nested.methods : [];
  const methods = raw.filter((m): m is StepUpMethod =>
    (STEP_UP_METHODS as readonly string[]).includes(m as string),
  );

  return {
    // `reauth` is the server's own fallback when an account holds neither a
    // password nor a factor, so it is the fallback here too.
    methods: methods.length > 0 ? methods : ["reauth"],
    message:
      code === "STEP_UP_INVALID"
        ? (str(nested.message) ?? "That did not verify. Try again.")
        : "",
  };
}

/** Whether this error is a rate limit on the step-up itself, not a refusal. */
export function isStepUpRateLimited(err: unknown): boolean {
  const e = obj(err);
  const nested = obj(obj(e.body).error);
  return (str(nested.code) ?? str(e.code)) === "rate_limited";
}

/**
 * Which proof to ask for.
 *
 * Password first when the account has one, because typing a password is the
 * cheaper ask; an authenticator code otherwise. `reauth` alone means the
 * account can offer neither, and the honest answer is to say so rather than
 * present an empty field.
 */
export function stepUpMethodFor(challenge: StepUpChallenge): StepUpMethod {
  if (challenge.methods.includes("password")) return "password";
  if (challenge.methods.includes("mfa")) return "mfa";
  return "reauth";
}

export interface StepUpField {
  label: string;
  placeholder: string;
  secure: boolean;
  keypad: boolean;
}

export function stepUpFieldFor(method: StepUpMethod): StepUpField | null {
  switch (method) {
    case "password":
      return {
        label: "Your password",
        placeholder: "Current password",
        secure: true,
        keypad: false,
      };
    case "mfa":
      return {
        label: "Authenticator code",
        placeholder: "6-digit code",
        secure: false,
        keypad: true,
      };
    case "reauth":
      // Nothing to type. The surface says so instead of showing a dead field.
      return null;
  }
}

export const REAUTH_ONLY_NOTE =
  "This account has no password or authenticator set up, so this action cannot be " +
  "confirmed here. Add a sign-in method in Security, then try again.";

export function buildStepUpProof(method: StepUpMethod, value: string): StepUpProof | null {
  const v = value.trim();
  if (v.length === 0) return null;
  if (method === "password") return { method: "password", currentPassword: v };
  if (method === "mfa") return { method: "mfa", code: v };
  return null;
}

/** The body of a retried request: the original fields plus the proof. */
export function withStepUp<T extends object>(body: T, proof: StepUpProof | null): T {
  return proof ? { ...body, stepUp: proof } : body;
}
