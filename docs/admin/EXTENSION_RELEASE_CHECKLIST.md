# PROOVRA Direct Web Capture — Extension Release & Store-Submission Checklist

**Status: `READY_FOR_STORE_SUBMISSION`** (repository-side closure complete; store publication and
production OAuth-client registration are external console actions — see §5/§6).

The extension is `apps/extension` (MV3). There is ONE extension; do not fork it. It authenticates with
PROOVRA via OAuth Authorization-Code + PKCE, opens a server-issued direct-capture session, and submits
captured bytes through the canonical capture-trust pipeline (`acquisitionMode = DIRECT_WEB_CAPTURE_EXTENSION`).

---

## 1. Build the production release artifact (repository-side — DONE, reproducible)

```bash
cd apps/extension
PROOVRA_API_ORIGIN=https://api.proovra.com pnpm release
```

The `release` script (`release.mjs`) is **fail-closed**:
- refuses to run without an `https://` `PROOVRA_API_ORIGIN` (no localhost/http in a release);
- validates the MV3 manifest;
- builds the production bundle (`NODE_ENV=production`, minified, no source maps, no remote code);
- **leak-scans** the bundle and refuses to ship if any localhost/dev origin survived;
- emits a deterministic **stored** ZIP at `apps/extension/release/proovra-extension-v<version>.zip`
  plus a provenance block (version, origin, file count, bytes, `sha256(zip)`).

Optional overrides (env): `PROOVRA_AUTH_AUTHORIZE_URL`, `PROOVRA_AUTH_TOKEN_URL`, `PROOVRA_OAUTH_CLIENT_ID`
(defaults derive authorize/token from `PROOVRA_API_ORIGIN` and client id `proovra-extension`).

`release/` is gitignored — the binary is not committed (per release policy). CI or the releaser produces it.

## 2. Store listing inputs (repository-side — READY)
- **Name:** `PROOVRA Direct Web Capture` (`public/manifest.json`).
- **Version:** `1.0.0` (`package.json` / manifest — bump per release).
- **Short description / description:** from the manifest (`"Preserve a web page through a PROOVRA-authorized
  capture session. PROOVRA records how and when the page was captured — not that its content is true."`).
- **Icons:** 16 / 48 / 128 real PNGs derived from the canonical PROOVRA app mark (`public/icons/`).
- **Homepage / support URL:** `https://proovra.com` / `https://app.proovra.com/settings/legal/support`.
- **Privacy / data-use disclosure inputs:** see §4. **[Counsel review required]** for the final store
  privacy declaration wording before submission.

## 3. Permission justifications (least privilege — every permission explained)
| Permission | Why it is required | Notes |
|---|---|---|
| `activeTab` | Capture the page in the tab the user explicitly acts on (click the PROOVRA action). Grants access only to that tab, only after a user gesture. | No broad tab access. |
| `scripting` | Inject the capture routine into the active tab to read the rendered DOM/pixels for the authorized capture. | Runs only during an active, user-initiated capture. |
| `storage` | Persist the short-lived OAuth session token in `chrome.storage.session` (cleared on browser close) and minimal UI state. | No long-lived secret; no API key. |
| `identity` | Run the OAuth PKCE flow via `chrome.identity.launchWebAuthFlow` and obtain the `chromiumapp.org` redirect. | No profile/email scraping. |
| `host_permissions` | **none** (empty) | Access is gated by `activeTab` + user gesture, not by broad host grants. |

No `<all_urls>`, no persistent background host access, no remote code (strict CSP:
`script-src 'self'`), no embedded credentials, no legacy/unrelated functionality.

## 4. Data-use / trust boundary (for the store privacy declaration)
- The extension transmits the captured page bytes + capture metadata to the PROOVRA API over HTTPS, only
  during a user-initiated, server-issued capture session.
- It stores only a short-lived session token (session storage). It does not collect browsing history,
  form data, credentials, or analytics.
- Trust boundary (must appear in listing + in-product): PROOVRA records **how and when** a page entered the
  evidence lifecycle; it does **not** establish that the page's content is true, who authored it, or that a
  website is genuine. **[Counsel review required]** for final privacy-policy wording.

## 5. Production OAuth client + redirect registration (EXTERNAL — required before AVAILABLE)
The extension uses `redirect_uri = chrome.identity.getRedirectURL("oauth2")` =
**`https://<EXTENSION_ID>.chromiumapp.org/oauth2`**.
- `<EXTENSION_ID>` is assigned by the Chrome Web Store at publication (or pinned via a manifest `key`).
- Server side (`services/api` extension-oauth service) must allow that exact redirect — register it via the
  `EXTENSION_OAUTH_REDIRECT_ALLOW` env (or the store-derived ID) and the `proovra-extension` public client.
  Until then the server **fails closed** (unknown redirect → rejected), so no code change presents a false
  "signed in" state.
- **Exact remaining human step:** after the store assigns the ID, set `EXTENSION_OAUTH_REDIRECT_ALLOW` to
  `https://<EXTENSION_ID>.chromiumapp.org/oauth2` in the production API environment and redeploy the API.

## 6. Chrome Web Store & Edge Add-ons submission (EXTERNAL — human console)
Chrome Web Store (https://chrome.google.com/webstore/devconsole):
1. Sign in with the PROOVRA developer account (one-time $5 registration, identity verification).
2. Upload `release/proovra-extension-v<version>.zip`.
3. Fill the listing (§2), permission justifications (§3), privacy declaration (§4, counsel-approved).
4. Submit for review. On approval, record the assigned **extension ID** and do §5.

Edge Add-ons (https://partner.microsoft.com/dashboard/microsoftedge): the SAME stored ZIP is valid (MV3
Chromium). Submit through the Edge Partner Center; no fork required. Register the Edge redirect if the ID
differs.

**Do not mark PUBLISHED until the store review completes and the ID + redirect (§5) are registered.**

## 7. Wire the /capture "Install" CTA (repository-side — config-driven, already fail-closed)
The `/capture` Direct Web Capture card shows an **Install** control ONLY when
`NEXT_PUBLIC_EXTENSION_INSTALL_URL` is a validated external store URL (Chrome Web Store / Edge Add-ons).
After publication, set that env to the store listing URL and the card flips from `COMING_SOON` to
`AVAILABLE` automatically (via the canonical `resolveWebCaptureCapabilities` authority — no code change, no
hardcoded availability boolean).

## 8. Classification ladder — where this is now
- IMPLEMENTED ✅ · INSTALLABLE INTERNALLY ✅ (`pnpm build` → `dist/`, load-unpacked) ·
  **READY_FOR_STORE_SUBMISSION ✅** (deterministic prod ZIP + this checklist) ·
  PUBLISHED_AND_INSTALLABLE ❌ (requires §5 + §6 external console actions).
