# /verify/[token]

**PWA entry:** `apps/web/app/verify/[token]/page.tsx`
**Native entry:** `apps/mobile/app/verify.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 9 | 3 |
| Elements | 543 | 80 |
| Interactive elements | 59 | 11 |
| Conditionally-rendered elements | 359 | 30 |
| Style rules resolved | 33 (106 props) | 78 (87 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/verify/[token]/page.tsx` | 422 | `(entry)` |
| 1 | `apps/web/components/ui-legacy.tsx` | 27 | `Card,Skeleton,EmptyState,Button` |
| 2 | `apps/web/components/feedback/ProovraToast.tsx` | 13 | `ProovraToast` |
| 3 | `apps/web/components/feedback/severity.tsx` | 13 | `FeedbackIcon` |
| 3 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/capture-location/CaptureLocationMapPanel.tsx` | 25 | `CaptureLocationMapPanel` |
| 1 | `apps/web/components/verify-v2/VerifyTechnicalMetadataSection.tsx` | 17 | `VerifyTechnicalMetadataSection` |
| 1 | `apps/web/components/verify-v2/VerifyCaptureIntegritySection.tsx` | 13 | `VerifyCaptureIntegritySection` |
| 1 | `apps/web/components/verify-v2/VerifyRedactionSection.tsx` | 9 | `VerifyRedactionSection` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/verify.tsx` | 34 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraLoadingState,ProovraCard,ProovraFormField,ProovraInput,ProovraButton,ProovraErrorState,ProovraSection,ProovraBadge,ProovraText,ProovraListRow` |
| 1 | `apps/mobile/src/ui/brand.tsx` | 4 | `AuthBrandHeader` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 13 | 2 | -11 |
| BUTTON | 24 | 6 | -18 |
| CARD | 12 | 6 | -6 |
| CONTAINER | 354 | 24 | -330 |
| HEADING | 7 | 0 | -7 |
| ICON | 16 | 0 | -16 |
| IMAGE | 8 | 1 | -7 |
| INPUT | 23 | 3 | -20 |
| LINK | 7 | 0 | -7 |
| LIST | 8 | 2 | -6 |
| OTHER | 32 | 6 | -26 |
| STATE_EMPTY | 2 | 0 | -2 |
| STATE_ERROR | 0 | 1 | 1 |
| STATE_LOADING | 8 | 3 | -5 |
| TEXT | 29 | 26 | -3 |

### C.1 Paired (1)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Try Again | `apps/web/app/verify/[token]/page.tsx:4616` | `apps/mobile/src/ui/index.tsx:531` |


### C.2 MISSING in Native (59)

| Role | Label | PWA source |
|---|---|---|
| BUTTON | Copy | `apps/web/app/verify/[token]/page.tsx:515` |
| BUTTON | {expanded ? "Collapse" : "Expand"} | `apps/web/app/verify/[token]/page.tsx:703` |
| BADGE | countLabel ?? `${events.length} Event${events.length === 1 ? "" : "s"}` | `apps/web/app/verify/[token]/page.tsx:911` |
| LINK | Open text evidence | `apps/web/app/verify/[token]/page.tsx:1399` |
| LINK | Open preserved file | `apps/web/app/verify/[token]/page.tsx:1442` |
| BADGE | row.value | `apps/web/app/verify/[token]/page.tsx:2487` |
| BADGE | signatureValid === true ? "Valid" : signatureValid === false ? "Invalid" : signature ? "Present" : "Unavailable" | `apps/web/app/verify/[token]/page.tsx:4135` |
| BADGE | canonicalHashMatches === true ? "Valid" : canonicalHashMatches === false ? "Invalid" : "Pending" | `apps/web/app/verify/[token]/page.tsx:4163` |
| BADGE | custodyChainValid === true ? custodyChainMode === "legacy" ? "Valid (Legacy)" : "Valid" : custodyChainValid === false ? | `apps/web/app/verify/[token]/page.tsx:4187` |
| BADGE | otsTone(otsStatus, otsBitcoinTxid).label | `apps/web/app/verify/[token]/page.tsx:4213` |
| BADGE | storagePresentation.badgeLabel | `apps/web/app/verify/[token]/page.tsx:4223` |
| BADGE | timestampTone(tsaStatus).label | `apps/web/app/verify/[token]/page.tsx:4233` |
| BADGE | otsProofPresent === true ? "Proof Present" : otsProofPresent === false ? "Not Present" : "Unavailable" | `apps/web/app/verify/[token]/page.tsx:4278` |
| BADGE | otsHashMatches === true ? "Hash Matches" : otsHashMatches === false ? "Hash Mismatch" : "Unavailable" | `apps/web/app/verify/[token]/page.tsx:4304` |
| LINK | Back to Home | `apps/web/app/verify/[token]/page.tsx:4495` |
| HEADING | Evidence Trust Decision | `apps/web/app/verify/[token]/page.tsx:4532` |
| STATE_EMPTY | Verification Failed | `apps/web/app/verify/[token]/page.tsx:4612` |
| STATE_EMPTY | Evidence Not Found | `apps/web/app/verify/[token]/page.tsx:4634` |
| BUTTON | Back to Home | `apps/web/app/verify/[token]/page.tsx:4638` |
| BADGE | item.label | `apps/web/app/verify/[token]/page.tsx:4989` |
| INPUT | Snapshot Source | `apps/web/app/verify/[token]/page.tsx:5195` |
| INPUT | Generated At | `apps/web/app/verify/[token]/page.tsx:5199` |
| INPUT | Report Version | `apps/web/app/verify/[token]/page.tsx:5207` |
| INPUT | Package Version | `apps/web/app/verify/[token]/page.tsx:5215` |
| INPUT | OTS Status At Generation | `apps/web/app/verify/[token]/page.tsx:5223` |
| INPUT | Report Signature | `apps/web/app/verify/[token]/page.tsx:5227` |
| INPUT | Package Manifest Signature | `apps/web/app/verify/[token]/page.tsx:5231` |
| INPUT | Snapshot Trust Decision | `apps/web/app/verify/[token]/page.tsx:5241` |
| INPUT | Current OTS Status | `apps/web/app/verify/[token]/page.tsx:5315` |
| INPUT | Anchored At | `apps/web/app/verify/[token]/page.tsx:5319` |
| INPUT | Bitcoin Transaction | `apps/web/app/verify/[token]/page.tsx:5327` |
| INPUT | Last Anchoring Update | `apps/web/app/verify/[token]/page.tsx:5331` |
| INPUT | Latest Report | `apps/web/app/verify/[token]/page.tsx:5339` |
| INPUT | Latest Package | `apps/web/app/verify/[token]/page.tsx:5343` |
| BUTTON | Copy TxID | `apps/web/app/verify/[token]/page.tsx:5534` |
| LINK | Open preserved evidence | `apps/web/app/verify/[token]/page.tsx:6089` |
| LINK | Download evidence | `apps/web/app/verify/[token]/page.tsx:6115` |
| BUTTON | Jump to primary item | `apps/web/app/verify/[token]/page.tsx:6227` |
| HEADING | Technical Review Materials | `apps/web/app/verify/[token]/page.tsx:6275` |
| BUTTON | Record | `apps/web/app/verify/[token]/page.tsx:6360` |
| BUTTON | Integrity | `apps/web/app/verify/[token]/page.tsx:6365` |
| BUTTON | Package Integrity | `apps/web/app/verify/[token]/page.tsx:6370` |
| BUTTON | Custody Chain | `apps/web/app/verify/[token]/page.tsx:6375` |
| BUTTON | Access Activity | `apps/web/app/verify/[token]/page.tsx:6380` |
| INPUT | field.label | `apps/web/app/verify/[token]/page.tsx:6412` |
| INPUT | evidenceContentSummary?.itemCount && evidenceContentSummary.itemCount > 1 ? "Canonical Package Digest (SHA-256)" : tsaIn | `apps/web/app/verify/[token]/page.tsx:6467` |
| INPUT | timestampedDigestLabel ?? getTimestampDigestLabel({ itemCount: evidenceContentSummary?.itemCount, tsaInputKind, }) | `apps/web/app/verify/[token]/page.tsx:6531` |
| INPUT | Canonical Fingerprint Hash | `apps/web/app/verify/[token]/page.tsx:6559` |
| INPUT | Digital Signature | `apps/web/app/verify/[token]/page.tsx:6570` |
| INPUT | Public Key | `apps/web/app/verify/[token]/page.tsx:6581` |
| INPUT | OpenTimestamps Proof | `apps/web/app/verify/[token]/page.tsx:6592` |
| HEADING | Actions | `apps/web/app/verify/[token]/page.tsx:6873` |
| BUTTON | Copy Verification Link | `apps/web/app/verify/[token]/page.tsx:6900` |
| INPUT | {error && <div className="input-error">{error}</div>} | `apps/web/components/ui-legacy.tsx:293` |
| BUTTON | Dismiss notification | `apps/web/components/feedback/ProovraToast.tsx:119` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | Copy coordinates | `apps/web/components/capture-location/CaptureLocationMapPanel.tsx:297` |
| LINK | Open in map | `apps/web/components/capture-location/CaptureLocationMapPanel.tsx:316` |
| HEADING | Redaction | `apps/web/components/verify-v2/VerifyRedactionSection.tsx:103` |

### C.3 EXTRA in Native (8)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Verifying | `apps/mobile/app/verify.tsx:81` |
| INPUT | Verification link or id | `apps/mobile/app/verify.tsx:88` |
| INPUT | https://proovra.com/verify/… | `apps/mobile/app/verify.tsx:89` |
| BUTTON | Verify | `apps/mobile/app/verify.tsx:91` |
| BUTTON | Open verification report | `apps/mobile/app/verify.tsx:181` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |

### C.4 SOURCE-UNRESOLVED labels (14)

| Role | PWA source | Why unpairable |
|---|---|---|
| BUTTON | `apps/web/app/verify/[token]/page.tsx:696` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/verify/[token]/page.tsx:753` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/verify/[token]/page.tsx:885` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/verify/[token]/page.tsx:2409` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/verify/[token]/page.tsx:4646` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/verify/[token]/page.tsx:6332` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/verify/[token]/page.tsx:6926` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:209` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:263` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui-legacy.tsx:360` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraToast.tsx:100` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraToast.tsx:104` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (33 rules, 106 properties)

