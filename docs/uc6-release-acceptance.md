# UC-6 — RELEASE ACCEPTANCE MATRIX AND CONTROLLED LAUNCH PLAN

Branch `uc6-public-launch`, cut from the verified `origin/main`
(`7a6bd8cc2e349489446689ad4012a984ae00398c`, confirmed against the remote
rather than assumed from the brief).

Every status below is one of `PASS`, `FAIL`, `BLOCKED_EXTERNAL`, `NOT_TESTED`,
`NOT_APPLICABLE`. **No category inherits another category's result.** Code
readiness is not device acceptance, and neither is launch readiness.

---

## A. WHAT "VERIFIED" MEANS IN EACH COLUMN

| Column | What it is evidence of | What it is NOT evidence of |
|---|---|---|
| Automated suites | the behaviour the code exhibits under the harness | that a person can use it |
| Live-database integration | real PostgreSQL 16, real routes, real object store | production data or production scale |
| Playwright layout projects | computed styles and focus in a real engine, on the production bundle | anything about a phone |
| Physical acceptance | a human with hardware executed the script | anything a CI run can claim |

---

## A2. CI ON THIS BRANCH

All three workflows are green on `4247636aa`:

| workflow | conclusion |
|---|---|
| `ci` | **success** |
| `playwright-e2e` | **success** |
| `schema-reproducibility` | **success** |

`ci` was red at every intermediate commit, for a different real reason each
time, and each was fixed at its cause rather than routed around:

1. Docker Hub rate-limited the anonymous MinIO pull (exit 125) → pinned quay.io
   release, the image `playwright-e2e.yml` already uses here.
2. The full-stack smoke test posted its own stale legal versions and 400'd
   before reaching the capture it exists to prove.
3. Four line-anchored capability sites moved when the error and mixed-origin
   work inserted lines above them.
4. Two imports left unused after the dictionary moved to `@proovra/shared`.
5. The audit engine's freshness gate, on artifacts the bundling work changed.

`playwright-e2e` went green at the first UC-6 commit — the first time that
workflow has passed, after 86 tests had been failing on one stale string.

---

## B. RELEASE ACCEPTANCE MATRIX

| # | Category | Status | Evidence |
|---|---|---|---|
| 1 | Web production code | **PASS** | `apps/web` typecheck clean, lint 0 errors (1 pre-existing warning in `SurfaceGate.tsx`, untouched by this branch), 3222 node:test + 1470 render tests pass, production build succeeds |
| 2 | API | **PASS** | 25 194 unit cases (1 skipped), 819/819 files, on a clean tree |
| 3 | Database | **PASS** | clean boot of every migration from empty on disposable PostgreSQL 16; `db:drift-check` OK; `db:raw-schema-verify` 880 objects / 0 divergences; `db:preflight` 4 pass / 1 warn (historical destructive patterns, pre-existing) |
| 4 | Workers | **PASS** | 974/974, 65/65 files, including the five verification-package cases against a real MinIO |
| 5 | Object storage | **PASS** | streaming publication, exact-size HEAD, server-side promotion and stale-staging reconciliation proven against real MinIO rather than a double |
| 6 | UC-0a provenance truth | **PASS (code)** | one acquisition authority in `@proovra/shared`; uploads are `isDirectCapture: false` with `CREATION_NOT_OBSERVED_BY_PROOVRA`; the AI path reads acquisition, never the structure enum; no forbidden authenticity claim found in any client |
| 7 | UC-0b attestation truth | **PASS (code)** | canonical materials DOWNGRADE a claimed `ANCHORED` OTS state to `PENDING` when no txid or anchored-at time is present, and record why; TSA failure is `FAILED` + `TIMESTAMP_FAILED`, never silent |
| 8 | UC-0c derivative lifecycle | **PASS (code)** | `EvidencePart.artifactClass` is `ORIGINAL` or `CAPTURE_MANIFEST` only; derived assets carry their own kinds and transformations; UC-4 kinds are separate |
| 9 | UC-1 Direct Web Capture | **PASS (code)** · **BLOCKED_EXTERNAL (publication)** | extension builds and its MV3 manifest lints; the capture card states the truthful unavailable state because `NEXT_PUBLIC_EXTENSION_INSTALL_URL` is set nowhere in the repository. No store listing exists |
| 10 | UC-2 Android screen capture | **PASS (code)** · **NOT_TESTED (device)** | integration suite against live PostgreSQL; MediaProjection path unchanged by UC-6 |
| 11 | UC-3 continuous capture | **PASS (code)** · **NOT_TESTED (device)** | ordered segments, continuity manifest, refusals for non-contiguous / duplicate / substituted segments, all against live PostgreSQL |
| 12 | UC-4 derived intelligence | **PASS (code)** | media-intelligence run kinds and derived-asset contracts covered by the API suites |
| 13 | UC-5 iOS broadcast | **PASS (code)** · **NOT_TESTED (device)** | 8 integration cases against live PostgreSQL, including the defect regression where the shared continuity validator accepted Android and refused iOS |
| 14 | Android physical acceptance | **NOT_TESTED** | no device available to this session. An internal-distribution build was produced on EAS from this branch; the script is `apps/mobile/docs/physical-acceptance.md` |
| 15 | iPhone physical acceptance | **NOT_TESTED** | same. iOS credentials exist on the EAS account (previous builds FINISHED), so a build is producible |
| 16 | iPad physical acceptance | **NOT_TESTED** | same |
| 17 | Extension store readiness | **BLOCKED_EXTERNAL** | packaging exists; Chrome Web Store and Edge Add-ons submission, listing copy and review are outside the repository and were not performed |
| 18 | Security | **PASS (targeted review)** | see §C. This is a source-and-tests review against disposable infrastructure — **not** a penetration test |
| 19 | Accessibility | **PASS (measured surfaces)** | `operations-layout` 194/194 after the gate was repaired; `settings-layout` 74; `search-layout` 382; `capture-layout` 32; intake + evidence-detail + attention 230 |
| 20 | Functional parity | **PASS (code)** | 62/62 NATIVE_REQUIRED surfaces; contract audit 79/79 with 0 UNRESOLVED; action inventory 218 actions with 0 reserved and 0 reserved links |
| 21 | Error and recovery UX | **PASS (repository-resolvable)** | see §D. 441 codes inventoried; native went from 15 to 83 answered with the product's own copy; the capture screens stopped rendering raw thrown text |
| 22 | Monitoring | **NOT_TESTED** | configuration reviewed, not exercised. No production contact was made |
| 23 | Backup and restoration | **NOT_TESTED** | a restoration rehearsal needs a snapshot this session had no authorization to take |
| 24 | Legal and commercial readiness | **PASS (code)** · **BLOCKED_EXTERNAL (store listings)** | legal corpus versions are derived from the documents themselves; consent version now names the Cookie Policy revision it is shown under |

