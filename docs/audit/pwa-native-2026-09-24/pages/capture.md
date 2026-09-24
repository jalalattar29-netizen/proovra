# /capture

**PWA entry:** `apps/web/app/(app)/capture/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/capture.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 28 | 3 |
| Elements | 718 | 157 |
| Interactive elements | 84 | 41 |
| Conditionally-rendered elements | 337 | 111 |
| Style rules resolved | 1043 (3650 props) | 124 (185 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/capture/page.tsx` | 158 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell,PageHeader` |
| 1 | `apps/web/components/uploads/UploadOperationsPanel.tsx` | 30 | `UploadOperationsPanel` |
| 1 | `apps/web/app/(app)/capture/_lib/CaptureIntakeRail.tsx` | 7 | `CaptureIntakeRail` |
| 1 | `apps/web/app/(app)/capture/_lib/CaptureTrustStrip.tsx` | 7 | `CaptureTrustStrip` |
| 1 | `apps/web/app/(app)/capture/_lib/CaptureDirectWebCaptureCard.tsx` | 8 | `CaptureDirectWebCaptureCard` |
| 1 | `apps/web/components/contextual-help/ContextualHelp.tsx` | 10 | `ContextualHelp` |
| 1 | `apps/web/app/(app)/capture/_lib/CaptureReadinessPanel.tsx` | 13 | `CaptureReadinessPanel` |
| 1 | `apps/web/app/(app)/capture/_lib/CaptureSuggestionsPanel.tsx` | 10 | `CaptureSuggestionsPanel` |
| 1 | `apps/web/components/capture-v2/CaptureRequirements.tsx` | 42 | `CaptureRequirements` |
| 1 | `apps/web/app/(app)/capture/_lib/CaptureDraftReattachNotice.tsx` | 12 | `CaptureDraftReattachNotice` |
| 1 | `apps/web/components/capture-v2/CaptureDropzone.tsx` | 18 | `CaptureDropzone` |
| 2 | `apps/web/components/ui-legacy.tsx` | 27 | `Button` |
| 3 | `apps/web/components/feedback/ProovraToast.tsx` | 13 | `ProovraToast` |
| 4 | `apps/web/components/feedback/severity.tsx` | 13 | `FeedbackIcon` |
| 1 | `apps/web/app/(app)/capture/_lib/CaptureOperationalSummary.tsx` | 7 | `CaptureOperationalSummary` |
| 1 | `apps/web/app/(app)/capture/_lib/CaptureActivityDisclosure.tsx` | 15 | `CaptureActivityDisclosure` |
| 1 | `apps/web/app/(app)/capture/_lib/CaptureFinalReadiness.tsx` | 9 | `CaptureFinalReadiness` |
| 1 | `apps/web/components/capture-v2/CaptureBottomBar.tsx` | 8 | `CaptureBottomBar` |
| 1 | `apps/web/components/capture-v2/CaptureSessionPanel.tsx` | 85 | `CaptureSessionPanel` |
| 2 | `apps/web/app/(app)/capture/_lib/CaptureReadinessSignals.tsx` | 19 | `CaptureReadinessSignals` |
| 2 | `apps/web/components/ai/CaptureAiAssistant.tsx` | 107 | `CaptureAiAssistant` |
| 1 | `apps/web/components/capture-v2/CaptureCameraOverlay.tsx` | 23 | `CaptureCameraOverlay` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/capture.tsx` | 88 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraButton,ProovraSection,ProovraCard,ProovraText,ProovraEmptyState,ProovraSheet,ProovraListRow,ProovraBadge,ProovraFormField,ProovraInput` |
| 1 | `apps/mobile/src/ui/capture-plan-sections.tsx` | 27 | `CapturePlanSections` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 4 | 4 |
| BUTTON | 54 | 28 | -26 |
| CARD | 2 | 9 | 7 |
| CONTAINER | 241 | 40 | -201 |
| DIALOG | 0 | 3 | 3 |
| HEADING | 16 | 0 | -16 |
| ICON | 61 | 0 | -61 |
| IMAGE | 1 | 1 | 0 |
| INPUT | 9 | 4 | -5 |
| LINK | 4 | 0 | -4 |
| LIST | 34 | 7 | -27 |
| OTHER | 60 | 5 | -55 |
| STATE_EMPTY | 0 | 1 | 1 |
| STATE_ERROR | 3 | 0 | -3 |
| STATE_LOADING | 0 | 2 | 2 |
| TEXT | 233 | 53 | -180 |

### C.1 Paired (5)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Resume | `apps/web/app/(app)/capture/page.tsx:694` | `apps/mobile/app/(stack)/capture.tsx:1317` |
| BUTTON | Start Recording | `apps/web/app/(app)/capture/page.tsx:968` | `apps/mobile/app/(stack)/capture.tsx:1459` |
| BUTTON | Discard | `apps/web/app/(app)/capture/page.tsx:984` | `apps/mobile/app/(stack)/capture.tsx:1318` |
| BUTTON | Stop | `apps/web/app/(app)/capture/page.tsx:976` | `apps/mobile/app/(stack)/capture.tsx:1435` |
| BUTTON | Record | `apps/web/components/capture-v2/CaptureCameraOverlay.tsx:140` | `apps/mobile/app/(stack)/capture.tsx:1532` |


### C.2 MISSING in Native (49)

| Role | Label | PWA source |
|---|---|---|
| BUTTON | Drafts ( {draftList.drafts.length} ) | `apps/web/app/(app)/capture/page.tsx:650` |
| BUTTON | Close | `apps/web/app/(app)/capture/page.tsx:674` |
| BUTTON | Delete | `apps/web/app/(app)/capture/page.tsx:717` |
| BUTTON | Add to Session | `apps/web/app/(app)/capture/page.tsx:995` |
| BUTTON | Clear all mappings | `apps/web/app/(app)/capture/page.tsx:1056` |
| BUTTON | Remove pending items | `apps/web/app/(app)/capture/page.tsx:1069` |
| BUTTON | {isExpanded ? "Close" : "Notes"} | `apps/web/app/(app)/capture/page.tsx:1267` |
| BUTTON | Remove | `apps/web/app/(app)/capture/page.tsx:1279` |
| INPUT | Add a note about this material (private to you). | `apps/web/app/(app)/capture/page.tsx:1298` |
| INPUT | e.g. Phone camera, on-site | `apps/web/app/(app)/capture/page.tsx:1334` |
| BUTTON | Keep Session | `apps/web/app/(app)/capture/page.tsx:1439` |
| BUTTON | Clear Session | `apps/web/app/(app)/capture/page.tsx:1447` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | Resume | `apps/web/components/uploads/UploadOperationsPanel.tsx:189` |
| BUTTON | Pause | `apps/web/components/uploads/UploadOperationsPanel.tsx:198` |
| BUTTON | Cancel | `apps/web/components/uploads/UploadOperationsPanel.tsx:207` |
| HEADING | Recover earlier uploads | `apps/web/components/uploads/UploadOperationsPanel.tsx:231` |
| BUTTON | Resume | `apps/web/components/uploads/UploadOperationsPanel.tsx:264` |
| BUTTON | Retry | `apps/web/components/uploads/UploadOperationsPanel.tsx:272` |
| BUTTON | Clear | `apps/web/components/uploads/UploadOperationsPanel.tsx:280` |
| HEADING | Direct Web Capture | `apps/web/app/(app)/capture/_lib/CaptureDirectWebCaptureCard.tsx:61` |
| LINK | Install the PROOVRA extension | `apps/web/app/(app)/capture/_lib/CaptureDirectWebCaptureCard.tsx:79` |
| LINK | Learn how Direct Web Capture works | `apps/web/app/(app)/capture/_lib/CaptureDirectWebCaptureCard.tsx:89` |
| BUTTON | Hide | `apps/web/components/contextual-help/ContextualHelp.tsx:197` |
| BUTTON | Hide | `apps/web/app/(app)/capture/_lib/CaptureReadinessPanel.tsx:150` |
| BUTTON | Hide | `apps/web/app/(app)/capture/_lib/CaptureSuggestionsPanel.tsx:117` |
| BUTTON | Dismiss | `apps/web/app/(app)/capture/_lib/CaptureDraftReattachNotice.tsx:75` |
| INPUT | {error && <div className="input-error">{error}</div>} | `apps/web/components/ui-legacy.tsx:293` |
| BUTTON | Dismiss notification | `apps/web/components/feedback/ProovraToast.tsx:119` |
| BUTTON | Clear Session | `apps/web/components/capture-v2/CaptureBottomBar.tsx:52` |
| BUTTON | {busy ? "Finishing…" : "Review & Sign"} | `apps/web/components/capture-v2/CaptureBottomBar.tsx:61` |
| INPUT | Add investigator, legal, insurance, or internal review context. | `apps/web/components/capture-v2/CaptureSessionPanel.tsx:318` |
| HEADING | Session readiness review | `apps/web/components/ai/CaptureAiAssistant.tsx:477` |
| BUTTON | Close | `apps/web/components/ai/CaptureAiAssistant.tsx:484` |
| HEADING | Reviewing workflow… | `apps/web/components/ai/CaptureAiAssistant.tsx:496` |
| HEADING | AI unavailable | `apps/web/components/ai/CaptureAiAssistant.tsx:501` |
| HEADING | Coverage requirements | `apps/web/components/ai/CaptureAiAssistant.tsx:545` |
| HEADING | Risk signals | `apps/web/components/ai/CaptureAiAssistant.tsx:554` |
| HEADING | Metadata review | `apps/web/components/ai/CaptureAiAssistant.tsx:565` |
| HEADING | Workflow next actions | `apps/web/components/ai/CaptureAiAssistant.tsx:577` |
| HEADING | Legal limitation | `apps/web/components/ai/CaptureAiAssistant.tsx:616` |
| BUTTON | Close | `apps/web/components/capture-v2/CaptureCameraOverlay.tsx:59` |
| BUTTON | Flash | `apps/web/components/capture-v2/CaptureCameraOverlay.tsx:87` |
| BUTTON | Flip | `apps/web/components/capture-v2/CaptureCameraOverlay.tsx:97` |
| BUTTON | Add to Evidence Session | `apps/web/components/capture-v2/CaptureCameraOverlay.tsx:131` |
| BUTTON | Stop & Add | `apps/web/components/capture-v2/CaptureCameraOverlay.tsx:149` |

### C.3 EXTRA in Native (24)

| Role | Label | Native source |
|---|---|---|
| BUTTON | Back | `apps/mobile/app/(stack)/capture.tsx:1306` |
| STATE_EMPTY | PERSONAL_SPACE_UNAVAILABLE_TITLE | `apps/mobile/app/(stack)/capture.tsx:1329` |
| INPUT | Include location metadata | `apps/mobile/app/(stack)/capture.tsx:1373` |
| BUTTON | Screen capture | `apps/mobile/app/(stack)/capture.tsx:1398` |
| BUTTON | Continuous screen capture | `apps/mobile/app/(stack)/capture.tsx:1404` |
| BUTTON | Screen capture | `apps/mobile/app/(stack)/capture.tsx:1412` |
| BUTTON | Capture Photo | `apps/mobile/app/(stack)/capture.tsx:1454` |
| BUTTON | activeType === "DOCUMENT" ? "Pick Document" : "Open Camera" | `apps/mobile/app/(stack)/capture.tsx:1466` |
| BUTTON | Add Another Document | `apps/mobile/app/(stack)/capture.tsx:1530` |
| BUTTON | activeType === "PHOTO" ? "Open Camera for More Photos" : "Open Camera for More Videos" | `apps/mobile/app/(stack)/capture.tsx:1539` |
| DIALOG | mixedOrigin?.title ?? "" | `apps/mobile/app/(stack)/capture.tsx:1565` |
| BUTTON | mixedOrigin?.finishLabel ?? "Finish this capture first" | `apps/mobile/app/(stack)/capture.tsx:1573` |
| BUTTON | mixedOrigin?.cancelLabel ?? "Not now" | `apps/mobile/app/(stack)/capture.tsx:1580` |
| BADGE | Chosen | `apps/mobile/app/(stack)/capture.tsx:1617` |
| INPUT | Context note | `apps/mobile/app/(stack)/capture.tsx:1629` |
| INPUT | Why this was captured, in your words | `apps/mobile/app/(stack)/capture.tsx:1630` |
| BUTTON | Open Settings | `apps/mobile/app/(stack)/capture.tsx:1652` |
| BADGE | status.label | `apps/mobile/app/(stack)/capture.tsx:1669` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |
| BADGE | s.label | `apps/mobile/src/ui/capture-plan-sections.tsx:133` |
| BADGE | Selected | `apps/mobile/src/ui/capture-plan-sections.tsx:219` |

### C.4 SOURCE-UNRESOLVED labels (21)

| Role | PWA source | Why unpairable |
|---|---|---|
| INPUT | `apps/web/app/(app)/capture/page.tsx:569` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/capture/page.tsx:589` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/capture/page.tsx:734` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/capture/page.tsx:779` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/capture/_lib/CaptureSuggestionsPanel.tsx:173` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/capture-v2/CaptureRequirements.tsx:68` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:209` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:263` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui-legacy.tsx:360` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraToast.tsx:100` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraToast.tsx:104` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/capture/_lib/CaptureReadinessSignals.tsx:65` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/components/ai/CaptureAiAssistant.tsx:379` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ai/CaptureAiAssistant.tsx:447` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (1043 rules, 3650 properties)

