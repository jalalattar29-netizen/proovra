"use client";

/**
 * The IdP handoff (see page.tsx for why this page is public).
 *
 *   1. Read `challenge` and `token` from location.HASH — never the query — and
 *      strip the fragment from history at once, so the capability is not left
 *      in the back stack or a screenshot of the address bar.
 *   2. `return=app` in the fragment (the app opened this page in an auth
 *      session) is remembered in sessionStorage for this tab, so the result
 *      page — reached after the IdP round trip — knows to hand the outcome
 *      back to the app.
 *   3. POST the pair to the begin endpoint (body, not URL) and go to the
 *      forced sign-in at the Organization's identity provider.
 *
 * A refused or expired link is reported calmly with the one next step.
 */
import { useEffect, useRef, useState } from "react";
import { IdpDone } from "./IdpDone";

import { apiBaseUrl } from "../../../lib/api";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** sessionStorage key: this tab's round trip was started by the mobile app. */
export const IDP_RETURN_TO_APP_KEY = "proovra.stepUpIdp.returnToApp";

export type IdpHandoffFragment = {
  handoff: { challengeId: string; token: string } | null;
  returnToApp: boolean;
};

export function readIdpHandoffFragment(hash: string): IdpHandoffFragment {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const challengeId = params.get("challenge") ?? "";
  const token = params.get("token") ?? "";
  const returnToApp = params.get("return") === "app";
  if (!UUID_RE.test(challengeId) || token.length < 16 || token.length > 128) {
    return { handoff: null, returnToApp };
  }
  return { handoff: { challengeId, token }, returnToApp };
}

/** Indirection so tests can observe the navigation (jsdom cannot follow it). */
export const idpNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

function rememberReturnToApp(returnToApp: boolean): void {
  try {
    if (returnToApp) window.sessionStorage.setItem(IDP_RETURN_TO_APP_KEY, "1");
    else window.sessionStorage.removeItem(IDP_RETURN_TO_APP_KEY);
  } catch {
    /* storage unavailable: the result page falls back to its other paths */
  }
}

type Phase =
  | { kind: "starting" }
  | { kind: "redirecting" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "unavailable" }
  | { kind: "context" }
  | { kind: "busy" }
  | { kind: "failed" };

const COPY: Record<Exclude<Phase["kind"], "starting" | "redirecting">, { title: string; body: string }> = {
  invalid: {
    title: "This link can't be used",
    body: "It may already have been used, or it was copied incompletely. Go back to PROOVRA and start the confirmation again.",
  },
  expired: {
    title: "This link has expired",
    body: "Confirmation links are short-lived. Go back to PROOVRA and start the confirmation again.",
  },
  unavailable: {
    title: "Your organization's sign-in isn't available right now",
    body: "Nothing was changed. Try again in a few minutes, or use another confirmation method if PROOVRA offers one.",
  },
  context: {
    title: "A stronger sign-in is required",
    body: "Your organization requires a stronger confirmation for this action than its sign-in can provide here. Use a passkey or security key, or ask your administrator.",
  },
  busy: {
    title: "Too many attempts",
    body: "Please wait a few minutes, then start the confirmation again from PROOVRA.",
  },
  failed: {
    title: "We couldn't start the sign-in",
    body: "Nothing was changed. Check your connection and start the confirmation again from PROOVRA.",
  },
};

function IdpHandoffStart() {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const { handoff, returnToApp } = readIdpHandoffFragment(window.location.hash);
    // The fragment is a capability: drop it from the address bar and history.
    try {
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      /* best-effort */
    }
    rememberReturnToApp(returnToApp);
    if (!handoff) {
      setPhase({ kind: "invalid" });
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`${apiBaseUrl()}/v1/identity-security/step-up/handoff/idp/begin`, {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId: handoff.challengeId, token: handoff.token }),
        });
        const json = (await res.json().catch(() => null)) as
          | { redirectUrl?: string; error?: { code?: string } }
          | null;
        if (res.status === 200 && typeof json?.redirectUrl === "string" && /^(https:\/\/|http:\/\/localhost[:/])/i.test(json.redirectUrl)) {
          setPhase({ kind: "redirecting" });
          idpNavigation.assign(json.redirectUrl);
          return;
        }
        if (res.status === 429) return setPhase({ kind: "busy" });
        const code = json?.error?.code;
        if (code === "IDP_REAUTH_EXPIRED") return setPhase({ kind: "expired" });
        if (code === "IDP_CONNECTION_UNAVAILABLE") return setPhase({ kind: "unavailable" });
        if (code === "IDP_CONTEXT_INSUFFICIENT") return setPhase({ kind: "context" });
        if (code === "STEP_UP_HANDOFF_INVALID") return setPhase({ kind: "invalid" });
        setPhase({ kind: "failed" });
      } catch {
        setPhase({ kind: "failed" });
      }
    })();
  }, []);

  if (phase.kind === "starting" || phase.kind === "redirecting") {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }} data-state={phase.kind}>
        <h1 style={{ fontSize: "1.25rem" }}>Confirm with your organization sign-in</h1>
        <p role="status">Taking you to your organization&apos;s sign-in page…</p>
      </main>
    );
  }
  const copy = COPY[phase.kind];
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }} data-state={phase.kind}>
      <h1 style={{ fontSize: "1.25rem" }}>{copy.title}</h1>
      <p role="alert">{copy.body}</p>
    </main>
  );
}

/**
 * /step-up/idp is ONE surface with two moments: the start of the Organization
 * sign-in (the handoff token in the fragment) and its end (the API returns the
 * browser here with `?result=approved|denied`).
 */
export function IdpHandoff() {
  const [phase, setPhase] = useState<"start" | "done" | null>(null);
  useEffect(() => {
    setPhase(new URLSearchParams(window.location.search).has("result") ? "done" : "start");
  }, []);
  if (phase === null) return null;
  return phase === "done" ? <IdpDone /> : <IdpHandoffStart />;
}
