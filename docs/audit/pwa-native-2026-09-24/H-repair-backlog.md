# H — REPAIR BACKLOG, GROUPED BY ROOT CAUSE

> **Currency:** this document reports the BASELINE run at `f822de79a`. It was re-run on `uc6-public-launch` @ `10668edbe` — see **[J](J-reconciliation-on-recovery-branch.md)**. All findings persist; the Android fingerprint is now fixed in-repo but undeployed, and the measured counts moved slightly (tests 942→946, controls 484→485).

**Audited SHA:** `f822de79ad9397928cb59d1760e42bd63e583457`

Grouped by **cause**, not by symptom, because most of the symptoms in this audit trace
back to five causes and fixing the cause closes many rows at once.

| Priority | Meaning |
|---|---|
| **P0** | The product does not work in production. Fix before anything else. |
| **P1** | A capability or a truth-telling instrument is wrong. |
| **P2** | Documentation that misdirects the next engineer. |
| **P3** | Quality, consistency, coverage. |

---

## ROOT CAUSE 1 — The production link association is deployed with placeholders

*Closes: J-02, J-21, J-22, J-23; removes the link caveat from J-01 and J-05.*

### H-1 (P0) — Substitute the real identifiers in the association files

**Defect (VERIFIED, measured live 2026-09-24):**
- `https://www.proovra.com/.well-known/apple-app-site-association` → 200, body contains
  literal `"<APPLE_TEAM_ID>.com.jalalattar29.proovra"`.
- `https://www.proovra.com/.well-known/assetlinks.json` → 200, body contains literal
  `"<ANDROID_SIGNING_SHA256_FINGERPRINT>"`.

**Acceptance criteria**
1. AASA `appIDs[0]` matches `^[A-Z0-9]{10}\.com\.jalalattar29\.proovra$`.
2. `assetlinks.json` fingerprint matches the SHA-256 of the **actual upload signing
   certificate** for the Play track being shipped (Play App Signing key, not the local
   keystore, if Play re-signs).
3. A CI check fails the deploy if either file matches `/<[A-Z_]+>/`.
4. On a device: an https `/intake/<token>` link opens the app, not the browser.
5. `adb shell pm get-app-links com.jalalattar29.proovra` reports `verified` for both hosts.

### H-2 (P0) — Serve the association files on the apex without a redirect

**Defect (VERIFIED):** `https://proovra.com/.well-known/apple-app-site-association` and
`assetlinks.json` both return **301** to `www`. `app.json` declares
`applinks:proovra.com`, and **Apple does not follow redirects** when fetching an AASA.
Apex universal links therefore fail independently of H-1, and would still fail after it.

**Acceptance criteria**
1. Both `.well-known` paths return **200** on the apex, not 3xx.
2. `Content-Type: application/json` on both hosts (production currently serves the AASA
   as `application/octet-stream`).
3. Either that, or `applinks:proovra.com` is removed from `app.json` and the apex is
   documented as non-linking.

---

## ROOT CAUSE 2 — Scope was decided by a heuristic that outranked the declared authority

### H-3 (P1) — Resolve `/operations` and `/operations/health`

**Defect (VERIFIED):** both are classified `ENTERPRISE_ONLY` **only** by
`derive-product-manifest.mjs`'s own `ENTERPRISE_DOMAINS = {…, OPS}` constant. Neither
routeId is in `ENTERPRISE_ONLY_ROUTE_IDS`; both carry `requiredActiveSpace:
PERSONAL_OR_ORG`. The registry author listed `operations.reliability`, `.automation`
and `.analytics` there **and deliberately omitted these two**. Result: no native screen,
no ledger row, no test, 21 uncalled page-scoped endpoints.

**Acceptance criteria** — *one* of:
- **(a)** Add both routeIds to `ENTERPRISE_ONLY_ROUTE_IDS` with a comment arguing why a
  personal-scope surface is enterprise-only; the manifest then excludes them from the
  authority rather than from a heuristic; **or**
- **(b)** Port them: a ledger row each, a native screen, and the endpoints
  `/v1/operations/*` the web page consumes.

In **both** cases: the `ENTERPRISE_DOMAINS` heuristic is narrowed or removed so that no
future route is excluded by domain alone. A test asserts that every `ENTERPRISE_ONLY`
row cites either `ENTERPRISE_ONLY_ROUTE_IDS` or `requiredActiveSpace:
ORGANIZATION_ONLY` — never a domain guess.

---

## ROOT CAUSE 3 — The instruments cannot see how native builds a URL

