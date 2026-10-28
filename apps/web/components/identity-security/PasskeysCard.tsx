"use client";

/**
 * PASSKEYS AND SECURITY KEYS (2026-10-28) — the account's WebAuthn factors,
 * managed from the personal security page next to the authenticator app.
 *
 * A passkey answers the STRONGEST step-up the product asks for (archiving a
 * Collaboration Team, and anything a phishing-resistant Organization gates),
 * so binding one is itself a sensitive change: the server refuses to begin a
 * registration — or to remove a passkey — without the same account
 * re-verification the authenticator-app removal uses. This card follows that
 * pattern exactly: the first attempt goes out without proof, a 401
 * STEP_UP_REQUIRED/STEP_UP_INVALID opens the shared "Verify it's you" prompt,
 * and the action is retried with the proof. Nothing here is a client-side
 * gate.
 *
 * Calm by design: dismissing the system passkey sheet is an ordinary choice,
 * reported as "nothing was changed", not as an error.
 */
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { createPasskeyCredential } from "../../lib/identity/webauthn";
import { formatUtcAuditDateTime } from "../../lib/date";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import {
  StepUpVerify,
  extractStepUp,
  type StepUpMethods,
  type StepUpProof,
} from "../../app/(app)/security-center/components/PersonalSecuritySections";

export type PasskeyRow = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
  transports: string[];
};

const LABEL_MAX = 60;

const titleStyle: React.CSSProperties = {
  margin: 0,
  marginBottom: 8,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--ink-primary, #0f172a)",
};
const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--ink-secondary, #475569)",
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  maxWidth: 320,
  padding: "9px 11px",
  borderRadius: 10,
  border: "1px solid var(--border-default, rgba(15,23,42,0.12))",
  background: "var(--surface-card, #ffffff)",
  color: "var(--ink-primary, #0f172a)",
  fontSize: 13,
};
const errorBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(179,38,30,0.06)",
  border: "1px solid rgba(179,38,30,0.35)",
  color: "#8f1d16",
  fontSize: 12,
};
const noticeBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(22, 122, 91, 0.07)",
  border: "1px solid rgba(22, 122, 91, 0.35)",
  color: "var(--success-ink, #167A5B)",
  fontSize: 12,
};
const quietBox: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "var(--surface-muted, rgba(15,23,42,0.04))",
  border: "1px solid var(--border-default, rgba(15,23,42,0.12))",
  color: "var(--ink-secondary, #475569)",
  fontSize: 12,
};

function errorCode(err: unknown): string | null {
  const e = err as { body?: { error?: { code?: string } }; code?: string } | null;
  return e?.body?.error?.code ?? e?.code ?? null;
}

function kindOf(p: PasskeyRow): string {
  if (p.transports.includes("internal") || p.backedUp) return "Passkey";
  if (p.transports.some((t) => t === "usb" || t === "nfc" || t === "ble")) return "Security key";
  return "Passkey";
}

type Pending = { kind: "add"; label: string } | { kind: "remove"; passkey: PasskeyRow };

