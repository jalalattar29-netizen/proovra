# UC-1 — Browser extension: publication readiness (store + legal)

Status: **PUBLICATION PENDING — DRAFTS, COUNSEL REVIEW REQUIRED**
Date: 2026-09-17

This document is the pre-publication checklist for the PROOVRA browser
extension. Nothing here is published. It exists so the store submission and the
legal disclosures are prepared and reviewable, and so no surface makes a false
availability claim before the extension actually ships.

> **These are engineering drafts, not legal advice.** Every disclosure below is
> marked **[COUNSEL REVIEW REQUIRED]** and must be reviewed and approved by
> qualified counsel before it is published or submitted to any store. Do not
> ship on the strength of this document alone.

---

## 1. No false availability (enforced now)

- The extension is **not** listed on the Chrome Web Store or Edge Add-ons in
  this task, and no code claims it is.
- Marketing / web copy must not state "available on the Chrome Web Store" (or
  Edge) until the listing is live. The capture card links to
  `NEXT_PUBLIC_EXTENSION_INSTALL_URL`, which must remain unset / point to an
  internal "coming soon" state until publication — not to a store URL that does
  not yet resolve.
- The FINAL ACCEPTANCE verdict in `UC1_DIRECT_WEB_CAPTURE_IMPLEMENTATION.md`
  keeps UC-1 **NOT CLOSED**; publication is downstream of both that closure and
  counsel sign-off.

## 2. Store package readiness

| Item | State |
| --- | --- |
| MV3 manifest (`apps/extension/public/manifest.json`) | READY — least privilege (`activeTab`, `scripting`, `storage`, `identity` only; no `cookies`/`webRequest`/`<all_urls>`/`debugger`), strict CSP, no remote code. |
| Reproducible build | READY — `pnpm --filter @proovra/extension build` emits `dist/SHA256SUMS.json`; a reviewer can confirm the artifact byte-for-byte. |
| Store icons (16/32/48/128) | **PLACEHOLDER — pending brand assets.** Must be replaced with final brand icons before submission. |
| Screenshots / listing copy | **NOT DRAFTED** — required by both stores; must not overstate what is proven (no "tamper-proof web page" language; the recorded limitations govern). |
| Privacy practices form (Chrome) / data-use (Edge) | **[COUNSEL REVIEW REQUIRED]** — must match §3 below exactly. |
| Single-purpose / permission justification | DRAFTED below (§4); **[COUNSEL REVIEW REQUIRED]** for wording. |

## 3. Data-handling disclosure (extension) — [COUNSEL REVIEW REQUIRED]

Draft of what the extension does with data, to seed the store privacy form and
the extension section of Privacy / Terms / AUP / DPA. Reflects the actual code.

- **What is collected when the user invokes a capture:** the content of the page
  the user is actively viewing (viewport or full-page image, and a sanitized,
  inert DOM snapshot), a versioned capture manifest (page URL, title, timestamp,
  viewport, capture parameters), and the user's chosen workspace. Capture is
  **user-initiated per page** (`activeTab` + a click) — the extension does not
  read pages in the background and has no `<all_urls>` access.
- **Secret redaction:** password / OTP / CSRF / token field values are cleared by
  the sanitizer before upload (type + name/autocomplete heuristics; unit-tested).
  This is best-effort and must be disclosed as such, not as a guarantee.
- **Where it goes:** directly to the user's PROOVRA workspace over TLS, through
  the same server-issued capture session as every other PROOVRA acquisition. The
  extension stores only a short-lived OAuth-issued access token in
  `chrome.storage.session` (cleared on browser close); no long-lived token, no
  cookie scraping, no third-party analytics in the extension.
- **Authentication:** OAuth Authorization Code + PKCE against PROOVRA; the
  extension never sees a password.
- **What is NOT claimed:** the extension records web content as the user's
  browser rendered it; it does **not** prove the remote server's content or that
  the page was unmodified locally (recorded limitations
  `WEB_CONTENT_TRUTH_NOT_PROVEN`, `WEB_SERVER_ORIGIN_NOT_PROVEN`,
  `WEB_PAGE_STATE_AT_CAPTURE`). Disclosures must not imply otherwise.

## 4. Permission justification (single purpose) — draft

- **Single purpose:** "Capture the web page you are viewing into your PROOVRA
  evidence workspace, when you click the PROOVRA button."
- `activeTab` — read the current tab's content only after the user invokes a
  capture; no standing host access.
- `scripting` — inject the capture/sanitize routine into that tab on invocation.
- `storage` — hold the short-lived session token and per-session capture state.
- `identity` — run the OAuth (`launchWebAuthFlow`) sign-in against PROOVRA.
- Explicitly **absent:** `cookies`, `webRequest`, `<all_urls>`, `debugger`,
  remote code (forbidden by the MV3 lint and the strict CSP).

## 5. Remaining before publication (all downstream of UC-1 closure)

1. Final brand icons replace the placeholders.
2. Counsel reviews and approves the §3 disclosures and the store privacy forms.
3. Extension-specific Privacy / Terms / AUP / DPA language is finalised and
   published; the capture card's install link is pointed at the live listing.
4. Store listing copy + screenshots drafted within the recorded-limitations
   claim envelope.
5. Chrome + Edge browser acceptance passes (`pnpm uc1:acceptance:windows`) —
   the UC-1 closure gate.

None of these are engineering blockers in the codebase; they are publication and
legal steps that require assets and counsel this task cannot substitute for.
