# PROOVRA Native — conversion ledger

Progress tracking for the Native conversion. **This is not a product authority.**
Scope is decided by `tools/derive-product-manifest.mjs` from canonical Web/backend
evidence; per-surface destinations live in `src/product/native-destinations.mjs`;
this file records what has actually been done and what is still owed.

```bash
node tools/derive-product-manifest.mjs      # scope
node --test "test/**/*.test.mjs"            # mobile suite
```

---

## 1. Scope — derived, closed, verified

| Disposition | Count | Decided by |
|---|---:|---|
| NATIVE_REQUIRED | **61** | not excluded by any admin/enterprise gate |
| ADMIN_ONLY | **36** | `routeRegistry` `domain: PLATFORM_ADMIN` (26) or `requiredActiveSpace: PLATFORM_ADMIN` (10) |
| ENTERPRISE_ONLY | **93** | `ENTERPRISE_ONLY_ROUTE_IDS` (91), `domain: OPS` (2) |
| PUBLIC_INFORMATIONAL_ONLY | **18** | renders the marketing site AND drives neither the product API nor a link token |
| UNRESOLVED | **0** | — |
| **Total** | **208** | filesystem walk of `apps/web/app` |

`208 = 61 + 36 + 93 + 18`. A new Web route with no disposition fails the build
(`test/product-manifest-coverage.test.mjs`).

**Classification verification (§2).** Every disposition was re-inspected:

- All 36 ADMIN_ONLY rest on a `PLATFORM_ADMIN` gate. Accepted.
- 91 of 93 ENTERPRISE_ONLY come from the web registry's own explicit
  `ENTERPRISE_ONLY_ROUTE_IDS` set, which the access resolver turns into
  `NEEDS_UPGRADE` for non-enterprise actors. The two borderline rows were
  checked individually: `/security-center/mfa-recovery` is the **admin queue for
  approving other people's** recovery requests (the user's own recovery is
  `/auth/mfa-recovery/verify`, which IS native-required), and
  `/settings/notifications/deliveries` is an **operator** delivery log with
  resend. Both correctly excluded.
- The marketing set found **one misclassification**: `/verify` drives the
  paste-a-token flow that pushes into `/verify/[token]`, and was being read as
  marketing because its routing lives in `_components/` while the page imports
  the marketing chrome. Product evidence now beats chrome, and a page that
  routes a user INTO a product surface counts as a product flow. NATIVE_REQUIRED
  went 60 → 61.
- The remaining 18 are genuinely informational (`/about`, `/faq`, `/for-*`,
  `/pricing`… ) — public pages with no product behaviour behind them.

## 2. Implementation status of the 61 NATIVE_REQUIRED surfaces

| Status | Count |
|---|---:|
| PARITY (device-verified) | **0 / 61** |
| PARTIAL (primary journey works, named gaps) | **24 / 61** |
| SHELL (materially thinner than Web) | **3 / 61** |
| NOT_STARTED | **34 / 61** |

`PARITY` may not be claimed from CI. It requires the physical acceptance in §6.

## 3. Done

### Foundation — one source of truth per dimension
| Dimension | Was | Now |
|---|---|---|
| Product scope | hand-authored 33-row table; guard could not see an omission | derived from `routeRegistry` + `middleware`; 0 unresolved, new route fails the build |
| Design tokens | 63 of 158 hand-mirrored; 27 pairs guarded | **generated** from `tokens.css`; 151 values, every `var()` flattened, drift impossible |
| Domain enums | 5 Prisma enums re-declared verbatim | **generated** from `schema.prisma`; a canonical value without a mapping is a compile error |
| Component language | 12 generic primitives vs 214 web components | + a pattern family: PageHeader, FilterBar/Search/Chips, Empty (page\|inline), ResultCount, CursorPager, ConfirmSheet, Sheet, KpiGrid, DetailRows, AsyncView |
| Render coverage | **zero** tests rendered a component | esbuild + react-test-renderer harness; 48 render tests |

### Blockers closed in code (device acceptance still owed)
| # | Defect | Fix |
|---|---|---|
| B-1 | `crypto.subtle` on every native upload path — no capture of any kind could be sealed | `expo-crypto` SHA-256, platform MD5, chunked reads (peak memory ~3.3× → ~1×) |
| B-2 | Discard left a reserved Evidence record in Active | `POST /v1/capture/direct-sessions/:id/discard` + never-committed list invariant + client awaits the server |
| B-3 | `NativeSharedObjectNotFoundException` on every exit from Capture | stop on blur, not unmount; 250 ms recorder poller deleted |
| B-4 | Google unconfigured in every built binary | client ids into all four EAS profiles; iOS reversed-client-id scheme registered |

### Surfaces ported
| Surface | Before | After |
|---|---|---|
| **Settings › Security** | web handoff link — no password change, no sessions, no MFA on the device most likely to be lost | all five canonical sections native |
| **Home** | 2 of 7 canonical sources; UC screen capture in the hero | canonical overview: summary band, 5 KPIs, severity-ranked queue, recent work, matters, storage. UC moved to Capture |
| **Search** | query + paging only | + result families, typeahead, result count. 9 of 11 `/v1/search*` endpoints are `isPlatformAdmin` operator surfaces and stay excluded |

### Defects found by the new guards and tests
1. `verify-email`, `reset-password`, `invite/[token]` — complete screens **nothing
   navigated to**; every emailed account-recovery link dead-ended. The old
   contract declared all three "REACHABLE".
2. `TRASHED` missing from the lifecycle display table — the old drift guard
   compared the native table to itself.
3. `ProovraInput` named itself from its **placeholder**, so every `ProovraFormField`
   without one rendered an unnamed text box.
