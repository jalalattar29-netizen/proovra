"use client";

/**
 * PHASE 13 (NEW-058) — CONTACT FACTOR ENROLMENT: the product surface.
 *
 * The enterprise step-up gate stopped accepting a destination from the request
 * body, because a challenge answered on a handset the CALLER named proves
 * possession of nothing — a stolen session supplied its own number and approved
 * its own elevation. The gate now resolves the destination from an ACTIVE,
 * verified factor owned by the authenticated account.
 *
 * That fix is correct and it created this obligation in the same movement:
 * with no surface on which to enrol, NO account could satisfy the gate, so
 * every step-up-dependent feature — evidence publication and withdrawal,
 * reviewer approve and reject, escalation resolve, bulk reviewer operations,
 * destruction approve and execute, governance policy update, department
 * membership grant and revoke — was unreachable for every user. This panel is
 * the missing half.
 *
 * THE FOUR ROUTES (route-dispositions.json →
 * MISSING_PRODUCT_UI_RELEASE_REQUIRED):
 *
 *   GET  /v1/identity-security/contact-factors
 *        → { factors: ProjectedContactFactor[] }   masked; never a destination
 *   POST /v1/identity-security/contact-factors/enroll/start
 *        body { teamId, channel: SMS|WHATSAPP, destination, label? }  STRICT
 *        200  { factor, verificationAttemptId, codeExpiresAtUtc }
 *        409  { error: { code: "already_enrolled" | … } }
 *        429  { error: { code: "rate_limited" } }
 *        502  { error: { code: "provider_error" } }
 *   POST /v1/identity-security/contact-factors/enroll/verify
 *        body { teamId, factorId, verificationAttemptId, code }       STRICT
 *        200  { factor }        400 { status: "denied" }  (wrong OR expired)
 *   POST /v1/identity-security/contact-factors/:id/revoke
 *        200  { factor }        404 { error: { code: "not_found" } }
 *
 * WHY THE DESTINATION IS AN INPUT HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 * Enrolment is the one operation whose entire purpose is proving ownership of a
 * destination the user names, and the value becomes a factor only after the
 * code sent TO it comes back. Step-up start has no `destination` field at all —
 * it reads the enrolled factor. The asymmetry is the security property, so this
 * panel never reuses the enrolment field for anything else, and drops the typed
 * value from state the moment enrolment completes.
 *
 * WHAT THIS SURFACE MUST NEVER DO
 * ---------------------------------------------------------------------------
 *   - display the persisted destination (the API projects `destinationMask`
 *     only, and there is no route that returns the full value — the mask is
 *     the ONLY thing rendered once a factor exists);
 *   - put a code, destination, or raw error body in the DOM, a URL, or a log;
 *   - offer a control that would 401/403 on click — an ineligible state
 *     renders the reason instead.
 *
 * `codeExpiresAtUtc` exists so this panel can tell "that code was wrong" from
 * "that code has expired". The SERVER deliberately returns one denial shape for
 * both so an attacker learns nothing; the enrolling user needs to know whether
 * to retype or to resend, and the expiry of a code they just asked for is not a
 * secret. The distinction is therefore made here, from the attempt's own
 * expiry, without weakening the server's single response.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

// ===========================================================================
// Contract types — the masked projection, mirrored from
// services/api/src/services/security/verified-contact-factor.service.ts
// ===========================================================================

type ContactFactorKind = "SMS" | "WHATSAPP";

type ContactFactor = {
  factorId: string;
  kind: ContactFactorKind;
  label: string;
  /** The ONLY destination-shaped value that may ever be rendered. */
  destinationMask: string;
  status: "ENROLLING" | "ACTIVE" | "REVOKED";
  generation: number;
  verifiedAtUtc: string | null;
  revokedAtUtc: string | null;
};

const CHANNELS: ReadonlyArray<{ value: ContactFactorKind; label: string }> = [
  { value: "SMS", label: "Text message (SMS)" },
  { value: "WHATSAPP", label: "WhatsApp" },
];

