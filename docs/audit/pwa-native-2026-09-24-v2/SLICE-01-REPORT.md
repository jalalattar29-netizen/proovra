# SLICE 1 — T-02 · T-03 · T-22 (RC-02, RC-03, RC-23)

**Base SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Wave:** G1 · **Authorized:** yes

---

## 1. Changed production files

| File | Change | Why |
|---|---|---|
| `apps/web/public/.well-known/apple-app-site-association:6` | `<APPLE_TEAM_ID>` → `4LCZK75N86` | RC-02 — the placeholder resolves over HTTPS and then fails association silently, so **every iOS Universal Link opened Safari**. Team ID user-confirmed; it appears nowhere in the repo and was not inferred. |
| `apps/web/__tests__/universal-link-parity.test.ts:137-178` | guard now **rejects** the placeholder | RC-23 — the guard was written to **pass** on `<APPLE_TEAM_ID>`. CI stayed green for the entire period in which every iOS deep link was dead, and the defect was found on a physical iPad instead of in the pipeline. |
| `apps/mobile/.env` (untracked, gitignored) | three platform-specific Google client IDs; retired `EXPO_PUBLIC_GOOGLE_CLIENT_ID` removed | RC-03 — `use-oauth.ts:45-47` reads only the platform names, so any locally-bundled build had `iosClientId === undefined` → `promptGoogle` refused with `OAUTH_GOOGLE_UNCONFIGURED` (503) before any network call. |

**No secret was written.** The three Google values are public OAuth client identifiers already committed in `eas.json`; no client secret is in `.env`.

## 2. Root-cause proof, before → after

**RC-02** — `apple-app-site-association:6`
```
- "<APPLE_TEAM_ID>.com.jalalattar29.proovra"
+ "4LCZK75N86.com.jalalattar29.proovra"
```
iOS cannot match a placeholder appID to an installed app; it declines the association and every `https://www.proovra.com/...` link opens the browser. 10 declared path components → **14 of the 63 applicable routes**.

**RC-03** — `apps/mobile/.env`
```
- EXPO_PUBLIC_GOOGLE_CLIENT_ID=…          # read by nothing in the repository
+ EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=…
+ EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=…
+ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=…
```
Verified to **AGREE with all four `eas.json` profiles** (development, preview, production, ios-simulator), so a local bundle and a preview build now behave identically.

## 3. Negative test — proven, not asserted

The mandate requires a test that fails against the original defect. Demonstrated by temporarily restoring the placeholder:

```
✖ the Apple Team ID is a real one, not a placeholder
  AssertionError: the AASA still ships the literal placeholder. Universal Links
  verification fails silently: the file resolves, the appID matches no installed
  app, and every deep link opens the browser instead.
ℹ pass 4  ℹ fail 1
```

Restored to the fix:
```
ℹ tests 5  ℹ pass 5  ℹ fail 0
```

Plus `retired-endpoint-presentation.test.ts` — **8 tests, 8 pass, 0 fail**. No regressions; nothing else in `apps`, `services`, `packages` or `e2e` depends on the placeholder.

## 4. Security / authorization checks

* No audience check weakened. `assertAudience` untouched.
* No secret, token or private key read, written or printed.
* `check-env-example.mjs` still passes — *".env.example matches the 7 variables the code reads"*.
* `.env` remains untracked and gitignored (`.gitignore:2`).

### Refinement to RC-01 found while verifying
`services/api/src/services/auth.service.ts:277` needs `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY`, and the production env record **has all three**. Those serve `createAppleClientSecret` → `exchangeAppleCodeForIdToken`, i.e. the **web authorization-code** flow.
**Native does not use that path.** It posts an identity token to `/v1/auth/apple` → `verifyAppleIdToken` → `assertAudience(payload.aud, allowedAudiences("APPLE_CLIENT_ID", "APPLE_CLIENT_IDS"))`. So **RC-01 stands unchanged**: the bundle id must be in `APPLE_CLIENT_IDS`, and Apple signing config being present does not satisfy it.

## 5. Status labels — kept apart

| Dimension | State |
|---|---|
| SOURCE-FIXED | **YES** — RC-02, RC-03, RC-23 |
| AUTOMATED-TESTED | **YES** — negative test proven, 8/8 pass |
| DEPLOYED-CONFIG-VERIFIED | **NO** — the AASA must be **deployed and the CDN cache purged**; I did not deploy |
| PHYSICAL-ACCEPTED | **NO** — no device run |

**Universal Links are NOT fixed until the new AASA is served.** A prior live probe recorded production returning the placeholder; nothing in this slice changes what is served.

## 6. Ledger

| | |
|---|---|
| Rows closed | **15 of 1,044** (12 G0 handler closures + RC-02, RC-03, RC-23) |
| Open | 1,029 |

## 7. External dependencies and tests NOT run

1. **Deploy `apps/web` + purge CDN** for `/.well-known/apple-app-site-association` — requires authorization.
2. **RV-02** — device test that an emailed `/verify/<token>` opens the app.
3. **RV-01 / T-01** — `GOOGLE_CLIENT_IDS` and `APPLE_CLIENT_IDS` on the deployed API. **Not in the repository; needs host access.** Still the leading explanation for the observed sign-in failure.
4. **T-03 device proof** — a locally-bundled build showing an enabled Google button.

## 8. Next

**Slice 2 — T-01 (RC-01), the last P0.** It is deployment configuration, not code: confirm `GOOGLE_CLIENT_IDS` contains the iOS + Android client IDs and `APPLE_CLIENT_IDS` contains `com.jalalattar29.proovra`, verified by membership check rather than by printing values.

**Blocked on:** API host access or a redacted `printenv` result.
**Unblocked meanwhile:** T-04 (fonts) and T-05 (artwork) — independent of auth, and T-07 is now decided (**PWA canonical**), which unblocks T-06/T-07 once artwork lands.
