/**
 * THE built manifest — pure, so the permission contract is unit tested.
 *
 * UC-SEC-002 — the MV3 service worker and the popup call the PROOVRA API and PUT
 * the capture bytes to the presigned storage URL. Without host access to those
 * two origins every call is CORS-bound, and production depended on an
 * undocumented CORS_ORIGINS entry plus a bucket CORS rule nothing configured. A
 * RELEASE build therefore declares host access to exactly PROOVRA's own API
 * origin and the configured storage origins — never a wildcard host, never
 * `<all_urls>`. (The API additionally allow-lists the pinned extension origin in
 * its CORS policy; see EXTENSION_ALLOWED_ORIGINS.)
 *
 * UC-TQ-008 — the E2E TEST build (and only it) adds two things a real user's
 * install never has:
 *   - `<all_urls>` host access, because Chrome grants `activeTab` only on a real
 *     toolbar click, which automation cannot perform; captureVisibleTab and
 *     scripting then work on the fixture pages without a user gesture;
 *   - a fixed public `key`, so the unpacked extension has a known id and its
 *     OAuth redirect (`https://<id>.chromiumapp.org/oauth2`) can be allow-listed
 *     on the disposable API before it boots.
 * The test build is written to `dist-e2e/`, never `dist/`, and release.mjs and
 * the dist lint refuse any manifest carrying either.
 */

/**
 * PUBLIC half of the E2E build's fixed key. Not a secret: an unpacked
 * extension's `key` is the public key its id is derived from. It exists only so
 * the acceptance harness knows the id in advance.
 */
export const E2E_EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAseb2m4Fzic9wKOO+JJlnO2jSDOIwmagxY9BuHuKBJvdXHb1wj+3HjRrvmeVkk8r/PzNIgCDQXklHoeNSs6PEYR6rldSKU27hwyF8KoZ4YwxWoBXSaW4CE4hmEBzTU9+lTWc9easxayLIHKgfYof5ASCceTsjpCDcFi69WhpGGcXbiqq/gYqPT7Of9ufmDqQyaGhbckAvPZDH+omMuWt0oeBGqzqFvFwMjHuGCU96/eSTSUjv/sK9lSTtriH35J7o1A4malLqZETOq+7XrAuf7CroU193O4OnNQQmDQVd0cmFuiNxW3FCrlBNgwvmR6yiNwqV0r8tEVVswQYeVKp5kwIDAQAB";

/** The id Chrome/Edge derive from E2E_EXTENSION_PUBLIC_KEY. */
export const E2E_EXTENSION_ID = "cifdmjicbglkaoiagjhikkglbnhibdkd";

/** The redirect chrome.identity.getRedirectURL("oauth2") returns for the E2E build. */
export const E2E_OAUTH_REDIRECT = `https://${E2E_EXTENSION_ID}.chromiumapp.org/oauth2`;

/** `https://api.proovra.com` → `https://api.proovra.com/*` (host incl. port). */
export function originMatchPattern(origin) {
  let u;
  try {
    u = new URL(origin);
  } catch {
    throw new Error(`not a URL origin: ${origin}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`origin must be http(s): ${origin}`);
  if (u.username || u.password) throw new Error(`origin must not carry credentials: ${origin}`);
  if (!u.hostname || u.hostname.includes("*")) throw new Error(`origin must name one host: ${origin}`);
  return `${u.protocol}//${u.host}/*`;
}

/** Comma list → origins (blank entries dropped). */
export function parseOriginList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function planManifest(source, { apiOrigin, storageOrigins = [], e2e = false }) {
  const manifest = JSON.parse(JSON.stringify(source));
  const hosts = [originMatchPattern(apiOrigin), ...storageOrigins.map(originMatchPattern)];
  manifest.host_permissions = [...new Set(hosts)];
  if (e2e) {
    manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
    manifest.key = E2E_EXTENSION_PUBLIC_KEY;
    manifest.name = `${manifest.name} (E2E test build)`;
  } else {
    delete manifest.key;
  }
  return manifest;
}

/**
 * Problems with a BUILT release manifest: host access must be exactly the
 * configured PROOVRA origins, and nothing test-only may be present.
 */
export function releaseManifestProblems(manifest, { apiOrigin, storageOrigins = [] }) {
  const problems = [];
  const expected = new Set([originMatchPattern(apiOrigin), ...storageOrigins.map(originMatchPattern)]);
  for (const h of manifest.host_permissions ?? []) {
    if (h === "<all_urls>" || h.includes("*://") || /:\/\/\*/.test(h)) problems.push(`wildcard host permission: ${h}`);
    else if (!expected.has(h)) problems.push(`host permission not a configured PROOVRA origin: ${h}`);
  }
  if (manifest.key) problems.push("release manifest must not carry the E2E key");
  if (/E2E test build/.test(manifest.name ?? "")) problems.push("release manifest is named as the E2E test build");
  return problems;
}
