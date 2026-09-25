# G0 — BASELINE, SUPERSESSION LEDGER, HANDLER CLOSURE, WORK LEDGER

**Executed:** 2026-09-24 · **No product code changed in G0.**

---

## G0.1 Baseline — verified, not assumed

| Check | Result |
|---|---|
| `git rev-parse HEAD` | `71e148f34410c7c231f8930d1387d8924b10b4e5` |
| Identical to the audit freeze SHA? | **YES** — no source delta required |
| Branch / tracking | `main` → `origin/main` |
| Working tree | 1 untracked entry: `docs/audit/pwa-native-2026-09-24-v2/` (this audit). **0 product changes.** |
| Stashes | **7 present — none popped, none dropped** |
| Worktrees | **34 — none created, modified or removed** |

No push, deploy, EAS build, reset, clean or stash operation was performed.

---

## G0.2 Supersession ledger — historical findings re-verified against CURRENT source

The mandate requires treating audit claims as evidence to verify. Each historical
claim below was re-checked against the frozen source, **not** inherited.

| # | Historical claim | Verdict | Evidence at HEAD |
|---|---|---|---|
| H-1 | `globalThis.crypto.subtle.digest` unusable on Hermes | **FIXED** | `apps/mobile/src/upload-utils.ts:193` uses `Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)` (expo-crypto). **No live `crypto.subtle` call remains** anywhere in `apps/mobile` — the only hits are comments documenting the fix. **Do not reintroduce Web Crypto or re-report this bug.** |
| H-2 | `reserve` created durable Evidence before bytes existed; "Discard" was client-only → ghost Evidence + custody rows | **FIXED** | `apps/mobile/src/direct-capture.ts:266-274` — `discardDirectCaptureSession` posts to `/v1/capture/direct-sessions/:id/discard` and returns `{ releasedEvidenceId, discarded }`. `sealDirectCapture:251` releases on failure, best-effort, never masking the original error (`:240-242`). Staging now opens a **DRAFT** session holding no Evidence. |
| H-3 | Native single-kind capture vs web multi-kind collection plan; mixed media impossible | **FIXED** | `apps/mobile/src/capture/capture-draft.ts:82-88` — `deriveBatchEvidenceType` implements the canonical rule (single kind keeps it, **mixed → DOCUMENT**), producing one Evidence with many parts "exactly as the web produces". |
| H-4 | `NativeSharedObjectNotFoundException` on expo-audio recorder cleanup after release | **RUNTIME UNKNOWN** | `expo-audio ~0.3.5` is still a dependency (`package.json:30`). Source cannot decide whether the lifecycle defect persists. **Requires device re-test** (capture exit/unmount, interrupted recording, permission denial). |
| H-5 | AASA served with a literal `<APPLE_TEAM_ID>` | **STILL BROKEN — repo AND production** | `apps/web/public/.well-known/apple-app-site-association:6` still reads `"<APPLE_TEAM_ID>.com.jalalattar29.proovra"`. A prior **live HTTP probe** recorded 200 with the placeholder in the body (v1 `A-executive-reality-report.md:59`, `J-…:100`). |
| H-6 | 62/62 `CODE_PARITY` | **STILL FALSE** | `native-destinations.mjs` claims it unconditionally; the repo's own data gives 45% handler coverage, `/home` 13%, 0/62 physically accepted. → RC-21 / T-20. |
| H-7 | Ledger note at `native-destinations.mjs:203` claiming three gaps closed | **CONFIRMED by independent source check** | H-1, H-2 and H-3 each verified directly above rather than on the ledger's word. |

### Conflict resolved
The mandate cites Apple Team ID **`4LCZK75N86`**. That value appears **nowhere in
this repository** — not in `app.json`, `eas.json`, any doc, or any audit artifact.
It cannot be verified from source and **must not be written blind**. See G0.5.

---

## G0.3 U-1 CLOSED — all 28 handler bindings resolved

They were **not** runtime unknowns. They destructure from `EvidenceDetailCtx` (an
object literal built in `evidence/[id]/page.tsx` and passed to every `_tabs/*`
component) and from `_hooks/useEvidenceArtifactActions.ts`.

