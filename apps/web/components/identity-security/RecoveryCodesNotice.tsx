"use client";

/**
 * B1-F-002 — what an account with a second factor still needs to stay
 * recoverable.
 *
 * Recovery codes are issued automatically only when an authenticator app is
 * set up. An account whose only factor is a phone or a passkey holds none, and
 * a personal workspace has no administrator who could reset the factor, so
 * losing that one device locks the account. PROOVRA support cannot remove a
 * second factor. This notice says so where the factor is managed, and the
 * card's action becomes "Generate recovery codes" (nothing is being replaced).
 */

export const NO_RECOVERY_CODES_COPY =
  "You have no recovery codes. If you lose access to your second factor, you will not be able to sign in, and PROOVRA support cannot remove a second factor for you. Generate recovery codes and keep them somewhere safe.";

export const SINGLE_FACTOR_COPY =
  "Only one second factor is set up. Adding another (an authenticator app, a passkey or a phone) means losing one device does not lock you out.";

/** The card's recovery-code action, worded for what it actually does. */
export function recoveryCodesActionLabel(recoveryCodesRemaining: number): string {
  return recoveryCodesRemaining > 0 ? "Regenerate recovery codes" : "Generate recovery codes";
}

export function RecoveryCodesNotice({
  activeFactorCount,
  recoveryCodesRemaining,
}: {
  activeFactorCount: number;
  recoveryCodesRemaining: number;
}) {
  if (activeFactorCount === 0) return null;
  const noCodes = recoveryCodesRemaining <= 0;
  const singleFactor = activeFactorCount === 1;
  if (!noCodes && !singleFactor) return null;
  return (
    <div data-cc-mfa-recovery-guidance style={{ marginTop: 10 }}>
      {noCodes ? (
        <p
          role="alert"
          data-cc-mfa-no-recovery-codes
          style={{
            margin: "0 0 8px",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--status-risk-border, #fca5a5)",
            background: "var(--status-risk-bg, #fef2f2)",
            color: "var(--status-risk-fg, #991b1b)",
            fontSize: 13,
          }}
        >
          {NO_RECOVERY_CODES_COPY}
        </p>
      ) : null}
      {singleFactor ? (
        <p data-cc-mfa-single-factor style={{ margin: 0, fontSize: 13, color: "var(--ink-secondary, #475569)" }}>
          {SINGLE_FACTOR_COPY}
        </p>
      ) : null}
    </div>
  );
}
