/**
 * ACCOUNT SECURITY — pure projections for the native Settings › Security pane.
 *
 * Ports the canonical web surface
 * `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx`,
 * which `/settings#security` renders. Native Settings read exactly ONE endpoint
 * (`/v1/users/me`) where the web reads 26, and the entire account-security
 * family had zero native consumers: a user could not change their password, see
 * or revoke their sessions, manage MFA, or review security activity — on a
 * device they might lose.
 *
 * The five canonical sections and their endpoints:
 *   Change password        POST /v1/identity-security/password
 *   Sign-in methods        GET  /v1/identity/links
 *   Two-factor             GET  /v1/identity/mfa/factors
 *                          POST /v1/identity/mfa/enroll/{start,verify}
 *                          POST /v1/identity/mfa/recovery-codes/regenerate
 *                          DELETE /v1/identity/mfa/factors/:id
 *   Sessions               GET  /v1/identity-security/my-sessions
 *                          POST /v1/identity-security/my-sessions/:id/revoke
 *                          POST /v1/identity-security/my-sessions/revoke-others
 *   Security activity      GET  /v1/identity-security/security-events
 *
 * Pure: no React, no react-native, no fetch. Parsing is defensive in the same
 * style as the other `src/product/*` modules — a field the server stops sending
 * degrades to a safe default rather than crashing a security screen.
 */
import type { ProovraStatusTone } from "@proovra/ui";

/* ----------------------------------------------------------------- helpers */

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const bool = (v: unknown): boolean => v === true;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/* ---------------------------------------------------------- sign-in methods */

export type SignInProvider = "PASSWORD" | "GOOGLE" | "APPLE";

export interface SignInMethod {
  provider: SignInProvider;
  label: string;
  /** Present for a linked OAuth identity. */
  linkedAtIso: string | null;
  /**
   * Whether removing this method is allowed. The server refuses the removal of
   * the LAST usable method independently; this only decides whether native
   * offers the control, so the user is not sent into a guaranteed refusal.
   */
  removable: boolean;
}

export interface SignInMethods {
  methods: SignInMethod[];
  passwordConfigured: boolean;
  /** How many ways this account can be signed into. */
  usableMethods: number;
}

const PROVIDER_LABEL: Record<SignInProvider, string> = {
  PASSWORD: "Password",
  GOOGLE: "Google",
  APPLE: "Apple",
};

export function parseSignInMethods(payload: unknown): SignInMethods {
  const o = obj(payload);
  const passwordConfigured = bool(o.passwordConfigured);
  const usableMethods = num(o.usableMethods);

  const methods: SignInMethod[] = [];
  if (passwordConfigured) {
    methods.push({
      provider: "PASSWORD",
      label: PROVIDER_LABEL.PASSWORD,
      linkedAtIso: null,
      removable: false, // the password is removed by the account, not from here
    });
  }
  for (const raw of rows(o.links)) {
    const l = obj(raw);
    const provider = str(l.provider);
    if (provider !== "GOOGLE" && provider !== "APPLE") continue;
    methods.push({
      provider,
      label: PROVIDER_LABEL[provider],
      linkedAtIso: str(l.linkedAtUtc),
      // Never offer to remove the only way in.
      removable: usableMethods > 1,
    });
  }
  const legacy = str(o.legacyProvider);
  if (legacy === "GOOGLE" || legacy === "APPLE") {
    if (!methods.some((m) => m.provider === legacy)) {
      methods.push({
        provider: legacy,
        label: PROVIDER_LABEL[legacy],
        linkedAtIso: null,
        // A legacy pair with no link row is surfaced READ-ONLY by the server.
        removable: false,
      });
    }
  }
  return { methods, passwordConfigured, usableMethods };
}

/**
 * The one-line account-security headline.
 *
 * An account reachable by a single method with no second factor is the state
 * worth naming, because it is the one a lost device compromises outright.
 */