| Callable | Declared at | Effects | Endpoint |
|---|---|---|---|
| `loadWorkflowEvents` | `evidence/[id]/page.tsx:219` | API, STATE | `/v1/evidence/${id}/reviewer-workflow/events` |
| `loadWorkspace` | `page.tsx:270` | API, FEEDBACK, STATE | `/v1/evidence/${id}/review-workspace`, `/v1/cases?eligibleForEvidenceId=` |
| `openOriginal` | `page.tsx:568` | API, NAV | `/v1/evidence/${id}/original` |
| `downloadOriginal` | `page.tsx:587` | API, NAV | `/v1/evidence/${id}/original` |
| `restoreTrash` | `page.tsx:718` | API, FEEDBACK, STATE | `/v1/evidence/${id}/restore` |
| `removeCase` | `page.tsx:758` | API, FEEDBACK, STATE | `/v1/cases/${caseId}/evidence/${id}` |
| `handleRemoveRelationship` | `page.tsx:519` | API, FEEDBACK, STATE | `/v1/evidence/${id}/relationships/${relId}` |
| `downloadReport` | `_hooks/useEvidenceArtifactActions.ts:104` | API, NAV | `/v1/evidence/${id}/report/latest` |
| `downloadVerificationPackage` | `useEvidenceArtifactActions.ts:126` | API, NAV | `/v1/evidence/${id}/verification-package` |
| `links.onUnlink` | `MatterWorkspace.tsx:999` | STATE | — |
| `handlers.onOpen` | `operations/page.tsx:1840` → `setOpenId` | STATE | — |
| `handlers.onToggleMark` | `operations/page.tsx:1845` → `toggleMark` | STATE | — |

Remaining inline bindings resolved in place: DOM `.select()` focus (3), clipboard
`writeText` (1), intake-links wizard `onPatch` state (3), capture session filter (1).

**The two `operations/page.tsx` bindings are SUBSUMED by RC-12** — that route has no
native screen at all.

**`q5-closure-final.json` U-1 count: 28 → 0.** Machine record: `q5-hook-bodies.json`.

---

## G0.4 Work ledger — 1,044 child IDs

`WORK-LEDGER.json`. One row per child ID; a parent task closes only when every
child is dispositioned.

| Axis | Rows |
|---|---:|
| `UNREACHABLE` (RC-15 → T-13) | **457** |
| `CONTENT` owning files (RC-14 → T-14) | **191** |
| `CSS` genuinely unstyled (RC-09 → T-08) | **115** |
| `ENDPOINT` absent from app (RC-16 → T-15/T-11) | **111** |
| `ROUTE` (64 registered) | **64** |
| `CONTROL` absent (RC-13 → T-12) | **63** |
| `ROOT_CAUSE` RC-01…RC-25 | **25** |
| `HANDLER` — **CLOSED in G0** | **12** |
| `UC` UC-1…UC-6 | **6** |
| **TOTAL** | **1,044** |

### Arithmetic re-verified (mandate §2)
4,360 correspondences · 705 matches (47 exact + 83 copy + 204 role + 371 promoted)
· 2,732 content-absent · 69 one-hop reachable · 457 unreachable · 462 Enterprise
exclusions (upheld) · 132 shell exclusions (13 overturned) · 175 subsumed · 58
role-absent · 14 extractor artifacts. **Consistent.**

**191 owning files are requirement GROUPS, not 191 specified features** — each
still needs per-string disposition. Recorded on every `CONTENT_FILE:` row.

**The per-route matrix does include both CORE Operations screens** — verified:
`/operations` and `/operations/health`, both `NO_NATIVE_SCREEN`, both → T-11/RC-12.

---

## G0.5 Decisions required before their branches can proceed

| # | Decision | Blocks | Why it cannot be decided from source |
|---|---|---|---|
| D-1 | **Apple Team ID** — the authorized 10-character value | T-02 / RC-02 / all iOS Universal Links | `4LCZK75N86` appears nowhere in the repo. Writing an unverified ID leaves links broken *and* hides the defect. |
| D-2 | **Primitive shape** — button radius 8px vs pill 999; card 28px/translucent vs 14px/opaque; gradient vs flat | T-07 / RC-07 | Which is the product intent is a design decision, not a source fact. |
| D-3 | **Four untranslated locales** — translate `fr`/`es`/`tr`/`ru`, or stop advertising them | T-17 / RC-17 | Commercial decision. Inventing translations or deleting languages unilaterally is not acceptable. |
| D-4 | **Legal consent ordering** — PWA gates registration on a checkbox; Native creates the account then enforces server-side 428 | Wave 3 | A compliance decision with legal implications. |
| D-5 | **iOS capture UX** — implement iOS `/screen-capture` on the existing ReplayKit module, or keep routing to `/continuous-capture` with a truthful label | T-18/T-19 / RC-18/RC-19 / UC-5 | Product scope decision. |

**D-1 additionally requires an external fact the repository does not hold.**

---

## G0.6 Status

**G0 COMPLETE.** Baseline verified · 7 historical findings reconciled (3 FIXED, 1
STILL BROKEN, 1 RUNTIME UNKNOWN, 1 STILL FALSE, 1 CONFIRMED) · U-1 closed (28 → 0)
· 1,044-row executable ledger emitted · 5 decisions surfaced.

**No product code has been changed.**
