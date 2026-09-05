"use client";

/**
 * PHASE 12B — Authenticator self-check. Product surface for
 *
 *   POST /v1/identity/mfa/challenge/verify
 *
 * The endpoint was registered with no consumer. It verifies EITHER a live
 * TOTP code OR a backup recovery code for the SIGNED-IN operator — the
 * server derives the subject from the session, so there is no user id to
 * declare and no way to point it at anyone else.
 *
 * Why it belongs in the Security Center: before an operator changes the MFA
 * policy or resets another member's factors, they need to know their OWN
 * authenticator still works — otherwise a policy tightening can lock the
 * administrator out of their own workspace.
 *
 * SAFETY
 *   * The code is held in component state only for the duration of the
 *     submit and cleared immediately. It is never placed in a URL, in
 *     localStorage, in a log, or in an analytics payload.
 *   * The input is `autoComplete="one-time-code"` and never `type="text"`
 *     with a name that a password manager would persist.
 *   * A verified recovery code is CONSUMED by the server. The copy says so
 *     before the operator submits.
 *   * The response never contains a seed, a secret, or a new recovery code.
 */

import { useCallback, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { PageSection } from "../../../../../components/ui/PageShell";
import {
  SectionDescription,
  safeMessage,
  sectionInputStyle,
  sectionLabelStyle,
  sectionMuted,
} from "./section-state";

type Mode = "totp" | "recovery";

type Outcome =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "verified"; used: string }
  | { kind: "rejected"; message: string };

export function MfaSelfCheckSection() {
  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  const submit = useCallback(async () => {
    const value = code.trim();
    if (value.length === 0) return;
    setOutcome({ kind: "checking" });
    try {
      const res = (await apiFetch("/v1/identity/mfa/challenge/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "totp" ? { code: value } : { recoveryCode: value },
        ),
      })) as { ok?: boolean; used?: string } | null;
      setOutcome({
        kind: "verified",
        used: res?.used === "recovery_code" ? "backup code" : "authenticator code",
      });
    } catch (err) {
      setOutcome({
        kind: "rejected",
        message: safeMessage(
          err,
          "That code was not accepted. Check your authenticator's clock and try again.",
        ),
      });
    } finally {
      // Clear the entered code in every outcome — it is single-use material.
      setCode("");
    }
  }, [code, mode]);

  return (
    <PageSection
      title="Check your own authenticator"
      description={
        <SectionDescription text="Verify that your second factor still works before you tighten the policy or reset someone else's factors. This checks your own account only — the server takes the identity from your session and there is no field to point it at anyone else." />
      }
      data-mfa-self-check-section
    >
      <Card padding="comfortable">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
          <label className="adm-choice" style={{ alignItems: "center", gap: 6, fontSize: 13 }}>
            <input
              type="radio"
              name="mfa-self-check-mode"
              checked={mode === "totp"}
              onChange={() => {
                setMode("totp");
                setCode("");
                setOutcome({ kind: "idle" });
              }}
            />
            Authenticator code
          </label>
          <label className="adm-choice" style={{ alignItems: "center", gap: 6, fontSize: 13 }}>
            <input
              type="radio"
              name="mfa-self-check-mode"
              checked={mode === "recovery"}
              onChange={() => {
                setMode("recovery");
                setCode("");
                setOutcome({ kind: "idle" });
              }}
            />
            Backup code
          </label>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="mfa-self-check-code" style={sectionLabelStyle}>
            {mode === "totp"
              ? "Six-digit code from your authenticator app"
              : "One of your saved backup codes"}
          </label>
          <input
            id="mfa-self-check-code"
            type="text"
            inputMode={mode === "totp" ? "numeric" : "text"}
            autoComplete="one-time-code"
            value={code}
            maxLength={mode === "totp" ? 11 : 20}
            onChange={(e) => setCode(e.target.value)}
            style={{ ...sectionInputStyle, maxWidth: 260 }}
            data-mfa-self-check-input
          />
          <p style={{ ...sectionMuted, margin: "6px 0 0" }}>
            {mode === "totp"
              ? "Nothing changes if the code is correct — this is a read-only check."
              : "A backup code that verifies is USED UP and cannot be reused. Only run this check with a backup code if you intend to spend one."}
          </p>
          <div style={{ marginTop: 12 }}>
            <Button
              type="submit"
              variant="secondary"
              loading={outcome.kind === "checking"}
              disabled={outcome.kind === "checking" || code.trim().length === 0}
            >
              Check code
            </Button>
          </div>
        </form>

        {outcome.kind === "verified" ? (
          <div style={{ marginTop: 12 }} data-mfa-self-check-result="verified">
            <Badge tone="verified">Your {outcome.used} was accepted</Badge>
          </div>
        ) : null}
        {outcome.kind === "rejected" ? (
          <div
            style={{ marginTop: 12 }}
            role="alert"
            data-mfa-self-check-result="rejected"
          >
            <Badge tone="risk">Not accepted</Badge>
            <p style={{ ...sectionMuted, margin: "6px 0 0" }}>{outcome.message}</p>
          </div>
        ) : null}
      </Card>
    </PageSection>
  );
}

export default MfaSelfCheckSection;
