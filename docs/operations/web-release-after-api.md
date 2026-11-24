# Web release after an API release

The web (`proovra-web` on Vercel) deploys from `main` automatically. Every push
to `main` creates a production deployment, and Vercel runs
`node scripts/vercel-ignore-build.mjs` (the `ignoreCommand` in `vercel.json`)
before building it. There is no blanket hold: the gate decides.

## What the gate does on `main`

It builds only when all of these are positively established; anything else is a
SKIP (Vercel cancels the deployment and the current production web keeps
serving):

1. The build's own contract version and route epoch are readable.
2. `https://api.proovra.com/health` answers 2xx with `x-proovra-contract` and
   `x-proovra-route-epoch` not lower than the build's.
3. The live API states its `revision`, and no API-facing source
   (`services/api/src`, `services/api/prisma`, `services/worker/src`,
   `packages/shared/src` except locale text) differs between that revision and
   the commit being built.
4. The build is not a strict ancestor of the live web's own revision
   (`https://<production domain>/api/health`), so an older queued or
   redeployed commit cannot replace a newer release. An unreadable live web is
   logged and does not block on its own.

Every run writes two lines to the Vercel build log, beginning
`vercel-ignore-build:`. The first says what was compared. The second gives
`BUILD` or `SKIP` and the reason.

The same check runs a second time at the start of the build command
(`node scripts/vercel-ignore-build.mjs --enforce && pnpm --filter proovra-web build`).
There, a production build the gate refuses **fails** (`--enforce: REFUSED`): the
deployment errors, nothing is promoted, and the current web keeps serving. This
holds even if the ignore step fails. A build whose environment shows neither
`VERCEL_ENV` nor `VERCEL_GIT_COMMIT_REF` is treated as production.

**Why the gate never ran before 2026-11-21.** The Vercel project's Root
Directory is `apps/web`, and Vercel runs both commands from there. Until then
the ignore command was `node scripts/vercel-ignore-build.mjs`, which failed
with `Cannot find module '/vercel/path0/apps/web/scripts/vercel-ignore-build.mjs'`.
The step exited 1, and Vercel reads that as BUILD. This is how 0376721d9 went
live against an older API on 2026-11-19, and how 5b9fa29e4 built without a
check. Both commands now `cd` to the repository root first. Keep that prefix if
you edit them.

**Evidence without Vercel access:** each gate run requests
`https://api.proovra.com/health`, which the production API logs as a
`request.completed` line for `/health`. A deployment window with no such line
means the gate did not ask the API.

## Releasing a web that needs a newer API (automatic continuation)

A push whose API-facing source the live API does not serve yet is skipped, by
design. Since 2026-11-24 the backend is released automatically in the reviewed
order (worker → API, after a verified backup) by `backend-release.yml`; see
`automatic-backend-release.md`. **The web then continues by itself**, and only
once the live API's release is verified (commit status `release/backend`
success on its revision): no empty commit, no second push, no Vercel action.

`.github/workflows/web-release-continuation.yml` runs
`scripts/release/web-continuation.mjs` on every push to `main`, whenever a
required workflow (ci, playwright-e2e, schema-reproducibility,
updated-report-journey) or deploy-images completes on `main`, and every 10
minutes. Each run evaluates **only the newest commit of `main`**:

| What it reads | Decision |
|---|---|
| www `/api/health` already serves that commit | status `success` "web live at …"; nothing to do |
| Vercel's status for the commit is pending | a build is in flight; nothing to do |
| the gate refused it and the live API still lacks it | status `pending`, e.g. "waiting for API epoch 5 (live 4), revision >= abc123456 (live 8e3b57ba3); web stays at 7b852996e"; exits green |
| the live API serves it now, the required workflows are green on that exact SHA, and `main` has not moved | calls the proovra-web **Vercel Deploy Hook** once; status `pending` "triggered web build of …" |
| a required workflow failed on that SHA | status `failure`; not continued |
| live API 5xx | status `error` "live API unhealthy … web stays at …"; retried |
| anything unreadable (API, www, GitHub, Vercel status, the diff) | status `pending` "no promotion: … unreadable"; retried next run |
| the hook secret is missing when a continuation is due | status `error` "waiting on owner configuration: VERCEL_WEB_DEPLOY_HOOK_URL"; the run fails |

