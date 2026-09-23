# PROOVRA Native — physical acceptance script

Deterministic steps for a human with real hardware. **Nothing here may be ticked
from CI.** Automated tests prove what a component renders and which request it
makes; they prove nothing about native layout, gestures, fonts, safe areas,
Hermes, or whether bytes reached storage.

Device columns: **iPhone** · **iPad** · **Android phone**. Record the build id
and OS version at the top of each run.

Builds: `eas build --profile preview --platform ios|android`. The profiles now
carry the Google client ids and API base (see `eas.json`), so a preview build is
configured — a build made before that change is not, and Google sign-in will
report `OAUTH_GOOGLE_UNCONFIGURED`.

---

## 0. Pre-flight — must be true before anything else means anything

| # | Check | How | iPhone | iPad | Android |
|---|---|---|:--:|:--:|:--:|
| 0.1 | The API runtime carries the native OAuth audiences | read the deployed container env: `GOOGLE_CLIENT_IDS` and `APPLE_CLIENT_IDS` must include the ids in `eas.json` and the iOS bundle id `com.jalalattar29.proovra`. Do **not** restart anything to find out. | ☐ | ☐ | ☐ |
| 0.2 | The build is a *preview/production* profile, not a stale dev client | check the build id against the EAS run that followed the `eas.json` change | ☐ | ☐ | ☐ |

If 0.1 is false, **section 1 Google/Apple will fail for a configuration reason,
not a code reason.** Record that rather than logging a code defect.

---

## 1. Auth

| # | Flow | Expected | iPhone | iPad | Android |
|---|---|---|:--:|:--:|:--:|
| 1.1 | Email sign-in | reaches Home; no error toast | ☐ | ☐ | ☐ |
| 1.2 | Kill and relaunch | session restores without re-entering credentials | ☐ | ☐ | ☐ |
| 1.3 | Sign out | returns to the auth gateway; relaunch does not restore | ☐ | ☐ | ☐ |
| 1.4 | Register a new account | verification-first; no session before verification | ☐ | ☐ | ☐ |
| 1.5 | **Google** | completes to a session. *Watch for:* the browser opening and never returning = the iOS reversed-client-id URL scheme; `OAUTH_GOOGLE_UNCONFIGURED` = env not inlined at build | ☐ | ☐ | ☐ |
| 1.6 | **Apple** (iOS only) | completes to a session. *A 401 on `aud` means 0.1 is false.* | ☐ | ☐ | n/a |
| 1.7 | Forgot password → email → **tap the link** | the app opens on Reset Password with the token applied | ☐ | ☐ | ☐ |
| 1.8 | Verify-email link | the app opens and verifies | ☐ | ☐ | ☐ |
| 1.9 | Invitation link | the app opens on acceptance; accepting joins the team | ☐ | ☐ | ☐ |
| 1.10 | MFA challenge (if enrolled) | TOTP and recovery code both accepted | ☐ | ☐ | ☐ |
| 1.11 | Legal acceptance gate | a 428 routes to acceptance and back | ☐ | ☐ | ☐ |

1.7–1.9 are the three screens that had **no navigation at all** before this work.
A tapped link that does nothing means the credential deep-link family regressed.

---

## 2. Capture — the lifecycle law

The rule under test: **no committed Evidence exists before explicit Finalize,
and Discard leaves none.**

| # | Flow | Expected | iPhone | iPad | Android |
|---|---|---|:--:|:--:|:--:|
| 2.1 | Open Capture | nothing is created. Check the Evidence Library in another session: unchanged | ☐ | ☐ | ☐ |
| 2.2 | Stage one photo | a draft exists; **the library still shows no new record** | ☐ | ☐ | ☐ |
| 2.3 | **Discard** | library unchanged; no empty record in Active *or* Trash | ☐ | ☐ | ☐ |
| 2.4 | Photo → Finalize | reaches `SIGNED`; opens in the library | ☐ | ☐ | ☐ |
| 2.5 | Video → Finalize | `SIGNED` | ☐ | ☐ | ☐ |
| 2.6 | Audio: record, stop, Finalize | `SIGNED` | ☐ | ☐ | ☐ |
| 2.7 | Document pick → Finalize | `SIGNED` | ☐ | ☐ | ☐ |
| 2.8 | **Mixed media**: audio, then photo, then document, in ONE session | all three stage; the switch is **not refused**; Finalize yields ONE record of type `DOCUMENT` with three parts | ☐ | ☐ | ☐ |
| 2.9 | Stage three, remove one, Finalize | two parts, no orphan | ☐ | ☐ | ☐ |
| 2.10 | Remove the LAST staged item | the draft is discarded; no record appears | ☐ | ☐ | ☐ |
| 2.11 | **Large video (≥1 GB)** → Finalize | `SIGNED`, **no out-of-memory**. The file is read in 3 MiB chunks into one exact-size buffer; a crash here is the known incremental-digest limit | ☐ | ☐ | ☐ |
| 2.12 | Kill the app mid-upload, relaunch, resume | completes; **no duplicate parts** | ☐ | ☐ | ☐ |
| 2.13 | Airplane mode mid-upload, restore | recovers or fails honestly — never a silent success | ☐ | ☐ | ☐ |
| 2.14 | Public-verify a finalized record | the verification page resolves | ☐ | ☐ | ☐ |