export function PasskeysCard() {
  const { confirm } = useConfirmAction();
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quiet, setQuiet] = useState<string | null>(null);
  const [stepUpFor, setStepUpFor] = useState<Pending | null>(null);
  const [stepUpMethods, setStepUpMethods] = useState<StepUpMethods>(["reauth"]);
  const [stepUpMsg, setStepUpMsg] = useState("");

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const res = (await apiFetch("/v1/identity-security/passkeys")) as { passkeys?: PasskeyRow[] };
      setPasskeys(Array.isArray(res?.passkeys) ? res.passkeys : []);
    } catch {
      setLoadError("Your passkeys could not be loaded. Refresh the page to try again.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const resetMessages = () => {
    setError(null);
    setNotice(null);
    setQuiet(null);
  };

  /** A step-up denial re-opens the prompt; anything else is reported. */
  const surfaceOrStepUp = (err: unknown, pending: Pending, fallback: string) => {
    const su = extractStepUp(err);
    if (su) {
      setStepUpFor(pending);
      setStepUpMethods(su.methods);
      setStepUpMsg(su.message);
      return;
    }
    if (errorCode(err) === "rate_limited") {
      setError("Too many attempts. Wait a few minutes and try again.");
      return;
    }
    setError(fallback);
  };

  const addPasskey = useCallback(
    async (name: string, proof?: StepUpProof) => {
      resetMessages();
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        setError("Give the passkey a name first.");
        return;
      }
      setBusy(true);
      try {
        let begun: { options: Record<string, unknown>; ticket: string };
        try {
          begun = (await apiFetch("/v1/identity-security/passkeys/registration/options", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(proof ? { stepUp: proof } : {}),
          })) as { options: Record<string, unknown>; ticket: string };
        } catch (err) {
          surfaceOrStepUp(err, { kind: "add", label: trimmed }, "A passkey could not be added right now.");
          return;
        }
        setStepUpFor(null);
        setStepUpMsg("");

        const created = await createPasskeyCredential(begun.options);
        if (created.status !== "ok") {
          if (created.status === "cancelled") {
            setQuiet("Passkey setup was cancelled. Nothing was changed.");
          } else if (created.status === "unsupported") {
            setQuiet("This browser cannot create passkeys. Try a current version of Chrome, Edge, Safari or Firefox.");
          } else if (created.status === "already_registered") {
            setQuiet("This device or key already holds a passkey for your account.");
          } else {
            setError("The passkey could not be created. Try again.");
          }
          return;
        }

        try {
          await apiFetch("/v1/identity-security/passkeys/registration/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ticket: begun.ticket, label: trimmed, response: created.credential }),
          });
        } catch (err) {
          const code = errorCode(err);
          setError(
            code === "PASSKEY_ALREADY_REGISTERED"
              ? "This passkey is already registered."
              : "The passkey could not be registered. Start again.",
          );
          return;
        }
        setLabel("");
        setNotice(`Passkey “${trimmed}” added.`);
        await reload();
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reload],
  );

  const removePasskey = useCallback(
    async (passkey: PasskeyRow, proof?: StepUpProof) => {
      if (!proof) {
        const ok = await confirm({
          title: `Remove “${passkey.label}”?`,
          description:
            "This passkey will no longer be able to confirm sensitive actions. Any confirmation it already gave that has not been used yet stops working too.",
          confirmLabel: "Remove passkey",
          tone: "danger",
          testId: "remove-passkey",
        });
        if (!ok) return;
      }
      resetMessages();
      setBusy(true);
      try {
        await apiFetch(`/v1/identity-security/passkeys/${encodeURIComponent(passkey.id)}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof ? { stepUp: proof } : {}),
        });
        setStepUpFor(null);
        setStepUpMsg("");
        setNotice(`Passkey “${passkey.label}” removed.`);
        await reload();
      } catch (err) {
        surfaceOrStepUp(err, { kind: "remove", passkey }, "The passkey could not be removed.");
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirm, reload],
  );

  return (
    <Card variant="admin" style={{ marginBottom: 14 }} data-cc-passkeys-card>
      <section aria-labelledby="passkeys-heading">
        <h2 id="passkeys-heading" style={titleStyle}>
          Passkeys and security keys
        </h2>
        <p style={mutedStyle}>
          A passkey or hardware security key confirms sensitive actions with
          your fingerprint, face, device PIN or key — and cannot be phished.
        </p>

        {loadError ? (
          <div role="alert" style={errorBox}>
            {loadError}
          </div>
        ) : passkeys === null ? (
          <p style={{ ...mutedStyle, marginTop: 10 }} aria-live="polite" data-cc-passkeys-loading>
            Loading passkeys…
          </p>
        ) : passkeys.length === 0 ? (
          <p style={{ ...mutedStyle, marginTop: 10 }} data-cc-passkeys-empty>
            You have no passkeys yet.
          </p>
        ) : (
          <ul aria-label="Your passkeys" style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
            {passkeys.map((p) => (
              <li
                key={p.id}
                data-cc-passkey-row={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                  marginBottom: 6,
                  fontSize: 13,
                  color: "var(--ink-primary, #0f172a)",
                }}
              >
                <span>
                  <strong>{p.label}</strong>{" "}
                  <Badge tone="verified" subtle style={{ marginLeft: 6 }}>
                    {kindOf(p)}
                  </Badge>
                  <span style={{ ...mutedStyle, display: "block", marginTop: 2 }}>
                    Added {formatUtcAuditDateTime(p.createdAt)}
                    {p.lastUsedAt ? ` · Last used ${formatUtcAuditDateTime(p.lastUsedAt)}` : " · Not used yet"}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void removePasskey(p)}
                  disabled={busy}
                  aria-label={`Remove passkey ${p.label}`}
                  data-cc-passkey-remove={p.id}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void addPasskey(label);
          }}
        >
          <label htmlFor="passkey-label" style={{ ...mutedStyle, display: "block", marginBottom: 4 }}>
            Name for the new passkey
          </label>
          <input
            id="passkey-label"
            type="text"
            value={label}
            maxLength={LABEL_MAX}
            placeholder="e.g. Work laptop or YubiKey"
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
            style={inputStyle}
            data-cc-passkey-label
          />
          <div style={{ marginTop: 10 }}>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={busy}
              disabled={busy || label.trim().length === 0}
              disabledReason={label.trim().length === 0 ? "Name the passkey first." : undefined}
              data-cc-passkey-add
            >
              Add passkey
            </Button>
          </div>
        </form>

        {stepUpFor ? (
          <StepUpVerify
            title={
              stepUpFor.kind === "add"
                ? "Adding a passkey is a sensitive change. Confirm it's you to continue."
                : "Removing a passkey is a sensitive change. Confirm it's you to continue."
            }
            methods={stepUpMethods}
            initialError={stepUpMsg}
            busy={busy}
            onSubmit={(proof) => {
              if (stepUpFor.kind === "add") void addPasskey(stepUpFor.label, proof);
              else void removePasskey(stepUpFor.passkey, proof);
            }}
            onCancel={() => {
              setStepUpFor(null);
              setStepUpMsg("");
            }}
          />
        ) : null}

        <div aria-live="polite">
          {notice ? (
            <div style={noticeBox} data-cc-passkey-notice>
              {notice}
            </div>
          ) : null}
          {quiet ? (
            <div style={quietBox} data-cc-passkey-quiet>
              {quiet}
            </div>
          ) : null}
        </div>
        {error ? (
          <div role="alert" style={errorBox} data-cc-passkey-error>
            {error}
          </div>
        ) : null}
      </section>
    </Card>
  );
}
