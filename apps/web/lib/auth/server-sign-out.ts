/**
 * B8-F-001 — SIGN-OUT IS NOT BEST-EFFORT.
 *
 * The (app) layout awaited POST /v1/auth/logout inside `try {} catch {}` and
 * then cleared local state and routed to /login whatever happened. When the
 * request never reached the route (overload gate 503, network loss, a 5xx),
 * the HttpOnly `proovra_session` cookie survived: the next (app) load signed
 * the person straight back in — on a shared computer, after they were told
 * they had signed out. When the handler itself answered 503
 * `logout_incomplete`, the server session stayed alive and nothing was said.
 *
 * This reads the outcome. Only a 2xx (or a 401: there is no session left to
 * end) is a completed sign-out; everything else is reported so the caller can
 * keep the person on a "sign-out did not complete — retry" state.
 */
import { apiFetch } from "../api";

export type ServerSignOutFailure = "busy" | "network" | "incomplete" | "error";

export type ServerSignOutResult = { ok: true } | { ok: false; reason: ServerSignOutFailure };

export async function requestServerSignOut(): Promise<ServerSignOutResult> {
  try {
    await apiFetch("/v1/auth/logout", { method: "POST" }, { auth: true, retryAuthOnce: false });
    return { ok: true };
  } catch (err) {
    const e = (err ?? {}) as { statusCode?: number; status?: number; code?: string };
    const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
    const code = typeof e.code === "string" ? e.code : "";
    // A credential the server no longer accepts has no live session to end.
    if (status === 401) return { ok: true };
    if (code === "NETWORK_ERROR" || status === 0) return { ok: false, reason: "network" };
    if (code.toLowerCase() === "logout_incomplete") return { ok: false, reason: "incomplete" };
    if (code === "SERVER_BUSY" || status === 503) return { ok: false, reason: "busy" };
    return { ok: false, reason: "error" };
  }
}

export const SIGN_OUT_INCOMPLETE_TITLE = "Sign-out did not complete";

export function signOutIncompleteMessage(reason: ServerSignOutFailure): string {
  switch (reason) {
    case "network":
      return "PROOVRA could not be reached, so this session was not ended. You are still signed in on this device. Check your connection and retry.";
    case "busy":
      return "PROOVRA is busy and did not end this session. You are still signed in on this device. Retry in a moment.";
    case "incomplete":
      return "The server could not confirm that this session was ended, so it may still be active. Retry to finish signing out.";
    default:
      return "This session was not ended. You are still signed in on this device. Retry to sign out.";
  }
}