**`.capture-page-shell`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-page-shell.capture-enterprise-page`

- `background`: **transparent !important**
- `background-color`: **transparent !important**
- `box-shadow`: **none !important**

**`.capture-page-shell`** — `apps/web/components/capture-v2/capture-workspace.css` · `.ui-page-shell.capture-page-shell`

- `background`: **transparent !important**
- `background-color`: **transparent !important**
- `box-shadow`: **none !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page`

- `--capture-ink`: **#101828**
- `--capture-muted`: **#667085**
- `--capture-card`: **#ffffff**
- `--capture-line`: **rgba(16, 24, 40, 0.08)**
- `--capture-line-strong`: **rgba(16, 24, 40, 0.13)**
- `--capture-accent`: **#7c3aed**
- `--capture-accent-strong`: **#5b21b6**
- `--capture-accent-soft`: **rgba(124, 58, 237, 0.1)**
- `--capture-accent-line`: **rgba(124, 58, 237, 0.24)**
- `--capture-red`: **#f04438**
- `--capture-red-dark`: **#b42318**
- `--capture-red-soft`: **rgba(240, 68, 56, 0.1)**
- `--capture-orange`: **#f79009**
- `--capture-orange-soft`: **rgba(247, 144, 9, 0.11)**
- `min-height`: **100%**
- `padding`: **44px 28px 28px**
- `color`: **var(--capture-ink)**  ⚠ undeclared --capture-ink

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page button`

- `font-family`: **inherit**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page input`

