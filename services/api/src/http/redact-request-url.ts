/**
 * UC-SEC-003 — the ONE redactor for URLs written to operational logs.
 *
 * A bearer capability in a URL is still a credential. Intake-link tokens,
 * external-review access tokens, organization / team / collaboration invite
 * tokens, public-verify share tokens (`pvs_…`) and OAuth-style query values
 * (extension `code`, `state`, PKCE values) all arrive in the request URL, and
 * the request log used to write `req.url` verbatim — so every one of them
 * reached every log sink and backup, outliving its revocation window.
 *
 * The secret is replaced, not the line: the path shape stays legible so an
 * operator can still tell which endpoint was hit.
 *
 * Three independent rules, any one of which redacts:
 *   1. ROUTE PARAMETERS — when the matched route's params are known, every
 *      param whose NAME is token-bearing (`token`, `*Token`, `secret`, `code`)
 *      is replaced wherever its value sits in the path.
 *   2. TOKEN PATH PREFIXES — for requests that matched no route (404s, the
 *      probes an attacker sends), the segment after each token-bearing prefix.
 *   3. SHARE TOKENS — any path segment or query value shaped `pvs_…`.
 * Plus: the value of every token-bearing QUERY key.
 */

const REDACTED = "[redacted]";

/** Route prefixes whose NEXT path segment is a bearer token. */
const TOKEN_PATH_PREFIXES: readonly string[] = [
  "/v1/external-intake/",
  "/v1/external-review/access/",
  "/v1/org-invites/",
  "/v1/teams/invites/",
  "/v1/collaboration-team-invites/",
  "/collaboration-teams/invites/",
];

/** Param / query key names that carry a credential. */
const SECRET_KEY = /^(.*token|.*secret|code|code_verifier|code_challenge|otp|signature|x-amz-signature|x-amz-credential|x-amz-security-token|key|api_?key)$/i;

const SHARE_TOKEN = /^pvs_[A-Za-z0-9_-]+$/;

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function redactPath(path: string, params?: Record<string, unknown> | null): string {
  let out = path;

  // Rule 1 — named route parameters.
  if (params && typeof params === "object") {
    for (const [key, raw] of Object.entries(params)) {
      if (!isSecretKey(key)) continue;
      if (typeof raw !== "string" || raw.length === 0) continue;
      const encoded = encodeURIComponent(raw);
      out = out
        .split("/")
        .map((seg) => (seg === raw || seg === encoded ? REDACTED : seg))
        .join("/");
    }
  }

  // Rule 2 — token-bearing prefixes (also covers unmatched routes).
  const lower = out.toLowerCase();
  for (const prefix of TOKEN_PATH_PREFIXES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(prefix, from);
      if (at < 0) break;
      const start = at + prefix.length;
      let end = out.indexOf("/", start);
      if (end < 0) end = out.length;
      if (end > start && out.slice(start, end) !== REDACTED) {
        out = out.slice(0, start) + REDACTED + out.slice(end);
        return redactPath(out, null); // re-scan with updated indices
      }
      from = start;
    }
  }

  // Rule 3 — share-token shaped segments anywhere.
  return out
    .split("/")
    .map((seg) => (SHARE_TOKEN.test(safeDecode(seg)) ? REDACTED : seg))
    .join("/");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactQuery(query: string): string {
  if (!query) return query;
  return query
    .split("&")
    .map((pair) => {
      if (!pair) return pair;
      const eq = pair.indexOf("=");
      const key = safeDecode(eq < 0 ? pair : pair.slice(0, eq));
      const value = eq < 0 ? "" : safeDecode(pair.slice(eq + 1));
      if (eq >= 0 && (isSecretKey(key) || SHARE_TOKEN.test(value))) {
        return `${pair.slice(0, eq)}=${REDACTED}`;
      }
      return pair;
    })
    .join("&");
}

/**
 * Redact every credential from a request URL before it is logged.
 * `params` is the matched route's params when known (Fastify `req.params`).
 */
export function redactRequestUrl(url: string, params?: unknown): string {
  if (typeof url !== "string" || url.length === 0) return url;
  const q = url.indexOf("?");
  const path = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? "" : url.slice(q + 1);
  const safePath = redactPath(
    path,
    params && typeof params === "object" ? (params as Record<string, unknown>) : null,
  );
  return q < 0 ? safePath : `${safePath}?${redactQuery(query)}`;
}
