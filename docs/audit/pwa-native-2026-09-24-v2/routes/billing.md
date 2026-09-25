# Route register — `/billing`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/billing/page.tsx` | `apps/mobile/app/(stack)/billing.tsx` |
| Files in recursive tree | 179 | 141 |
| Max import depth | 7 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 607 | 189 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 109 |
| Labelled native elements | 26 |
| Paired exactly (same role + same literal) | 6 |
| Paired, role differs | 6 |
| Unpaired web labels | 97 |
| — of which the native screen has NO element of that role | **4** |
| Extra in native | 17 |
| Web elements carrying no literal label | 589 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 67 |
| `PRESENT_ELSEWHERE_IN_APP` | 26 |
| `ROLE_ABSENT_ON_SCREEN` | 4 |

#### `ROLE_ABSENT_ON_SCREEN` — 4 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| STATE_EMPTY | "Billing is managed for you" | `apps/web/app/(app)/billing/page.tsx:952` |
| STATE_EMPTY | "No payments yet" | `apps/web/app/(app)/billing/_sections/StorageAndHistory.tsx:444` |
| LIST | "Billing account" | `apps/web/app/(app)/billing/_sections/AccountSelector.tsx:158` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 1454 | 239 |
| Distinct colours actually used by this route's elements | **58** | **19** |
| — shared between the two | 8 | 8 |
| — **PWA-only (no native counterpart value)** | **50** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 2 (2 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 20 | — |
| Competing rules for one class (cascade decides at runtime) | 98 | — |
| Native theme tokens not resolvable to a literal | — | 83 |

**PWA-only colours on this route (first 30):** `#172033` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `#d9c7fb` `rgba(15, 23, 42, 0.18)` `#000000` `#6b5bff` `#5b6b7b` `#f1f4f9` `#c4b5fd` `#1434cb` `rgba(15, 23, 42, 0.04)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `#ea580c` `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.58)` `#344054` `rgba(248, 250, 253, 0.7)` `rgba(15, 23, 42, 0.07)` `#667085` `rgba(124, 58, 237, 0.07)` `rgba(124, 58, 237, 0.02)` `rgba(255, 255, 255, 0)` `rgba(15, 23, 42, 0.05)` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(124, 58, 237, 0.14)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1634 | 1125 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING | STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 98 | 32 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 14 |
| Distinct `/v1` endpoints the native screen reaches | 6 |
| Shared | 4 |
| **Called by PWA, never by native** | **10** |
| Called by native only | 2 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/billing/subscription/plan` — `apps/web/lib/api/billing-accounts.ts:595`
- `/v1/billing/credits/checkout/stripe` — `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:147`
- `/v1/billing/credits/checkout/paypal` — `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:153`
- `/v1/billing/storage-addons/checkout/stripe` — `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:172`
- `/v1/billing/storage-addons/checkout/paypal` — `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:178`
- `/v1/billing/checkout/stripe` — `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:195`
- `/v1/billing/checkout/paypal` — `apps/web/app/(app)/billing/_sections/CheckoutDrawer.tsx:201`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **67** — needs a per-element read.
- Web classes with no CSS rule: **2**.
- Runtime-built `className`: **20**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 98.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.