/**
 * Resend cooldown.
 *
 * The server's own limit is 5 enrolment starts per account per hour, which is
 * the security control. This shorter client cooldown exists so the FIRST thing
 * an impatient user does is not burn that hourly budget in four clicks and
 * lock themselves out of enrolling for an hour.
 */
const RESEND_COOLDOWN_MS = 60_000;

const CODE_MIN = 3;
const CODE_MAX = 16;

// ===========================================================================
// State machine
// ===========================================================================

type OtpContext = {
  factorId: string;
  verificationAttemptId: string;
  destinationMask: string;
  /** Epoch ms, or null when the API did not project an expiry. */
  codeExpiresAt: number | null;
  /** Epoch ms the code was last sent — drives the resend cooldown. */
  sentAt: number;
  /** True when this enrolment replaces an existing ACTIVE factor. */
  replacing: boolean;
};

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "otp_sent"; ctx: OtpContext }
  | { kind: "verifying"; ctx: OtpContext }
  | { kind: "enrolled"; destinationMask: string }
  | { kind: "replacement_complete"; destinationMask: string }
  | { kind: "revoked" };

/**
 * A transient condition layered over the phase.
 *
 * Kept separate from `Phase` because every one of these leaves the user ON the
 * step they were on — an incorrect code must not discard the attempt context,
 * or the user would have to restart enrolment to fix a typo.
 */
type Notice =
  | { kind: "validating" }
  | { kind: "incorrect_code" }
  | { kind: "expired_code" }
  | { kind: "rate_limited" }
  | { kind: "reauthentication_required" }
  | { kind: "provider_unavailable" }
  | { kind: "already_enrolled" }
  | { kind: "failed"; message: string };

type ErrorLike = { statusCode?: number; code?: string };

function statusOf(err: unknown): number {
  const e = err as ErrorLike | null;
  return typeof e?.statusCode === "number" ? e.statusCode : 0;
}

function codeOf(err: unknown): string {
  const e = err as ErrorLike | null;
  return typeof e?.code === "string" ? e.code : "";
}

/** Human label for a factor state, used in the roster and the live region. */
function statusLabel(status: ContactFactor["status"]): string {
  if (status === "ACTIVE") return "Active";
  if (status === "ENROLLING") return "Awaiting verification";
  return "Revoked";
}