**`.page`** — `apps/web/app/globals.css` · `.page`

- `min-height`: **100vh**
- `display`: **flex**
- `flex-direction`: **column**

**`.verify-enterprise-font`** — `apps/web/app/globals.css` · `.verify-enterprise-font`

- `font-family`: **var(--font-jakarta), ui-sans-serif, system-ui, sans-serif !important**  ⚠ undeclared --font-jakarta

**`.verify-enterprise-font`** — `apps/web/app/globals.css` · `.verify-enterprise-font *`

- `font-family`: **var(--font-jakarta), ui-sans-serif, system-ui, sans-serif !important**  ⚠ undeclared --font-jakarta

**`.verify-enterprise-font`** — `apps/web/app/globals.css` · `.verify-enterprise-font input`

- `font-family`: **var(--font-jakarta), ui-sans-serif, system-ui, sans-serif !important**  ⚠ undeclared --font-jakarta

**`.verify-enterprise-font`** — `apps/web/app/globals.css` · `.verify-enterprise-font button`

- `font-family`: **var(--font-jakarta), ui-sans-serif, system-ui, sans-serif !important**  ⚠ undeclared --font-jakarta

**`.verify-enterprise-font`** — `apps/web/app/globals.css` · `.verify-enterprise-font a`

- `font-family`: **var(--font-jakarta), ui-sans-serif, system-ui, sans-serif !important**  ⚠ undeclared --font-jakarta

