"use client";

/**
 * The passkey handoff ceremony (see page.tsx for why this page is public).
 *
 *   1. Read `challenge` and `token` from location.HASH — never the query —
 *      and immediately strip the fragment from history, so the capability is
 *      not left in the back stack or a shared screenshot of the address bar.
 *   2. Fetch the WebAuthn request options for that challenge (this does not
 *      spend anything) so the ceremony can start inside the person's tap —
 *      Safari refuses a passkey prompt that is not tied to a user gesture.
 *   3. On "Continue with passkey": run the ceremony and post the assertion.
 *   4. Done: tell the person, and offer the way back to the app.
 *
 * `return=app` in the fragment: the app opened this page in an auth session
 * (expo-web-browser openAuthSessionAsync). Once the SERVER accepts or refuses,
 * the page navigates itself to `proovra://step-up/complete?result=approved`
 * (or `result=denied`), which closes that session. A dismissed passkey sheet
 * is not a server answer, so it stays here with "Try again".
 *
 * Tone: a dismissed passkey sheet, an expired link, a refusal — all are
 * reported calmly with the one next step that helps. Nothing here can harm the
 * account; the worst outcome is "start again in the app".
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl } from "../../../lib/api";
import { getPasskeyAssertion } from "../../../lib/identity/webauthn";

/** The mobile app's scheme (apps/mobile/app.json `expo.scheme`). */
export const MOBILE_STEP_UP_RETURN_URL = "proovra://step-up/complete";

type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "working" }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "done" }
  | { kind: "expired" }
  | { kind: "refused" }
  | { kind: "busy" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HandoffFragment = {
  /** null when the fragment does not carry a usable challenge + token. */
  handoff: { challengeId: string; token: string } | null;
  /**
   * `return=app`: the app opened this page in an auth session
   * (expo-web-browser openAuthSessionAsync), which closes when the app's
   * return URL loads — so the page navigates there itself with the outcome.
   */
  returnToApp: boolean;
};

export function readHandoffFragment(hash: string): HandoffFragment {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const challengeId = params.get("challenge") ?? "";
  const token = params.get("token") ?? "";
  const returnToApp = params.get("return") === "app";
  if (!UUID_RE.test(challengeId) || token.length < 16 || token.length > 128) {
    return { handoff: null, returnToApp };
  }
  return { handoff: { challengeId, token }, returnToApp };
}

/** The app's return URL carrying the outcome (only ever these two values). */
export function appReturnUrl(result: "approved" | "denied"): string {
  return `${MOBILE_STEP_UP_RETURN_URL}?result=${result}`;
}

/** Indirection so tests can observe the navigation (jsdom cannot follow it). */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

async function readJson(res: Response): Promise<{ status: number; json: Record<string, unknown> | null }> {
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * Every handoff denial is the same uniform 400 (the server does not say which
 * check failed). Before the ceremony that can only mean the link is no longer
 * usable; after it, that the passkey did not confirm.
 */
function phaseForFailure(status: number, stage: "options" | "answer"): Phase {
  if (status === 429) return { kind: "busy" };
  return stage === "options" ? { kind: "expired" } : { kind: "refused" };
}

const shell: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px 16px",
  background: "var(--surface-page, #f8fafc)",
  color: "var(--ink-primary, #0f172a)",
  fontFamily: "inherit",
};
const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  padding: "28px 24px",
  borderRadius: 16,
  background: "var(--surface-card, #ffffff)",
  border: "1px solid var(--border-default, rgba(15,23,42,0.12))",
  boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
};
const muted: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: "var(--ink-secondary, #475569)",
  margin: "8px 0 0",
};
const primaryButton: React.CSSProperties = {
  display: "inline-block",
  marginTop: 20,
  padding: "11px 18px",
  borderRadius: 10,
  border: "none",
  background: "var(--brand-primary, #0f172a)",
  color: "#ffffff",
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
};

