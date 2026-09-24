# /portal/[token]

**PWA entry:** `apps/web/app/portal/[token]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/portal/[token].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 4 | 2 |
| Elements | 70 | 66 |
| Interactive elements | 11 | 11 |
| Conditionally-rendered elements | 30 | 36 |
| Style rules resolved | 0 (0 props) | 60 (72 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/portal/[token]/page.tsx` | 49 | `(entry)` |
| 1 | `apps/web/components/external-portal/PortalMfaCodeStep.tsx` | 11 | `PortalMfaCodeStep` |
| 2 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 1 | `apps/web/components/external-portal/PortalDenialNotice.tsx` | 5 | `PortalDenialNotice` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/portal/[token].tsx` | 24 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraPageHeader,ProovraLoadingState,ProovraCard,ProovraText,ProovraFormField,ProovraInput,ProovraButton,ProovraEmpty,ProovraBadge,ProovraPageSection,ProovraListRow` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 9 | 2 | -7 |
| BUTTON | 6 | 6 | 0 |
| CARD | 0 | 4 | 4 |
| CONTAINER | 11 | 22 | 11 |
| HEADING | 3 | 0 | -3 |
| INPUT | 1 | 3 | 2 |
| LINK | 1 | 0 | -1 |
| LIST | 16 | 2 | -14 |
| OTHER | 3 | 3 | 0 |
| STATE_EMPTY | 0 | 2 | 2 |
| STATE_ERROR | 1 | 0 | -1 |
| STATE_LOADING | 1 | 3 | 2 |
| TEXT | 18 | 19 | 1 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | {busy ? "Trying again…" : "Try again"} | `apps/web/components/external-portal/PortalDenialNotice.tsx:157` | `apps/mobile/src/ui/index.tsx:531` |


### C.2 MISSING in Native (10)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Confirm it is you | `apps/web/app/portal/[token]/page.tsx:113` |
| BADGE | projection.reviewer.organization | `apps/web/app/portal/[token]/page.tsx:206` |
| BADGE | projection.session.mfaSatisfied ? "MFA satisfied" : "MFA required" | `apps/web/app/portal/[token]/page.tsx:217` |
| BADGE | `SSO bound: ${projection.session.ssoConnectionId.slice(0, 8)}…` | `apps/web/app/portal/[token]/page.tsx:227` |
| BUTTON | Log out | `apps/web/app/portal/[token]/page.tsx:236` |
| HEADING | Assigned reviews | `apps/web/app/portal/[token]/page.tsx:294` |
| LINK | Open review → | `apps/web/app/portal/[token]/page.tsx:336` |
| HEADING | Enter your sign-in code | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:196` |
| BUTTON | {busy === "verify" ? "Checking code…" : "Verify code"} | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:267` |
| BUTTON | {busy ? "Signing in…" : "Sign in again"} | `apps/web/components/external-portal/PortalDenialNotice.tsx:146` |

### C.3 EXTRA in Native (12)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Opening your review access | `apps/mobile/app/(stack)/portal/[token].tsx:164` |
| INPUT | Verification code | `apps/mobile/app/(stack)/portal/[token].tsx:170` |
| INPUT | 123456 | `apps/mobile/app/(stack)/portal/[token].tsx:171` |
| BUTTON | Continue | `apps/mobile/app/(stack)/portal/[token].tsx:179` |
| STATE_EMPTY | This review access is not open | `apps/mobile/app/(stack)/portal/[token].tsx:189` |
| BADGE | phase.dashboard.scopeLabel | `apps/mobile/app/(stack)/portal/[token].tsx:207` |
| STATE_EMPTY | Nothing is assigned to you right now. | `apps/mobile/app/(stack)/portal/[token].tsx:219` |
| BADGE | a.submittedDecisionAtIso ? "Done" : "To review" | `apps/mobile/app/(stack)/portal/[token].tsx:235` |
| BUTTON | Sign out of the portal | `apps/mobile/app/(stack)/portal/[token].tsx:265` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |

### C.4 SOURCE-UNRESOLVED labels (9)

| Role | PWA source | Why unpairable |
|---|---|---|
| BADGE | `apps/web/app/portal/[token]/page.tsx:204` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/portal/[token]/page.tsx:208` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/portal/[token]/page.tsx:209` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/portal/[token]/page.tsx:210` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/portal/[token]/page.tsx:212` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/portal/[token]/page.tsx:233` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:217` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/external-portal/PortalMfaCodeStep.tsx:277` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (0 rules, 0 properties)

_no static classes on this route_



### D.2 PWA SOURCE-UNRESOLVED (3)

- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (60 rules, 72 properties)

**`flex`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`screen`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `backgroundColor`: **#F7F8FC**  _(theme.color.surface.app)_

**`screenBody`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`centerColumn`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `width`: **100%**
- `alignItems`: **center**

**`screenPadded`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_

**`scrollContent`** — `apps/mobile/src/ui/index.tsx`

- `paddingBottom`: **40**  _(theme.space.s10)_
- `flexGrow`: **1**

**`footer`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`card`** — `apps/mobile/src/ui/index.tsx`

- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_
- `borderRadius`: **14**  _(theme.radius.card)_
- `padding`: **20**  _(theme.space.s5)_
- `borderWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_

**`pressed`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.94**

**`section`** — `apps/mobile/src/ui/index.tsx`

- `marginBottom`: **24**  _(theme.space.s6)_

**`sectionHead`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **space-between**
- `marginBottom`: **12**  _(theme.space.s3)_

**`button`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_
- `paddingHorizontal`: **20**  _(theme.space.s5)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignItems`: **center**
- `justifyContent`: **center**

**`buttonFull`** — `apps/mobile/src/ui/index.tsx`

- `alignSelf`: **stretch**

**`buttonDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

**`buttonInner`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_

**`buttonLabel`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `fontWeight`: **600**

**`badge`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_
- `paddingVertical`: **6**
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignSelf`: **flex-start**

**`badgeDot`** — `apps/mobile/src/ui/index.tsx`

- `width`: **8**
- `height`: **8**
- `borderRadius`: **4**

**`badgeText`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.label**  _(theme.type.size.label)_  ⚠ token path not found in proovra.generated.ts

**`row`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_

**`rowInner`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `gap`: **12**  _(theme.space.s3)_

**`rowText`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `gap`: **2**

**`stateCenter`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **center**
- `paddingVertical`: **40**  _(theme.space.s10)_

**`stateGap`** — `apps/mobile/src/ui/index.tsx`

- `marginTop`: **12**  _(theme.space.s3)_

**`field`** — `apps/mobile/src/ui/index.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **16**  _(theme.space.s4)_

**`input`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `borderWidth`: **1**
- `borderRadius`: **8**  _(theme.radius.md)_
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `color`: **#0F172A**  _(theme.color.ink.primary)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`inputDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 4 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 70 |
| Native elements identified | 66 |
| Pairable PWA elements | 22 |
| Paired | 1 |
| Missing in Native | 10 |
| Extra in Native | 12 |
| Unlabelled (not pairable by label) | 2 |
| SOURCE-UNRESOLVED labels | 9 |
| PWA style properties resolved | 0 |
| PWA style items SOURCE-UNRESOLVED | 3 |
| Native style properties resolved | 72 |
| PWA interactive elements | 11 |
| Native interactive elements | 11 |
| PWA conditional branches | 30 |
| Native conditional branches | 36 |