The status context is `release/web-continuation` on the commit; its link opens
the workflow run, whose job summary lists the originating push, the required
workflow runs, the Vercel deployment links, the live API and web revisions and
the decision.

Why it is safe:

- The decision whether the API is compatible is made by the gate's own
  `decide()`, with the same inputs the Vercel build will use.
- The hook builds `main`'s HEAD. The workflow re-reads `main` immediately before
  calling it and does nothing if `main` moved. In the remaining window (a push
  landing in the second between that check and Vercel resolving the hook), the
  build is of the newer commit, which the Vercel build gates independently
  (compatibility + never older than the live web), exactly as that commit's own
  push build was gated. The run records which commit Vercel started building.
- The "triggered" status is written BEFORE the hook is called, and the hook is
  not called if that write fails, so a build can never escape the in-flight
  window and the retry cap. A hook call that fails is followed by a "deploy hook
  call failed" status, which voids that record; if even that write fails, the
  record stands and the next runs wait (the conservative side).
- A refused or lost continuation build is retried at most 3 times per live API
  revision; then the status turns `failure` and asks for the Vercel build log.
  While a requested build has not been reported (30 minutes), no second request
  is made.
- Only the newest commit is ever triggered. An older commit still marked
  `pending` is marked `error` "superseded by …". The workflow's concurrency group
  serializes runs and never cancels one mid-flight.
- It never commits, pushes or tags.

To check a release by hand:

1. `curl -s https://api.proovra.com/health` shows `"revision":"<release SHA>"`
   (or a later commit of `main`).
2. The commit's `release/web-continuation` status moves from "waiting for API …"
   to "triggered web build of …" to "web live at …".
3. In the Vercel build log of the continued deployment, the gate printed
   `vercel-ignore-build: BUILD — the live API (<sha>, ...) serves everything
   this build relies on`.
4. `https://www.proovra.com/api/health` shows the commit; the site shows no
   "update is finishing" notice.

Dry run (reads real production, writes nothing, calls no hook):
`node scripts/release/web-continuation.mjs --dry-run`, or Actions →
web-release-continuation → Run workflow → `dry_run`.

### Owner setup (once)

1. Vercel → project **proovra-web** → Settings → Git → Deploy Hooks → create a
   hook named `web-release-continuation` for branch `main`. Copy the URL (it is a
   secret; do not paste it anywhere else).
2. GitHub → repository Settings → Secrets and variables → Actions → New
   repository secret: name `VERCEL_WEB_DEPLOY_HOOK_URL`, value the hook URL.
3. Nothing else: the workflow uses its own `GITHUB_TOKEN` (`statuses: write`,
   `actions: read`, `contents: read`).

A deploy hook can do one thing: start a build of `main` of proovra-web, which
the gate then checks. A Vercel access token (needed to deploy an exact SHA
through the REST API) is scoped to a whole account or team, not to one project
or one action (as of 2026-11; re-check Vercel's token options before changing
this), so it would also reach environment variables, domains and every other
project. That is why the hook is used.

### Fallback if the continuation is unavailable

Push any commit to `main` after the API is live (for example
`git commit --allow-empty -m "chore(release): web release after API <release SHA>"`).
This is no longer the normal path.

## Break-glass

Set the Vercel environment variable `PROOVRA_WEB_IGNORE_API_EPOCH=1` for one
deliberate release only, and remove it afterwards. With it set, the gate builds
without the compatibility check. Vercel's Instant Rollback promotes an earlier
build without running the gate.