4. The capture CTA rendered **"+ + Capture Evidence"** — the canonical string
   already contains the plus.
5. `mobile-boot-contract.test.mjs` **required** UC-2 to be reachable from Home.

## 4. Deletion ledger

| Deleted | Duplicate truth it held | Canonical replacement | Proof |
|---|---|---|---|
| `src/product/native-surface-contract.ts` | product scope, native-authored | `tools/derive-product-manifest.mjs` | reverse-reference search before and after; zero runtime consumers |
| `test/surface-parity-contract.test.mjs` | validated the table against itself | `test/product-manifest-coverage.test.mjs` | walks `apps/web/app` |
| `test/native-surface-contract.test.mjs` | hand-declared `reachability` | `test/native-route-reachability.test.mjs` | derives from the navigation graph |
| `test/design-token-parity.test.mjs` | 27 literal pairs across two authored files | `packages/ui/tests/tokens-generated.test.mjs` | artefact must equal a fresh generation |
| `test/domain-display.test.mjs` | module compared to its own exports | `test/domain-enums-generated.test.mjs` | asserts against `schema.prisma` |
| `test/oauth-config.test.mjs` | asserted variable NAMES in source | `test/oauth-build-config.test.mjs` | reads `eas.json` + `app.json` |
| `test/ui-kit-contract.test.mjs` | source contained "theme.", no hex, "44" | `test/ui-kit.render.test.mjs` | presses buttons, reads resolved style |
| hand-rolled `md5ArrayBuffer` (~80 lines) | second implementation of a canonical digest | platform MD5 via `getInfoAsync` | — |
| hand-mirrored token literals | second design source | generated module | zero colour literals asserted |

Preserved deliberately: `src/product/protected-native-paths.mjs` (the ReplayKit /
MediaProjection register — a platform concern, not a product one).

## 5. Owed — ordered

1. **Device acceptance of everything above.** Nothing is proven until it runs on
   hardware. Capture remains unproven end to end.
2. **`GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS` in the deployed API runtime.**
   Repository code is correct; this is deployment configuration.
3. **Capture convergence (§15).** Web drives `/v1/capture/sessions` +
   `/v1/uploads/sessions` with a multi-kind `CollectionPlanTemplate`; native
   drives UC-0, where one session reserves exactly one Evidence of one type —
   which is why there is no mixed-media composer. The UC-0 *provenance
   primitive* is worth keeping; what must go is its role as a competing product
   lifecycle. Largest remaining piece.
4. **The 34 NOT_STARTED surfaces**, notably Reports (a canonical primary-nav
   destination), organizations/people/workspaces, legal and trust-center
   readers, and the share/intake/portal flows.
5. **Remaining PARTIAL gaps** — see `gaps` on each row in
   `src/product/native-destinations.mjs`.
6. **Notifications** (3 of 13 endpoints), **Cases** (6 of 12), Evidence actions
   (download original, comments, annotations, relationships).
7. **Component tests for the remaining surfaces** — Auth, Capture, Evidence,
   Cases and Notifications have projection tests but no render tests yet.

## 6. Physical acceptance matrix

Nothing here may be ticked from CI.

| Case | iPhone | iPad | Android |
|---|:--:|:--:|:--:|
| Email sign-in → session restore → logout | ☐ | ☐ | ☐ |
| Google sign-in end-to-end | ☐ | ☐ | ☐ |
| Apple sign-in end-to-end | ☐ | ☐ | n/a |
| Emailed verify-email / reset-password / invite link opens the app | ☐ | ☐ | ☐ |
| PHOTO capture → SIGNED → public verify | ☐ | ☐ | ☐ |
| VIDEO (≥1 GB) capture → SIGNED, no OOM | ☐ | ☐ | ☐ |
| AUDIO capture → SIGNED | ☐ | ☐ | ☐ |
| DOCUMENT pick → SIGNED | ☐ | ☐ | ☐ |
| Stage → **Discard** → no orphan in Active or Trash | ☐ | ☐ | ☐ |
| Enter/leave Capture ×20, all four modes, zero exceptions | ☐ | ☐ | ☐ |
| Kill app mid-upload → resume → SIGNED, no duplicate part | ☐ | ☐ | ☐ |
| UC-5 ReplayKit → segments → manifest → SIGNED | ☐ | ☐ | n/a |
| UC-2 MediaProjection → SIGNED | n/a | n/a | ☐ |
| UC-3 continuous → continuity manifest → SIGNED | n/a | n/a | ☐ |
| Settings › Security: change password, revoke a session | ☐ | ☐ | ☐ |
| Home renders the canonical sections against real data | ☐ | ☐ | ☐ |
| Search: query, family filter, typeahead, paging | ☐ | ☐ | ☐ |
| Tablet rail nav at ≥840 pt, RTL | n/a | ☐ | ☐ |
| Side-by-side design comparison against the PWA | ☐ | ☐ | ☐ |

## 7. Known limits, stated

- `expo-crypto` exposes no **incremental** digest, so a file must still be
  resident once to hash it. Chunked hashing needs a native streaming digest.
  Not claimed as done.
- The **UC-0 discard integration suite has not been executed** — this
  environment has no Docker and no `TEST_DATABASE_URL`. It runs in the
  integration environment. Production was not contacted at any point.
- The render harness proves what a component renders, which branch it takes and
  what a press does. It does **not** prove native layout, gestures, fonts, safe
  areas or anything about Hermes.
- 14 API test files fail in `services/api`, all pre-existing and none referencing
  changed files. Two that did were repaired (they had been throwing `ENOENT`
  rather than asserting since Phase 12 deleted the mobile files they read).