- `font-family`: **inherit**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page select`

- `font-family`: **inherit**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page textarea`

- `font-family`: **inherit**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page .capture-inline-heading-icon`

- `color`: **#238b84 !important**
- `background`: **linear-gradient(180deg, #2f9c94 0%, #16766f 100%) !important**
- `border-color`: **rgba(35, 139, 132, 0.32) !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page .capture-inline-heading-icon svg`

- `color`: **#ffffff !important**
- `stroke`: **#ffffff !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page .capture-upload-actions svg`

- `color`: **#ffffff !important**
- `stroke`: **#ffffff !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page::before`

- `opacity`: **0 !important**
- `display`: **none !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page::after`

- `opacity`: **0 !important**
- `display`: **none !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page .muted`

- `color`: **#5f6b76 !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page p`

- `color`: **#5f6b76 !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page h1`

- `letter-spacing`: **-0.018em**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page h2`

- `letter-spacing`: **-0.018em**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page h3`

- `letter-spacing`: **-0.018em**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page h4`

- `letter-spacing`: **-0.018em**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page strong`

- `letter-spacing`: **-0.018em**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-v2.css` · `.capture-enterprise-page *` _[@media (max-width: 980px)]_

- `max-width`: **100% !important**
- `writing-mode`: **horizontal-tb !important**
- `transform`: **none !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-session-column`

