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
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
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
  }, [active]);

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

  if (!active || !status?.requiresReacceptance) return null;

  return (
    <div
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
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
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
