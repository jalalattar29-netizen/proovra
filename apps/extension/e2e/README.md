# UC-1 browser acceptance (real Chrome + real Edge)

The UC-1 gate drives the PROOVRA extension itself in **Google Chrome** (Playwright
channel `chrome`) and **Microsoft Edge** (channel `msedge`) — the installed
stable browsers, never Playwright's bundled Chromium. Each test asserts the
launched browser's identity (Edge must report `Edg/`, Chrome must not) and prints
its version, so a project can never pass on the wrong browser.

For each deterministic fixture page (static, long/full-page ≥ 6 viewports, SPA,
mutating) it:

1. **Signs in through the extension's own code.** The browser carries the seeded
   user's `proovra_session` cookie (as a signed-in web session would); the popup's
   *Sign in* button makes the background run `chrome.identity.launchWebAuthFlow`
   against the real `/v1/oauth/extension/authorize`, which 302s to the extension's
   `chromiumapp.org` redirect; the PKCE-bound code is exchanged at
   `/v1/oauth/extension/token`. Nothing is written into extension storage by the test.
2. **Captures through the popup.** The popup lists the workspace from the real
   `/v1/platform/context` and the seeded case from `/v1/cases`; the Capture button
   starts the capture in the background, whose persisted status the test waits on.
   The `static` capture is filed to the seeded case at seal.
3. **Traces the sealed record** through Library → Detail → Case → Search → Report →
   Verification Package → Package Validator → Public Verify with the user's WEB
   session (the extension token is capture-scoped and may not read those routes).

Every stage is bounded and prints `PASS`/`FAIL` with its elapsed time.

## Why an E2E test build

- Chrome grants `activeTab` only on a real toolbar click, which automation cannot
  perform, and a service worker's `runtime.sendMessage` to itself is never
  delivered. `node apps/extension/build.mjs --e2e` writes **`dist-e2e/`** with
  `<all_urls>` host access and a fixed public `key` (so the extension id — and its
  OAuth redirect — is known before the API boots). The release build (`dist/`,
  `release.mjs`) refuses both (`scripts/manifest-plan.mjs`).
- Branded Chrome (≥ 137) ignores `--load-extension`, so both projects load the
  unpacked build with CDP `Extensions.loadUnpacked`
  (`--enable-unsafe-extension-debugging`).

## Run it (disposable stack only)

```bash
# From the repo root. Starts disposable Postgres/Redis/MinIO containers (uc1-acc-*),
# the API, worker, web and fixture server, runs both browsers, and tears it all down.
node scripts/uc1-acceptance-windows.mjs --start-infra --browsers=chromium,edge
# One browser / one fixture while debugging:
node scripts/uc1-acceptance-windows.mjs --start-infra --browsers=edge --grep=static
```

The harness builds its environment from `scripts/local-fixture-env` (an allowlist
that is scanned for anything off this machine before a process starts). The
extension OAuth redirect allow-list the API requires (`EXTENSION_OAUTH_REDIRECT_ALLOW`,
fail-closed) is passed as a **typed redirect allow-list** — shape-checked as an
extension `chromiumapp.org` redirect, never treated as an endpoint — so the scan is
not weakened. The harness refuses to start if any stack port (API, worker, web,
fixture) is already in use, and after the run it stops every child, reaps anything
still listening on those ports, and removes the containers.

`PROOVRA_E2E_SESSION_BEARER` is minted by `services/api/scripts/uc1-seed-acceptance.ts`
against the disposable database only; it must never be a production token.
