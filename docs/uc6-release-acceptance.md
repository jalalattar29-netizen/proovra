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

`ci` was red at every intermediate commit, for a DIFFERENT real reason each
time, and each was fixed at its cause rather than retried or routed around.

Five of the ten were tests asking a question before the answer could exist.
That is worth naming as a pattern rather than ten separate accidents: a fixed
sleep, a click read on the next line, a poller assumed to have fired. Each one
passed everywhere except where it mattered.

The third one arrived AFTER the merge, on `main`, at a SHA this workflow had
already passed on the branch — which is what finally made it a pattern rather
than a coincidence. So the habit was swept instead of waited for: every read of
an `aria-expanded`, an `aria-describedby` reason or a `.disabled` taken on
the line after the action that changes it, across the whole render suite, now
waits for the settled state. That is 13 sites in 10 files.

| # | Cause | Fix |
|---|---|---|
| 1 | Docker Hub rate-limited the anonymous MinIO pull (exit 125) | pinned quay.io release — the image `playwright-e2e.yml` already uses on this runner |
| 2 | The full-stack smoke test posted its own stale legal versions and 400'd before reaching the capture it exists to prove | corrected at the source of the versions |
| 3 | Four line-anchored capability sites moved when the error and mixed-origin work inserted lines above them | re-anchored |
| 4 | Two imports left unused after the dictionary moved to `@proovra/shared` | removed |
| 5 | The audit engine's freshness gate, on artifacts the bundling work changed | regenerated |
| 6 | `schema-reproducibility` failed on a DOC-ONLY commit: a concurrency test asserted `bodiesEntered === 1` after a fixed sleep and read **0** on a loaded runner — a question asked too early, not a lock failure (that reads 2 or 3) | both it and its sibling now wait for the EVENT, with a 30s deadline |
| 7 | The freshness gate again, three commits running | regenerated — and fixing it is what let #8 become visible at all |
| 8 | `Test — api`: the Point-5 ledger carried TWO runIds, so the gate read "proof stitched from 2 runs" and credited **0** of 34 units | all 14 credited suites re-executed in ONE invocation against a fresh database (19 files, 338 cases), leaving one runId |
| 9 | `Test — web`: `webhook-destinations.render.test.tsx` failed on a commit whose ENTIRE diff is one markdown file, having passed on the commit before it — identical code, different result | six assertions read the form on the line after the click that opens it. All six now await it; the file passes 20/20 four consecutive times |
| 10 | `Test — web` **on `main`, after the merge**: `external-bulk-invite-scope.render.test.tsx` read the submit button's reason on the line after the alert it awaited — separate state, a render later. The SAME SHA had passed this workflow on the branch | the read waits; and the pattern was then SWEPT rather than waited for: 12 more eager reads across 9 files now wait too |

### What #8 is worth remembering for

The ledger churn looks like noise — every `binding` SHA and every case list is
identical between the two runs, and only `runId` and a timestamp differ. It
was reverted as noise, which preserved the mixture instead of clearing it. The
runId **is** the evidence: it is the claim that one execution proved these
families, and two of them stitched together is exactly the dishonest proof the
gate exists to refuse.

---
## B. RELEASE ACCEPTANCE MATRIX

Twelve categories. **No category inherits another's result** — the three
sentences that matter are kept apart on purpose: code that passes its gates,
an application somebody can install, and a launch an operator can stand behind.