*This one cause produced a wrong ledger gap, a wrong cross-check, and 25 false positives
in this audit's own first pass.*

### H-4 (P1) — Teach the capability-map generator to resolve path builders

**Defect (VERIFIED):** `docs/architecture/current-runtime-capability-map.json` records
258 MOBILE consumer sites and **zero** in `apps/mobile/src/product/evidence-detail.ts`,
which defines 22 `/v1/...` builders the evidence screen calls. Builders compose
(`buildEvidenceArchivePath` → `` `${buildEvidencePath(id)}/archive` ``), so a literal
scan at the call site finds the base and loses every leaf.

**Downstream damage already observed:** the ledger's own S15 cross-check used this map,
concluded "11 of 16 unconsumed", and hand-corrected three. This audit's first pass
reported Archive/Unarchive/Unlock as absent when they are implemented.

**Acceptance criteria**
1. `generate-runtime-capability-map.mjs` resolves builder composition to a fixed point
   (the reference implementation is `native-endpoints.mjs` in this directory: 98
   builders → 191 distinct paths).
2. The map records ≥ 1 MOBILE consumer in `evidence-detail.ts`.
3. A negative test: a builder-routed call that is **removed** from a screen must make
   the map's mobile-consumer count drop. A check that cannot fail is not a check.
4. Re-run the S15 cross-check afterwards and correct the `/evidence/[id]` gap list.

### H-5 (P1) — Fix `destinationCounts()`

**Defect (VERIFIED):** `native-destinations.mjs:877` seeds
`{NOT_STARTED, BLOCKED_BY_DECISION, SHELL, PARTIAL, PARITY}` and then does
`counts[d.status] += 1`. `CODE_PARITY` is not a key, so every row yields `NaN`. The
function reports **zero progress** over a 62/62 ledger.

Severity is contained only because the export has **no consumers**.

**Acceptance criteria**
1. Counts are derived from the status union type, not a hand-written literal, so a new
   status cannot be silently uncounted.
2. A test asserts `sum(counts) === Object.keys(NATIVE_DESTINATIONS).length`.
3. If the export is genuinely dead, delete it — a dead instrument that lies is worse
   than no instrument.

---

## ROOT CAUSE 4 — Documents drifted from the authorities they summarise

### H-6 (P2) — Regenerate `docs/native-conversion-status.md`

**Defect (VERIFIED):** four material falsehoods at this SHA — see A §3.5
(41/14/6/1 vs **62/0/0/0**; 580 tests vs **942**; "invariant is not met" when it is;
"`app.json` declares only the `proovra://` scheme" when `associatedDomains` and ten
`autoVerify` filters are declared).

**Acceptance criteria**
1. The file is **generated** from `native-destinations.mjs` + `derive-product-manifest.mjs`,
   not hand-maintained. It already declares itself a summary that "is wrong the moment
   it disagrees" — make that structurally impossible.
2. Test count is read from a real run, or the claim is removed.

### H-7 (P2) — Correct the `/evidence/[id]` ledger gap `[3]`

**Defect (VERIFIED):** gap `[3]` lists five capabilities as "STILL ABSENT" that are all
wired at this SHA — label PATCH (`:418`), relationship create (`:473`) / delete (`:509`),
`ReviewerWorkflowPanel` (`:1101`), original download (`:537`).

**Acceptance criteria**
1. Gap `[3]` is rewritten against the code, not against the stale map (H-4 first).
2. A guard asserts that any capability a gap names as absent has **no** resolvable
   native call site — so this class of drift fails CI instead of ageing.

---

## ROOT CAUSE 5 — Parity was claimed per-route without an inverse check

### H-8 (P1) — Triage the 195-endpoint gap register

**Finding (SOURCE-INFERRED):** 195 distinct endpoints consumed by applicable web routes
are never called anywhere in native; 35 of 64 routes are affected. Full detail in
`endpoint-gap-register.json`.

Triage of the two largest routes found **three** causes, and only the first is a defect:

| Class | Example | Action |
|---|---|---|
| Genuinely absent | `/home`'s whole `/v1/ops/*` cluster (18 endpoints) | port or argue |
| Same capability, different endpoint | `/cases/[id]` export: native `GET /v1/cases/:id/export` vs web `POST /v1/cases/:id/siu-export` | record the mapping |
| Argued product decision | `/cases/[id]` renders the 5-tab personal branch, not the 12-tab enterprise `MatterWorkspace` | already argued — keep |

