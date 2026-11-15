"use client";

/**
 * THE ACCEPTANCE STEP AFTER SIGN-IN (RT-015).
 *
 * The server already knows which policies a person has accepted, at which version.
 * So sign-in asks nothing, and this step appears, whichever way the person arrived
 * (password, Google, Apple, SSO, after an MFA challenge), only when
 * `GET /v1/users/legal-status` says a required version is outstanding. Accepting
 * records exactly those policies, at the versions the server named.
 *
 * It sits over the app, because the routes behind it answer 428 until it is done.
 * A status read that fails shows nothing: `requireLegalAcceptance` still refuses on
 * the server, so this is the way out of that refusal and never the gate itself.
 *
 * A1-06 — the server refuses every authenticated WRITE (not only a few route
 * families) until the current terms are accepted, and reads stay open. So the
 * step re-opens whenever `apiFetch` reports a 428 `LEGAL_REACCEPT_REQUIRED`
 * (terms updated while the page was open), and it can be set aside ("Not now"):
 * cancelling, exporting, closing the account and revoking must stay reachable
 * without agreeing. Accepting reloads; the status then reads current, so the
 * step cannot come back on its own — only another refused write re-opens it.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { useDialogFocus } from "../../lib/ui/dialogFocus";
import { LEGAL_REACCEPT_REQUIRED_EVENT } from "../../lib/session-events";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { Button } from "../ui/Button";

type LegalStatus = {
  requiresReacceptance: boolean;
  missingPolicies: string[];
  requiredVersions: Record<string, string>;
};

export function LegalAcceptanceStep({ active }: { active: boolean }) {
  const [status, setStatus] = useState<LegalStatus | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A1-06 — bumped when the server refuses a write for outstanding terms, so a
  // refusal after page load re-reads the status and brings the step back.
  const [recheck, setRecheck] = useState(0);
  // "Not now": cancelling, exporting, closing the account and revoking stay
  // open without accepting, so the step must not trap the person. The next
  // refused write shows it again; nothing re-opens it on its own.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!active) return;
    const onRefused = () => {
      setDismissed(false);
      setRecheck((n) => n + 1);
    };
    window.addEventListener(LEGAL_REACCEPT_REQUIRED_EVENT, onRefused);
    return () => window.removeEventListener(LEGAL_REACCEPT_REQUIRED_EVENT, onRefused);
  }, [active]);

  useEffect(() => {
    if (!active) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiFetch("/v1/users/legal-status", { method: "GET" })) as LegalStatus;
        if (!cancelled) setStatus(res);
      } catch {
        // The server's own refusal stands; there is nothing to show here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, recheck]);

  const accept = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/v1/users/legal-acceptance", {
        method: "POST",
        body: JSON.stringify({
          source: "post_sign_in",
          acceptances: status.missingPolicies.map((policyKey) => ({
            policyKey,
            policyVersion: status.requiredVersions[policyKey],
          })),
        }),
      });
      // Everything behind this step was refused while it stood.
      window.location.reload();
    } catch (err) {
      setError(toSafeUserError(err, { message: "Your acceptance could not be saved. Try again." }).message);
      setBusy(false);
    }
  }, [status]);

  const open = active && !dismissed && status?.requiresReacceptance === true;
  // F-P1-07 — a modal step keeps focus: it moves to the agreement box on open,
  // Tab stays inside, Escape is "Not now", and focus returns on close.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const agreeRef = useRef<HTMLInputElement | null>(null);
  useDialogFocus(dialogRef, open, {
    initialFocusRef: agreeRef,
    onEscape: () => {
      if (!busy) setDismissed(true);
    },
  });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      data-legal-step
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-step-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(15,23,42,0.55)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 460,
          padding: 24,
          borderRadius: 12,
          background: "var(--surface-card, #ffffff)",
          color: "var(--ink-primary, #0f172a)",
        }}
      >
        <h2 id="legal-step-title" style={{ margin: "0 0 8px", fontSize: 18 }}>
          Before you continue
        </h2>
        <p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.5 }}>
          Please review and accept our current terms to keep using PROOVRA.
        </p>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, lineHeight: 1.5 }}>
          <input
            ref={agreeRef}
            type="checkbox"
            data-legal-step-agree
            checked={agreed}
            disabled={busy}
            onChange={(e) => setAgreed(e.target.checked)}
            style={{ marginTop: 4 }}
          />
          <span>
            I agree to the <Link href="/legal/terms" target="_blank">Terms of Service</Link>,{" "}
            <Link href="/legal/privacy" target="_blank">Privacy Policy</Link> and{" "}
            <Link href="/legal/cookies" target="_blank">Cookie Policy</Link>.
          </span>
        </label>
        {error ? (
          <p role="alert" style={{ margin: "10px 0 0", fontSize: 13 }}>
            {error}
          </p>
        ) : null}
        <p style={{ margin: "12px 0 0", fontSize: 13, lineHeight: 1.5 }}>
          {/* Until the API carrying the A1-06 gate is live, the running API still refuses
              subscription cancellation for a stale user, so the copy promises only what both
              API versions allow (rollout note, 2026-11-15). */}
          Until you accept, you can still view your records, export your data, revoke shares or close your
          account.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <Button
            variant="secondary"
            onClick={() => setDismissed(true)}
            disabled={busy}
            data-legal-step-dismiss
          >
            Not now
          </Button>
          <Button
            variant="primary"
            onClick={() => void accept()}
            disabled={!agreed || busy}
            disabledReason={!agreed ? "Tick the box to accept." : undefined}
            loading={busy}
            data-legal-step-accept
          >
            Accept and continue
          </Button>
        </div>
      </div>
    </div>
  );
}
