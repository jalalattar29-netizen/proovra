# Q — SOURCE-AUDIT COVERAGE REPORT

**Audited SHA:** `10668edbe4ac189ff965a09c7e8be17953d83f4a` (branch `uc6-public-launch`, = `origin/main`)
**Method:** static source comparison **only**. No rendering, no screenshots, no
emulator, no simulator, no device, no product-code change.

This report answers the mandatory coverage gate. Every number is emitted by the
instruments in this directory and is reproducible.

---

## 1. Route coverage

| | Count |
|---|---:|
| **Total applicable routes** | **64** |
| **Routes fully source-compared** | **62** |
| **Routes partially source-compared** | **2** |
| **Routes not compared** | **0** |

The 2 partial are `/operations` and `/operations/health`: their **PWA** side was
fully read (24 and 8 files, 613 and 145 elements), and there is **no native screen
to compare against**. They are partial because one half of the comparison does not
exist, not because the audit stopped.

### What "fully source-compared" means here

For each of the 62, all of the following were produced and are on disk in
`pages/<route>.md`:

- the **complete PWA component tree**, resolved recursively through imports,
  barrel re-exports, `export { default } from` chains and `redirect()` shims;
- the **complete Native component tree**, resolved the same way;
- an **element correspondence table** (paired / copy-differs / role-differs /
  missing / extra / source-unresolved);
- **style declarations resolved to literal values** on both sides;
- **interactive-element and conditional-branch inventories** on both sides;
- per-route coverage counts.

## 2. Element coverage

| | Count |
|---|---:|
| Distinct PWA files read across the 64 rendered trees | **289** |
| Distinct Native files read | **57** |
| **Total PWA elements identified** | **19 788** |
| Total Native elements identified | **5 455** |
| PWA elements in a pairable role | **3 349** |
| — paired exactly | 75 |
| — paired, copy differs | 55 |
| — paired, role differs (candidate wrong control) | 29 |
| — unpaired on their own route (distinct) | 1 271 |
| — unpaired (per-route occurrences) | 2 559 |
| Extra in Native (no PWA counterpart) | 890 |
| Unlabelled — carry no literal label, so not pairable by label | 566 |
| **SOURCE-UNRESOLVED labels** | **823** |

### Missing Native elements — the honest split

| | Count |
|---|---:|
| Distinct unpaired PWA elements | 1 271 |
| …**present on another native screen** (placement difference, not a gap) | **746** |
| …**found nowhere in the native app** | **525** |

**525 is the real missing-element figure.** The 746 exist — the largest single
block being the entire change-password form, which the web renders inside
`/settings` and native renders at `app/(stack)/settings/security.tsx:218-273`.
Reporting those as missing would have been a false finding, and the first pass of
this audit did exactly that before the global native-presence check was added.

## 3. Style-property coverage

| | Count |
|---|---:|
| CSS files indexed | 30 |
| CSS classes indexed | 2 515 |
| CSS custom properties indexed | 235 |
| **PWA style properties resolved to literal values** | **26 222** |
| PWA style items SOURCE-UNRESOLVED | 3 764 |
| **Native style properties resolved to literal values** | **4 990** |
| Native token values available | 136 |
| **Total style properties compared** | **31 212** |

Resolution chases `var(--x)` through `tokens.css` to a literal, and
`theme.color.*` through `proovra.generated.ts` to a literal. Stock Tailwind
utilities are resolved to **default Tailwind values** and flagged as such, because
`apps/web/tailwind.config.ts` is `theme: { extend: {} }` and therefore carries no
PROOVRA tokens.

### The colour finding

| | Count |
|---|---:|
| Distinct hex colours declared anywhere in web CSS | **238** |
| …with a counterpart in the native token set | 28 |
| Hex literals written directly in component CSS, bypassing tokens | **2 079 occurrences / 222 distinct** |
| …with a counterpart in the native token set | **25** |

A shared token import is not evidence of shared styling, and this is the measure
that shows it.

## 4. Handler and state coverage

| | Count |
|---|---:|
| **PWA interactive elements identified** | **2 703** |
| Native interactive elements identified | **1 215** |
| PWA conditional branches (ternary / `&&` / `.map`) | **9 281** |
| Native conditional branches | **2 802** |
| **Total conditional states compared** | **12 083** |

### Handlers traced end-to-end — stated precisely

| Depth of trace | Count | What it establishes |
|---|---:|---|
| Handler located and its **effect class resolved** in-file (API call / navigation / local state / dialog-feedback), following named handlers up to 3 levels | **451** of 484 native controls on applicable screens (artifact **D**) | the control is bound and what kind of effect it has |
| Handler located but effect leaves the file | **33** | reported UNVERIFIED, never as a pass |
| Handler traced **through to the HTTP request** and compared against the PWA's request for the same capability | **218 endpoints** via the endpoint join (artifact **D**/`endpoint-gap-register.json`) | client/server contract comparison |

**This audit does not claim 2 703 end-to-end handler traces.** Handlers were
inventoried and classified at the scale above; the endpoint-level comparison was
done for the whole API surface rather than per control. The difference is stated
rather than blurred.

## 5. All SOURCE-UNRESOLVED items

| Class | Count | Why it cannot be resolved statically |
|---|---:|---|
| Labels computed at runtime | **823** | the label is an expression with no string literal (`{caseStatusDisplay(c.status).label}`); source cannot name the words that will appear |
| Elements with no literal label | **566** | the element carries no text or label attribute in source; it can be counted but not paired by name |
| Style items | **3 764** | a `className` built from a runtime expression, or a class with no matching CSS rule and no recognised stock Tailwind utility |
| Which CSS declaration wins | all 26 222 | cascade order, specificity and conditional class application are runtime facts |
| Native inline `style={[...]}` arrays with computed members | included in the 4 990 as `non-literal expression` | the array member is a variable, not a literal |
| Truncated tree branches (depth bound 8) | reported per route in `pages/*.md` | a branch deeper than 8 is named rather than silently dropped |

None of these is a demand for a screenshot. Each is a statement about what source
can and cannot decide.

## 6. What this pass did NOT do

- Did **not** render anything, on any platform.
- Did **not** modify product code, push, merge, deploy, build or migrate.
- Did **not** create a worktree, branch or parallel audit.
- Did **not** re-run route discovery — the 208/64 inventory from artifact **B** is
  reused unchanged.
- Did **not** adjudicate all 192 root-cause groups: **15 were classified by reading
  both implementations**, and **177 remain UNCLASSIFIED** and are listed in
  **P.4** as such. They are not claimed as defects.

## 7. Coverage gate — self-assessment

| Gate | Status |
|---|---|
| Every applicable route has a per-page source comparison | **met** — 64 files in `pages/` |
| Component trees resolved past the page file | **met** — 289 PWA / 57 Native distinct files, through barrels, default re-exports and redirects |
| No control passed on the existence of a handler alone | **met** — effect class resolved for 451/484; 33 reported UNVERIFIED |
| No colour/card/text claimed to match because a token is shared | **met** — §3, and the 222-hardcoded-colour finding |
| Dynamic properties marked SOURCE-UNRESOLVED with a reason | **met** — §5 |
| Every finding carries source evidence and line references | **met** for the 15 classified groups; the 177 unclassified carry file-level references only |
| 100% coverage claimed anywhere | **no** |

> **The rendered dimension remains entirely unaddressed and is not claimed:
> 0 screenshots, 0 simulator runs, 0 device runs, 0 of 62 ledger rows physically
> accepted.** This report is a source audit and says only what source can support.
