# F — FINAL EXECUTION READINESS

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · branch `main` · tree clean · **0 product changes**

---

## Determination

| Question | Answer |
|---|---|
| Is the **source audit** complete? | **YES**, with 2 named exceptions (U-1, U-4) |
| Is every source-resolvable issue **adjudicated**? | **YES** — 4,360/4,360 element correspondences, 208/208 routes, 2,841/2,841 CSS tokens, 153/181 re-opened handlers |
| Are the implementation tasks **sufficiently specified to start**? | **YES for 21 of 23** |
| Is **product parity** established? | **NO** |
| Is **physical-device parity** established? | **NO — no runtime evidence of any kind was produced** |

### → **GO for implementation. NOT READY for launch.**

Those are different statements and are kept apart. The backlog is specified well
enough to schedule; nothing in it has been verified on a device, and 11 runtime
validations remain unrun.

---

## What "GO for implementation" rests on

| Deliverable | State |
|---|---|
| Route inventory | 208 discovered, 208 dispositioned, 63 applicable + 1 borderline explicit |
| Per-route registers | 64 human + 256 machine files |
| Element adjudication | **4,360 / 4,360**, 0 unresolved |
| CSS closure (Q4) | 2,841 tokens: **94.2%** mechanically resolved; residue split; `cc-*` defect isolated |
| Handlers (Q5) | 2,200 distinct; of 181 re-opened, **153 accounted for**, 28 named with their resolution path |
| UC acceptance (Q6) | UC-1/2/4 **independently re-audited and upheld**; UC-3/5 **contradicted** on CODE |
| Content grouping (Q9) | 2,732 strings → **191 owning files**, deduplicated |
| Mandated re-checks | 371 promoted to MATCH · 457 demoted to absent · 13 exclusions overturned |
| Root causes | **25**, deduplicated, each with file:line and full affected-route list |
| Backlog | **23 tasks**, dependency-ordered, with acceptance criteria |
| Runtime plan | **11 validations**, each with a credential-free diagnostic |

## The 2 tasks NOT sufficiently specified

| Task | Why | What unblocks it |
|---|---|---|
| **T-07** (primitive shape tokens) | Requires a **product decision**, not a source fact: button radius `8px` vs pill `999`, card `28` vs `14`, gradient vs flat. The audit can say they differ; it cannot say which is intended. | a design decision per primitive |
| **T-17** (four untranslated locales) | Translate or withdraw is a **commercial** decision. The audit can say `fr`/`es`/`tr`/`ru` return English for all 42 keys. | a product decision |

## Source-unresolved items carried forward — complete

| # | Item | Count | Closes with |
|---|---|---:|---|
| **U-1** | `HOOK_RETURNED_CALLABLE` handlers | **28** | **audit work, no device** — read ~6 hooks (RV-11) |
| **U-2** | Which CSS declaration wins | all | rendered evidence only |
| **U-3** | Composed `className` strings | 108 exprs | rendered evidence only |
| **U-4** | `.app-shell-v2` background (5 competing rules) | 1 | RV-08 *(the **sidebar** image has no competitor and IS certain)* |
| **U-5** | Native font actually rendered | 1 | RV-06 *(that **no font is loaded** is already source-certain)* |
| **U-6** | Every runtime item | 11 | `FINAL-RUNTIME-VALIDATION-PLAN.md` |

**None of these blocks implementation.** U-1 is unfinished audit work; U-2…U-5 are
runtime facts by construction; U-6 is validation.

## Launch blockers — must close before any launch claim

| # | Blocker | Owner |
|---|---|---|
| 1 | **RC-01** — native OAuth audiences not allow-listed. No native user can sign in with Google or Apple. | deployment config (T-01/RV-01) |
| 2 | **RC-02** — placeholder Apple Team ID ships in the committed AASA. **Every iOS Universal Link is dead**, across 14 applicable routes. CI is written to pass on it. | T-02/RV-02 |
| 3 | **RC-18/RC-19** — the only iOS screen-capture path is labelled "Finish & Sign" and does not sign. UC-3/UC-5 CODE is not complete. | T-18/T-19 |
| 4 | **0 of 62 surfaces physically accepted** | RV-04, RV-10 |

## Three things this audit does **not** claim

1. **That any physical-device problem is fixed.** No code was changed and nothing was run. Every device symptom the user reported has a source-traceable cause; a cause is not a fix.
2. **That the PWA is a clean reference.** It is not, in two measured ways: **295 distinct colours bypass its own tokens** (RC-08), and **~115 custom CSS classes have no rule** after the `cc-*` → `ec-*` rename (RC-09). Both must be settled before those surfaces are treated as a parity target.
3. **That the element counts equal user-visible defects.** 2,732 `CONTENT_ABSENT` strings deduplicate to **191 owning files**, and 457 of them already exist in Native but on an unreachable screen (RC-15) — a navigation fix, not new copy. Ship T-13 before T-14.

## Correction to the record

Three prior claims in this audit directory are **withdrawn**, each superseded by evidence in this pass:

| Withdrawn | Superseded by |
|---|---|
| "3,820 element correspondences unresolved" (v3) | an artifact of exact-literal pairing over whole-file trees. Now 0 unresolved of 4,360 |
| "5,430 CSS classes unmatched" (v4) | **94.2%** resolve; the genuine residue is ~115 custom classes (RC-09) |
| "per-element style pairing is not expressible" (v4) | partly wrong. It is not expressible **per element** (16 of 111 pairs), but it **is** expressible per **primitive** — done in `N-VISUAL-PARITY.md` §N.4, which is where the real divergences were found |

---

## Verdict, stated once

**SOURCE AUDIT COMPLETE** — every source-resolvable dimension adjudicated, with U-1
(28 handlers, audit work) and U-2…U-5 (runtime by construction) named and counted.

**PRODUCT PARITY NOT ESTABLISHED.**
**PHYSICAL-DEVICE PARITY NOT ESTABLISHED AND NOT CLAIMED.**

**GO for implementation** on the 21 fully-specified tasks.
**NOT READY for launch** until the 4 blockers above close and the 11 runtime
validations run.