| # | Category | Status | Evidence |
|---|---|---|---|
| 1 | **Repository code readiness** | **PASS** | api unit 25 194 (1 skipped) · api integration 2294/2294 across 160 files against live PostgreSQL 16 booted from migrations alone (a second run against a REUSED database read 2292/2294; both failures were residue-sensitive tick counters that scan every workspace, and the two files pass 50/50 on a database created and migrated fresh — which is what CI provisions) · worker 974/974 · web 3230 + 1470 render · operations/capture layout 296/296 on a freshly built bundle (§C3) · mobile 942/942 · contract audit 79/79 with 0 UNRESOLVED · AuditEngineIntegrity PASS · ReleaseBlockingClosure PASS · typecheck and lint clean across every workspace |
| 2 | **CI readiness** | **PASS** | all three workflows green on `b79706b66`: `ci` (run 35902545060), `playwright-e2e` (35902545042), `schema-reproducibility` (35902545057). **Ten** distinct red causes were fixed at source along the way — none retried, none suppressed — and five of them were tests that asked a question too early rather than product faults. §A2 lists every one |
| 3 | **Android build readiness** | **PASS (build)** · **SUPERSEDED (native manifest)** | EAS build `1bb438ab` FINISHED, v1.0.0 (17), internal distribution, existing keystore, APK published to the account's artifact store. **No longer corresponds to the final app code**, in exactly one respect: `apps/mobile/app.json` was changed after the build to narrow the Android `/auth` deep-link claim (§C2). Nothing else the bundle includes has moved — `git diff 7f994890f..HEAD -- apps/mobile packages/shared packages/shared-runtime` is that file plus a doc. The JavaScript is therefore identical; only the native manifest differs, and it is INERT until the signing fingerprint in §E2 is written, which forces a rebuild anyway |
| 4 | **iOS build readiness** | **PASS (bundle)** · **NOT_TESTED (signed native build)** | `expo export --platform ios` succeeds (1608 modules) after a clean `--frozen-lockfile` install. A JavaScript bundle is not a signed application: no iOS build was produced in this phase, though credentials exist on the account from earlier FINISHED builds |
| 5 | **Android physical acceptance** | **NOT_TESTED** | no device was available to this session. The APK exists and `apps/mobile/docs/physical-acceptance.md` carries the script, the build id and the two UC-6 behaviours to exercise deliberately |
| 6 | **iPhone physical acceptance** | **NOT_TESTED** | same, and no iOS build was produced |
| 7 | **iPad physical acceptance** | **NOT_TESTED** | same |
| 8 | **Extension distribution readiness** | **PASS (package)** · **BLOCKED_EXTERNAL (submission)** | `proovra-extension-v1.0.0.zip`, 456 783 bytes, sha256 `9dc38c9a…`, built against `https://api.proovra.com`; MV3 lint OK — least privilege, strict CSP, no remote code, `host_permissions` empty. Listing copy, permission justifications and the privacy declaration are written. **The archive is gitignored and exists only on the build machine** — `apps/extension/release/` is not committed, so a reviewer reproduces it with the build rather than finding it in the tree. Submission, the store-assigned extension ID and the OAuth redirect registration are human-console steps that were not performed |
| 9 | **Security and evidence integrity** | **PASS (targeted review)** | one acquisition authority; uploads are never described as direct capture; a claimed `ANCHORED` OTS state is downgraded to `PENDING` when nothing supports it; no user-facing copy leaks resource existence (all 92 dictionary entries checked); the capture screens no longer render thrown text. **Not a penetration test** — see §C |
| 10 | **Backup and recovery** | **PASS (rehearsed on disposable data)** · **NOT_TESTED (production source)** | a full `pg_dump -Fc` of a 278-migration database was restored into a fresh database in **11 seconds with zero errors**: evidence 500, custody 52, teams 103, users 107, migrations 278, **0 orphaned custody events**, `db:drift-check` OK, and `db:raw-schema-verify` byte-identical to the source. The production backup source is a Neon snapshot this session had no access to, and `safe-migrate.mjs` already refuses a production migration that does not name one |
| 11 | **Monitoring and incident response** | **FAIL (not wired)** | 32 alert rules exist in `infra/grafana/alerts/`, and **nothing evaluates them**: `docker-compose.prod.yml` declares redis, api, worker and caddy — no Prometheus, no Grafana, no Alertmanager — and the rule file names no contact point. The API exposes `/metrics`, `/health`, `/healthz` and `/readyz`, so the data exists and nothing is scraping it. Alerts that reach nobody are not monitoring |
| 12 | **Full public launch readiness** | **NOT READY** | blocked by rows 5, 6, 7 (no device acceptance), row 8 (no store listing), row 11 (no alert delivery), and the external identifiers in §E |

### What moved since the previous matrix

* Backup restoration went from NOT_TESTED to rehearsed, with measured timings
  and integrity checks.
* Monitoring went from NOT_TESTED to **FAIL**, because exercising it is what
  revealed that no evaluator is deployed. That is a worse answer than the one
  it replaces, and it is the true one.
* The error-surface work gained a reachability denominator: 441 produced, 326
  reachable, and 195 of those still undispositioned — now ratcheted so the
  number cannot grow silently.