**`.verify-enterprise-font`** — `apps/web/app/globals.css` · `.verify-enterprise-font textarea`

- `font-family`: **var(--font-jakarta), ui-sans-serif, system-ui, sans-serif !important**  ⚠ undeclared --font-jakarta

**`.verify-enterprise-font`** — `apps/web/app/globals.css` · `.verify-enterprise-font select`

- `font-family`: **var(--font-jakarta), ui-sans-serif, system-ui, sans-serif !important**  ⚠ undeclared --font-jakarta

**`.section`** — `apps/web/app/globals.css` · `.section`

- `padding`: **120px 0 160px**

**`.section`** — `apps/web/app/globals.css` · `html[dir="rtl"] .section`

- `direction`: **rtl**
- `text-align`: **right**

**`.container`** — `apps/web/app/globals.css` · `.container`

- `max-width`: **1180px**  _(--container-max=1180px)_
- `margin`: **0 auto**
- `width`: **100%**
- `padding`: **0 16px**  _(--container-gutter=16px)_

**`.container`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > .card:first-child`

- `margin-top`: **8px**

**`.container`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > .grid-2:first-child`

- `position`: **relative**

**`.container`** — `apps/web/app/globals.css` · `.app-hero + .app-body .container > div:first-child`

- `position`: **relative**

**`.page-title`** — `apps/web/app/globals.css` · `.page-title`

- `display`: **flex**
- `align-items`: **flex-start**
- `justify-content`: **space-between**
- `gap`: **24px**
- `flex-wrap`: **wrap**
- `margin-bottom`: **0**

**`.page-title`** — `apps/web/app/globals.css` · `.page-title > div:first-child`

- `min-width`: **0**

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



### D.2 PWA SOURCE-UNRESOLVED (5)

- `page-subtitle` at `apps/web/app/verify/[token]/page.tsx:4545` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `finalClassName` at `apps/web/components/ui-legacy.tsx:163` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``card ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:179` — className built from a runtime expression
- ``input ${error ? "input-has-error" : ""} ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:293` — className built from a runtime expression
- ``select ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:360` — className built from a runtime expression

### D.3 Native StyleSheet rules resolved (78 rules, 87 properties)

**`card`** — `apps/mobile/app/verify.tsx`

- `marginBottom`: **16**  _(theme.space.s4)_
- `gap`: **8**  _(theme.space.s2)_

**`gap`** — `apps/mobile/app/verify.tsx`

- `marginTop`: **8**  _(theme.space.s2)_

**`hashRow`** — `apps/mobile/app/verify.tsx`

- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.06)**  _(theme.color.border.subtle)_
- `gap`: **2**

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
| PWA files inspected (rendered tree) | 9 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 543 |
| Native elements identified | 80 |
| Pairable PWA elements | 104 |
| Paired | 1 |
| Missing in Native | 59 |
| Extra in Native | 8 |
| Unlabelled (not pairable by label) | 30 |
| SOURCE-UNRESOLVED labels | 14 |
| PWA style properties resolved | 106 |
| PWA style items SOURCE-UNRESOLVED | 5 |
| Native style properties resolved | 87 |
| PWA interactive elements | 59 |
| Native interactive elements | 11 |
| PWA conditional branches | 359 |
| Native conditional branches | 30 |
