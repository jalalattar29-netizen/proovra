# PROOVRA Native — conversion ledger

Progress tracking for the Native conversion. **This is not a product authority.**
Scope is decided by `tools/derive-product-manifest.mjs` from canonical Web/backend
evidence; per-surface destinations live in `src/product/native-destinations.mjs`;
this file records what has actually been done and what is still owed.

Regenerate the numbers with:

```bash
node tools/derive-product-manifest.mjs
```

---

## 1. Scope (derived, closed)

| Disposition | Count | Decided by |
|---|---:|---|
| NATIVE_REQUIRED | **60** | not excluded by any admin/enterprise gate |
| ADMIN_ONLY | **36** | `routeRegistry` `domain: PLATFORM_ADMIN` / `requiredActiveSpace: PLATFORM_ADMIN` |
| ENTERPRISE_ONLY | **93** | `ENTERPRISE_ONLY_ROUTE_IDS`, `requiredActiveSpace: ORGANIZATION_ONLY`, or domain GOVERNANCE/OPS/REVIEW_OPERATIONS |
| PLATFORM_SPECIFIC_EQUIVALENT | **19** | public marketing site (no product API, no link token); native equivalent is the store listing |
| UNRESOLVED | **0** | — |
| **Total web routes discovered** | **208** | filesystem walk of `apps/web/app` |

`208 = 60 + 36 + 93 + 19`. The guard `test/product-manifest-coverage.test.mjs`
fails when a new Web route appears with no disposition.

## 2. Implementation status of the 60 NATIVE_REQUIRED surfaces

| Status | Count |
|---|---:|
| PARITY (device-verified) | **0** |
| PARTIAL (primary journey works, named gaps) | **20** |
| SHELL (materially thinner than Web) | **6** |
| NOT_STARTED | **34** |

`PARITY` may not be claimed from CI. It requires the physical-device acceptance
recorded in §5.

## 3. Done so far

### Foundation
- **Derived product manifest** replaces the hand-authored
  `native-surface-contract.ts` (deleted). The old table held 33 rows against 208
  routes and its guard only validated rows it already contained, so an omitted
  surface could never fail it; 79 web routes were absent from it entirely.
- **Protected native capture register** extracted to
  `src/product/protected-native-paths.mjs` and its guard now imports it as data
  rather than regexing source.
- **Derived reachability guard** replaces the declared `reachability` field.

### Blockers closed (code; device acceptance still owed)
| # | Defect | Fix |
|---|---|---|
| B-1 | `crypto.subtle` on every native upload path — no capture of any kind could be sealed | native digests: `expo-crypto` SHA-256, platform MD5 via `getInfoAsync`, chunked reads (peak memory ~3.3x → ~1x). Hand-rolled MD5 and `atob`/`btoa` deleted |
| B-2 | Discard left a reserved Evidence record in the Active library | `POST /v1/capture/direct-sessions/:id/discard` + never-committed list invariant + client awaits the server |
| B-3 | `NativeSharedObjectNotFoundException` on every exit from Capture | stop on blur, not unmount; 250 ms recorder poller deleted |
| B-4 | Google unconfigured in every built binary | client ids moved into all four EAS profiles; iOS reversed-client-id URL scheme registered |

### Defect found by the new guards
`verify-email`, `reset-password` and `invite/[token]` were complete screens that
**nothing navigated to** — every emailed account-recovery link dead-ended. The
superseded contract declared all three "REACHABLE". Fixed by
`parseCredentialDeepLink`, deliberately outside the tenant resolve gate.

### Tests deleted (source-text self-certification) and what replaced them
| Deleted | Why it could not fail | Replacement |
|---|---|---|
| `surface-parity-contract.test.mjs` | validated a hand-written table against itself | `product-manifest-coverage.test.mjs` (walks `apps/web/app`) |
| `native-surface-contract.test.mjs` | compared the tree to a hand-declared `reachability` field; also asserted `PRODUCT_DECISIONS` ids existed as text | `native-route-reachability.test.mjs` (derives reachability from the navigation graph) |
| `oauth-config.test.mjs` | asserted variable NAMES appeared in `use-oauth.ts` while all three were `undefined` in every build | `oauth-build-config.test.mjs` (reads `eas.json` + `app.json`) |

Two pre-existing API tests had been throwing `ENOENT` rather than asserting ever
since Phase 12 removed the mobile files they read
(`app/(tabs)/deleted.tsx`, `app/(tabs)/reports.tsx`). Both repaired.

## 4. Owed — ordered

1. **Device acceptance of B-1…B-4.** Nothing above is proven until it runs on a
   phone/tablet. Until then Capture remains unproven end to end.
2. **Apple audience in the deployed API runtime.** `GOOGLE_CLIENT_IDS` /
   `APPLE_CLIENT_IDS` must include the native audiences and the iOS bundle id.
   Repository code is correct; this is deployment configuration and must be
   verified through the real deployment mechanism, not by restarting anything.
3. **Capture session model (C-1).** Web drives `/v1/capture/sessions` +
   `/v1/uploads/sessions` with a multi-kind `CollectionPlanTemplate`; native
   drives UC-0, where one session reserves exactly one Evidence of one type.
   That is why there is no mixed-media composer — the server model cannot
   express it. Needs one canonical decision, then both clients speak it.
4. **Domain rewiring**, by data starvation: Settings (1 of 26 endpoints),
   Home (2 of 9), Search (1 of 11), Notifications (3 of 13), Cases (6 of 12).
5. **The 34 NOT_STARTED surfaces**, notably Reports (a canonical primary-nav
   destination), account security, organizations/people/workspaces, legal and
   trust-center readers, share/intake/portal flows.
6. **Design system.** 63 of 158 web tokens mirrored, 27 guarded; 12 native
   primitives against 214 web components. Tokens must be generated from
   `tokens.css`, not mirrored.
7. **Domain enums.** `src/product/domain-display.ts` mirrors Prisma enums
   verbatim; must be generated or shared so a canonical change reaches Native.
8. **Component/native-runtime test tiers.** Nothing renders a component today.

## 5. Physical acceptance matrix

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
| Tablet rail nav at ≥840 pt, RTL | n/a | ☐ | ☐ |

## 6. Known limits stated honestly

- `expo-crypto` exposes no **incremental** digest, so a file must still be
  resident once to hash it. Chunked hashing needs a native streaming digest.
  Not claimed as done.
- `globalThis.atob` / `btoa` are no longer used, but whether Hermes provides
  them was never established — it no longer matters on the integrity path.
- The UC-0 discard integration suite has not been executed in this environment
  (no Docker / `TEST_DATABASE_URL`). It runs in the integration environment.
  Production was not contacted at any point.
