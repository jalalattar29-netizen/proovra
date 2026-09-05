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
| `apps/web/app/(app)/admin/identity/ui-tokens.ts` | `apps/web (app, components, lib)` | 872 | 0 | gone, zero consumers |
| `the admin TOKENS.* colour alias map` | `app/(app)/admin/, app/(app)/settings/security, components/` | 319 | 0 | gone, zero consumers |
| `--text-muted and --text-strong` | `apps/web (app, components, lib)` | 872 | 0 | gone, zero consumers |
| `the duplicate --status-* declarations in app/globals.css` | `app/globals.css` | 1 | 0 | gone, zero consumers |
| `hex fallbacks inside var() at admin call sites` | `app/(app)/admin/` | 76 | 0 | gone, zero consumers |
| `page-local INK_* and PALETTE aliases under /admin` | `app/(app)/admin/` | 76 | 0 | gone, zero consumers |
| `the cc-* class family` | `app/(app)/admin/` | 76 | 0 | gone, zero consumers |
| `admin-v2 files` | `apps/web (app, components, lib)` | 872 | 0 | gone, zero consumers |
| `hand-rolled status capsules under /admin` | `app/(app)/admin/` | 76 | 0 | gone, zero consumers |

## Why each one went

- **apps/web/app/(app)/admin/identity/ui-tokens.ts** — the console's parallel visual language — twenty style objects and a twelve-entry colour alias map, consumed by nineteen admin pages and two Security Center pages. Its values were re-pointed at the canonical tokens first, which fixed the navy accent on seventeen surfaces and left the mechanism in place; this removed the mechanism.
- **the admin TOKENS.* colour alias map** — a second name for every colour, so a surface could be violet through TOKENS and violet through --accent-600 and nobody could tell which one a page was using. Sixty-one uses across the console, all migrated to the canonical tokens before the file was deleted.
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

## Known debt this proof deliberately does not claim

**A second `ui-tokens.ts` still exists outside the console.** The deleted file was
`app/(app)/admin/identity/ui-tokens.ts`. `app/(app)/reviewer-ops/ui-tokens.ts` is a
separate copy of the same idea, consumed by `governance/policy`,
`governance/policy/_sections/WorkspaceGovernancePolicySection`,
`reviewer-ops/escalations` and `reviewer-ops/sla` — six `TOKENS.*` uses in four
files, none of them under `/admin`.

The first version of the `TOKENS.*` predicate banned the name across all of
`apps/web` and reported those six as regressions. Widening the deletion to cover
them would have been a claim about work nobody did; deleting the pattern to make
the table green would have hidden that the second copy exists. So the predicate is
scoped to what this phase actually deleted, and the rest is written down here.
