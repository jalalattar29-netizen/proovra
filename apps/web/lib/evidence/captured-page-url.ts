/**
 * B4-F-102 (Free-user audit 0ea0, web display) — the captured page address a
 * web-capture record shows, without its fragment and with credential or
 * signature parameters replaced by REDACTED.
 *
 * The extension now records the address this way (its DOM sanitizer's rule,
 * apps/extension/src/lib/sanitizer.ts SENSITIVE_QUERY_PARAMS). A record made
 * by an older extension holds the raw address; the provenance view applies the
 * same rule when it prints it, so an OAuth `#access_token=` or a signed
 * `?X-Amz-Signature=` is never shown. PURE.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
  "signature",
  "sig",
  "key-pair-id",
  "policy",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "auth",
  "authorization",
  "apikey",
  "api_key",
  "api-key",
  "key",
  "session",
  "sessionid",
  "session_id",
  "sid",
  "jwt",
  "code",
  "otp",
  "csrf",
  "csrf_token",
  "xsrf",
  "password",
  "secret",
]);

export function capturedPageAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const hashAt = raw.indexOf("#");
  const noFragment = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const queryAt = noFragment.indexOf("?");
  if (queryAt < 0) return noFragment;
  const base = noFragment.slice(0, queryAt);
  const query = noFragment.slice(queryAt + 1);
  if (!query) return base;
  const pairs = query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const rawName = eq >= 0 ? pair.slice(0, eq) : pair;
    let name = rawName;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, " "));
    } catch {
      /* keep the raw name */
    }
    return SENSITIVE_QUERY_PARAMS.has(name.trim().toLowerCase()) ? `${rawName}=REDACTED` : pair;
  });
  return `${base}?${pairs.join("&")}`;
}