---

## C. SECURITY REVIEW — SCOPE AND LIMITS

Performed: source review of the authorization primitives, the error surface and
the capture-to-verification path, plus the executed suites named above, against
disposable local infrastructure.

Findings closed in this phase:

* **No user-facing copy leaks resource existence.** All 92 entries in the
  shared dictionary were checked for existence disclosure; `NOT_FOUND` stays
  deliberately vague, which is what makes the anti-enumeration 404s work.
* **The capture screens no longer render thrown text.** Sixteen sites rendered
  `err.message` straight into a toast or an inline error, which is how a
  backend string — or a requestId, or an API base — reaches a person.

Explicit limits:

* This is **not** a penetration test and must not be described as one.
* No production system was contacted, scanned or mutated.
* Rate limiting, resource exhaustion and long-running capture were reviewed in
  source and exercised only at test scale.

---

## D. ERROR AND REJECTION UX — WHAT WAS MEASURED

`tools/error-surface-inventory.mjs` reads three inventories out of the tree and
writes `docs/architecture/error-surface-inventory.json`. Nothing in it is
hand-maintained.

| | Before | After |
|---|---|---|
| Codes the API can emit | 441 | 441 |
| Answered with product copy on the web | 140 | 140 |
| Answered with product copy on native | **15** | **83** |
| A single shared dictionary | no | yes (92 entries) |

The 298 codes named by neither client are not all defects: many are internal,
and several MUST stay generic — an anti-enumeration 404 that explained itself
would stop being one. The web's `error-code-registry.ts` is where each code's
disposition is chosen, and its guard now reads the dictionary at its new home.

---

## E. CONTROLLED LAUNCH PLAN

### Stage 1 — Internal acceptance (repository-executable; done here)

Complete. The gates in §B columns 1–13 and 19–21 are the stage-1 definition,
and every one of them was executed in this phase rather than inherited.

### Stage 2 — Private beta (needs hardware and store accounts)

1. Produce internal builds from `uc6-public-launch`: `eas build --profile
   preview --platform android|ios`. Android credentials exist; iOS credentials
   exist from prior FINISHED builds.
2. Execute `apps/mobile/docs/physical-acceptance.md` on an iPhone, an iPad and
   an Android phone. Record build id and OS version per run. **No row may be
   ticked from CI.**
3. Confirm §0 of that script first: if the deployed API's OAuth audiences do
   not include the ids in `eas.json`, sign-in fails for a configuration reason
   and must be recorded as such, not as a code defect.
4. Browser extension: load unpacked in Chrome and Edge, exercise the capture
   session end to end against staging, and confirm the web card still shows the
   unavailable state until a listing exists.

### Stage 3 — Limited public rollout

Entry criteria: every Stage-2 row ticked; the three workflows green on `main`;
an owner named for incident response; a rollback that has been rehearsed rather
than written down.

Monitoring thresholds to agree before opening: capture-session failure rate,
seal-refusal rate by denial code, report-generation latency, worker DLQ depth,
and the rate of unmapped error codes reaching either client — the last one is
now measurable because the inventory exists.

### Stage 4 — Full public launch

Only after Stage 3 holds, and only with explicit publication approval. Store
submission, production deployment and any production migration remain outside
what this phase was authorized to do.

---

## F. WHAT THIS PHASE DID NOT DO

* No production deployment, no production migration, no production data access.
* No store submission for the extension or either app.
* No merge to `main`.
* No change to `/share/[id]` or anything it reaches — verified byte-identical
  to `origin/main`.
* No invented Apple Team ID, Android fingerprint or provisioning profile. The
  association files still carry their placeholders, deliberately.