export function PasskeyHandoff() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const handoff = useRef<{ challengeId: string; token: string } | null>(null);
  const options = useRef<Record<string, unknown> | null>(null);
  const [returnToApp, setReturnToApp] = useState(false);
  const returnRef = useRef(false);

  /**
   * The server accepted or refused: with `return=app`, hand the outcome back
   * to the app's auth session (which closes when this URL loads).
   */
  const finish = useCallback((next: Phase) => {
    setPhase(next);
    if (!returnRef.current) return;
    if (next.kind === "done") navigation.assign(appReturnUrl("approved"));
    else if (next.kind === "refused" || next.kind === "expired" || next.kind === "busy") {
      navigation.assign(appReturnUrl("denied"));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const parsed = readHandoffFragment(window.location.hash);
    // Strip the fragment whatever it held: the capability must not linger in
    // history once read.
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    } catch {
      /* a history API that refuses is not a reason to stop */
    }
    returnRef.current = parsed.returnToApp;
    setReturnToApp(parsed.returnToApp);
    if (!parsed.handoff) {
      finish({ kind: "expired" });
      return;
    }
    const target = parsed.handoff;
    handoff.current = target;
    void (async () => {
      try {
        const res = await readJson(
          await fetch(`${apiBaseUrl()}/v1/identity-security/step-up/handoff/passkey/options`, {
            method: "POST",
            credentials: "omit",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ challengeId: target.challengeId, token: target.token }),
          }),
        );
        if (cancelled) return;
        const opts = res.json?.passkeyOptions;
        if (res.status !== 200 || !opts || typeof opts !== "object") {
          finish(phaseForFailure(res.status, "options"));
          return;
        }
        options.current = opts as Record<string, unknown>;
        setPhase({ kind: "ready" });
      } catch {
        if (!cancelled) setPhase({ kind: "refused" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [finish]);

  const confirmWithPasskey = useCallback(async () => {
    const h = handoff.current;
    const opts = options.current;
    if (!h || !opts) return;
    setPhase({ kind: "working" });
    const result = await getPasskeyAssertion(opts);
    if (result.status !== "ok") {
      setPhase(
        result.status === "unsupported"
          ? { kind: "unsupported" }
          : result.status === "cancelled"
            ? { kind: "cancelled" }
            : { kind: "refused" },
      );
      return;
    }
    try {
      const res = await readJson(
        await fetch(`${apiBaseUrl()}/v1/identity-security/step-up/handoff/passkey`, {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challengeId: h.challengeId, token: h.token, assertion: result.assertion }),
        }),
      );
      finish(res.status === 200 ? { kind: "done" } : phaseForFailure(res.status, "answer"));
    } catch {
      // A network failure is not the server's answer: stay, so the person
      // can still return to the app themselves.
      setPhase({ kind: "refused" });
    }
  }, [finish]);

  return (
    <main style={shell}>
      <div style={card} data-step-up-passkey-phase={phase.kind}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
          {phase.kind === "done" ? "You're confirmed" : "Confirm with your passkey"}
        </h1>

        <div aria-live="polite">
          {phase.kind === "loading" ? <p style={muted}>Getting things ready…</p> : null}

          {phase.kind === "ready" ? (
            <p style={muted}>
              The PROOVRA app asked you to confirm a sensitive action. Use your
              passkey or security key to continue.
            </p>
          ) : null}

          {phase.kind === "working" ? <p style={muted}>Waiting for your passkey…</p> : null}

          {phase.kind === "cancelled" ? (
            <p style={muted}>
              No problem — nothing was confirmed. You can try again, or go back
              to the app.
            </p>
          ) : null}

          {phase.kind === "unsupported" ? (
            <p style={muted}>
              This browser can&apos;t use passkeys. Open this link in Safari or
              Chrome, or go back to the app and choose another way to confirm.
            </p>
          ) : null}

          {phase.kind === "done" ? (
            <p style={muted}>
              Your passkey confirmed the request. Return to the PROOVRA app to
              finish.
            </p>
          ) : null}

          {phase.kind === "expired" ? (
            <p style={muted}>
              This confirmation link has expired or was already used. Go back to
              the app and start again.
            </p>
          ) : null}

          {phase.kind === "refused" ? (
            <p style={muted}>
              We couldn&apos;t confirm with that passkey. Go back to the app and
              start again — nothing was changed.
            </p>
          ) : null}

          {phase.kind === "busy" ? (
            <p style={muted}>Too many attempts for now. Wait a few minutes, then start again in the app.</p>
          ) : null}
        </div>

        {phase.kind === "ready" || phase.kind === "cancelled" ? (
          <button type="button" style={primaryButton} onClick={() => void confirmWithPasskey()}>
            {phase.kind === "cancelled" ? "Try again" : "Continue with passkey"}
          </button>
        ) : null}

        {phase.kind === "working" || phase.kind === "loading" ? null : (
          <p style={{ margin: "20px 0 0" }}>
            <a
              href={
                returnToApp
                  ? appReturnUrl(phase.kind === "done" ? "approved" : "denied")
                  : MOBILE_STEP_UP_RETURN_URL
              }
              style={phase.kind === "done" ? primaryButton : { ...muted, textDecoration: "underline" }}
            >
              Return to the PROOVRA app
            </a>
          </p>
        )}
      </div>
    </main>
  );
}
