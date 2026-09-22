# UC-1 … UC-5 — FINAL DISPOSITION

The five native acquisition use cases, each with what is CODE COMPLETE, what
is waiting on something outside this repository, and where it lives.

The distinction matters because these four things fail differently and are
fixed by different people:

| Axis | What it means |
|---|---|
| **CODE** | The implementation in this repository. Resolvable here. |
| **EXTERNAL** | A store listing, a signing identity, a published domain association. Not in this repository. |
| **PHYSICAL** | Acceptance on real hardware. Cannot be produced by any amount of code. |
| **ENVIRONMENT** | A local prerequisite (a database, a daemon) that is absent on this machine. |

A single "blocked" would collapse all four, which is how a finished
implementation ends up described as unbuilt. None of the rows below is blocked
on CODE.

---

## The canonical spine

Every one of the five writes through the SAME UC-0 acquisition spine:
`acquisitionMode` is the origin authority and `captureMethod` records
structure. Nothing below introduces a second capture model, a second session
shape, or a second way of reaching Evidence. The finalize path is the one
direct-capture session in every case.

The mode values are `packages/shared/src/evidence-acquisition.ts`
(`EVIDENCE_ACQUISITION_MODES`), not a native copy.

---

## UC-1 — Direct Web Capture (browser extension)

| Axis | State |
|---|---|
| CODE | **COMPLETE.** MV3 extension in `apps/extension`, writing `DIRECT_WEB_CAPTURE_EXTENSION` on the UC-0 spine. |
| EXTERNAL | **PENDING.** The extension is not published to a store, and the web install CTA has nowhere to point until it is. |
| PHYSICAL | n/a — a desktop browser, exercised by the extension's own e2e. |
| ENVIRONMENT | n/a |

Not a native-app row. It is listed because it shares the spine and because the
install CTA is a WEB surface whose target is external.

## UC-2 — Android Screen Capture (MediaProjection)

| Axis | State |
|---|---|
| CODE | **COMPLETE.** `DIRECT_SCREEN_CAPTURE_ANDROID`; native module + `(stack)/screen-capture.tsx`. |
| EXTERNAL | n/a |
| PHYSICAL | **PENDING** — `docs/physical-acceptance.md` row 2.19. MediaProjection cannot be exercised without an Android device: the OS consent dialog and the projection surface do not exist in a simulator. |
| ENVIRONMENT | n/a |

## UC-3 — Android continuous capture

| Axis | State |
|---|---|
| CODE | **COMPLETE.** `DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS`; streaming segmented ORIGINAL parts plus the continuity manifest, `(stack)/continuous-capture.tsx`. |
| EXTERNAL | n/a |
| PHYSICAL | **PENDING** — row 2.20. Same reason as UC-2, plus the thing continuous capture exists to prove: that a long session survives backgrounding, thermal throttling and a low-storage warning. None of those is reproducible off-device. |
| ENVIRONMENT | n/a |

## UC-4 — Derived intelligence on a captured record

| Axis | State |
|---|---|
| CODE | **COMPLETE.** Rendered on **Evidence Detail**, as a `Derived` tab. |
| EXTERNAL | n/a |
| PHYSICAL | n/a — it is a read over a record that already exists. |
| ENVIRONMENT | n/a |

**Where it belongs, and why it is not in Capture.** Derived review is a
property of a RECORD, not of an acquisition. Eligibility comes from the
record's own provenance category (`isDerivedReviewEligible`), which the detail
screen already loads — so the tab appears for a screen-capture original and
not otherwise, from one source. Putting it in Capture would have made it a
property of the session that happened to be open, which is a different and
false claim: a record captured last week is just as eligible.

## UC-5 — iOS screen capture (ReplayKit)

| Axis | State |
|---|---|
| CODE | **COMPLETE.** `DIRECT_SCREEN_CAPTURE_IOS`; Broadcast Extension target compiled and packaged on EAS, `CFBundleExecutable` and the `appExtensions` declaration in place. |
| EXTERNAL | **PENDING.** A real signing identity and provisioning profile for the Broadcast Extension. Not derivable here, and §6 forbids inventing one. |
| PHYSICAL | **PENDING.** Two device-only facts: the ReplayKit broadcast picker, and `crypto.subtle` — the simulator does not exercise the hashing path the extension uses. |
| ENVIRONMENT | n/a |

---

## Summary

| UC | CODE | EXTERNAL | PHYSICAL |
|---|---|---|---|
| UC-1 | complete | pending (store listing) | n/a |
| UC-2 | complete | n/a | pending (Android device) |
| UC-3 | complete | n/a | pending (Android device) |
| UC-4 | complete | n/a | n/a |
| UC-5 | complete | pending (signing identity) | pending (iOS device) |

**CODE is complete for all five.** Nothing on this list is waiting on work
that could be done in this repository. What remains is a store listing, a
signing identity, and two pieces of hardware.
