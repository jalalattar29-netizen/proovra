# Route register — `/register`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/register/page.tsx` | `apps/mobile/app/(stack)/register.tsx` |
| Files in recursive tree | 147 | 140 |
| Max import depth | 8 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 345 | 165 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 68 |
| Labelled native elements | 27 |
| Paired exactly (same role + same literal) | 4 |
| Paired, role differs | 4 |
| Unpaired web labels | 60 |
| — of which the native screen has NO element of that role | **3** |
| Extra in native | 15 |
| Web elements carrying no literal label | 325 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 29 |
| `PRESENT_ELSEWHERE_IN_APP` | 19 |
| `NOT_APPLICABLE_SHELL` | 9 |
| `ROLE_ABSENT_ON_SCREEN` | 3 |

#### `ROLE_ABSENT_ON_SCREEN` — 3 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| LIST | "Password requirements" | `apps/web/app/register/page.tsx:1377` |
| LIST | "Security and privacy commitments" | `apps/web/app/register/page.tsx:1665` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 504 | 242 |
| Distinct colours actually used by this route's elements | **42** | **20** |
| — shared between the two | 1 | 1 |
| — **PWA-only (no native counterpart value)** | **41** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 200 (123 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 21 | — |
| Competing rules for one class (cascade decides at runtime) | 33 | — |
| Native theme tokens not resolvable to a literal | — | 79 |

**PWA-only colours on this route (first 30):** `#446166` `rgba(62, 96, 99, 0.96)` `rgba(24, 43, 48, 0.98)` `rgba(79, 112, 107, 0.28)` `rgba(20, 48, 52, 0.16)` `#eef3f1` `#45656a` `#6c787c` `rgba(79, 112, 107, 0.14)` `rgba(255, 255, 255, 0.92)` `rgba(79, 112, 107, 0.16)` `rgba(6, 16, 22, 0.08)` `#102126` `rgba(79, 112, 107, 0.34)` `#b79d84` `rgba(240, 244, 241, 0.98)` `rgba(255, 255, 255, 0.75)` `rgba(15, 23, 42, 0.08)` `rgba(79, 112, 107, 0.42)` `#d64545` `rgba(255, 255, 255, 0.52)` `rgba(180, 35, 24, 0.12)` `#496268` `rgba(255, 255, 255, 0.42)` `rgba(79, 112, 107, 0.10)` `rgba(15, 23, 42, 0.035)` `rgba(255, 255, 255, 0.28)` `rgba(0, 0, 0, 0.7)` `#1b3136` `rgba(158, 216, 207, 0.2)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1186 | 1044 |
| Declared state roles present | — | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 61 | 31 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 11 |
| Distinct `/v1` endpoints the native screen reaches | 13 |
| Shared | 6 |
| **Called by PWA, never by native** | **5** |
| Called by native only | 7 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/auth/email/availability?email=${…}` — `apps/web/app/register/page.tsx:362`
- `/v1/evidence/claim` — `apps/web/app/register/page.tsx:542`
- `/v1/users/me` — `apps/web/app/providers.tsx:93`
- `/v1/users/cookie-consent` — `apps/web/app/providers.tsx:252`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **29** — needs a per-element read.
- Web classes with no CSS rule: **200**.
- Runtime-built `className`: **21**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 33.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.