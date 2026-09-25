# E — FINAL RUNTIME VALIDATION PLAN

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5`

Source inspection cannot prove any of the items below. Each names the **minimum
safe diagnostic** — no credential, token, cookie, bearer header or request body
is ever required, and none should be captured.

> **Nothing in the source audit proves any physical-device problem fixed.**
> A green diagnostic here is the only evidence that closes these.

---

## Safety rules for every diagnostic

1. Record **status codes and sanitized paths only**. Never bodies, headers or query strings that may carry tokens.
2. Redact any path segment that is a token: `/v1/external-intake/<TOKEN>/...` → `/v1/external-intake/{token}/...`.
3. `printenv` output: report **presence and shape** (`set / not set`, id prefix), never a secret's value.
4. Never ask anyone to paste a session token, OAuth token or `.env` file.

---

## RV-01 · OAuth audience allow-list  ·  closes RC-01 (confidence B → A)

**Question:** does the deployed API accept the native token audiences?
**Diagnostic (choose one):**
* On the API host: `printenv GOOGLE_CLIENT_ID GOOGLE_CLIENT_IDS APPLE_CLIENT_ID APPLE_CLIENT_IDS` — report only whether each is **set**, and whether the *iOS* client id prefix `548168595768-uhuga…` and the bundle id `com.jalalattar29.proovra` appear.
* Or from the device: attempt Apple sign-in and report the **HTTP status** of `POST /v1/auth/apple` plus the server's error **code** (not the token).

**Expected if RC-01 holds:** 4xx with an audience/`Invalid aud` failure.
**Acceptance after T-01:** 200, and a session is established.

## RV-02 · iOS Universal Links  ·  closes RC-02 (already A; this confirms the deploy)

**Diagnostic:** `curl -sSI https://www.proovra.com/.well-known/apple-app-site-association` (status + content-type), then `curl -s … | head -8` — the appID line is **not** a secret.
**Expected today:** `<APPLE_TEAM_ID>` present.
**Acceptance after T-02:** a real 10-character Team ID; on a device with the app installed, an emailed `/verify/<token>` link opens the **app**. Repeat for one `/intake/*` and one `/portal/*`.

## RV-03 · Empty Home / Cases / Evidence / Reports / Notifications  ·  RC-16, and rules out RC-01 as the cause

**Do not assume one cause.** For **one** affected screen:
1. The `activeSpace.id` the device reports from `/v1/platform/context`, compared with the workspace id the **web** session shows for the same account. *(Ids are opaque and workspace-scoped; safe to compare.)*
2. For each request that screen makes: **method + sanitized path + status code**. Nothing else.

**Reading the result:**
| Observation | Conclusion |
|---|---|
| requests 200 with empty collections | data genuinely absent for that workspace — **not** a native defect |
| requests 401/403 | authorization, upstream of the screen → RV-01 |
| the expected endpoint is **never requested** | RC-16 (absent from the app) — source-confirmed |
| requests 200 with data but the screen is empty | a **mapping** defect; capture the response **shape** (key names only, no values) |
| `activeSpace.id` differs from the web's | workspace-selection defect — **ruled out by source**, so this would be a new finding |

## RV-04 · ReplayKit capture finalization (iOS)  ·  RC-18, RC-19  ·  UC-5

**Source establishes:** the label lies (`continuous-capture.tsx:415,417`) and iOS has no `/screen-capture` (`screen-capture.tsx:57`). It does **not** establish which execution stage failed on the iPad.

**Diagnostic — stage markers, in order:**
| # | Stage | Observable |
|---|---|---|
| 1 | broadcast picker appears | yes/no |
| 2 | segments written to the App Group | file **count**, not contents |
| 3 | `drainUploads()` settles | yes/no |
| 4 | `stageContinuousCapture` | per-part `PUT` **status codes** |
| 5 | `sealDirectCapture` | status of the completion request |
| 6 | `openCaptureDraft` / `saveCaptureSession` | status |
| 7 | UI | which message appeared |

Stage 1 tests the ReplayKit extension's **signing identity** (UC-5 EXTERNAL-pending). Stages 2–3 test the App Group handoff. Stage 4+ tests the canonical session.
**Why this is needed:** today every failure in that five-step chain collapses to one string (`:343`) and the session is terminal (`:340-342`) — so the user cannot tell you which stage broke. **T-18 makes this diagnosable in-product.**

## RV-05 · Broadcast Extension hashing on a real device  ·  UC-5 PHYSICAL

`uc-disposition.md` lists `crypto.subtle` as device-only. The **JS** path is closed — `src/upload-utils.ts:193` uses `expo-crypto`. If a concern remains it is the **Swift** extension's own hashing, which the simulator does not exercise.
**Diagnostic:** one real-device capture; confirm the server **accepts** the declared digests (status only).

## RV-06 · Native font rendering  ·  RC-04

Source is already decisive: `expo-font` absent, no `useFonts`, **zero font files**.
**Acceptance after T-04:** one device screenshot of `/home` showing the product typeface, and one in `ar` showing Noto Sans Arabic.

## RV-07 · Sidebar and auth artwork  ·  RC-05, RC-06

**Acceptance after T-05/T-06:** device screenshots of the tablet rail, `/login` and `/register` showing the artwork with light nav ink and legible labels.

## RV-08 · The `.app-shell-v2` background cascade  ·  U-4

`.app-shell-v2` has **5 competing rules**, one re-declaring `background-image: none`. Source cannot say which wins.
**Diagnostic:** in a desktop browser, the computed `background-image` of `.app-shell-v2` at one wide and one narrow breakpoint. *(This is a PWA-side question and the only item here that needs a browser — it is **not** part of the native audit.)*

## RV-09 · Global search reachability  ·  RC-10

**Acceptance after T-09a:** from each of the 7 primary destinations, search is reachable without returning to Home.

## RV-10 · Android acceptance  ·  UC-2, UC-3

`docs/uc6-release-acceptance.md:76` records **NOT_TESTED**. Run `apps/mobile/docs/physical-acceptance.md` on an Android device.

## RV-11 · The 28 hook-returned handlers  ·  U-1 — **audit work, not runtime**

These are **statically resolvable**; they were not finished. Read ~6 hooks (`useEvidenceArtifacts`, `useWorkflowEvents`, `useCaseLinks`, …), map each returned key to its body, and close them in `q5-closure-final.json`. **No device needed.**

---

## Execution order

```
RV-01, RV-02        first — they gate every authenticated test
RV-03               once sign-in works
RV-04, RV-05        after T-18 makes stages diagnosable
RV-06, RV-07, RV-09 after W1/W2 land
RV-10               Android device
RV-08, RV-11        independent (RV-11 needs no device)
```

**None of these has been run. This audit produced no runtime evidence of any kind.**
