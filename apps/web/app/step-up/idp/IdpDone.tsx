"use client";

/**
 * The end of the Organization sign-in round trip.
 *
 * Three ways back, in this order:
 *   1. The mobile app started it (`return=app` remembered by /step-up/idp in
 *      this tab's sessionStorage, or `?app=1`): navigate to
 *      `proovra://step-up/complete?result=…` — the app's auth session closes
 *      when that URL loads.
 *   2. A PROOVRA page opened this as a popup (`window.opener`): post
 *      `{ type: "proovra-step-up-idp", result, reason }` to our OWN origin only
 *      and close. The opener confirms with the server; this message is a hint,
 *      never the approval.
 *   3. Otherwise show the outcome, with a link back to the app.
 *
 * Denials are calm and say the one useful next step. Nothing here reveals the
 * Organization's sign-in configuration.
 */
import { useEffect, useRef, useState } from "react";

import { IDP_RETURN_TO_APP_KEY } from "./IdpHandoff";

/** The mobile app's scheme (apps/mobile/app.json `expo.scheme`). */
export const MOBILE_STEP_UP_COMPLETE_URL = "proovra://step-up/complete";
export const IDP_STEP_UP_MESSAGE_TYPE = "proovra-step-up-idp";

const REASON_RE = /^[A-Z_]{3,48}$/;

export type IdpOutcome = { result: "approved" } | { result: "denied"; reason: string };

export function readIdpOutcome(search: string): IdpOutcome {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("result") === "approved") return { result: "approved" };
  const reason = params.get("reason") ?? "";
  return { result: "denied", reason: REASON_RE.test(reason) ? reason : "IDP_REAUTH_FAILED" };
}

export function appCompleteUrl(outcome: IdpOutcome): string {
  const params = new URLSearchParams({ result: outcome.result });
  if (outcome.result === "denied") params.set("reason", outcome.reason);
  return `${MOBILE_STEP_UP_COMPLETE_URL}?${params.toString()}`;
}

/** Indirection so tests can observe navigation and closing. */
export const idpDoneWindow = {
  assign(url: string): void {
    window.location.assign(url);
  },
  close(): void {
    window.close();
  },
};

function takeReturnToApp(search: string): boolean {
  let remembered = false;
  try {
    remembered = window.sessionStorage.getItem(IDP_RETURN_TO_APP_KEY) === "1";
    window.sessionStorage.removeItem(IDP_RETURN_TO_APP_KEY);
  } catch {
    /* storage unavailable */
  }
  return remembered || new URLSearchParams(search).get("app") === "1";
}

const DENIED_COPY: Record<string, { title: string; body: string }> = {
  IDP_CONTEXT_INSUFFICIENT: {
    title: "A stronger sign-in is required",
    body: "Your organization needs a stronger sign-in for this action than the one just used. Try again and choose the stronger option your organization offers (for example a security key), or ask your administrator.",
  },
  IDP_REAUTH_STALE: {
    title: "We need a fresh sign-in",
    body: "We couldn't confirm that you just signed in. Start the confirmation again and sign in when your organization asks.",
  },
  IDP_AUTH_TIME_MISSING: {
    title: "We need a fresh sign-in",
    body: "We couldn't confirm when you signed in. Start the confirmation again; if this keeps happening, contact your administrator.",
  },
  IDP_SUBJECT_MISMATCH: {
    title: "A different account signed in",
    body: "The account used at your organization's sign-in isn't the one that started this confirmation. Sign in with your own account and try again.",
  },
  IDP_CONNECTION_MISMATCH: {
    title: "A different sign-in was used",
    body: "This confirmation must be completed with your organization's usual sign-in. Start again from PROOVRA.",
  },
  IDP_CONNECTION_UNAVAILABLE: {
    title: "Your organization's sign-in isn't available",
    body: "Nothing was changed. Try again later, or use another confirmation method if PROOVRA offers one.",
  },
  IDP_REAUTH_EXPIRED: {
    title: "This confirmation has expired",
    body: "Confirmations are short-lived. Start again from PROOVRA.",
  },
  IDP_REAUTH_REPLAYED: {
    title: "This confirmation was already used",
    body: "Start a new confirmation from PROOVRA.",
  },
  IDP_REAUTH_CANCELLED: {
    title: "Sign-in was cancelled",
    body: "Nothing was changed. You can start the confirmation again whenever you're ready.",
  },
};
const DENIED_FALLBACK = {
  title: "We couldn't confirm it's you",
  body: "Nothing was changed. Start the confirmation again from PROOVRA.",
};

export function IdpDone() {
  const [outcome, setOutcome] = useState<IdpOutcome | null>(null);
  const [handedOff, setHandedOff] = useState<"app" | "opener" | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const search = window.location.search;
    const read = readIdpOutcome(search);
    setOutcome(read);
    if (takeReturnToApp(search)) {
      setHandedOff("app");
      idpDoneWindow.assign(appCompleteUrl(read));
      return;
    }
    const opener = window.opener as Window | null;
    if (opener && opener !== window) {
      try {
        opener.postMessage(
          {
            type: IDP_STEP_UP_MESSAGE_TYPE,
            result: read.result,
            ...(read.result === "denied" ? { reason: read.reason } : {}),
          },
          window.location.origin,
        );
        setHandedOff("opener");
        idpDoneWindow.close();
        return;
      } catch {
        /* fall through to the in-page result */
      }
    }
  }, []);

  if (!outcome) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }} data-state="loading">
        <p role="status">Finishing up…</p>
      </main>
    );
  }
  const approved = outcome.result === "approved";
  const copy = approved
    ? {
        title: "You're confirmed",
        body:
          handedOff === "opener"
            ? "You can close this window and continue in PROOVRA."
            : "Return to PROOVRA to finish what you started.",
      }
    : (DENIED_COPY[outcome.reason] ?? DENIED_FALLBACK);
  return (
    <main
      style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}
      data-state={approved ? "approved" : "denied"}
      data-reason={approved ? undefined : outcome.reason}
    >
      <h1 style={{ fontSize: "1.25rem" }}>{copy.title}</h1>
      <p role={approved ? "status" : "alert"}>{copy.body}</p>
      <p>
        <a href={appCompleteUrl(outcome)} data-testid="step-up-idp-return-app">
          Return to the PROOVRA app
        </a>
      </p>
    </main>
  );
}