- `width`: **auto !important**
- `min-width`: **0 !important**
- `max-width`: **none !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-strip`

- `align-items`: **stretch !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-ai-advisory-shell .capture-phase7-ai-toggle`

- `background-image`: **none !important**
- `background-color`: **#ffffff !important**
- `color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong
- `border`: **1px solid var(--capture-accent-line) !important**  ⚠ undeclared --capture-accent-line
- `box-shadow`: **none !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-ai-advisory-shell .capture-phase7-ai-toggle:hover`

- `background-image`: **none !important**
- `background-color`: **#ffffff !important**
- `color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong
- `border`: **1px solid var(--capture-accent-line) !important**  ⚠ undeclared --capture-accent-line
- `box-shadow`: **none !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-ai-advisory-shell .capture-phase7-ai-toggle *`

- `color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-ai-advisory-shell .capture-ai-count-pill`

- `-webkit-text-fill-color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-ai-advisory-shell .capture-ai-count-pill *`

- `-webkit-text-fill-color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-mode:not(.active) .capture-setup-icon svg`

- `stroke`: **currentColor !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-location:not(.active) .capture-setup-icon svg`

- `stroke`: **currentColor !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-trust-item__icon svg`

- `stroke`: **currentColor !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-mode.active .capture-setup-icon svg`

- `stroke`: **#ffffff !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-location.active .capture-setup-icon svg`

