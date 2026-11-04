/**
 * REPORT-013 — the verify page's opaque per-tab VIEW SESSION.
 *
 * A use-limited reviewer link spends one use per viewing session, not per page
 * load. The page keeps a random id in sessionStorage (one per browser tab; it
 * survives a reload, not a new tab) and sends it as `x-proovra-verify-session`.
 * The API hashes it and lets only the session that spent the link's latest use
 * reload or refresh anchoring without spending another. It is not a
 * credential: on its own it opens nothing.
 *
 * Storage can be unavailable (private mode, blocked site data). Then no id is
 * sent and every load counts, exactly as before; the page still works.
 */
const KEY = "proovra.verify.viewSession";

function randomId(): string | null {
  try {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}

/** The tab's view session id, created on first use; null when storage is unavailable. */
export function readVerifyViewSession(): string | null {
  try {
    const existing = window.sessionStorage.getItem(KEY);
    if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
    const fresh = randomId();
    if (!fresh) return null;
    window.sessionStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/** Request options carrying the view session header, when there is one. */
export function verifyViewSessionInit(): { headers?: Record<string, string> } {
  const id = readVerifyViewSession();
  return id ? { headers: { "x-proovra-verify-session": id } } : {};
}
