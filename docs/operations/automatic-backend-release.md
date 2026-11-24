# Automatic production backend release

From 2026-11-24 a main commit reaches production with no person in the loop:

```
push to main
 → required CI green on that exact SHA (ci, playwright-e2e, schema-reproducibility, updated-report-journey)
 → deploy-images: ghcr.io/<owner>/proovra-{api,worker}:sha-<7>, smoked, revision-labelled
 → backend-release (this runbook)
     gate:    images exist with that exact revision · SHA is still main HEAD · CI green on it
              · the live API runs an ANCESTOR of it · no earlier automatic attempt of it failed
     host:    rollback point recorded and its images proven
              → database backup taken and proven (checksum, pg_restore --list, counts, schema)
              → scripts/deploy-prod-pull.sh --plan, then worker → API (its own revision,
                schema and readiness gates)
              → every container's image tag, revision label, health and readiness verified;
                /health revision, contract and route epoch = the release's own contract
              → on any failure after a service changed: automatic rollback (API first), verified
     finish:  the PUBLIC API verified from GitHub (revision, contract, route epoch, /readyz)
              → commit status release/backend = success → web-release-continuation dispatched
 → web-release-continuation: promotes the matching web ONLY while the live API's
   revision carries release/backend success; the Vercel build re-runs the fail-closed gate
```

Files: `.github/workflows/backend-release.yml`, `scripts/release/backend-release.mjs`
(runner side), `scripts/release/host-release.sh` (host side, run from the commit being
released), `infra/host/proovra-release-entry.sh` (the only command the release key can
run), `scripts/deploy-prod-pull.sh` (unchanged: the established deploy).

## 1. What each outcome looks like

The commit status `release/backend` on the released commit is the record. Nothing is
reported green that was not verified.

| Status | Meaning | Web |
|---|---|---|
| pending "deploying X over Y: backup, worker, API, verification" | in progress | waits |
| success "backend live at X: api+worker revision, readiness, epoch N verified; backup …" | verified | continuation promotes it |
| error "superseded by Z: not deployed" | main moved on; Z is released instead | follows Z |
| failure "deploy failed before any service changed: <reason>; still Y" | backup, rollback point, plan, pull or schema gate refused; nothing restarted | stays |
| failure "deploy failed; rolled back to Y (verified)" | the release failed after a service changed; the rollback verified | held; checked compatible with Y |
| error "deploy failed and the rollback to Y did NOT verify: operator needed now" | **act now** (§4) | checked; promote attempted |
| error "verification failed: …" | the host and the public API disagree | held |
| error "waiting on owner configuration (…)" | §2 is not done | waits |

A failed automatic attempt is never retried automatically; retry with a dispatch (§3).

## 2. Owner setup (once)

The release connects to the host over SSH with a key that is used for nothing else and
can run only `/opt/proovra/bin/proovra-release`. No secret is ever typed into chat or a
document.

### 2.1 Create the release key (your own machine)

```bash
ssh-keygen -t ed25519 -N "" -C "proovra-release@github-actions" -f proovra-release
```

This writes `proovra-release` (private) and `proovra-release.pub` (public).

### 2.2 On the production host (as the `proovra` user)

Install the entry point from main and bind the key to it:

```bash
cd /opt/proovra/app && git fetch --quiet origin
```
```bash
mkdir -p /opt/proovra/bin && git show origin/main:infra/host/proovra-release-entry.sh > /opt/proovra/bin/proovra-release && chmod 755 /opt/proovra/bin/proovra-release
```

Append ONE line to `~/.ssh/authorized_keys`, with the content of `proovra-release.pub`
after the options:

```
command="/opt/proovra/bin/proovra-release",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc ssh-ed25519 AAAA…(proovra-release.pub)… proovra-release@github-actions
```

Check (from your machine): `ssh -i proovra-release proovra@<host> status` prints
`PROOVRA_RELEASE revision_api=…` lines and `PROOVRA_RELEASE result=STATUS`, and
`ssh -i proovra-release proovra@<host> ls` is refused with `result=USAGE`.

`flock` (util-linux) must exist on the host; `/opt/proovra` must be writable by
`proovra` for the lock file `/opt/proovra/.release.lock`.

### 2.3 In GitHub (Settings → Environments → New environment → `production`)

- Deployment branches and tags: **Selected branches** → `main`.
- No required reviewers (the release is automatic; the gates are the control).
- Environment secret `PROD_RELEASE_SSH_KEY`: the whole content of the private key file
  `proovra-release`. Then delete the private key file from your machine.
- Environment variable `PROD_RELEASE_SSH_TARGET`: `proovra@<host>`.
- Environment variable `PROD_RELEASE_SSH_KNOWN_HOSTS`: the host's ed25519 key line,
  `<host> ssh-ed25519 AAAA…`. Compare its fingerprint with the host's own
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` before saving.

### 2.4 For a web rollback (Settings → Secrets and variables → Actions, repository level)

A backend rollback can restore an API older than what the live web needs. The release
then makes the web compatible first, by promoting the newest READY production
deployment the restored API supports, and refuses the rollback when it cannot. After
such a web rollback Vercel stops auto-assigning production, so the continuation then
promotes the next compatible release instead of rebuilding it. Both need:

- Repository secret `VERCEL_TOKEN`: a Vercel access token limited to the team that owns
  `proovra-web`.
- Repository variable `VERCEL_PROJECT_ID`: the `proovra-web` project ID
  (Vercel → proovra-web → Settings → General).
- Repository variable `VERCEL_TEAM_ID`, if the project belongs to a team.

Without them a release still works; a rollback whose restored API does not support the
live web is refused (nothing changes) and says so.

## 3. Dispatch (Actions → backend-release → Run workflow)

| mode | sha | does |
|---|---|---|
| release | main HEAD | retries a release after a failure was understood and fixed |
| verify | the live release | verifies a release that is already running and records `release/backend` success (e.g. after an owner-run host deploy) |
| rollback | the release running now | makes the web compatible with the recorded rollback point (or refuses), then rolls the backend back (API first) and verifies it |

## 4. When the rollback did not verify

The release run is red with "operator needed now". On the host:

```bash
cd /opt/proovra/app && cat .deploy-state/previous-release && docker compose --env-file .env -f infra/docker/docker-compose.prod.yml ps
```

Then follow `low-ram-deploy-runbook.md` §5 (Rollback) by hand. The backup this release
took is named in the run log (`PROOVRA_RELEASE backup=…`) and in
`.deploy-state/backup-proof-<sha>.txt`.

## 5. What did not change

- `scripts/deploy-prod-pull.sh` is the deploy, unchanged: worker first, revision labels,
  runtime schema gate, health and `/readyz` per service, release record.
- Migrations are not run by any of this. A release that needs one is refused by the
  schema gate before anything restarts; apply it through the migration runbook first,
  then dispatch `release`.
- The Vercel build gate (`scripts/vercel-ignore-build.mjs`) and its `--enforce` build
  step are unchanged and still decide every web build.
- No step commits, pushes, tags, or uses a `latest` image.