export function signInRisk(methods: SignInMethods, mfa: MfaStatus): {
  label: string;
  tone: ProovraStatusTone;
} {
  if (mfa.hasMfa) return { label: "Two-factor on", tone: "verified" };
  if (methods.usableMethods <= 1) {
    return { label: "One sign-in method, no second factor", tone: "risk" };
  }
  return { label: "No second factor", tone: "pending" };
}

/* ------------------------------------------------------------------- MFA */

export interface MfaFactor {
  id: string;
  label: string;
  status: string;
  enrolledAtIso: string | null;
  lastUsedAtIso: string | null;
}

export interface MfaStatus {
  hasMfa: boolean;
  factors: MfaFactor[];
  recoveryCodesRemaining: number;
  /** True when the remaining codes are low enough to warrant regenerating. */
  recoveryCodesLow: boolean;
}

/** Below this the user is one lost device away from being locked out. */
export const RECOVERY_CODES_LOW_WATERMARK = 3;

export function parseMfaStatus(payload: unknown): MfaStatus {
  const o = obj(payload);
  const factors = rows(o.factors).map((raw) => {
    const f = obj(raw);
    return {
      id: str(f.id) ?? "",
      label: str(f.label) ?? "Authenticator app",
      status: str(f.status) ?? "UNKNOWN",
      enrolledAtIso: str(f.enrolledAt),
      lastUsedAtIso: str(f.lastUsedAt),
    };
  });
  const remaining = num(o.recoveryCodesRemaining);
  const hasMfa = bool(o.hasMfa) || factors.some((f) => f.status === "ACTIVE");
  return {
    hasMfa,
    factors,
    recoveryCodesRemaining: remaining,
    recoveryCodesLow: hasMfa && remaining <= RECOVERY_CODES_LOW_WATERMARK,
  };
}

export function mfaFactorTone(status: string): ProovraStatusTone {
  if (status === "ACTIVE") return "verified";
  if (status === "PENDING") return "pending";
  return "neutral";
}

/* -------------------------------------------------------------- sessions */

export interface AccountSession {
  id: string;
  isCurrent: boolean;
  /** "Chrome on macOS · 203.0.113.x · GB" — whatever the server disclosed. */
  deviceLabel: string;
  lastSeenAtIso: string | null;
  issuedAtIso: string | null;
  expiresAtIso: string | null;
  quarantined: boolean;
  /** Signed in through an SSO connection rather than directly. */
  viaSso: boolean;
}

export interface SessionInventory {
  sessions: AccountSession[];
  /** Sessions other than this one — what "sign out everywhere else" acts on. */
  otherCount: number;
  quarantinedCount: number;
}

export function parseSessions(payload: unknown): SessionInventory {
  const sessions = rows(obj(payload).sessions).map((raw) => {
    const s = obj(raw);
    const ua = str(s.uaPreview);
    const ip = str(s.ipPreview);
    const country = str(s.countryCode);
    // The server deliberately sends PREVIEWS, not full UA/IP strings. Join what
    // it disclosed rather than reconstructing anything it withheld.
    const deviceLabel = [ua, ip, country].filter(Boolean).join(" · ") || "Unrecognised device";
    return {
      id: str(s.id) ?? "",
      isCurrent: bool(s.isCurrent),
      deviceLabel,
      lastSeenAtIso: str(s.lastSeenAtUtc),
      issuedAtIso: str(s.issuedAtUtc),
      expiresAtIso: str(s.expiresAtUtc),
      quarantined: bool(s.quarantined),
      viaSso: str(s.ssoConnectionId) !== null,
    };
  });
  // The current session sorts first: it is the one the user can identify, and
  // it anchors the list they are about to revoke things from.
  sessions.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
  return {
    sessions,
    otherCount: sessions.filter((s) => !s.isCurrent).length,
    quarantinedCount: sessions.filter((s) => s.quarantined).length,
  };
}

/* ------------------------------------------------------- security activity */

export interface SecurityEvent {
  id: string;
  label: string;
  atIso: string | null;
  tone: ProovraStatusTone;
  detail: string | null;
}

/**
 * Event types the surface names explicitly. Anything else is humanised rather
 * than hidden — a security log that silently drops unknown events is worse than
 * one that shows a plain label.
 */
