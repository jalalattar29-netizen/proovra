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
  /** The link row id — what `DELETE /v1/identity/links/:id` addresses. Null for password / legacy pairs. */
  linkId: string | null;
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
      linkId: null,
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
      linkId: str(l.id),
      // Never offer to remove the only way in — and never without an id to address.
      removable: usableMethods > 1 && str(l.id) !== null,
    });
  }
  const legacy = str(o.legacyProvider);
  if (legacy === "GOOGLE" || legacy === "APPLE") {
    if (!methods.some((m) => m.provider === legacy)) {
      methods.push({
        provider: legacy,
        label: PROVIDER_LABEL[legacy],
        linkedAtIso: null,
        linkId: null,
        // A legacy pair with no link row is surfaced READ-ONLY by the server.
        removable: false,
      });
    }
  }
  return { methods, passwordConfigured, usableMethods };
}

/* --------------------------------------------- link / unlink (T-15) */
//
// POST   /v1/identity/links/:provider   { idToken, stepUp? }  — add Google/Apple
// DELETE /v1/identity/links/:linkId     { stepUp? }           — remove one
//
// Both are step-up guarded (re-auth), exactly as on the web
// (PersonalSecuritySections.tsx:721-880). The server refuses removing the
// last usable method (`last_login_method_protected`) and linking an identity
// another account holds (`identity_already_linked`); both refusals carry a
// message the web shows verbatim, and so does native.

export type LinkableProvider = "GOOGLE" | "APPLE";

/** Providers not yet linked — the ones a Connect control may be offered for. */
export function linkableProviders(m: SignInMethods): LinkableProvider[] {
  const linked = new Set(m.methods.map((x) => x.provider));
  return (["GOOGLE", "APPLE"] as const).filter((p) => !linked.has(p));
}

export function buildIdentityLinkPath(provider: "google" | "apple"): string {
  return `/v1/identity/links/${provider}`;
}
export function buildIdentityUnlinkPath(linkId: string): string {
  return `/v1/identity/links/${encodeURIComponent(linkId)}`;
}

const SERVER_WORDED_LINK_CODES = new Set(["last_login_method_protected", "identity_already_linked"]);

/** The refusal to show: the server's own words for the two named refusals, else the fallback. */
export function identityLinkRefusal(err: unknown, fallback: string): string | null {
  const body = (err as { body?: unknown } | null)?.body;
  const e = obj(obj(body).error);
  const code = str(e.code) ?? str((err as { code?: unknown } | null)?.code);
  if (code && SERVER_WORDED_LINK_CODES.has(code)) return str(e.message) ?? fallback;
  return null;
}

/**
 * T-15 — ADD a first password to a Google/Apple-only account
 * (POST /v1/identity/password { newPassword, stepUp? }; web
 * PersonalSecuritySections.tsx:825-853). An account with no password has
 * nothing to CHANGE: the change form asked for a current password that does
 * not exist, so it could never succeed.
 */
export const ADD_PASSWORD_PATH = "/v1/identity/password";
export const ADD_PASSWORD_COPY = {
  title: "Add a password",
  description: "This account signs in with Google or Apple only. Adding a password gives it a second way in.",
  label: "New password (12+ chars, upper- and lower-case, a number)",
  action: "Add password",
  added: "Password added. You can now sign in with email and password.",
  failed: "Could not add a password.",
} as const;