* Two product defects were found by running a suite nobody runs, and fixed: a
  refused context still reading `/v1/ops/incident-groups` (§C3), and Android
  claiming every path under `/auth` as a deep link (§C2). Neither was
  reachable through any workflow, which is the part worth keeping in mind.
* The UC-0 → UC-5 chain is now stated as a table with the proof for each mode
  and the device column kept separate from the code column (§C1).

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

## C1. THE UC-0 → UC-5 CHAIN

One authority decides origin for every capture: `acquisitionMode` in
`packages/shared/src/evidence-acquisition.ts`, with `captureMethod`
describing structure and never origin. Each mode below is a value of that
one enum, accepted on the same ingest spine, and each is exercised against
live PostgreSQL 16 in the API integration suite.

| UC | `acquisitionMode` | Proof in the tree | Code | Device |
|---|---|---|---|---|
| 0 | `PROOVRA_MOBILE_APP` (and the spine itself) | `uc0-acquisition-capture` 10 cases · `uc0-discard-lifecycle` · `uc0-zero-legacy-acquisition` | PASS | see rows 5–7 of §B |
| 1 | `DIRECT_WEB_CAPTURE_EXTENSION` | `uc1-web-capture` 4 cases · `uc1-extension-oauth` 5 cases | PASS | BLOCKED_EXTERNAL — unpublished (§B row 8) |
| 2 | `DIRECT_SCREEN_CAPTURE_ANDROID` | `uc2-screen-capture` 4 cases | PASS | NOT_TESTED |
| 3 | `DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS` | `uc3-continuous-capture` 10 cases | PASS | NOT_TESTED |
| 4 | derived intelligence — `DERIVED_MACHINE_EXTRACTED`, `DERIVED_RECONSTRUCTED` | 19 test files across intelligence, OCR and transcript authority | PASS (mechanism) | **accuracy NOT EVALUATED** |
| 5 | `DIRECT_SCREEN_CAPTURE_IOS` | `uc5-ios-screen-capture` 8 cases | PASS | NOT_TESTED |

### What "PASS" means in the Code column, and what it does not

It means the mode is accepted, recorded and refused correctly against a real
database — not that a phone has ever produced one. Rows 5–7 of §B are the
device question and they are all NOT_TESTED.

**UC-4 accuracy is not claimed.** The mechanism is proven: a derived asset
carries `DERIVED_MACHINE_EXTRACTED` or `DERIVED_RECONSTRUCTED` provenance and
can never be presented as captured. Whether the OCR reads a given screenshot
correctly, or a reconstructed conversation matches what was said, has not
been measured against representative real data and must not be stated until
it has.

---

## C2. SIGNING, AUTHENTICATION AND APP LINKS

### Neither association file can verify anything today

`apps/web/public/.well-known/assetlinks.json` carries the literal string
`<ANDROID_SIGNING_SHA256_FINGERPRINT>` and `apple-app-site-association`
carries `<APPLE_TEAM_ID>`. Both are served from real paths on a real host, so
the files RESOLVE and the verification FAILS — which is the quiet failure
mode: a link opens the browser and nothing anywhere says why. The two values
are external prerequisites 1 and 2 in §E2, and neither can be read from this
repository.

### One real defect, found and fixed

The Android configuration claimed the deep-link prefix `/auth` — every path
beneath it, `/auth/login` included — while iOS claimed exactly the two paths
`apps/mobile/docs/universal-links.md` documents. A verified Android install
would have opened the app on a sign-in link it has no route for.

Narrowed to `/auth/verify-email` and `/auth/mfa-recovery`. Both platforms now
claim the same nine prefixes and the same two hosts, and
`apps/web/__tests__/universal-link-parity.test.ts` holds them there: it
compares the AASA components against `android.intentFilters`, compares the
hosts, and requires every claimed path to appear in the documented table.
Verified to FAIL on the pre-fix configuration (`androidOnly: /auth`) rather
than merely to pass on the new one.

**Cost of the change:** the existing APK predates it. That costs nothing,
because no deep link verifies until the signing fingerprint above is written,
and writing it requires a new build regardless.

---

## C3. LAYOUT AND ACCESSIBILITY ACCEPTANCE

**296 passed, 0 failed** across `operations-layout` and `capture-layout`,
against a freshly built production bundle with the previously running
`next start` servers killed first — `reuseExistingServer: true` will happily
serve a stale build and report green about code that was never loaded.

