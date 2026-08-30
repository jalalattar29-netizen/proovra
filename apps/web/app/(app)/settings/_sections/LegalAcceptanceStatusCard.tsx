"use client";

/**
 * PHASE 12 VERTICAL A (2026-07-30) — legal acceptance STATUS.
 *
 * Wires `GET /v1/users/legal-status` into the workflow it already governs.
 * `requireLegalAcceptance` sits in front of billing, checkout and many other
 * product routes and answers `428 LEGAL_REACCEPT_REQUIRED` when the account
 * is behind on a policy version. Before this card that gate was INVISIBLE:
 * the customer saw an unexplained failure on another page with no way to
 * resolve it.
 *
 * The card is the resolution surface for that gate:
 *
 *   GET  /v1/users/legal-status      — which policies are outstanding, at
 *                                      which required version (SERVER truth)
 *   POST /v1/users/legal-acceptance  — accept exactly the outstanding ones
 *
 * Hard rules honoured here:
 *   - The SERVER decides what is required. The submitted `policyVersion` is
 *     the version the STATUS response named, never a constant compiled into
 *     the bundle and never a value the operator can influence.
 *   - The status is re-read from the server after accepting; the client never
 *     optimistically marks itself compliant.
 *   - `ok` / `requiresReacceptance` are rendered from the response, not
 *     re-derived by comparing version strings in the browser.
 *   - Loading, up-to-date, action-required, and error are distinct renders.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../../../../components/ui/Button";
import { AppStatusText } from "../../../../components/app-primitives/AppStatusText";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { captureException } from "../../../../lib/sentry";
import { useTenantGuard } from "../../../../lib/platform-context";

type LegalStatus = {
  ok: boolean;
  requiresReacceptance: boolean;
  missingPolicies: string[];
  acceptedVersions: Record<string, string | undefined>;
  requiredVersions: Record<string, string>;
};

type State =
  | { kind: "LOADING" }
  | { kind: "READY"; status: LegalStatus }
  | { kind: "ERROR"; title: string; message: string };

/** Plain-language name per policy key. Presentation only. */
const POLICY_LABEL: Record<string, string> = {
  terms: "Terms of Service",
  privacy: "Privacy notice",
  cookies: "Cookie policy",
};

/** Reader route for each policy inside the app (never the public site). */
const POLICY_HREF: Record<string, string> = {
  terms: "/settings/legal/terms",
  privacy: "/settings/legal/privacy",
  cookies: "/settings/legal/cookies",
};

function labelFor(key: string): string {
  return POLICY_LABEL[key] ?? key;
}

const muted: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

export function LegalAcceptanceStatusCard({
  onAccepted,
}: {
  /** Lets the parent re-read its own acceptance-history projection. */
  onAccepted?: () => void;
}) {
  const { stamp, isStale } = useTenantGuard();
  const [state, setState] = useState<State>({ kind: "LOADING" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const captured = stamp();
    try {
      const data = (await apiFetch("/v1/users/legal-status")) as LegalStatus;
      if (isStale(captured)) return;
      setState({ kind: "READY", status: data });
    } catch (err) {
      if (isStale(captured)) return;
      captureException(err, { feature: "settings_legal_status" });
      const safe = toSafeUserError(err, {
        message: "Your policy acceptance status could not be checked.",
      });
      setState({ kind: "ERROR", title: safe.title, message: safe.message });
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = useCallback(async () => {
    if (state.kind !== "READY") return;
    const captured = stamp();
    // Accept EXACTLY what the server said is outstanding, at the version the
    // server said is required. No client-side version constant is involved.
    const acceptances = state.status.missingPolicies.map((policyKey) => ({
      policyKey,
      policyVersion: state.status.requiredVersions[policyKey],
    }));
    if (acceptances.length === 0) return;

    setBusy(true);
    setActionError(null);
    try {
      await apiFetch("/v1/users/legal-acceptance", {
        method: "POST",
        body: JSON.stringify({ source: "settings", acceptances }),
      });
      if (isStale(captured)) return;
      // Re-read from the server — never assume the write made us compliant.
      await load();
      if (isStale(captured)) return;
      onAccepted?.();
    } catch (err) {
      if (isStale(captured)) return;
      captureException(err, { feature: "settings_legal_accept" });
      setActionError(
        toSafeUserError(err, {
          message: "Your acceptance could not be recorded. Try again in a moment.",
        }).message,
      );
    } finally {
      setBusy(false);
    }
  }, [state, stamp, isStale, load, onAccepted]);

  return (
    <div className="set-privacy__status" data-cc-legal-status={state.kind}>

      {state.kind === "LOADING" ? (
        <p style={muted} data-cc-legal-status-loading>
          Checking which policies your account has accepted…
        </p>
      ) : state.kind === "ERROR" ? (
        <div data-cc-legal-status-error>
          <p style={{ ...muted, color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
            {state.title}
          </p>
          <p style={{ ...muted, marginTop: 4 }}>{state.message}</p>
          <div className="mt-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load()}
              data-cc-legal-status-retry
            >
              Check again
            </Button>
          </div>
        </div>
      ) : state.status.requiresReacceptance ? (
        <div data-cc-legal-status-action-required>
          <p style={{ ...muted, color: "var(--ink-primary, #0f172a)" }}>
            <AppStatusText tone="amber" size="sm">
              Action needed
            </AppStatusText>{" "}
            Some parts of the product — including billing and checkout — stay
            locked until these are accepted.
          </p>
          <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
            {state.status.missingPolicies.map((key) => (
              <li
                key={key}
                data-cc-legal-status-missing={key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  flexWrap: "wrap",
                  padding: "8px 2px",
                  borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.07))",
                  fontSize: 13,
                }}
              >
                <Link
                  href={POLICY_HREF[key] ?? "/settings#privacy"}
                  style={{
                    color: "var(--ink-primary, #0f172a)",
                    fontWeight: 600,
                    textDecoration: "underline",
                  }}
                >
                  Read the {labelFor(key)} →
                </Link>
                <span style={muted}>
                  {state.status.acceptedVersions[key]
                    ? `You accepted v${state.status.acceptedVersions[key]} · v${state.status.requiredVersions[key]} is now required`
                    : `Never accepted · v${state.status.requiredVersions[key]} required`}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void accept()}
              loading={busy}
              disabled={busy}
              data-cc-legal-status-accept
            >
              I have read and accept these
            </Button>
          </div>
          {actionError ? (
            <div
              role="alert"
              className="mt-3 rounded-lg border px-3 py-2 text-[12px]"
              style={{
                borderColor: "rgba(179,38,30,0.35)",
                background: "rgba(179,38,30,0.06)",
                color: "#8f1d16",
              }}
              data-cc-legal-status-accept-error
            >
              {actionError}
            </div>
          ) : null}
        </div>
      ) : (
        <div data-cc-legal-status-current>
          <p style={{ ...muted, color: "var(--ink-primary, #0f172a)" }}>
            <AppStatusText tone="green" size="sm">
              Up to date
            </AppStatusText>{" "}
            Your account has accepted every policy version currently required.
          </p>
          <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
            {Object.keys(state.status.requiredVersions).map((key) => (
              <li
                key={key}
                data-cc-legal-status-current-row={key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  flexWrap: "wrap",
                  padding: "8px 2px",
                  borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.07))",
                  fontSize: 13,
                }}
              >
                <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
                  {labelFor(key)}
                </span>
                <AppStatusText tone="green" size="sm">
                  Up to date
                </AppStatusText>
                <span style={muted}>v{state.status.requiredVersions[key]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
