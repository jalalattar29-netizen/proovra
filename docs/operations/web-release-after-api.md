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

## Releasing a web that needs a newer API

A push whose API-facing source the live API does not serve yet is skipped, by
design. Release in the reviewed order: migration → worker → API, on the host,
with `scripts/deploy-prod-pull.sh` at the release SHA. Then deploy the web.

1. Confirm the API serves the release:
   `curl -s https://api.proovra.com/health` must show `"revision":"<release SHA>"`
   (or a later commit of `main`).
2. Push to `main`. Any commit will do. If there is nothing else to ship:
   ```bash
   git commit --allow-empty -m "chore(release): web release after API <release SHA>"
   ```
   ```bash
   git push origin main
   ```
3. In the Vercel build log of that deployment, check that the gate printed
   `vercel-ignore-build: BUILD — the live API (<sha>, ...) serves everything
   this build relies on`.
4. Confirm the release:
   - `https://www.proovra.com/api/health` shows the pushed commit;
   - the site shows no "update is finishing" notice.

## Break-glass

Set the Vercel environment variable `PROOVRA_WEB_IGNORE_API_EPOCH=1` for one
deliberate release only, and remove it afterwards. With it set, the gate builds
without the compatibility check. Vercel's Instant Rollback promotes an earlier
build without running the gate.