- `stroke`: **#ffffff !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-workflow-guidance`

- `border`: **1px solid var(--capture-line) !important**  ⚠ undeclared --capture-line
- `border-radius`: **var(--cap-radius) !important**  ⚠ undeclared --cap-radius
- `background`: **#ffffff !important**
- `box-shadow`: **0 1px 2px rgba(16, 24, 40, 0.04) !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-contextual-help`

- `border`: **1px solid var(--capture-line) !important**  ⚠ undeclared --capture-line
- `border-radius`: **var(--cap-radius) !important**  ⚠ undeclared --cap-radius
- `background`: **#ffffff !important**
- `box-shadow`: **0 1px 2px rgba(16, 24, 40, 0.04) !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-mode:not(.active) .capture-setup-icon svg *`

- `stroke`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong
- `color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-location:not(.active) .capture-setup-icon svg *`

- `stroke`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong
- `color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-mode.active .capture-setup-icon svg *`

- `stroke`: **#ffffff !important**
- `color`: **#ffffff !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-location.active .capture-setup-icon svg *`

- `stroke`: **#ffffff !important**
- `color`: **#ffffff !important**

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-mode.active strong`

- `color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong
- `-webkit-text-fill-color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong

**`.capture-enterprise-page`** — `apps/web/components/capture-v2/capture-workspace.css` · `.capture-enterprise-page .capture-setup-location.active strong`

- `color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong
- `-webkit-text-fill-color`: **var(--capture-accent-strong) !important**  ⚠ undeclared --capture-accent-strong


**Stock Tailwind utilities used (4).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.rounded-[18px]` → {"kind":"border-radius"}
- `.p-0` → {"kind":"padding","side":"all","value":"0px"}
- `.p-3` → {"kind":"padding","side":"all","value":"12px"}
- `.text-sm` → {"kind":"font-size/line-height","value":"14px/20px"}


### D.2 PWA SOURCE-UNRESOLVED (82)

- ``capture-setup-mode ${planMode === "CHECKLIST_REQUIRED" ? "active" : ""}`` at `apps/web/app/(app)/capture/page.tsx:829` — className built from a runtime expression
- ``capture-setup-mode ${planMode === "FLEXIBLE" ? "active" : ""}`` at `apps/web/app/(app)/capture/page.tsx:844` — className built from a runtime expression
- ``capture-setup-location ${useLocation ? "active" : ""}`` at `apps/web/app/(app)/capture/page.tsx:859` — className built from a runtime expression
- ``capture-material-row-shell ${ isExpanded ? "is-expanded" : "" }`` at `apps/web/app/(app)/capture/page.tsx:1151` — className built from a runtime expression
- ``capture-material-row-type-icon ${previewTypeLabel.toLowerCase()}`` at `apps/web/app/(app)/capture/page.tsx:1161` — className built from a runtime expression
- ``capture-material-dropdown compact ${ openMaterialDropdownId === item.id ? "is-open" : "" }`` at `apps/web/app/(app)/capture/page.tsx:1187` — className built from a runtime expression
- `!item.checklistStepId` at `apps/web/app/(app)/capture/page.tsx:1211` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `?` at `apps/web/app/(app)/capture/page.tsx:1211` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"active"` at `apps/web/app/(app)/capture/page.tsx:1211` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `:` at `apps/web/app/(app)/capture/page.tsx:1211` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `""` at `apps/web/app/(app)/capture/page.tsx:1211` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``capture-material-row-status ${ item.error ? "critical" : riskTone }`` at `apps/web/app/(app)/capture/page.tsx:1258` — className built from a runtime expression
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations` at `apps/web/components/uploads/UploadOperationsPanel.tsx:75` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__list` at `apps/web/components/uploads/UploadOperationsPanel.tsx:94` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__banner` at `apps/web/components/uploads/UploadOperationsPanel.tsx:119` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__banner--offline` at `apps/web/components/uploads/UploadOperationsPanel.tsx:119` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `props.safeToClose` at `apps/web/components/uploads/UploadOperationsPanel.tsx:136` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"proovra-upload-operations__close` at `apps/web/components/uploads/UploadOperationsPanel.tsx:136` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__close--safe"` at `apps/web/components/uploads/UploadOperationsPanel.tsx:136` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__close--unsafe"` at `apps/web/components/uploads/UploadOperationsPanel.tsx:136` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__row` at `apps/web/components/uploads/UploadOperationsPanel.tsx:165` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__row-header` at `apps/web/components/uploads/UploadOperationsPanel.tsx:166` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__state-pill` at `apps/web/components/uploads/UploadOperationsPanel.tsx:167` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__reason` at `apps/web/components/uploads/UploadOperationsPanel.tsx:171` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `proovra-upload-operations__progress` at `apps/web/components/uploads/UploadOperationsPanel.tsx:179` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (124 rules, 185 properties)