**Acceptance criteria (per route, applied to all 35)**
1. Every endpoint in that route's `missingEntirely` list is assigned exactly one of
   `PORT` / `EQUIVALENT_ENDPOINT:<id>` / `DECIDED:<argument>`.
2. `EQUIVALENT_ENDPOINT` rows name the native endpoint, and a test asserts the native
   call exists.
3. `DECIDED` rows appear in that route's ledger `gaps` in the ledger's own voice.
4. **No route keeps `CODE_PARITY` while holding an unassigned `PORT` row.**

Suggested order — by gap density, which is also product depth:
`/cases/[id]` (43) → `/evidence/[id]` (42) → `/settings` (19) → `/home` (18) →
`/capture` (13) → `/teams/[id]` (13) → `/collaboration-teams/[teamId]` (12) →
remainder.

---

## STANDALONE ITEMS

### H-9 (P1) — `userInterfaceStyle: "dark"` over a light palette, with no `StatusBar`

See C.1.1. **Affects every screen on both platforms.**

**Acceptance criteria**
1. `app.json` `userInterfaceStyle` matches the palette the app actually paints
   (`surface.app #F7F8FC` is light) — i.e. `"light"`, or `"automatic"` only once a real
   dark token set exists.
2. Splash `backgroundColor` matches the first painted frame (no dark→light flash).
3. An explicit `<StatusBar style="dark" />` (or equivalent) so glyph colour is decided
   by the app rather than inherited.
4. On a device: the clock and battery are legible on Home, Evidence and Capture.

### H-10 (P2) — RTL mirrors text but not row direction

See C.1.2 — 45 files use `flexDirection: "row"`, 3 read `isRTL`; `I18nManager.forceRTL`
is never called.

**Acceptance criteria**
1. A decision is recorded: adopt `I18nManager.forceRTL` (with its relaunch requirement)
   **or** keep manual mirroring.
2. If manual: row direction is centralised in the `src/ui` primitives so a screen cannot
   opt out by writing `flexDirection: "row"` inline; a lint rule enforces it.
3. On an Arabic device: list rows, section headers and chevrons read right-to-left.

### H-11 (P3) — Success feedback exists on 22 of 73 native files

See A §4.3. Only 12 files use the toast system; `evidence/[id].tsx` alerts on failure
and re-fetches silently on success.

**Acceptance criteria**
1. Every control classified `API_CALL` that performs a **write** either shows an
   explicit success affordance or has a recorded reason why the data refresh is
   sufficient.
2. One-way and long-running actions — Archive, Lock, Unlock, Regenerate, Finalize —
   always confirm explicitly.

### H-12 (P3) — 18 of 64 applicable routes have no referencing test

Including `/evidence/[id]` and `/cases/[id]`, the two deepest surfaces in the product.
Full list in **G.3**.

**Acceptance criteria**
1. Every applicable route has at least one referencing test.
2. The two deepest surfaces gain a render test.
3. `routesWithZeroTests` is asserted at 0 by a guard, so it cannot silently regress.

### H-13 (P3) — 33 controls could not be resolved to an effect

Concentrated on `/evidence` (8), `/evidence/[id]` (5), `/share/[id]` (5). Some are
conservative instrument limits rather than real ambiguity (`() => Linking.openSettings()`
and `oauth.promptGoogle` are resolvable by eye). See I §4 for the calibration.

**Acceptance criteria**
1. Each of the 33 is resolved by hand to `API_CALL` / `NAVIGATION` / `LOCAL_STATE` /
   `DIALOG`, or fixed if genuinely inert.
2. `onPress` forwarded through a prop (`/evidence:117`) names the concrete action at the
   call site so the register can see it.

### H-14 (P0-gate, not a code fix) — Execute the physical acceptance script

`physicallyAccepted` is `false` on all 62 rows; this audit ran 0 simulator and 0 device
sessions. `apps/mobile/docs/physical-acceptance.md` already exists and is the right
script. **Until it is executed, launch readiness cannot be claimed**, whatever the
ledger says.

Do H-1 and H-2 **first** — several of the script's steps (1.7 link arrival, intake,
portal, invites) cannot pass until links reach the app.

---

## Ordering

```
H-1, H-2      ← nothing else matters until a link opens the app
H-3           ← decide scope before measuring against it
H-4           ← fix the instrument before trusting any parity number
H-5, H-6, H-7 ← make the paperwork match the code
H-8           ← the real parity work, now measurable
H-9, H-10     ← visual/accessibility, cheap and app-wide
H-11 … H-13   ← quality and coverage
H-14          ← the gate. Cannot be short-circuited.
```
