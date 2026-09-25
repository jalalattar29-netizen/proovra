# Route register — `/login`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** UNMATCHED(default CORE) / allow(default)
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/login/page.tsx` | `apps/mobile/app/(stack)/auth.tsx` |
| Files in recursive tree | 148 | 144 |
| Max import depth | 8 | 10 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 318 | 159 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 68 |
| Labelled native elements | 24 |
| Paired exactly (same role + same literal) | 6 |
| Paired, role differs | 5 |
| Unpaired web labels | 57 |
| — of which the native screen has NO element of that role | **1** |
| Extra in native | 11 |
| Web elements carrying no literal label | 299 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 25 |
| `NOT_APPLICABLE_SHELL` | 22 |
| `PRESENT_ELSEWHERE_IN_APP` | 9 |
| `ROLE_ABSENT_ON_SCREEN` | 1 |

#### `ROLE_ABSENT_ON_SCREEN` — 1 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 495 | 251 |
| Distinct colours actually used by this route's elements | **43** | **19** |
| — shared between the two | 1 | 1 |
| — **PWA-only (no native counterpart value)** | **42** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 222 (128 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 21 | — |
| Competing rules for one class (cascade decides at runtime) | 33 | — |
| Native theme tokens not resolvable to a literal | — | 76 |

**PWA-only colours on this route (first 30):** `#446166` `rgba(62, 96, 99, 0.96)` `rgba(24, 43, 48, 0.98)` `rgba(79, 112, 107, 0.28)` `rgba(20, 48, 52, 0.16)` `#eef3f1` `#6c787c` `rgba(79, 112, 107, 0.14)` `rgba(255, 255, 255, 0.92)` `rgba(79, 112, 107, 0.16)` `rgba(6, 16, 22, 0.08)` `#102126` `rgba(79, 112, 107, 0.34)` `#d64545` `rgba(255, 255, 255, 0.52)` `rgba(180, 35, 24, 0.12)` `#45656a` `#b79d84` `rgba(240, 244, 241, 0.98)` `rgba(255, 255, 255, 0.75)` `rgba(15, 23, 42, 0.08)` `rgba(79, 112, 107, 0.42)` `#496268` `rgba(255, 255, 255, 0.42)` `rgba(79, 112, 107, 0.10)` `#4f5f63` `rgba(15, 23, 42, 0.035)` `rgba(255, 255, 255, 0.28)` `rgba(0, 0, 0, 0.7)` `#1b3136`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1177 | 1059 |
| Declared state roles present | — | STATE_LOADING |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 61 | 33 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 11 |
| Distinct `/v1` endpoints the native screen reaches | 13 |
| Shared | 7 |
| **Called by PWA, never by native** | **4** |
| Called by native only | 6 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/evidence/claim` — `apps/web/app/login/page.tsx:411`
- `/v1/users/me` — `apps/web/app/providers.tsx:93`
- `/v1/users/cookie-consent` — `apps/web/app/providers.tsx:252`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **25** — needs a per-element read.
- Web classes with no CSS rule: **222**.
- Runtime-built `className`: **21**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 33.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.