**`headerRow`** — `apps/mobile/app/(stack)/capture.tsx`

- `flexDirection`: **row**
- `marginTop`: **8**  _(theme.space.s2)_

**`resumeCard`** — `apps/mobile/app/(stack)/capture.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **12**  _(theme.space.s3)_
- `borderColor`: **#7C3AED**  _(theme.color.accent.a500)_

**`resumeActions`** — `apps/mobile/app/(stack)/capture.tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginTop`: **8**  _(theme.space.s2)_

**`staleNote`** — `apps/mobile/app/(stack)/capture.tsx`

- `marginBottom`: **12**  _(theme.space.s3)_

**`typeRow`** — `apps/mobile/app/(stack)/capture.tsx`

- `flexDirection`: **row**
- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **12**  _(theme.space.s3)_

**`sourcesBlock`** — `apps/mobile/app/(stack)/capture.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginTop`: **12**  _(theme.space.s3)_
- `paddingTop`: **12**  _(theme.space.s3)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.06)**  _(theme.color.border.subtle)_

**`typeChip`** — `apps/mobile/app/(stack)/capture.tsx`

- `flex`: **1**
- `alignItems`: **center**
- `justifyContent`: **center**
- `minHeight`: **40**
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**

**`toggleRow`** — `apps/mobile/app/(stack)/capture.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `justifyContent`: **space-between**
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_
- `borderRadius`: **8**  _(theme.radius.md)_
- `borderWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `marginBottom`: **12**  _(theme.space.s3)_

**`cameraCard`** — `apps/mobile/app/(stack)/capture.tsx`

- `padding`: **0**
- `overflow`: **hidden**
- `marginBottom`: **12**  _(theme.space.s3)_

**`audioCard`** — `apps/mobile/app/(stack)/capture.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **12**  _(theme.space.s3)_

**`cameraPreview`** — `apps/mobile/app/(stack)/capture.tsx`

- `height`: **380**
- `width`: **100%**

**`overlayTopLeft`** — `apps/mobile/app/(stack)/capture.tsx`

- `position`: **absolute**
- `top`: **12**
- `left`: **12**

**`overlayTopRight`** — `apps/mobile/app/(stack)/capture.tsx`

- `position`: **absolute**
- `top`: **12**
- `right`: **12**

**`overlayBadge`** — `apps/mobile/app/(stack)/capture.tsx`