It began at **33 failed**. None of it was UC-6 damage: this project runs in
no workflow (`playwright-e2e.yml` names `--project=chromium`, and these are
opt-in behind `OPERATIONS_LAYOUT=1`), and it had been failing since
2026-08-26 with nobody finding out.

### What the silence was hiding

| # | Finding | Kind |
|---|---|---|
| 1 | The grouped queue read did not ask the access gate. `readAccess` carries a docblock — "two gates over one boundary drift, and these two already had" — and by the time the grouped queue arrived there were three. A refused context rendered the refusal panel and still issued `/v1/ops/incident-groups` for that workspace. The server refuses it, so nothing leaked; the client asked a question it had been told not to ask | **product defect, fixed** |
| 2 | Android claimed the deep-link prefix `/auth` — `/auth/login` included — while iOS claimed the two paths the documentation names (§C2) | **product defect, fixed** |
| 3 | The workbench opens GROUPED and every per-row instrument lives in the flat surface, so the readers returned zero and the assertions read as "the control is gone" | stale suite |
| 4 | The fixture never sent `lifecycle`, which `rowModel.ts` reads as an older server and fails closed — so NO row in the project could offer Resolve, whatever the product did | stale fixture |
| 5 | Two assertions spelled the summary cards out as literals, while `vocabulary.ts` states that nothing may assert a card COUNT against one | stale literal |
| 6 | `/v1/ops/incident-groups` was missing from the named endpoint allow-list | stale allow-list |
| 7 | `personal-pro` was expected to poll conditions it has no teamId for — it polls nothing at all, by three deliberate steps of the same design | wrong expectation |
| 8 | A focus-ring assertion used `.focus()` on a BUTTON styled with `:focus-visible`, which Chromium is right to withhold | wrong method |

### Not claimed

* An 8px horizontal document overflow at **320px RTL** appeared in one run
  and passed in the next against the same specs. One observation and one
  contradiction is not a defect — it is **unreproduced**, and it is recorded
  here rather than either fixed or forgotten.
* These projects still run in no workflow. Nothing in this phase changed
  that, so the next regression in them will be just as quiet.

---

## D. ERROR AND REJECTION UX — WHAT WAS MEASURED

`tools/error-surface-inventory.mjs` reads three inventories out of the tree
and writes `docs/architecture/error-surface-inventory.json`. Nothing in it is
hand-maintained.

### Reachability — the denominator a coverage claim may honestly use

| | count | what it means |
|---|---:|---|
| produced by the API | 441 | every code the enum declares, a route replies with, or a domain error carries |
| **reachable** | **326** | a reply, a `denial:`, or a thrown code the server serialises as `err.code` |
| observability-only | 86 | the code appears only inside a logger, audit row, metric or security event. It never leaves the server |
| enum-only | 29 | declared and never constructed |

Demanding copy for a code nobody can meet is noise, and noise is how a
coverage number stops being read.

### Coverage of the reachable set

| | before UC-6 | now |
|---|---:|---:|
| answered with product copy on the web | 132 | 132 |
| answered with product copy on native | **15** | **80** |
| a single shared dictionary | no | yes (92 entries) |
| carrying a registry disposition | 131 | 131 |
| **undispositioned** | **195** | **195, ratcheted** |

### What the ratchet is, and is not

The coverage guard read route files only, so it was green over the 195 codes
produced in the service layer. It reads every producer now. Failing outright
would leave a permanently red gate, and a permanently red gate is one nobody
reads — which is how the first silence happened. So the count is pinned: the
suite fails the moment it GROWS, and lowering it takes a deliberate edit.

Of the 195, **88 are produced only on enterprise/governance/admin paths** and
**107 are reachable from ordinary product surfaces**. Several of the 107 are
already handled contextually at a surface (the AI assistant answers
`AI_NOT_INCLUDED` itself) and are undispositioned as bookkeeping rather than
as silence. Separating those two is the next piece of work, and it is named
here rather than implied.

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

## E2. EXTERNAL PREREQUISITES — the exact remaining human steps

Nothing below is invented, and none of it can be done from a repository.

