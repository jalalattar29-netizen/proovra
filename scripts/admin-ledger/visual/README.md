# Admin visual verification instruments

The five sweeps whose numbers the Phase 7 report cites. They live in the
repository for one reason: a measurement nobody else can re-take is a claim,
not a measurement.

Each one drives a real browser against a local, loopback-only fixture. None of
them touches Production, and none can — the fixture launchers refuse any
non-localhost endpoint (see `scripts/local-fixture-env`).

## Running them

```bash
# 1. a disposable PG16 + Redis on loopback-only ports
docker run -d --name pv-p7-pg   -e POSTGRES_USER=pv -e POSTGRES_PASSWORD=pv \
  -e POSTGRES_DB=proovra_p7_fixture -p 127.0.0.1:55537:5432 pgvector/pgvector:pg16
docker run -d --name pv-p7-redis -p 127.0.0.1:56483:6379 redis:7-alpine

# 2. migrate and seed
export DATABASE_URL=postgresql://pv:pv@127.0.0.1:55537/proovra_p7_fixture
pnpm --filter proovra-api exec prisma migrate deploy
NODE_ENV=development pnpm --filter proovra-api exec tsx scripts/seed-admin-fixture.ts

# 3. ONE api and ONE web server
node services/api/scripts/dev-admin-fixture-api.mjs --api-port=8195 \
  --database-url="$DATABASE_URL" --redis-url=redis://127.0.0.1:56483/0
node apps/web/scripts/dev-admin-fixture.mjs --api-port=8195 --port=3315

# 4. the route list, then the sweeps
node apps/web/scripts/admin-inventory.mjs --json | node -e '…'   # or paste the 47
P7_WEB=http://localhost:3315 node scripts/admin-ledger/visual/responsive.mjs routes.txt
P7_WEB=http://localhost:3315 node scripts/admin-ledger/visual/contrast.mjs /admin /admin/costs …
P7_WEB=http://localhost:3315 node scripts/admin-ledger/visual/rtl.mjs routes.txt
P7_WEB=http://localhost:3315 node scripts/admin-ledger/visual/keyboard.mjs /admin …
P7_WEB=http://localhost:3315 node scripts/admin-ledger/visual/tabs.mjs
```

**ONE dev server, not two.** Two Next dev servers started from the same
worktree share `node_modules/.cache/admin-fixture-next` and clobber each
other's chunks. That produced a run in which all 47 routes measured 900px with
559 console errors — every page a `ChunkLoadError`. If a sweep reports a
uniform height across unrelated routes, that is the cause.

**Re-seed before any before/after comparison.** Each sign-in writes an audit
event and a session row, so the event-listing pages grow as the sweeps run. An
earlier pass attributed ~1,000px of growth on four pages to a CSS rule; the
real cause was the fixture having more data. Page-height comparisons are only
meaningful against a freshly seeded database.

## What each one measures, and what it got wrong first

Every instrument here has a corrections section in its own header. They are
kept because an instrument that has been wrong once will be trusted less and
read more, which is the right outcome.

| file | measures | its own correction |
|---|---|---|
| `responsive.mjs` | 47 routes × 7 widths + 200% zoom: body overflow with the offending element named, sub-44px targets split by ownership (page content vs app chrome), sub-11px text, H1 count | ran every width as `pointer: fine`, so phone widths got the shell's laptop-density path and reported 17 targets no phone can reach; settled at 1.5s and reported `h1=0` on 17 of 32 checks; exempted only `<a>` from the inline-in-a-sentence rule, which condemned a `font: inherit` text toggle 32 times |
| `contrast.mjs` | WCAG AA on every text node, with the effective background composited through every translucent ancestor | read `backgroundColor` only, so 6%-tinted white cards were treated as opaque slate and near-black text came out at 1.43:1; then ignored gradient fills, so white-on-purple button labels came out at 1.06:1 |
| `rtl.mjs` | 47 routes with the LOCALE set to Arabic (not with `dir` forced): overflow, technical strings that must stay LTR, physical inline-axis properties | tested `direction === "ltr"` only, which cannot see `unicode-bidi: plaintext` working — it does not change the computed direction — and reported 10 already-fixed defects; also flagged inline boxes whose *used* margin is not a rule anybody wrote |
| `keyboard.mjs` | tab order from the top of the document, focus visibility per stop, the skip link actually activated, nested interactive controls, clickable divs, heading order, landmarks, labels, and the mobile drawer driven end to end | matched the drawer trigger on any class containing "nav", which selected an invisible 0×0 sidebar link; and matched the focus-return check on the same word, so the drawer's own "Close navigation" button counted as a return to the trigger |
| `tabs.mjs` | every tab in the console opened by URL, one-selected, arrow keys, reload persistence, 44px targets, and both time-window controls | — |

## Why the numbers are split by ownership

`content` is inside `<main>`; `chrome` is the app shell. Reporting one number
over both makes a single shell issue look like 47 page issues and buries any
real page issue underneath it.
