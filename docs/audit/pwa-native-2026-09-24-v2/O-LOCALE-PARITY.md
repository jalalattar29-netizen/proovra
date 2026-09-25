# O — LOCALE AND CONTENT PARITY

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · SOURCE-ONLY
**Authority:** `packages/shared/src/i18n.ts` — **one shared dictionary**, imported by both platforms

---

## O.1 There is one dictionary, and both platforms use it

`packages/shared/src/i18n.ts` declares:

```
supportedLocales = ["en", "ar", "de", "fr", "es", "tr", "ru"]   // 7
defaultLocale    = "en"
dict             = { en: {...42 keys}, ar: {...}, de: {...}, fr: {...}, es: {...}, tr: {...}, ru: {...} }
```

Native imports it verbatim: `apps/mobile/src/i18n.ts:2` —
`import { dict, defaultLocale, supportedLocales, type Locale } from "@proovra/shared"`,
then `export const translations = dict`.

**So there is no native-vs-web translation drift to find in this dictionary — it
is literally the same object.** Every key count matches (42 × 7) and **no locale
is missing a key**.

## O.2 But four of the seven locales are untranslated placeholders

Evaluated from source:

| Locale | Keys | Values identical to English | State |
|---|---:|---:|---|
| `en` | 42 | — | baseline |
| `ar` | 42 | **1** | **translated** (41/42) |
| `de` | 42 | **4** | **translated** (38/42) |
| `fr` | 42 | **42** | **UNTRANSLATED — every key returns English** |
| `es` | 42 | **42** | **UNTRANSLATED** |
| `tr` | 42 | **42** | **UNTRANSLATED** |
| `ru` | 42 | **42** | **UNTRANSLATED** |

Verified by value:

| key | en | ar | de | fr | es | tr | ru |
|---|---|---|---|---|---|---|---|
| `home` | "Home" | "الرئيسية" | "Start" | "Home" | "Home" | "Home" | "Home" |
| `cases` | "Cases" | "القضايا" | "Fälle" | "Cases" | "Cases" | "Cases" | "Cases" |
| `ctaCapture` | "+ Capture Evidence" | "+ التقط دليلاً" | "+ Beweis erfassen" | "+ Capture Evidence" | "+ Capture Evidence" | "+ Capture Evidence" | "+ Capture Evidence" |
| `recentEvidence` | "Recent Evidence" | "أدلة حديثة" | "Neueste Beweise" | "Recent Evidence" | "Recent Evidence" | "Recent Evidence" | "Recent Evidence" |
| `downloadReport` | "Download Report" | "تنزيل التقرير" | "Bericht herunterladen" | "Download Report" | "Download Report" | "Download Report" | "Download Report" |

**`supportedLocales` advertises 7 languages. 4 of them (fr, es, tr, ru) deliver
100% English.** A French, Spanish, Turkish or Russian user selects their language
and the interface does not change.

**Class: CONTENT MISMATCH — affects BOTH platforms equally**, because the
dictionary is shared. This is not a Native parity gap; it is a product gap the
Native app inherits. Recorded because §9 asked for it and because a
"shared English label" is exactly the false proof the mandate warned against.

## O.3 The dictionary covers almost nothing

| | Count |
|---|---:|
| Keys available in the shared dictionary | **42** |
| **Distinct keys Native actually uses** | **11** |
| Total `t("…")` call sites in Native | **18** |
| Labelled Native elements across applicable routes | ~2,000 |
| Labelled PWA elements across applicable routes | **6,101** |

**Native localises 18 strings.** Everything else — every button label, heading,
empty state, error message and helper line inventoried in `routes-v4/*.json` — is
a hardcoded English literal in the component.

The same is true of the web: 42 keys against 6,101 labelled elements.

**So for both platforms, locale selection changes a few dozen strings and leaves
the product in English.** Arabic and German are genuinely translated *for those
42 keys only*.

## O.4 RTL

| | PWA | Native |
|---|---|---|
| RTL detection | no `dir="rtl"` found in `app/layout.tsx`; `components/language-switcher.tsx` sets locale only | `isRTL = locale === "ar"` — `src/locale-context.tsx:106` |
| Layout direction | — | `flexDirection: isRTL ? "row-reverse" : "row"` — `ui/shell.tsx:122`, and the rail/bottom-bar respect it |
| Text alignment | — | `textAlign: isRTL ? "right" : "left"` — `ui/index.tsx:360` |
| RTL font | — | `"Noto Sans Arabic"` — `locale-context.tsx:111` (**but no font is loaded — see `N-VISUAL-PARITY.md` §N.0**) |

**Native's RTL handling is more thorough than the web's**, and is recorded as
such: the shell flips direction, inputs flip text alignment, and `ProovraText`
is documented as direction-aware. The web side shows no `dir` attribute wiring in
the root layout.

**Caveat:** the Arabic *typeface* native selects is never loaded, so Arabic
renders in the system Arabic face rather than Noto Sans Arabic.

## O.5 Interpolation and pluralization

| | Finding |
|---|---|
| Interpolated values in the shared dictionary | **none** — all 42 values are static strings with no placeholders |
| Pluralization | **none** — no plural forms, no ICU messages, no `count` handling in either platform's `t()` |
| Consequence | Every count-bearing string (e.g. `"{n} segment(s) recorded"`, `continuous-capture.tsx:409`) is assembled by string concatenation in the component, in English, outside the dictionary |

## O.6 Verdicts

| ID | Class | Statement | Affects |
|---|---|---|---|
| **LOC-1** | **CONTENT MISMATCH (shared)** | `fr`, `es`, `tr`, `ru` are 100% English placeholders while `supportedLocales` advertises them | both platforms |
| **LOC-2** | **COVERAGE GAP (shared)** | 42 dictionary keys against 6,101 labelled web elements; Native uses 11 keys at 18 call sites. Locale selection leaves the product in English | both platforms |
| **LOC-3** | **NO INTERPOLATION / PLURALS (shared)** | count- and name-bearing strings are concatenated in components, untranslatable | both platforms |
| **LOC-4** | **NATIVE BETTER** | Native implements RTL direction, alignment and font selection; the web's root layout shows no `dir` wiring | — |
| **LOC-5** | **DEPENDS ON VIS-1** | The Arabic face Native selects is never loaded, so RTL text renders in the system font | native |

## O.7 UNRESOLVED

1. Whether the web renders `dir="rtl"` through a mechanism not found by this pass
   (e.g. a provider outside `app/layout.tsx`). **Searched:** `layout.tsx`,
   `language-switcher.tsx`, `MarketingLanguageSwitcher.tsx` — no `dir` attribute.
2. Locale-specific typography/alignment adaptations **beyond** direction and
   family were not inventoried per element.
3. No locale was rendered. Nothing here is an observed string on screen.
