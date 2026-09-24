# /auth/mfa-challenge

**PWA entry:** `apps/web/app/auth/mfa-challenge/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/mfa.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 6 | 4 |
| Elements | 123 | 69 |
| Interactive elements | 30 | 15 |
| Conditionally-rendered elements | 34 | 24 |
| Style rules resolved | 17 (79 props) | 72 (82 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/auth/mfa-challenge/page.tsx` | 32 | `(entry)` |
| 1 | `apps/web/components/ui-legacy.tsx` | 27 | `Button` |
| 2 | `apps/web/components/feedback/ProovraToast.tsx` | 13 | `ProovraToast` |
| 3 | `apps/web/components/feedback/severity.tsx` | 13 | `FeedbackIcon` |
| 3 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx` | 34 | `MfaRecoveryRequestPanel` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/mfa.tsx` | 11 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraSection,ProovraCard,ProovraText,ProovraFormField,ProovraInput,ProovraButton` |
| 1 | `apps/mobile/src/ui/brand.tsx` | 4 | `AuthBrandHeader` |
| 1 | `apps/mobile/src/ui/mfa-recovery-request.tsx` | 12 | `MfaRecoveryRequestPanel` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 12 | 9 | -3 |
| CARD | 0 | 2 | 2 |
| CONTAINER | 28 | 24 | -4 |
| FORM | 2 | 0 | -2 |
| HEADING | 7 | 0 | -7 |
| ICON | 16 | 0 | -16 |
| IMAGE | 0 | 1 | 1 |
| INPUT | 6 | 5 | -1 |
| LINK | 5 | 0 | -5 |
| LIST | 0 | 1 | 1 |
| OTHER | 13 | 4 | -9 |
| STATE_LOADING | 0 | 2 | 2 |
| TEXT | 34 | 21 | -13 |

### C.1 Paired (3)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | {busy ? "Filing request…" : "File recovery request"} | `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:570` | `apps/mobile/src/ui/mfa-recovery-request.tsx:179` |
| BUTTON | {busy === "cancel" ? "Cancelling…" : "Cancel request"} | `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:728` | `apps/mobile/src/ui/mfa-recovery-request.tsx:197` |
| BUTTON | {busy ? "Verifying..." : "Verify and continue"} | `apps/web/app/auth/mfa-challenge/page.tsx:395` | `apps/mobile/app/(stack)/mfa.tsx:62` |


### C.2 MISSING in Native (15)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Set up two-factor authentication | `apps/web/app/auth/mfa-challenge/page.tsx:228` |
| LINK | Sign in to start enrollment | `apps/web/app/auth/mfa-challenge/page.tsx:241` |
| LINK | Contact support | `apps/web/app/auth/mfa-challenge/page.tsx:257` |
| HEADING | Sign-in session expired | `apps/web/app/auth/mfa-challenge/page.tsx:282` |
| LINK | Return to sign in | `apps/web/app/auth/mfa-challenge/page.tsx:288` |
| HEADING | Two-factor verification | `apps/web/app/auth/mfa-challenge/page.tsx:317` |
| INPUT | 123 456 | `apps/web/app/auth/mfa-challenge/page.tsx:331` |
| INPUT | ABCDE-FGHJK | `apps/web/app/auth/mfa-challenge/page.tsx:360` |
| LINK | Contact support | `apps/web/app/auth/mfa-challenge/page.tsx:428` |
| INPUT | {error && <div className="input-error">{error}</div>} | `apps/web/components/ui-legacy.tsx:293` |
| BUTTON | Dismiss notification | `apps/web/components/feedback/ProovraToast.tsx:119` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| HEADING | Request an administrator reset | `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:479` |
| BUTTON | Retry | `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:676` |
| HEADING | Your recovery request | `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:709` |

### C.3 EXTRA in Native (10)

| Role | Label | Native source |
|---|---|---|
| INPUT | useRecovery ? "Recovery code" : "Authentication code" | `apps/mobile/app/(stack)/mfa.tsx:53` |
| INPUT | useRecovery ? "xxxx-xxxx" : "123456" | `apps/mobile/app/(stack)/mfa.tsx:54` |
| BUTTON | useRecovery ? "Use authenticator code" : "Use a recovery code" | `apps/mobile/app/(stack)/mfa.tsx:64` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |
| INPUT | What happened | `apps/mobile/src/ui/mfa-recovery-request.tsx:164` |
| INPUT | Describe how you lost access to your authenticator | `apps/mobile/src/ui/mfa-recovery-request.tsx:165` |
| BUTTON | Resend email | `apps/mobile/src/ui/mfa-recovery-request.tsx:190` |

### C.4 SOURCE-UNRESOLVED labels (11)

| Role | PWA source | Why unpairable |
|---|---|---|
| BUTTON | `apps/web/app/auth/mfa-challenge/page.tsx:400` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:209` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:263` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui-legacy.tsx:360` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraToast.tsx:100` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraToast.tsx:104` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:495` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:535` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx:717` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (17 rules, 79 properties)

**`.toast-container`** — `apps/web/app/globals.css` · `.toast-container`

- `position`: **fixed**
- `top`: **20px**
- `right`: **20px**
- `z-index`: **9999**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **10px**
- `width`: **380px**
- `max-width`: **calc(100vw - 40px)**
- `pointer-events`: **none**

**`.toast-container`** — `apps/web/app/globals.css` · `.toast-container > *`

- `animation`: **pf-toast-in 0.28s cubic-bezier(0.16, 1, 0.3, 1)**

**`.modal-overlay`** — `apps/web/app/globals.css` · `.modal-overlay`

- `position`: **fixed**
- `inset`: **0**
- `background`: **rgba(0, 0, 0, 0.7)**
- `z-index`: **9998**
- `animation`: **fadeIn 0.2s ease-out**
- `backdrop-filter`: **blur(2px)**

**`.modal-content`** — `apps/web/app/globals.css` · `.modal-content`

- `position`: **fixed**
- `top`: **50%**
- `left`: **50%**
- `transform`: **translate(-50%, -50%)**
- `background`: **linear-gradient(135deg, #102126 0%, #1b3136 100%)**
- `border`: **1px solid rgba(158, 216, 207, 0.2)**
- `border-radius`: **12px**
- `box-shadow`: **0 0 30px rgba(158, 216, 207, 0.1), 0 20px 60px rgba(0, 0, 0, 0.4)**
- `z-index`: **9999**
- `max-width`: **500px**
- `width`: **90%**
- `max-height`: **90vh**
- `overflow-y`: **auto**
- `animation`: **slideUp 0.3s ease-out**

**`.modal-header`** — `apps/web/app/globals.css` · `.modal-header`

- `padding`: **24px**

**`.modal-header`** — `apps/web/app/globals.css` · `.modal-header h2`

- `margin`: **0**
- `font-size`: **20px**
- `font-weight`: **600**
- `color`: **#e2e8f0**

**`.modal-close`** — `apps/web/app/globals.css` · `.modal-close`

- `border`: **0**
- `background`: **transparent**
- `color`: **#e2e8f0**
- `font-size`: **24px**
- `line-height`: **1**
- `cursor`: **pointer**

**`.modal-body`** — `apps/web/app/globals.css` · `.modal-body`

- `padding`: **24px**

**`.modal-footer`** — `apps/web/app/globals.css` · `.modal-footer`

- `padding`: **24px**

**`.skeleton`** — `apps/web/app/globals.css` · `.skeleton`

- `background-color`: **#e2e8f0**
- `border-radius`: **8px**
- `animation`: **pulse 1.6s ease-in-out infinite**

**`.empty-state-container`** — `apps/web/app/globals.css` · `.empty-state-container`

- `display`: **flex**
- `flex-direction`: **column**
- `align-items`: **center**
- `justify-content`: **center**
- `padding`: **60px 24px**
- `text-align`: **center**
- `gap`: **16px**

**`.empty-state-icon`** — `apps/web/app/globals.css` · `.empty-state-icon`

- `width`: **64px**
- `height`: **64px**
- `background`: **#f0f4f8**
- `border-radius`: **12px**
- `display`: **flex**
- `align-items`: **center**
- `justify-content`: **center**
- `color`: **#64748b**
- `font-size`: **32px**

**`.empty-state-title`** — `apps/web/app/globals.css` · `.empty-state-title`

- `margin`: **0**
- `font-size`: **18px**
- `font-weight`: **600**
- `color`: **#0f1d36**

**`.empty-state-subtitle`** — `apps/web/app/globals.css` · `.empty-state-subtitle`

- `margin`: **0**
- `color`: **#64748b**
- `font-size`: **14px**

**`.empty-state-button`** — `apps/web/app/globals.css` · `.empty-state-button`

- `margin-top`: **8px**

**`.input-error`** — `apps/web/app/globals.css` · `.input-error`

- `color`: **#d64545**
- `font-size`: **12px**
- `margin-top`: **4px**

**`.select-label`** — `apps/web/app/globals.css` · `.select-label`

- `display`: **block**
- `margin-bottom`: **6px**
- `font-size`: **14px**
- `font-weight`: **500**
- `color`: **#0f1d36**



### D.2 PWA SOURCE-UNRESOLVED (4)

- `finalClassName` at `apps/web/components/ui-legacy.tsx:163` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``card ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:179` — className built from a runtime expression
- ``input ${error ? "input-has-error" : ""} ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:293` — className built from a runtime expression
- ``select ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:360` — className built from a runtime expression

