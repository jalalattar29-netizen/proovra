# Phase 7 §21 — canonical deletion proof

<!--
  GENERATED. Do not edit by hand.
    node scripts/admin-ledger/deletion-proof.mjs --markdown \
      > docs/admin/phase7-deletion-proof.md
-->

§3 required the legacy colour system to be **deleted rather than isolated**, and
named the migration: find the declaration, identify the consumers, migrate them to
a canonical semantic token, prove zero consumers, delete. The last two steps are
claims about the whole tree, and a claim about the whole tree written as prose is a
claim that stops being true without anybody noticing.

So each row below is a **predicate over the current source**, re-checked by the
generator. Comments are stripped before any pattern is applied — every one of these
deletions is explained in a comment somewhere, and a checker that counted prose
would report the explanation as the offence. Tests, sweeps and e2e specs are
excluded by path: a guard naming the thing it forbids is not a regression.

| deleted | scope searched | files | consumers | verdict |
|---|---|---|---|---|
| `apps/web/app/(app)/admin/identity/ui-tokens.ts` | `apps/web (app, components, lib)` | 874 | 0 | gone, zero consumers |
| `the admin TOKENS.* colour alias map` | `apps/web (app, components, lib)` | 874 | 0 | gone, zero consumers |
| `apps/web/app/(app)/reviewer-ops/ui-tokens.ts` | `apps/web (app, components, lib)` | 874 | 0 | gone, zero consumers |
| `the three raw-hex badge palettes that came with it` | `apps/web (app, components, lib)` | 874 | 0 | gone, zero consumers |
| `--text-muted and --text-strong` | `apps/web (app, components, lib)` | 874 | 0 | gone, zero consumers |
| `the duplicate --status-* declarations in app/globals.css` | `app/globals.css` | 1 | 0 | gone, zero consumers |
| `hex fallbacks inside var() at admin call sites` | `app/(app)/admin/` | 77 | 0 | gone, zero consumers |
| `page-local INK_* and PALETTE aliases under /admin` | `app/(app)/admin/` | 77 | 0 | gone, zero consumers |
| `the cc-* class family` | `app/(app)/admin/` | 77 | 0 | gone, zero consumers |
| `admin-v2 files` | `apps/web (app, components, lib)` | 874 | 0 | gone, zero consumers |
| `hand-rolled status capsules under /admin` | `app/(app)/admin/` | 77 | 0 | gone, zero consumers |

## Why each one went

- **apps/web/app/(app)/admin/identity/ui-tokens.ts** — the console's parallel visual language — twenty style objects and a twelve-entry colour alias map, consumed by nineteen admin pages and two Security Center pages. Its values were re-pointed at the canonical tokens first, which fixed the navy accent on seventeen surfaces and left the mechanism in place; this removed the mechanism.
- **the admin TOKENS.* colour alias map** — a second name for every colour, so a surface could be violet through TOKENS and violet through --accent-600 and nobody could tell which one a page was using. Sixty-one uses across the console, all migrated to the canonical tokens before the file was deleted.
- **apps/web/app/(app)/reviewer-ops/ui-tokens.ts** — the SECOND parallel visual language — a twelve-entry raw-hex palette with a navy accent, three hand-written status palettes and twenty style objects, consumed by five pages outside the console. Its badge palettes went to the canonical status and severity maps, its layout to PageShell/PageSection/Card, its buttons to buttonSurfaceStyle, its inputs to the app-* primitives, and its two date helpers to lib/date — where one of them, a relative formatter that can say "in 3h", had no business living in a styling module at all.
- **the three raw-hex badge palettes that came with it** — slaBadgePalette, severityPalette and an inline lifecycle palette — forty-one hex literals encoding statuses the product already has one map for. They had drifted from it: IN_REVIEW was PURPLE, which canonical purple is reserved against, and CRITICAL was a darker red than HIGH, a distinction no operator was ever told the meaning of.
- **--text-muted and --text-strong** — two aliases added while closing 25 undefined tokens. --text-muted resolved to a value that failed WCAG AA against the card surface, so adding them broke contrast on ten files; all sixty consumers were migrated to --silver-ink or --ink-primary by role, and both aliases were deleted rather than re-pointed. This proof then caught the deletion leaking: `admin-system.css` still RE-DECLARED --text-muted, in a comment asserting a :root declaration that no longer existed — a live override of a custom property nothing reads.
- **the duplicate --status-* declarations in app/globals.css** — globals.css imports lib/design-tokens/tokens.css and then re-declared the same twenty-four --status-* properties beneath it, so the later block won and the token file every component documents as the authority was dead for those names. The two copies also DISAGREED: Badge's pending fallback was #EA580C at 3.20:1 while the value actually rendering was #78350F at 8.15:1.
- **hex fallbacks inside var() at admin call sites** — a fallback is a second value for the same name, and when the two disagree the fallback is what ships wherever the token is missing — which is how Badge's dead pending colour came to disagree with the live one by 4.95:1 of contrast.
- **page-local INK_* and PALETTE aliases under /admin** — twenty page-local colour maps, each a private palette that could drift from the product's.
- **the cc-* class family** — a dead prefix left behind by an earlier console: twenty elements still carried cc-* class names that no stylesheet defined, so they were styled by nothing at all.
- **admin-v2 files** — §3 forbade a parallel v2 tree as an escape from deleting the first one.
- **hand-rolled status capsules under /admin** — sixty-one elements built a badge out of an inline borderRadius:999 and their own colour pair, so the console had sixty-one status vocabularies. They are Badge or AppStatusBadge now.

## What is deliberately still allowed

A hardcoded colour is permitted for a **third-party brand mark**, because a payment
brand is recognised by its own colour and that mark is not a semantic state. The one
such authority in this tree is `.bill-pay__mark[data-mark=…]`, and the billing test
names it as the reason its own hex ban is scoped rather than blanket.

`--enterprise-accent` and `--enterprise-gradient` stay declared in `globals.css`:
they are a brand treatment rather than a status, nothing else declares them, and the
foundation test asserts they are there.

## Debt this proof used to carry, now closed

**The second `ui-tokens.ts` is gone.** Until Phase 7 §B3 the deleted file was only
`app/(app)/admin/identity/ui-tokens.ts`, and `app/(app)/reviewer-ops/ui-tokens.ts`
was a separate copy of the same idea, consumed by five pages outside the console.
The `TOKENS.*` predicate had to be scoped to /admin because of it, and this
section recorded that as debt rather than widening a claim nobody had earned.

§B3 migrated all five — `governance/policy`, its `WorkspaceGovernancePolicySection`,
`reviewer-ops/escalations`, `reviewer-ops/sla` and `reviewer-ops/[reviewId]` — onto
the shared design system and deleted the file. The scope came off the predicate at
the same time, so the ban now covers all of `apps/web`.