| # | Value | Where it lives now | The exact step |
|---|---|---|---|
| 1 | Android signing SHA-256 | `assetlinks.json` carries `<ANDROID_SIGNING_SHA256_FINGERPRINT>` | Read it from `eas credentials` → Android → Keystore, **or** from Play Console → App integrity once the app is enrolled. Play App Signing re-signs, so the Play value is authoritative the moment enrolment happens — writing the EAS upload-key fingerprint before then would be wrong later. The APK is signed with v2/v3 only, so the certificate is in the APK Signing Block rather than `META-INF`, and `apksigner`/`keytool` is the way to read it |
| 2 | Apple Team ID | `apple-app-site-association` carries `<APPLE_TEAM_ID>` | Apple Developer → Membership. It prefixes the App ID as `<TEAM>.com.jalalattar29.proovra` |
| 3 | Extension ID + OAuth redirect | fails closed server-side until registered | After store review assigns the ID, set `EXTENSION_OAUTH_REDIRECT_ALLOW=https://<EXTENSION_ID>.chromiumapp.org/oauth2` in the production API environment and redeploy |
| 4 | `NEXT_PUBLIC_EXTENSION_INSTALL_URL` | set nowhere, which is why the card says "not published yet" | Set it to the store listing URL after publication. The card flips to AVAILABLE through the canonical capability resolver — no code change |
| 5 | Google OAuth client IDs | **already configured** in `eas.json` for all three profiles | Confirm the deployed API's `GOOGLE_CLIENT_IDS` includes them, and `APPLE_CLIENT_IDS` includes the bundle id. §0 of the physical-acceptance script checks this first, because a mismatch fails sign-in for a configuration reason that looks like a code defect |
| 6 | Monitoring delivery | 32 rules, no evaluator, no contact point | Deploy Prometheus/Grafana (or point a hosted collector at `/metrics`), attach the rule file, and configure a contact point. Until then row 11 stays FAIL |

Identifiers that ARE consistent across EAS, the native project and the
association files, verified in this phase: bundle id
`com.jalalattar29.proovra`, Android package `com.jalalattar29.proovra`,
broadcast extension `com.jalalattar29.proovra.broadcast`, app group
`group.com.jalalattar29.proovra` (matching in `app.json`, the screen-capture
module and the broadcast SampleHandler), scheme `proovra`, associated domains
`www.proovra.com` and `proovra.com`.

## F. WHAT THIS PHASE DID NOT DO

* No production deployment, no production migration, no production data access.
* No store submission for the extension or either app.
* The merge to `main` is the ONE outward action this phase was authorised to
  take. Its preconditions are in §G. Nothing else outward was performed.
* No change to `/share/[id]` or anything it reaches — verified byte-identical
  to `origin/main`.
* No invented Apple Team ID, Android fingerprint or provisioning profile. The
  association files still carry their placeholders, deliberately.
* No device acceptance of any kind. Rows 5–7 of §B are NOT_TESTED because no
  phone or tablet was reachable from this session, not because the question
  was deferred as unimportant.
* No accuracy evaluation of UC-4 OCR or conversation reconstruction (§C1).
* No alert delivery wired up. Row 11 remains FAIL, and this phase did not
  change it — it only established that it is a FAIL rather than an unknown.
* No fix for the intermittent 320px RTL overflow (§C3): it was observed once,
  contradicted once, and is not understood well enough to change anything.

---

## G. THE MERGE TO `main`

A **fast-forward**, so `main` ends at exactly the branch head CI verified —
no merge commit introduces code no workflow has seen.

| precondition | how it was checked | result |
|---|---|---|
| `origin/main` is an ancestor of the branch | `git merge-base --is-ancestor` | yes — fast-forward possible |
| no database migration rides along | `git diff --name-only origin/main..HEAD -- services/api/prisma/migrations` | **0 files** |
| no schema change rides along | same, for `schema.prisma` | **0 files** |
| Secure Share untouched | `git diff origin/main..HEAD -- apps/web/app/share` and the API share routes | **byte-identical** |
| no deployment is triggered | `deploy-images.yml` builds GHCR images on push to `main`; `deploy-staging.yml` is `workflow_dispatch` only | images only, no environment changed |
| branch protection respected | no required checks are configured on this repository; nothing was bypassed and no force-push was used | clean |
| all three workflows green on the exact SHA | `ci`, `playwright-e2e`, `schema-reproducibility` | see §A2 |

**What pushing to `main` does cause:** `deploy-images.yml` builds and pushes
container images to GHCR. That is a registry write, not a deployment — no
running environment reads them without a separate, manual step. It is stated
here rather than left for somebody to discover.