const EVENT_LABEL: Record<string, { label: string; tone: ProovraStatusTone }> = {
  PASSWORD_CHANGED: { label: "Password changed", tone: "info" },
  MFA_ENROLLED: { label: "Two-factor enabled", tone: "verified" },
  MFA_REMOVED: { label: "Two-factor removed", tone: "risk" },
  MFA_CHALLENGE_FAILED: { label: "Failed two-factor attempt", tone: "risk" },
  RECOVERY_CODES_REGENERATED: { label: "Recovery codes regenerated", tone: "info" },
  SESSION_REVOKED: { label: "Session signed out", tone: "info" },
  SESSIONS_REVOKED_OTHERS: { label: "All other sessions signed out", tone: "info" },
  SESSION_QUARANTINED: { label: "Session quarantined", tone: "risk" },
  IDENTITY_LINKED: { label: "Sign-in method added", tone: "info" },
  IDENTITY_UNLINKED: { label: "Sign-in method removed", tone: "pending" },
  LOGIN_SUCCEEDED: { label: "Signed in", tone: "neutral" },
  LOGIN_FAILED: { label: "Failed sign-in", tone: "pending" },
  STEP_UP_VERIFIED: { label: "Identity re-confirmed", tone: "neutral" },
};

export function humanizeEventType(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function parseSecurityEvents(payload: unknown): SecurityEvent[] {
  const o = obj(payload);
  const list = rows(o.events).length > 0 ? rows(o.events) : rows(o.items);
  return list.map((raw, i) => {
    const e = obj(raw);
    const type = str(e.eventType) ?? str(e.type) ?? "";
    const known = EVENT_LABEL[type];
    return {
      id: str(e.id) ?? `${type}-${i}`,
      label: known?.label ?? (type ? humanizeEventType(type) : "Security event"),
      tone: known?.tone ?? "neutral",
      atIso: str(e.atUtc) ?? str(e.createdAt) ?? str(e.occurredAtUtc),
      detail: str(e.ipPreview) ?? str(e.detail) ?? null,
    };
  });
}

/* --------------------------------------------------------- password policy */

export interface PasswordCheck {
  id: string;
  label: string;
  met: boolean;
}

/**
 * The password requirements, shown as they are typed rather than as a refusal
 * after submitting. The web auth surface states the same four; the server
 * remains the authority and refuses independently.
 */
export function passwordChecks(password: string): PasswordCheck[] {
  return [
    { id: "length", label: "At least 12 characters", met: password.length >= 12 },
    { id: "lower", label: "A lowercase letter", met: /[a-z]/.test(password) },
    { id: "upper", label: "An uppercase letter", met: /[A-Z]/.test(password) },
    { id: "number", label: "A number", met: /\d/.test(password) },
  ];
}

export function passwordMeetsPolicy(password: string): boolean {
  return passwordChecks(password).every((c) => c.met);
}

/**
 * Why the change-password form cannot be submitted yet, or null when it can.
 * Returning the REASON (rather than a boolean) is what lets the screen say why
 * the button is inert instead of presenting a dead control.
 */
export function passwordFormBlocker(input: {
  current: string;
  next: string;
  confirm: string;
}): string | null {
  if (input.current.length === 0) return "Enter your current password.";
  if (!passwordMeetsPolicy(input.next)) return "Your new password does not meet the requirements.";
  if (input.next !== input.confirm) return "The two new passwords do not match.";
  if (input.next === input.current) return "Choose a password you have not used here before.";
  return null;
}

/* ------------------------------------------------------------- step-up */
//
// RETIRED. `isStepUpRequired` lived here and matched on the code alone, so the
// app could tell a user to "confirm it is you" without being able to ask them
// for anything — it never read `methods`, which is what decides whether the
// proof is a password or an authenticator code. It also matched MFA_REQUIRED,
// a code the API does not define, and read `err.body.code` where the server
// puts `err.body.error.code`.
//
// The canonical understanding of a step-up challenge is `src/product/step-up.ts`,
// and the prompt that answers one is `src/ui/step-up-sheet.tsx`.