### 2b. The recorder crash

| # | Flow | Expected | iPhone | iPad | Android |
|---|---|---|:--:|:--:|:--:|
| 2.15 | Enter and leave Capture **20×**, cycling all four sources | zero exceptions. *`NativeSharedObjectNotFoundException` / "Calling the 'get' function has failed" = regression* | ☐ | ☐ | ☐ |
| 2.16 | Start audio, navigate away **while recording** | stops cleanly on blur; no crash | ☐ | ☐ | ☐ |
| 2.17 | Background and foreground during audio | no crash | ☐ | ☐ | ☐ |

### 2c. Native acquisition sources (UC-2 / UC-3 / UC-5)

Reached from **Capture → "Other capture sources"**. They must **not** appear on Home.

| # | Flow | Expected | iPhone | iPad | Android |
|---|---|---|:--:|:--:|:--:|
| 2.18 | UC-5 ReplayKit: start, record, stop | segments discovered, manifest built, `SIGNED` | ☐ | ☐ | n/a |
| 2.19 | UC-2 MediaProjection | `SIGNED` | n/a | n/a | ☐ |
| 2.20 | UC-3 continuous | continuity manifest, `SIGNED` | n/a | n/a | ☐ |
| 2.21 | Home shows no screen-capture entry | confirmed absent | ☐ | ☐ | ☐ |

2.18–2.20 are the first real test of the crypto fix on a native path. "Web Crypto
API is not available" appearing anywhere = regression.

---

## 3. Product surfaces

| # | Surface | Check | iPhone | iPad | Android |
|---|---|---|:--:|:--:|:--:|
| 3.1 | Home | summary band, five KPIs, priority queue, recent evidence, matters, storage — against real data | ☐ | ☐ | ☐ |
| 3.2 | Home with a failing dashboard | says so; does **not** render "All clear" or zeroes | ☐ | ☐ | ☐ |
| 3.3 | Evidence Library | scopes, search, filters, paging | ☐ | ☐ | ☐ |
| 3.4 | Evidence detail | custody, integrity, artifacts, technical metadata | ☐ | ☐ | ☐ |
| 3.5 | Cases list + detail | status change, notes, evidence links | ☐ | ☐ | ☐ |
| 3.6 | Search | query, family filter, typeahead, count, paging, result opens | ☐ | ☐ | ☐ |
| 3.7 | Notifications | severity order, filters, read/unread/dismiss, mark-all | ☐ | ☐ | ☐ |
| 3.8 | **Reports** | six counters, lifecycle filters, paging, row opens evidence | ☐ | ☐ | ☐ |
| 3.9 | **Settings › Security**: change password | succeeds; the event appears in activity | ☐ | ☐ | ☐ |
| 3.10 | Settings › Security: sessions | this device marked; **sign out others** works | ☐ | ☐ | ☐ |
| 3.11 | Settings › Security: remove a 2FA method | states the consequence; requires confirmation | ☐ | ☐ | ☐ |
| 3.12 | Trust Center | sections load independently; a locked plan says "not included", never "nothing here" | ☐ | ☐ | ☐ |
| 3.13 | Billing | plan and usage render | ☐ | ☐ | ☐ |
| 3.14 | Every primary nav destination | reachable; back behaves | ☐ | ☐ | ☐ |

---

## 4. Responsive and accessibility