- `backgroundColor`: **rgba(15**
- `color`: **#FFFFFF**
- `paddingHorizontal`: **10**
- `paddingVertical`: **6**
- `borderRadius`: **999**  _(theme.radius.pill)_
- `fontSize`: **12**
- `fontWeight`: **700**
- `overflow`: **hidden**

**`counterBadge`** — `apps/mobile/app/(stack)/capture.tsx`

- `minWidth`: **34**
- `height`: **34**
- `borderRadius`: **17**
- `backgroundColor`: **#10B981**  _(theme.color.semantic.success)_
- `color`: **#FFFFFF**
- `textAlign`: **center**
- `fontSize`: **14**
- `fontWeight`: **800**
- `overflow`: **hidden**
- `paddingTop`: **7**

**`cameraControls`** — `apps/mobile/app/(stack)/capture.tsx`

- `padding`: **12**  _(theme.space.s3)_
- `gap`: **8**  _(theme.space.s2)_

**`previewLine`** — `apps/mobile/app/(stack)/capture.tsx`

- `marginBottom`: **12**  _(theme.space.s3)_

**`sessionCard`** — `apps/mobile/app/(stack)/capture.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **12**  _(theme.space.s3)_

**`thumbStrip`** — `apps/mobile/app/(stack)/capture.tsx`

- `gap`: **12**
- `paddingVertical`: **8**

**`thumbCard`** — `apps/mobile/app/(stack)/capture.tsx`

- `width`: **120**
- `backgroundColor`: **#F1F4F9**  _(theme.color.surface.muted)_
- `borderRadius`: **8**  _(theme.radius.md)_
- `padding`: **8**
- `borderWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderColor`: **rgba(15, 23, 42, 0.06)**  _(theme.color.border.subtle)_

**`thumbPreview`** — `apps/mobile/app/(stack)/capture.tsx`

- `width`: **100%**
- `height`: **90**
- `borderRadius`: **6**  _(theme.radius.sm)_
- `overflow`: **hidden**
- `backgroundColor`: **#F1F4F9**  _(theme.color.surface.muted)_
- `position`: **relative**

**`thumbImage`** — `apps/mobile/app/(stack)/capture.tsx`

- `width`: **100%**
- `height`: **100%**

**`thumbFallback`** — `apps/mobile/app/(stack)/capture.tsx`

- `flex`: **1**
- `alignItems`: **center**
- `justifyContent`: **center**

**`thumbFallbackText`** — `apps/mobile/app/(stack)/capture.tsx`

- `color`: **#475569**  _(theme.color.ink.secondary)_
- `fontWeight`: **800**
- `fontSize`: **12**

**`thumbIndexBadge`** — `apps/mobile/app/(stack)/capture.tsx`

- `position`: **absolute**
- `top`: **6**
- `right`: **6**
- `backgroundColor`: **rgba(15**
- `paddingHorizontal`: **8**
- `paddingVertical`: **3**
- `borderRadius`: **999**  _(theme.radius.pill)_

**`thumbIndexText`** — `apps/mobile/app/(stack)/capture.tsx`

- `color`: **#FFFFFF**
- `fontSize`: **11**
- `fontWeight`: **800**

**`thumbLabel`** — `apps/mobile/app/(stack)/capture.tsx`

- `marginTop`: **8**

**`removePill`** — `apps/mobile/app/(stack)/capture.tsx`

- `marginTop`: **8**
- `backgroundColor`: **theme.color.status.risk.solid**  _(theme.color.status.risk.solid)_  ⚠ token path not found in proovra.generated.ts
- `paddingVertical`: **6**
- `borderRadius`: **999**  _(theme.radius.pill)_
- `alignItems`: **center**

**`removePillText`** — `apps/mobile/app/(stack)/capture.tsx`

- `color`: **#FFFFFF**
- `fontSize`: **11**
- `fontWeight`: **700**

**`sessionActions`** — `apps/mobile/app/(stack)/capture.tsx`

- `marginTop`: **8**
- `gap`: **8**  _(theme.space.s2)_

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

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 28 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 718 |
| Native elements identified | 157 |
| Pairable PWA elements | 89 |
| Paired | 3 |
| Missing in Native | 49 |
| Extra in Native | 24 |
| Unlabelled (not pairable by label) | 14 |
| SOURCE-UNRESOLVED labels | 21 |
| PWA style properties resolved | 3650 |
| PWA style items SOURCE-UNRESOLVED | 82 |
| Native style properties resolved | 185 |
| PWA interactive elements | 84 |
| Native interactive elements | 41 |
| PWA conditional branches | 337 |
| Native conditional branches | 111 |