export const IDENTITY_LINK_COPY = {
  linkFailed: "Could not connect this login method.",
  unlinkFailed: "Could not disconnect this method.",
  unlinkConsequence: "You will no longer be able to sign in with this method. At least one other usable login method must remain.",
  connected: (provider: "google" | "apple") => `${provider === "google" ? "Google" : "Apple"} connected.`,
  disconnected: "Login method disconnected.",
} as const;

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
  /** "Chrome on macOS" — the UA preview, described (never the raw string). */
  deviceLabel: string;
  /** A human country name, or null when none is reliable ("Location unavailable"). */
  location: string | null;
  /** The raw previews the server disclosed — Technical details only. */
  uaPreview: string | null;
  ipPreview: string | null;
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
    // WEB PARITY (sessionPresentation.ts): the device is named from the UA
    // preview ("Firefox on Windows"); the raw preview and the masked IP are
    // forensic detail, kept for the per-session Technical details disclosure.
    return {
      id: str(s.id) ?? "",
      isCurrent: bool(s.isCurrent),
      deviceLabel: describeUserAgent(ua),
      location: presentLocation(country, ip),
      uaPreview: ua,
      ipPreview: ip,
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
  /** T-14 — the web "Technical details" disclosure: the exact event key and raw facts, never removed. */
  technical: string[];
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

/**
 * GET /v1/identity-security/security-events sends each row as
 * `{ id, action, severity, outcome, occurredAtUtc, ipPreview, … }`
 * (identity-security.routes.ts). The parser read `eventType`/`type`, so every
 * row read "Security event". `action` is a dotted key ("auth.google_login");
 * its words come from the SHARED vocabulary (@proovra/shared
 * presentSecurityEvent / presentOutcome), which the screen passes in so this
 * module stays free of package imports. The legacy upper-case keys still map.
 */
export interface SecurityEventPresenter {
  title: (action: string) => { title: string; description?: string };
  outcome: (outcome: string | null | undefined) => string | null;
}
const FALLBACK_PRESENTER: SecurityEventPresenter = {
  title: (action) => ({ title: action ? humanizeEventType(action.includes(".") ? action.slice(action.lastIndexOf(".") + 1) : action) : "Security event" }),
  outcome: () => null,
};

export function parseSecurityEvents(payload: unknown, presenter: SecurityEventPresenter = FALLBACK_PRESENTER): SecurityEvent[] {
  const o = obj(payload);
  const list = rows(o.events).length > 0 ? rows(o.events) : rows(o.items);
  return list.map((raw, i) => {
    const e = obj(raw);
    const action = str(e.action) ?? str(e.eventType) ?? str(e.type) ?? "";
    const legacy = EVENT_LABEL[action];
    const outcome = str(e.outcome);
    const severity = (str(e.severity) ?? "").toLowerCase();
    const failed = outcome === "failure" || outcome === "blocked";
    const tone: ProovraStatusTone =
      legacy?.tone ?? (failed || severity === "critical" || severity === "high" ? "risk" : severity === "warning" ? "pending" : "neutral");
    const outcomeWord = presenter.outcome(outcome);
    return {
      id: str(e.id) ?? `${action}-${i}`,
      label: legacy?.label ?? presenter.title(action).title,
      tone,
      atIso: str(e.occurredAtUtc) ?? str(e.atUtc) ?? str(e.createdAt),
      detail: [outcomeWord, str(e.ipPreview) ?? str(e.detail)].filter(Boolean).join(" · ") || null,
      technical: [
        action ? `Event key: ${action}` : null,
        outcome ? `Outcome: ${outcome}` : null,
        str(e.severity) ? `Severity: ${str(e.severity)}` : null,
        str(e.ipPreview) ? `IP: ${str(e.ipPreview)}` : null,
        str(e.resourceType) ? `Resource: ${str(e.resourceType)}` : null,
      ].filter((x): x is string => x !== null),
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

/* ------------------------------------------------------- TOTP enrolment */
//
// POST /v1/identity/mfa/enroll/start   { label? }
//        → { factorId, otpauthUri, secretBase32 }
// POST /v1/identity/mfa/enroll/verify  { factorId, code }
//        → { factorId, recoveryCodes }
//
// Enrolment was absent from Native: the app could REMOVE a factor and report
// whether one existed, but a person could not add one from the device. That is
// the wrong half of a security control to ship — it could weaken the account
// and not strengthen it.
//
// ===========================================================================
// A PHONE IS NOT A DESKTOP HERE, AND THE DIFFERENCE IS THE POINT
// ===========================================================================
// The web shows a QR code because the authenticator is on a DIFFERENT device.
// On a phone it is usually the SAME device, and photographing your own screen
// is not possible. The `otpauth://` URI is therefore opened directly, which
// hands the secret to whichever authenticator is installed. This is the
// responsive/native-integration adaptation the product law allows: the
// endpoint, the secret, the verification and the recovery codes are identical.
//
// The manual secret stays available, because a device with no authenticator
// installed must still be able to enrol one elsewhere.

export const MFA_ENROLL_START_PATH = "/v1/identity/mfa/enroll/start";
export const MFA_ENROLL_VERIFY_PATH = "/v1/identity/mfa/enroll/verify";

export function buildEnrollStartBody(label?: string | null) {
  const l = (label ?? "").trim();
  // `kind` is optional and defaults to TOTP; sending SMS/WHATSAPP here is an
  // explicit refusal with its own route, so this never sends a kind at all.
  return l.length > 0 ? { label: l } : {};
}

export interface TotpEnrollment {
  factorId: string;
  /** Handed to an installed authenticator. */
  otpauthUri: string | null;
  /** Typed in by hand when there is no authenticator on this device. */
  secretBase32: string | null;
}

export function parseTotpEnrollment(payload: unknown): TotpEnrollment | null {
  const d = obj(payload);
  const factorId = str(d.factorId);
  if (!factorId) return null;
  return {
    factorId,
    otpauthUri: str(d.otpauthUri),
    secretBase32: str(d.secretBase32),
  };
}

export function buildEnrollVerifyBody(factorId: string, code: string) {
  return { factorId, code: code.trim() };
}

/** The route takes 6–10 characters; a shorter code is a round trip wasted. */
export function validateTotpCode(code: string): string | null {
  const c = code.trim();
  if (c.length < 6) return "Enter the 6-digit code from your authenticator.";
  if (c.length > 10) return "That code is too long.";
  return null;
}

/**
 * The recovery codes, which the server returns EXACTLY ONCE.
 *
 * Its own comment says so: "Recovery codes returned ONCE here. The client must
 * surface them immediately; we never return them again." A surface that showed
 * them in a toast, or behind a step the user could skip, would be losing the
 * only copy that exists.
 */
export function parseRecoveryCodes(payload: unknown): string[] {
  return rows(obj(payload).recoveryCodes).filter((c): c is string => typeof c === "string");
}

export const RECOVERY_CODES_WARNING =
  "These codes are shown once and cannot be shown again. Save them somewhere you can " +
  "reach without this phone — they are how you get back in if you lose your authenticator.";

/** The enrolment refusals, told apart so the recovery differs. */
export type EnrollFailure = "CODE_INVALID" | "NOT_FOUND" | "RATE_LIMITED" | "UNKNOWN";

export function classifyEnrollFailure(err: unknown): EnrollFailure {
  const e = obj(err);
  const code = str(obj(e.body).error) ?? str(e.code);
  if (code === "rate_limited") return "RATE_LIMITED";
  if (code === "code_invalid") return "CODE_INVALID";

  const status = num(e.statusCode);
  if (status === 429) return "RATE_LIMITED";
  // The route answers 400 for a wrong code and 404 for an enrolment that is
  // gone. "Try again" is right for one and wrong for the other.
  if (status === 400) return "CODE_INVALID";
  if (status === 404) return "NOT_FOUND";
  return "UNKNOWN";
}

export function enrollFailureMessage(failure: EnrollFailure): string {
  switch (failure) {
    case "CODE_INVALID":
      return "That code did not match. Codes change every 30 seconds — try the current one.";
    case "NOT_FOUND":
      return "This enrolment has expired. Start again to get a new code.";
    case "RATE_LIMITED":
      return "Too many attempts. Wait a moment before trying again.";
    case "UNKNOWN":
      return "The code could not be verified.";
  }
}

/* ===================================================================== */
/* WEB PARITY (Settings › Security) — PersonalSecuritySections.tsx       */
/* ===================================================================== */

/* ------------------------------------------ session presentation (web) */
//
// Ported from apps/web/lib/security/sessionPresentation.ts. A raw user-agent
// preview is never primary content: it becomes "Chrome on Windows". The raw
// preview and the masked IP stay available behind "Technical details".

const UA_BROWSERS: ReadonlyArray<{ re: RegExp; label: string }> = [
  // Order matters — Edge/Opera UAs also contain "Chrome"; Chrome contains "Safari".
  { re: /Edg(?:e|A|iOS)?\//i, label: "Edge" },
  { re: /OPR\/|Opera/i, label: "Opera" },
  { re: /SamsungBrowser\//i, label: "Samsung Internet" },
  { re: /Firefox\/|FxiOS\//i, label: "Firefox" },
  { re: /CriOS\//i, label: "Chrome" },
  { re: /Chrome\//i, label: "Chrome" },
  { re: /Safari\//i, label: "Safari" },
];

const UA_PLATFORMS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /iPhone/i, label: "iPhone" },
  { re: /iPad/i, label: "iPad" },
  { re: /Android/i, label: "Android" },
  { re: /Windows/i, label: "Windows" },
  { re: /Macintosh|Mac OS X/i, label: "macOS" },
  { re: /CrOS/i, label: "ChromeOS" },
  { re: /Linux/i, label: "Linux" },
];

/** "Chrome on Windows" / "Safari on iPhone". Unknown → "Unknown device". Never the raw UA. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua || ua.trim().length === 0) return "Unknown device";
  const browser = UA_BROWSERS.find((b) => b.re.test(ua))?.label ?? null;
  const platform = UA_PLATFORMS.find((p) => p.re.test(ua))?.label ?? null;
  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return `Browser on ${platform}`;
  return "Unknown device";
}

/** RFC1918 / loopback / link-local on the masked preview. */
export function isPrivateNetworkIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim();
  if (v.startsWith("10.") || v.startsWith("192.168.") || v.startsWith("127.")) return true;
  if (v.startsWith("169.254.")) return true;
  const m = v.match(/^172\.(\d{1,3})\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  const lower = v.toLowerCase();
  return v === "::1" || lower.startsWith("fc") || lower.startsWith("fd");
}

type RegionNames = new (locales: string[], options: { type: string }) => { of: (code: string) => string | undefined };

/**
 * A human country name, or null when no RELIABLE location exists (missing or
 * placeholder code, or a private/container network address). The screen then
 * says "Location unavailable" — never "??".
 */
export function presentLocation(
  countryCode: string | null | undefined,
  ipPreview: string | null | undefined,
): string | null {
  const code = (countryCode ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (isPrivateNetworkIp(ipPreview)) return null;
  try {
    const DisplayNames = (Intl as unknown as { DisplayNames?: RegionNames }).DisplayNames;
    if (!DisplayNames) return null;
    const name = new DisplayNames(["en"], { type: "region" }).of(code);
    if (!name || name === code) return null;
    return name;
  } catch {
    return null;
  }
}

/** The web's session list: current first, then the latest others up to three, then "Show N more". */
export const SESSIONS_FIRST = 3;
export function visibleSessions(
  inventory: SessionInventory,
  expanded: boolean,
): { current: AccountSession[]; others: AccountSession[]; hiddenCount: number } {
  const current = inventory.sessions.filter((s) => s.isCurrent);
  const allOthers = inventory.sessions.filter((s) => !s.isCurrent);
  const room = Math.max(0, SESSIONS_FIRST - current.length);
  const others = expanded ? allOthers : allOthers.slice(0, room);
  return { current, others, hiddenCount: Math.max(0, allOthers.length - room) };
}

/* ------------------------------------------------ sign-in rows (web) */
//
// Ported from apps/web/lib/security/loginMethodsSummary.ts: one row per method
// — Email & password, Google, Apple — each with its status, its last use, and
// the ONE action the web offers for it. The last usable method never offers an
// enabled disconnect; the server's `last_login_method_protected` guard is
// mirrored rather than provoked.

export interface SignInRow {
  key: "password" | "google" | "apple";
  label: string;
  status: "configured" | "connected" | "not_connected";
  statusLabel: string;
  lastUsedAtIso: string | null;
  linkId: string | null;
  action: "add_password" | "connect" | "disconnect" | "none";
  disconnectBlocked: boolean;
  blockedReason: string | null;
}

export function presentSignInRows(payload: unknown): SignInRow[] {
  const o = obj(payload);
  const passwordConfigured = bool(o.passwordConfigured);
  const legacy = str(o.legacyProvider);
  const links = rows(o.links).map((raw) => {
    const l = obj(raw);
    return { id: str(l.id), provider: str(l.provider), lastUsedAtUtc: str(l.lastUsedAtUtc) };
  });
  let usable = num(o.usableMethods);
  if (!(usable > 0)) {
    const providers = new Set(links.map((l) => l.provider).filter(Boolean));
    if (legacy) providers.add(legacy);
    usable = providers.size + (passwordConfigured ? 1 : 0);
  }
  const providerRow = (key: "google" | "apple", provider: "GOOGLE" | "APPLE"): SignInRow => {
    const label = PROVIDER_LABEL[provider];
    const link = links.find((l) => l.provider === provider) ?? null;
    const connected = link !== null || legacy === provider;
    if (!connected) {
      return { key, label, status: "not_connected", statusLabel: "Not connected", lastUsedAtIso: null, linkId: null, action: "connect", disconnectBlocked: false, blockedReason: null };
    }
    const lastUsable = usable <= 1;
    const blocked = lastUsable || link === null || link.id === null;
    return {
      key,
      label,
      status: "connected",
      statusLabel: "Connected",
      lastUsedAtIso: link?.lastUsedAtUtc ?? null,
      linkId: link?.id ?? null,
      action: "disconnect",
      disconnectBlocked: blocked,
      blockedReason: blocked
        ? lastUsable
          ? `Add another login method before disconnecting ${label}.`
          : "This is your original sign-in method. Add a password or another provider first."
        : null,
    };
  };
  return [
    {
      key: "password",
      label: "Email & password",
      status: passwordConfigured ? "configured" : "not_connected",
      statusLabel: passwordConfigured ? "Configured" : "Not configured",
      lastUsedAtIso: null,
      linkId: null,
      action: passwordConfigured ? "none" : "add_password",
      disconnectBlocked: false,
      blockedReason: null,
    },
    providerRow("google", "GOOGLE"),
    providerRow("apple", "APPLE"),
  ];
}

/** "Google · Password" — the web summary strip's "Login method". */
export function summarizeSignInMethods(payload: unknown): string {
  const o = obj(payload);
  const providers = new Set<string>();
  for (const raw of rows(o.links)) {
    const p = str(obj(raw).provider);
    if (p) providers.add(p);
  }
  const legacy = str(o.legacyProvider);
  if (legacy) providers.add(legacy);
  const parts: string[] = [];
  if (providers.has("GOOGLE")) parts.push("Google");
  if (providers.has("APPLE")) parts.push("Apple");
  if (bool(o.passwordConfigured)) parts.push("Password");
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/* ---------------------------------------------- password change (web) */

export const PASSWORD_CHANGE_ERRORS: Readonly<Record<string, string>> = {
  rate_limited: "Too many attempts. Please wait a minute before trying again.",
  current_password_invalid: "The current password is incorrect.",
  sso_user_password_unsupported: "Your account signs in through an identity provider. Change your password there.",
  no_password_set: "No password is set on this account. Use the password reset flow to create one.",
  same_as_current: "Your new password must be different from your current password.",
  weak_new_password: "Use at least 12 characters with upper- and lower-case letters and a number.",
};

/** POST /v1/identity-security/password answers `{ ok, revokedOtherSessions }` (identity-security.routes.ts:1071). */
export function passwordChangedMessage(revokeOthers: boolean, payload: unknown): string {
  if (!revokeOthers) return "Password updated.";
  return `Password updated. ${num(obj(payload).revokedOtherSessions)} other session(s) signed out.`;
}

/* ------------------------------------------------ security events (web) */

/** The web renders the latest three, then "View more (N older)" in pages of eight. */
export const EVENTS_FIRST = 3;
export const EVENTS_PAGE = 8;
export const SECURITY_EVENTS_PATH = "/v1/identity-security/security-events?limit=50";