| # | Check | iPhone | iPad ⟂ | iPad ⟷ | Android |
|---|---|:--:|:--:|:--:|:--:|
| 4.1 | No clipping or horizontal scroll | ☐ | ☐ | ☐ | ☐ |
| 4.2 | Tablet **rail** nav at ≥840 pt (not a stretched phone) | n/a | ☐ | ☐ | ☐ |
| 4.3 | Safe areas respected (notch, home indicator) | ☐ | ☐ | ☐ | ☐ |
| 4.4 | Keyboard does not cover the focused field | ☐ | ☐ | ☐ | ☐ |
| 4.5 | Rotation preserves state | n/a | ☐ | ☐ | ☐ |
| 4.6 | **RTL** (Arabic): layout mirrors, text aligns | ☐ | ☐ | ☐ | ☐ |
| 4.7 | German: long labels wrap, do not truncate mid-word | ☐ | ☐ | ☐ | ☐ |
| 4.8 | Every control ≥44 pt | ☐ | ☐ | ☐ | ☐ |
| 4.9 | Screen reader announces labelled fields and their errors | ☐ | ☐ | ☐ | ☐ |

---

## 5. Design comparison against the PWA

Open the same surface on both, side by side, at a comparable width.

| # | Surface | Compare | iPhone | iPad | Android |
|---|---|---|:--:|:--:|:--:|
| 5.1 | Auth | background, branding, field treatment, legal area | ☐ | ☐ | ☐ |
| 5.2 | Home | page background, card surfaces, KPI treatment, type scale | ☐ | ☐ | ☐ |
| 5.3 | Evidence Library | row density, badges, filter controls | ☐ | ☐ | ☐ |
| 5.4 | Evidence detail | section hierarchy, status tones | ☐ | ☐ | ☐ |
| 5.5 | Settings | grouping, list-row treatment | ☐ | ☐ | ☐ |
| 5.6 | Status badges across surfaces | the same tone means the same thing | ☐ | ☐ | ☐ |

Record every divergence with a screenshot pair. A divergence traceable to a
token is a bug in the generator or the adapter; one traceable to composition is
a missing component family.

---

## 6. What a failure here means

| Symptom | Almost certainly |
|---|---|
| "Web Crypto API is not available" | the native digest path regressed |
| `NativeSharedObjectNotFoundException` | the recorder is being touched after release again |
| an empty record after Discard | staging reserved Evidence again |
| `OAUTH_GOOGLE_UNCONFIGURED` | `EXPO_PUBLIC_GOOGLE_*` not inlined — build config, not code |
| Google opens a browser and never returns | the iOS reversed-client-id URL scheme |
| Apple 401 on `aud` | pre-flight 0.1 — the API runtime lacks the native audience |
| a tapped email link does nothing | the credential deep-link family regressed |
| out-of-memory on a large video | the known incremental-digest limit |

---

## UC-6 build for this script (2026-09-23)

An internal-distribution Android build was produced from `uc6-public-launch`
on EAS using the existing keystore (`Build Credentials hQGv5KPYxF`) — no new
signing material was created:

    build id  1bb438ab-d353-4f54-8aaa-858def204906
    profile   preview (internal distribution)
    version   1.0.0 (build 17)
    artifact  https://expo.dev/artifacts/eas/PtEnbdW1C412odTZLwxLv-GwlpP04N7-CKfXBu72ZTg.apk

The FIRST attempt from this branch — 3472ff2d — ERRORED in the Bundle
JavaScript phase, and that failure is the reason the metro config now exists:
a TYPE-only `react` path mapping was being read by Metro as a runtime one, so
the app had not been bundlable since that mapping landed. The build above is
from the fix.

iOS credentials also exist on the account (earlier builds FINISHED), so an
equivalent `eas build --profile preview --platform ios` is producible without
creating anything new.

**No row in this script was ticked by the UC-6 phase.** No device was
available to it, and a build is not an acceptance: the whole point of this
file is that layout, gestures, fonts, safe areas, Hermes and whether bytes
reached storage are things only hardware can answer.

Two UC-6 changes are worth exercising deliberately when this script is next
run on a device:

* **Mixed origin.** Stage a screen recording, then try to add a photo to the
  same session. The app must explain why they need separate records, offer to
  finish the current capture, and keep everything staged either way. Before
  UC-6 it silently sealed both into one record under the screen's origin.
* **Failure copy.** Force a refusal the product has words for — a locked
  record, a plan limit — and confirm the phone states the reason rather than
  "Something went wrong. Please try again."