### D.3 Native StyleSheet rules resolved (72 rules, 82 properties)

**`intro`** — `apps/mobile/app/(stack)/mfa.tsx`

- `marginBottom`: **16**  _(theme.space.s4)_

**`actions`** — `apps/mobile/app/(stack)/mfa.tsx`

- `marginTop`: **8**  _(theme.space.s2)_

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

**`wrap`** — `apps/mobile/src/ui/brand.tsx`

- `alignItems`: **center**
- `marginTop`: **32**  _(theme.space.s8)_
- `marginBottom`: **24**  _(theme.space.s6)_

**`mark`** — `apps/mobile/src/ui/brand.tsx`

- `width`: **72**
- `height`: **81**
- `marginBottom`: **12**  _(theme.space.s3)_

**`word`** — `apps/mobile/src/ui/brand.tsx`

- `letterSpacing`: **2**

**`tag`** — `apps/mobile/src/ui/brand.tsx`

- `marginTop`: **8**  _(theme.space.s2)_

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 6 |
| Native files inspected (rendered tree) | 4 |
| PWA elements identified | 123 |
| Native elements identified | 69 |
| Pairable PWA elements | 30 |
| Paired | 2 |
| Missing in Native | 15 |
| Extra in Native | 10 |
| Unlabelled (not pairable by label) | 1 |
| SOURCE-UNRESOLVED labels | 11 |
| PWA style properties resolved | 79 |
| PWA style items SOURCE-UNRESOLVED | 4 |
| Native style properties resolved | 82 |
| PWA interactive elements | 30 |
| Native interactive elements | 15 |
| PWA conditional branches | 34 |
| Native conditional branches | 24 |