export function ContactFactorEnrollmentPanel({
  teamId,
}: {
  /**
   * The workspace the verification attempt is scoped to. The FACTOR is
   * account-owned — one enrolment serves every workspace the user can act in —
   * but the attempt's rate limit and audit trail are tenant-scoped, so the
   * routes require a workspace the caller belongs to. Null while the platform
   * context resolves; the panel refuses to act rather than guess.
   */
  teamId: string | null;
}) {
  const fieldPrefix = useId();
  const destinationFieldId = `${fieldPrefix}-destination`;
  const channelFieldId = `${fieldPrefix}-channel`;
  const labelFieldId = `${fieldPrefix}-label`;
  const codeFieldId = `${fieldPrefix}-code`;

  const [factors, setFactors] = useState<ReadonlyArray<ContactFactor> | null>(
    null,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [notice, setNotice] = useState<Notice | null>(null);

  const [channel, setChannel] = useState<ContactFactorKind>("SMS");
  const [destination, setDestination] = useState("");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");

  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  /** Explicit "replace the active factor" intent — see `showEnrolmentForm`. */
  const [replaceIntent, setReplaceIntent] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  /** Ticks once a second only while a cooldown or expiry is actually running. */
  const [now, setNow] = useState<number>(() => Date.now());

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  const loadFactors = useCallback(async () => {
    try {
      const res = await apiFetch("/v1/identity-security/contact-factors", {
        method: "GET",
      });
      if (!mountedRef.current) return;
      const rows: ReadonlyArray<ContactFactor> = Array.isArray(res?.factors)
        ? (res.factors as ContactFactor[]).filter(
            (f) => typeof f?.factorId === "string",
          )
        : [];
      setFactors(rows);
      setLoadFailed(false);
    } catch {
      if (!mountedRef.current) return;
      // Fail CLOSED for the roster: an unknown roster must not be rendered as
      // "you have no factors", because that invites a duplicate enrolment the
      // server would then refuse with a conflict the user cannot explain.
      setFactors(null);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadFactors();
  }, [loadFactors]);

  const activeFactor = factors?.find((f) => f.status === "ACTIVE") ?? null;
  const enrollingFactor = factors?.find((f) => f.status === "ENROLLING") ?? null;

  // A ticking clock is only mounted while something is actually counting down.
  const awaitingCode = phase.kind === "otp_sent" || phase.kind === "verifying";
  useEffect(() => {
    if (!awaitingCode) return;
    const t = setInterval(() => {
      if (mountedRef.current) setNow(Date.now());
    }, 1_000);
    return () => clearInterval(t);
  }, [awaitingCode]);

  const otpCtx = awaitingCode ? phase.ctx : null;
  const cooldownRemainingMs = otpCtx
    ? Math.max(0, otpCtx.sentAt + RESEND_COOLDOWN_MS - now)
    : 0;
  const codeHasExpired = Boolean(
    otpCtx?.codeExpiresAt && otpCtx.codeExpiresAt <= now,
  );

  // -------------------------------------------------------------------------
  // Enrolment — start
  // -------------------------------------------------------------------------

  /**
   * Map a failed start/verify onto a bounded notice.
   *
   * `toSafeUserError` is the ONLY path by which anything derived from an error
   * reaches the DOM; no branch here interpolates a raw body.
   */
  const noticeForError = useCallback(
    (err: unknown, fallback: string): Notice => {
      const status = statusOf(err);
      const errCode = codeOf(err);
      if (status === 401 || errCode === "STEP_UP_REQUIRED") {
        return { kind: "reauthentication_required" };
      }
      if (status === 429 || errCode === "rate_limited") {
        return { kind: "rate_limited" };
      }
      if (status === 409 || errCode === "already_enrolled") {
        return { kind: "already_enrolled" };
      }
      if (status === 502 || errCode === "provider_error") {
        return { kind: "provider_unavailable" };
      }
      return {
        kind: "failed",
        message: toSafeUserError(err, { message: fallback }).message,
      };
    },
    [],
  );

  const startEnrolment = useCallback(
    async (opts: { resend: boolean }) => {
      if (!teamId) return;
      if (phase.kind === "sending" || phase.kind === "verifying") return;

      const trimmed = destination.trim();
      if (!opts.resend) {
        // Client validation exists to spare the user a round-trip, not to
        // decide anything: the server re-validates and normalises to E.164.
        setNotice({ kind: "validating" });
        if (trimmed.length < 3 || trimmed.length > 32) {
          setDestinationError(
            "Enter the full number in international format, including the country code — for example +44 7700 900123.",
          );
          return;
        }
        if (!/^[+()\-.\s\d]+$/.test(trimmed)) {
          setDestinationError(
            "A phone number can only contain digits, spaces, and the characters + ( ) - .",
          );
          return;
        }
        setDestinationError(null);
      }

      const replacing = opts.resend
        ? awaitingCode
          ? phase.ctx.replacing
          : false
        : Boolean(activeFactor);

      const seq = ++seqRef.current;
      setPhase({ kind: "sending" });
      setNotice(null);
      setCodeError(null);
      try {
        const res = await apiFetch(
          "/v1/identity-security/contact-factors/enroll/start",
          {
            method: "POST",
            body: JSON.stringify({
              teamId,
              channel,
              destination: trimmed,
              ...(label.trim() ? { label: label.trim() } : {}),
            }),
          },
        );
        if (!mountedRef.current || seq !== seqRef.current) return;
        const factor = res?.factor as ContactFactor | undefined;
        const attemptId = res?.verificationAttemptId;
        if (!factor?.factorId || typeof attemptId !== "string") {
          setPhase({ kind: "idle" });
          setNotice({
            kind: "failed",
            message:
              "Enrolment could not be started. Nothing was changed on your account — try again shortly.",
          });
          return;
        }
        const expiresRaw = res?.codeExpiresAtUtc;
        const codeExpiresAt =
          typeof expiresRaw === "string" && !Number.isNaN(Date.parse(expiresRaw))
            ? Date.parse(expiresRaw)
            : null;
        setNow(Date.now());
        setPhase({
          kind: "otp_sent",
          ctx: {
            factorId: factor.factorId,
            verificationAttemptId: attemptId,
            destinationMask: factor.destinationMask,
            codeExpiresAt,
            sentAt: Date.now(),
            replacing,
          },
        });
        setCode("");
        void loadFactors();
        // Move focus to the field the user must now use. Without this a
        // keyboard user lands back at the top of the form and has to hunt for
        // the input that appeared below them.
        window.setTimeout(() => codeInputRef.current?.focus(), 0);
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setPhase({ kind: "idle" });
        setNotice(
          noticeForError(
            err,
            "The verification code could not be sent. Nothing was changed on your account — try again shortly.",
          ),
        );
        void loadFactors();
      }
    },
    [
      teamId,
      phase,
      destination,
      channel,
      label,
      activeFactor,
      awaitingCode,
      loadFactors,
      noticeForError,
    ],
  );

  const onStartSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void startEnrolment({ resend: false });
    },
    [startEnrolment],
  );

  // -------------------------------------------------------------------------
  // Enrolment — verify
  // -------------------------------------------------------------------------

  const onVerifySubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!teamId || phase.kind !== "otp_sent") return;
      const ctx = phase.ctx;

      const trimmed = code.trim();
      setNotice({ kind: "validating" });
      if (trimmed.length < CODE_MIN || trimmed.length > CODE_MAX) {
        setCodeError(
          `Enter the ${CODE_MIN}–${CODE_MAX} character code exactly as it was sent.`,
        );
        return;
      }
      setCodeError(null);

      const seq = ++seqRef.current;
      setPhase({ kind: "verifying", ctx });
      setNotice(null);
      try {
        const res = await apiFetch(
          "/v1/identity-security/contact-factors/enroll/verify",
          {
            method: "POST",
            body: JSON.stringify({
              teamId,
              factorId: ctx.factorId,
              verificationAttemptId: ctx.verificationAttemptId,
              code: trimmed,
            }),
          },
        );
        if (!mountedRef.current || seq !== seqRef.current) return;
        const factor = res?.factor as ContactFactor | undefined;
        const mask = factor?.destinationMask ?? ctx.destinationMask;
        // The typed destination has served its only purpose. Dropping it here
        // is what keeps the panel's own promise: after enrolment the mask is
        // the only destination-shaped value anywhere in this component.
        setDestination("");
        setLabel("");
        setCode("");
        setReplaceIntent(false);
        setPhase(
          ctx.replacing
            ? { kind: "replacement_complete", destinationMask: mask }
            : { kind: "enrolled", destinationMask: mask },
        );
        void loadFactors();
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        const status = statusOf(err);
        // The server answers wrong-code and expired-code identically, on
        // purpose. Only the attempt's own expiry can separate them, so that is
        // what decides which of the two the user is told.
        if (status === 400) {
          setPhase({ kind: "otp_sent", ctx });
          setNotice(
            ctx.codeExpiresAt && ctx.codeExpiresAt <= Date.now()
              ? { kind: "expired_code" }
              : { kind: "incorrect_code" },
          );
          window.setTimeout(() => codeInputRef.current?.focus(), 0);
          return;
        }
        setPhase({ kind: "otp_sent", ctx });
        setNotice(
          noticeForError(
            err,
            "The code could not be checked. Nothing was changed on your account — try again shortly.",
          ),
        );
      }
    },
    [teamId, phase, code, loadFactors, noticeForError],
  );

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  const revoke = useCallback(
    async (factorId: string) => {
      if (revokingId) return;
      const seq = ++seqRef.current;
      setRevokingId(factorId);
      setNotice(null);
      try {
        await apiFetch(
          `/v1/identity-security/contact-factors/${encodeURIComponent(factorId)}/revoke`,
          { method: "POST" },
        );
        if (!mountedRef.current || seq !== seqRef.current) return;
        setPhase({ kind: "revoked" });
        setReplaceIntent(false);
        setCode("");
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setNotice(
          noticeForError(
            err,
            "That factor could not be revoked. Nothing was changed — reload the page and try again.",
          ),
        );
      } finally {
        if (mountedRef.current) setRevokingId(null);
        void loadFactors();
      }
    },
    [revokingId, loadFactors, noticeForError],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /**
   * The single state token the whole surface reports.
   *
   * One attribute rather than a handful of booleans, because the browser proof
   * has to assert "the user was shown X" and a set of independent flags can
   * describe states the machine cannot actually be in.
   */
  const surfaceState: string = notice ? notice.kind : phase.kind;

  const busy =
    phase.kind === "sending" ||
    phase.kind === "verifying" ||
    revokingId !== null;

  const eligible = Boolean(teamId);

  /**
   * Show the enrolment form when there is something to enrol.
   *
   * An account that already holds an ACTIVE factor sees the roster and a
   * Replace control instead — so replacement is a deliberate act rather than
   * something a user stumbles into by retyping a number into a form that was
   * left open.
   */
  const showEnrolmentForm =
    !awaitingCode &&
    phase.kind !== "enrolled" &&
    phase.kind !== "replacement_complete" &&
    (replaceIntent || (!activeFactor && !loadFailed));

  const noticeText: string | null = !notice
    ? null
    : notice.kind === "validating"
      ? null
      : notice.kind === "incorrect_code"
        ? "That code was not correct. Check the digits and enter it again."
        : notice.kind === "expired_code"
          ? "That code has expired. Request a new one and enter the code from the newest message."
          : notice.kind === "rate_limited"
            ? "Too many verification codes have been requested for this account recently. Wait a while before trying again."
            : notice.kind === "reauthentication_required"
              ? "Your session needs to be confirmed again before you can change security settings. Sign in again, then return to this page."
              : notice.kind === "provider_unavailable"
                ? "The messaging service did not accept the request, so no code was sent. Nothing was changed on your account — try again shortly."
                : notice.kind === "already_enrolled"
                  ? "That destination is already enrolled on this account. Revoke the existing factor first if you want to enrol it again."
                  : notice.message;

  return (
    <section
      data-contact-factor-panel
      data-contact-factor-state={surfaceState}
      data-contact-factor-active={activeFactor ? "true" : "false"}
      aria-labelledby={`${fieldPrefix}-heading`}
      style={wrapStyle}
    >
      <h3 id={`${fieldPrefix}-heading`} style={headingStyle}>
        Verified contact device
      </h3>
      <p style={mutedStyle}>
        Sensitive operations — publishing or withdrawing evidence, approving a
        review or a destruction, changing a governance policy, granting
        department membership — ask you to confirm a one-time code first. The
        code is always sent to the device you enrol here, never to a number
        entered at the time of the action.
      </p>

      {/* --------------------------------------------------------------- */}
      {/* Roster                                                           */}
      {/* --------------------------------------------------------------- */}

      {loadFailed ? (
        <p data-contact-factor-load-failed style={errorTextStyle}>
          Your enrolled devices could not be loaded, so this section cannot be
          changed right now. Reload the page to try again.
        </p>
      ) : factors === null ? (
        <p data-contact-factor-loading style={hintStyle}>
          Loading your enrolled devices…
        </p>
      ) : factors.length === 0 ? (
        <p data-contact-factor-empty style={hintStyle}>
          You have no verified device yet. Enrol one below to unlock the
          operations listed above.
        </p>
      ) : (
        <ul data-contact-factor-list style={listStyle}>
          {factors.map((f) => (
            <li
              key={f.factorId}
              data-contact-factor-row={f.factorId}
              data-contact-factor-status={f.status}
              style={rowStyle}
            >
              <div>
                <p style={rowTitleStyle}>
                  {/* The mask, and only ever the mask. */}
                  <span data-contact-factor-mask>{f.destinationMask}</span>{" "}
                  <span style={mutedInlineStyle}>
                    · {f.kind === "WHATSAPP" ? "WhatsApp" : "SMS"}
                  </span>
                </p>
                <p style={hintStyle}>
                  <span data-contact-factor-status-label>
                    {statusLabel(f.status)}
                  </span>
                  {f.label ? ` · ${f.label}` : null}
                </p>
              </div>
              {f.status === "REVOKED" ? null : (
                <button
                  type="button"
                  data-contact-factor-revoke={f.factorId}
                  onClick={() => void revoke(f.factorId)}
                  disabled={busy || !eligible}
                  style={{
                    ...secondaryButtonStyle,
                    opacity: busy || !eligible ? 0.55 : 1,
                    cursor: busy || !eligible ? "not-allowed" : "pointer",
                  }}
                >
                  {revokingId === f.factorId ? "Revoking…" : "Revoke"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {activeFactor && !showEnrolmentForm && !awaitingCode ? (
        <button
          type="button"
          data-contact-factor-replace
          onClick={() => {
            setReplaceIntent(true);
            setPhase({ kind: "idle" });
            setNotice(null);
          }}
          disabled={busy || !eligible}
          style={{
            ...secondaryButtonStyle,
            opacity: busy || !eligible ? 0.55 : 1,
            cursor: busy || !eligible ? "not-allowed" : "pointer",
          }}
        >
          Replace this device
        </button>
      ) : null}

      {/* --------------------------------------------------------------- */}
      {/* Step 1 — destination                                             */}
      {/* --------------------------------------------------------------- */}

      {showEnrolmentForm ? (
        <form
          onSubmit={onStartSubmit}
          data-contact-factor-enroll-form
          aria-busy={phase.kind === "sending"}
          noValidate
        >
          {activeFactor ? (
            <p data-contact-factor-replace-notice style={hintStyle}>
              Enrolling a new device replaces{" "}
              <strong>{activeFactor.destinationMask}</strong>. The current
              device keeps working until the new one is verified, and any
              approval already granted against the old device stops working the
              moment it is replaced.
            </p>
          ) : null}

          <div style={fieldStyle}>
            <label htmlFor={channelFieldId} style={labelStyle}>
              How should the code be sent?
            </label>
            <select
              id={channelFieldId}
              name="channel"
              data-contact-factor-channel
              value={channel}
              onChange={(e) => setChannel(e.target.value as ContactFactorKind)}
              disabled={busy || !eligible}
              style={inputStyle}
            >
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div style={fieldStyle}>
            <label htmlFor={destinationFieldId} style={labelStyle}>
              Phone number
            </label>
            <input
              id={destinationFieldId}
              name="destination"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              maxLength={32}
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value);
                if (destinationError) setDestinationError(null);
                if (notice?.kind === "validating") setNotice(null);
              }}
              disabled={busy || !eligible}
              placeholder="+44 7700 900123"
              data-contact-factor-destination
              aria-invalid={destinationError ? true : undefined}
              aria-describedby={`${destinationFieldId}-hint${
                destinationError ? ` ${destinationFieldId}-error` : ""
              }`}
              style={inputStyle}
            />
            <p id={`${destinationFieldId}-hint`} style={hintStyle}>
              Include the country code. This is the only place the full number
              is entered — after verification the product shows a masked form of
              it and never displays it again.
            </p>
            {destinationError ? (
              <p
                id={`${destinationFieldId}-error`}
                role="alert"
                data-contact-factor-destination-error
                style={errorTextStyle}
              >
                {destinationError}
              </p>
            ) : null}
          </div>

          <div style={fieldStyle}>
            <label htmlFor={labelFieldId} style={labelStyle}>
              Name this device <span style={mutedInlineStyle}>(optional)</span>
            </label>
            <input
              id={labelFieldId}
              name="label"
              maxLength={60}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy || !eligible}
              placeholder="Work handset"
              data-contact-factor-label
              style={inputStyle}
            />
          </div>

          <button
            type="submit"
            data-contact-factor-send
            disabled={busy || !eligible}
            style={{
              ...submitStyle,
              opacity: busy || !eligible ? 0.55 : 1,
              cursor: busy || !eligible ? "not-allowed" : "pointer",
            }}
          >
            {phase.kind === "sending" ? "Sending code…" : "Send verification code"}
          </button>
          {replaceIntent ? (
            <button
              type="button"
              data-contact-factor-cancel-replace
              onClick={() => {
                setReplaceIntent(false);
                setDestination("");
                setDestinationError(null);
                setNotice(null);
              }}
              disabled={busy}
              style={{ ...secondaryButtonStyle, marginLeft: 8 }}
            >
              Cancel
            </button>
          ) : null}
          {!eligible ? (
            <p data-contact-factor-blocked style={hintStyle}>
              Open a workspace before enrolling a device — the verification is
              recorded against the workspace you are working in.
            </p>
          ) : null}
        </form>
      ) : null}

      {/* --------------------------------------------------------------- */}
      {/* Step 2 — the code                                                */}
      {/* --------------------------------------------------------------- */}

      {awaitingCode && otpCtx ? (
        <form
          onSubmit={onVerifySubmit}
          data-contact-factor-verify-form
          aria-busy={phase.kind === "verifying"}
          noValidate
        >
          <p style={mutedStyle}>
            A code was sent to{" "}
            <strong data-contact-factor-pending-mask>
              {otpCtx.destinationMask}
            </strong>
            . Enter it below to finish enrolling this device.
          </p>

          <div style={fieldStyle}>
            <label htmlFor={codeFieldId} style={labelStyle}>
              Verification code
            </label>
            <input
              id={codeFieldId}
              ref={codeInputRef}
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={CODE_MAX}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (codeError) setCodeError(null);
                if (
                  notice?.kind === "incorrect_code" ||
                  notice?.kind === "validating"
                ) {
                  setNotice(null);
                }
              }}
              disabled={phase.kind === "verifying"}
              data-contact-factor-code
              aria-invalid={
                codeError || notice?.kind === "incorrect_code" ? true : undefined
              }
              aria-describedby={
                codeError ? `${codeFieldId}-error` : `${codeFieldId}-hint`
              }
              style={inputStyle}
            />
            <p id={`${codeFieldId}-hint`} style={hintStyle}>
              {codeHasExpired
                ? "This code has expired. Request a new one below."
                : "The code is valid for a short time. Request a new one if it does not arrive."}
            </p>
            {codeError ? (
              <p
                id={`${codeFieldId}-error`}
                role="alert"
                data-contact-factor-code-error
                style={errorTextStyle}
              >
                {codeError}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            data-contact-factor-verify
            disabled={phase.kind === "verifying"}
            style={{
              ...submitStyle,
              opacity: phase.kind === "verifying" ? 0.55 : 1,
              cursor: phase.kind === "verifying" ? "not-allowed" : "pointer",
            }}
          >
            {phase.kind === "verifying" ? "Checking code…" : "Verify and enrol"}
          </button>

          {/* Resend is offered only when it would actually be honoured. A
              control that exists during the cooldown would spend the account's
              hourly budget on clicks the server refuses. */}
          <button
            type="button"
            data-contact-factor-resend
            data-contact-factor-resend-available={
              cooldownRemainingMs === 0 ? "true" : "false"
            }
            onClick={() => void startEnrolment({ resend: true })}
            disabled={busy || cooldownRemainingMs > 0}
            style={{
              ...secondaryButtonStyle,
              marginLeft: 8,
              opacity: busy || cooldownRemainingMs > 0 ? 0.55 : 1,
              cursor:
                busy || cooldownRemainingMs > 0 ? "not-allowed" : "pointer",
            }}
          >
            {cooldownRemainingMs > 0
              ? `Resend in ${Math.ceil(cooldownRemainingMs / 1000)}s`
              : "Resend code"}
          </button>

          <button
            type="button"
            data-contact-factor-abandon
            onClick={() => {
              setPhase({ kind: "idle" });
              setNotice(null);
              setCode("");
            }}
            disabled={phase.kind === "verifying"}
            style={{ ...secondaryButtonStyle, marginLeft: 8 }}
          >
            Start over
          </button>
        </form>
      ) : null}

      {/* --------------------------------------------------------------- */}
      {/* Terminal outcomes                                                */}
      {/* --------------------------------------------------------------- */}

      {phase.kind === "enrolled" || phase.kind === "replacement_complete" ? (
        <div data-contact-factor-done style={statusStyle}>
          <p style={{ margin: 0 }}>
            <strong>
              {phase.kind === "replacement_complete"
                ? "Device replaced."
                : "Device enrolled."}
            </strong>{" "}
            Codes for sensitive operations will be sent to{" "}
            <span data-contact-factor-enrolled-mask>
              {phase.destinationMask}
            </span>
            .
            {phase.kind === "replacement_complete"
              ? " Any approval granted against the previous device no longer works."
              : null}
          </p>
        </div>
      ) : null}

      {phase.kind === "revoked" ? (
        <div data-contact-factor-revoked style={statusStyle}>
          <p style={{ margin: 0 }}>
            <strong>Device revoked.</strong> Any approval granted against it has
            stopped working, and sensitive operations stay blocked until you
            enrol another device.
          </p>
        </div>
      ) : null}

      {noticeText ? (
        <p role="alert" data-contact-factor-notice style={errorTextStyle}>
          {noticeText}
        </p>
      ) : null}

      {/* One live region for the whole surface, so a screen reader is told
          about every transition without the visual layout deciding what is
          announced. */}
      <div
        role="status"
        aria-live="polite"
        data-contact-factor-status
        style={srOnlyStyle}
      >
        {phase.kind === "sending" ? "Sending a verification code…" : null}
        {phase.kind === "otp_sent" && !notice
          ? `A verification code was sent to ${phase.ctx.destinationMask}.`
          : null}
        {phase.kind === "verifying" ? "Checking your verification code…" : null}
        {phase.kind === "enrolled"
          ? `Device enrolled. Codes will be sent to ${phase.destinationMask}.`
          : null}
        {phase.kind === "replacement_complete"
          ? `Device replaced. Codes will now be sent to ${phase.destinationMask}.`
          : null}
        {phase.kind === "revoked"
          ? "Device revoked. Sensitive operations are blocked until another device is enrolled."
          : null}
        {noticeText}
      </div>

      {enrollingFactor && !awaitingCode ? (
        <p data-contact-factor-stale-enrolment style={hintStyle}>
          An enrolment for {enrollingFactor.destinationMask} was started but
          never verified. Start again to send a fresh code, or revoke it above.
        </p>
      ) : null}
    </section>
  );
}

// ===========================================================================
// Styles — matched to MfaRecoveryRequestPanel, which shares this card.
// ===========================================================================

const wrapStyle: CSSProperties = {
  marginTop: 16,
  padding: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const headingStyle: CSSProperties = {
  margin: "0 0 6px",
  fontSize: 15,
  fontWeight: 650,
  color: "#0f172a",
};
const mutedStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13,
  color: "#475569",
};
const mutedInlineStyle: CSSProperties = { color: "#64748b", fontWeight: 400 };
const listStyle: CSSProperties = {
  listStyle: "none",
  margin: "0 0 12px",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  background: "#f8fafc",
};
const rowTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
};
const fieldStyle: CSSProperties = { marginBottom: 12 };
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  marginBottom: 4,
};
const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 13,
  boxSizing: "border-box",
  fontFamily: "inherit",
};
const hintStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  color: "#64748b",
};
const errorTextStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  color: "#b91c1c",
};
const submitStyle: CSSProperties = {
  padding: "9px 16px",
  border: "1px solid #1d4ed8",
  background: "#1d4ed8",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
};
const secondaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
};
const statusStyle: CSSProperties = {
  marginTop: 12,
  padding: "8px 10px",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 13,
  color: "#0f172a",
};
const srOnlyStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
