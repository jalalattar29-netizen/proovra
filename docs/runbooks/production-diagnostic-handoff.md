# Production diagnostic — operator handoff

**Audience:** an operator with shell access to the PROOVRA production host and
permission to run `docker`.
**Effect:** read-only. Nothing is written to the database, and nothing is left
on the host or in the container once the last step completes.

The diagnostic answers what source code cannot: how many incidents there really
are, how many are the same condition wearing different rows, which alert signals
are backed by an incident, which evidence is stuck and in which overlapping
cohorts.

**Pinned commit:** `438f75649ed3ee7b9ab43e3dca4cf36279799f1e`

## What was wrong with the previous version of this document

It said to copy the script to `/tmp` and run `node /tmp/proovra-diagnostic.cjs`.
Reproduced against the real production image, that failed every time:

```
proovra-diagnostic: could not load @prisma/client / @prisma/adapter-pg / pg
(Cannot find module '@prisma/client' Require stack: - /tmp/proovra-diagnostic.cjs)
```

CommonJS resolves a bare specifier by walking up from the directory of the
**file doing the requiring**, not from the working directory. The image installs
hoisted into `/app/node_modules` and sets `WORKDIR` to `/app/services/api`, so
the walk went `/tmp/node_modules` → `/node_modules` → nothing. Being in the
right container did not help, and neither did the right working directory.

The script now resolves explicitly — an operator-supplied `--require-base`, then
its own directory, then the working directory, then a short list of conventional
install roots — and prints which base won. Both `/tmp` and in-tree placements
work, and a total failure names every base it tried. This is proven by
`services/api/scripts/diagnostic-container-smoke.mjs`, 17 checks against the
built image, which runs the exact command printed below.

## Before you start

**Use the running container's existing environment.** Do not `source .env`, do
not `export DATABASE_URL`, do not pass `-e DATABASE_URL=...`. The container
already holds the credentials the API is really using, and a shell-supplied
value can silently point somewhere else — which is how a diagnostic ends up
profiling staging and printing production-shaped JSON.

**Do not assume the database name.** `dw` and `neondb` are both plausible and
neither is verified. Step 2 asks the running process, and step 5 refuses to read
anything if the answer does not match what you pass it.

**Do not add `-w` to any `docker exec` below.** The commands rely on the image's
own `WORKDIR`. A stray `-w /tmp` is survivable — the conventional-roots fallback
covers it — but you will be relying on a fallback instead of the real answer.

---

## 1 — Find the API container, or refuse

The previous version said "`docker ps` to find it", which is an instruction to
guess. On a host running more than one stack — a blue/green pair mid-deploy, a
leftover from a rollback — guessing selects a container that is not serving
traffic, and every number the diagnostic then produces describes the wrong
process.

`find-api-container.sh` refuses instead. It tries the compose service label
`api`, then `proovra-api`, then a container name containing both "proovra" and
"api"; the first strategy that yields any candidate wins, and its result must be
unique. A later strategy is never used to break a tie, because a tie means you
have to look.

```bash
cd /opt/proovra/app && git fetch origin && git show 438f75649ed3ee7b9ab43e3dca4cf36279799f1e:services/api/scripts/find-api-container.sh > /tmp/find-api-container.sh
```

```bash
sh /tmp/find-api-container.sh
```

| Exit | Meaning |
| --- | --- |
| `0` | Exactly one. It prints the id, image, name, workdir, start time and image revision. |
| `1` | None running. Do not continue. |
| `2` | More than one. It lists them and chooses nothing — pick by hand. |

```bash
API=$(sh /tmp/find-api-container.sh | awk '{print $1}') && echo "API=$API"
```

Record the whole line it printed. The image revision and start time are what let
you say afterwards *which build* the numbers came from, and `workdir` should be
`/app/services/api` — if it is not, pass it as `--require-base` in step 5.

## 2 — Ask it which database it is connected to

This prints **one word and nothing else**. It reads `DATABASE_URL` from inside
the container — the value the API is actually using — and never displays it.

```bash
docker exec "$API" node -e 'const{Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL});p.query("select current_database() d").then(r=>{console.log(r.rows[0].d);return p.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
```

```bash
DB=<the-single-word-printed-above>
```

> If this prints a connection error rather than a name, stop. Do not work around
> it by supplying a URL yourself — the error is telling you something true about
> the container's configuration.

## 3 — Extract the scripts from the server's own checkout

**Preferred**, because it needs no network egress from the production host to
github.com and does not depend on a public URL staying reachable. `git show`
writes to stdout from the object database; it does not touch the working tree,
so the checkout's branch, index and files are unchanged.

```bash
cd /opt/proovra/app
```

```bash
git fetch origin
```

```bash
git show 438f75649ed3ee7b9ab43e3dca4cf36279799f1e:services/api/scripts/proovra-diagnostic.cjs > /tmp/proovra-diagnostic.cjs
```

```bash
git show 438f75649ed3ee7b9ab43e3dca4cf36279799f1e:services/api/scripts/proovra-diagnostic-summary.cjs > /tmp/proovra-diagnostic-summary.cjs
```

> **Do not** `git checkout`, `git reset`, `git pull`, or switch branches to get
> these files. `git fetch` only downloads objects; extracting two files to /tmp
> must not disturb what the server is running.

If the host has no checkout, copy from a machine that does:

```bash
scp services/api/scripts/proovra-diagnostic.cjs services/api/scripts/proovra-diagnostic-summary.cjs OPERATOR@HOST:/tmp/
```

**Verify the bytes before running them against production:**

```bash
sha256sum /tmp/find-api-container.sh /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs
```

| File | SHA-256 |
| --- | --- |
| `find-api-container.sh` | `7474bd560c13994089cfab0ecbf285ec6229465619642f4a3955e2ad260828a0` |
| `proovra-diagnostic.cjs` | `21c9092727d2e0448ad4fb941c040d465f7e4de47c0336aa97bfa8364d92bd3a` |
| `proovra-diagnostic-summary.cjs` | `436760f19440fd69ca6ce5033fec384a3ef15e57f865ff370eb409adbd51a8a8` |

> Both files are LF-only in git, so these hashes hold from any checkout. **If a
> hash does not match, stop** — a transfer that altered the bytes altered what
> the script does, and the self-hash the diagnostic reports would then attest to
> a file nobody reviewed.

## 4 — Copy them into the container

```bash
docker cp /tmp/proovra-diagnostic.cjs "$API":/tmp/proovra-diagnostic.cjs && docker cp /tmp/proovra-diagnostic-summary.cjs "$API":/tmp/proovra-diagnostic-summary.cjs
```

Re-verify — `docker cp` through a storage driver is one more place bytes can
change:

```bash
docker exec "$API" sha256sum /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs
```

> If `docker cp` is refused because the container runs with a read-only root
> filesystem, `/tmp` is normally still a writable tmpfs and this will work. If it
> does not, the container is fully read-only and the diagnostic cannot be
> introduced at all — say so rather than remounting anything.

## 5 — Run it, saving the output on the host

`> diag.json` is interpreted by **your** shell, not the container, so the file
lands on the host in your current directory. Nothing is written inside the
container, which is deliberate: it is ephemeral, and a file left there is lost
on the next deploy and forgotten before then.

```bash
umask 077
```

```bash
docker exec "$API" node /tmp/proovra-diagnostic.cjs --expect-database="$DB" > diag.json
```

The second line of stderr says which base the runtime resolved from — expect
`/app/services/api`. If step 1 showed a different `WorkingDir`, or if this line
names a conventional root rather than the real one, re-run with it explicit:

```bash
docker exec "$API" node /tmp/proovra-diagnostic.cjs --require-base=/app/services/api --expect-database="$DB" > diag.json
```

### The account under investigation

This run has a specific question behind it, so the trace argument is not
optional:

```bash
docker exec "$API" node /tmp/proovra-diagnostic.cjs --expect-database="$DB" --trace-account=rodrigoduarte44@gmail.com > diag.json
```

Only an exact email or an exact user id resolves — a display name never does,
because matching on a name is how a trace ends up describing the wrong person.
If the address does not resolve, the section says so with a match count rather
than guessing at a near miss.

The traced section is redacted at the source: the email reduces to its domain,
ids become per-run pseudonyms, IPs become a /24 or /48 network. It still
describes one real person's activity, so it is the part of `diag.json` that
must not go on a shared screen — see step 8.

If the script refuses because `current_database()` does not equal `$DB`, that
refusal is the point of the check — re-run step 2 rather than editing the
argument.

```bash
ls -l diag.json && stat -c '%a %U' diag.json
```

## 6 — Validate the JSON

Before reading any number out of it. A dropped session, a full disk or a
container killed mid-write all produce a file that looks plausible when skimmed
and is missing precisely the sections that mattered.

```bash
docker exec -i "$API" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);console.log("valid JSON,",s.length,"bytes, sections:",Object.keys(o.sections||{}).join(", "))}catch(e){console.error("INVALID:",e.message);process.exit(1)}})' < diag.json
```

Exit status `0` means the document parsed. Anything else means re-run step 5 —
do not summarise a partial capture.

## 7 — Print the safe summary

Aggregates only: no id, no pseudonym, no email, no domain, no per-workspace row,
and for a resolved account trace only the fact that it resolved. **This is the
output that is safe to share, and the only output that should leave the host.**

```bash
docker exec -i "$API" node /tmp/proovra-diagnostic-summary.cjs < diag.json
```

Read the exit code — it is the part that does not scroll away:

| Code | Meaning |
| --- | --- |
| `0` | Valid, and every section was read. A zero in the output is a measured zero. |
| `1` | Valid, but at least one section **failed**. A missing number is not a zero. |
| `2` | Not a valid diagnostic document. No numbers were printed. |

```bash
echo "summary exit code: $?"
```

## 8 — What not to display, and why you do not have to

The diagnostic selects **no secret**: no token, hash, cookie, session value,
signing key, connection string or webhook secret. It reads **no evidence
content**: no bytes, no storage key, no filename, no fingerprint, no GPS. Ids are
per-run pseudonyms, emails reduce to a domain, IPs to a /24 or /48 network. The
container smoke asserts the script contains no `INSERT`, `UPDATE`, `DELETE`,
DDL or `$executeRaw`.

So the risk is not that `diag.json` contains a credential. It is that:

- the raw document is thousands of lines, and anything alarming in it scrolls
  past unread;
- the traced-account section is one real person's activity, and a domain plus
  timestamps identifies them in a room;
- the per-workspace distributions identify a customer by shape even with the
  name removed.

Step 7 is therefore what you show. If the investigation genuinely needs the
traced account's activity, read the raw document under whatever access rule
covers looking at one customer — not on a shared screen, and never in a ticket
or chat message.

Do **not** paste `diag.json` into an issue tracker, a chat client or an AI
assistant. Do not commit it.

## 9 — Keep the raw output only until it has been interpreted

`diag.json` is the only copy of the measurement. Keep it until the summary has
been read and any follow-up question answered from it, then destroy it in the
same session. Do not archive it "in case", and do not move it off the host.

Remove the copies inside the container first:

```bash
docker exec "$API" rm -f /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs
```

Then the host copies. `shred` overwrites before unlinking:

```bash
shred -u -z /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs diag.json
```

If `shred` is unavailable:

```bash
rm -f /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs diag.json
```

Confirm nothing remains:

```bash
ls -l diag.json /tmp/proovra-diagnostic*.cjs 2>&1 | head
```

> **An honest limit.** `shred` overwrites the blocks a file currently occupies.
> On a copy-on-write or log-structured filesystem (btrfs, ZFS, overlayfs), on an
> SSD with wear levelling, or where the file was written to a snapshotted volume,
> earlier copies of those blocks can survive the overwrite. Treat `shred` as
> making casual recovery impractical, not as making recovery impossible. If the
> output must be provably destroyed, the host disk — not the file — is what has
> to be handled.

Also clear it from anywhere it was copied: terminal scrollback, tmux buffers,
`~/.bash_history` if you pasted content rather than a path, and any local copy.

---

## One block, start to finish

Adapted to `/opt/proovra/app`. Read the output of each step before running the
next; `<container-id>` and `<name-printed>` come from steps 1 and 2.

```bash
cd /opt/proovra/app && git fetch origin && for f in find-api-container.sh proovra-diagnostic.cjs proovra-diagnostic-summary.cjs; do git show 438f75649ed3ee7b9ab43e3dca4cf36279799f1e:services/api/scripts/$f > /tmp/$f; done && sha256sum /tmp/find-api-container.sh /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs
```

Compare all three against the table in step 3. **If any differs, stop.**

```bash
sh /tmp/find-api-container.sh
```

```bash
API=<container-id>
```

```bash
docker exec "$API" node -e 'const{Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL});p.query("select current_database() d").then(r=>{console.log(r.rows[0].d);return p.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
```

```bash
DB=<name-printed>
```

```bash
docker cp /tmp/proovra-diagnostic.cjs "$API":/tmp/proovra-diagnostic.cjs && docker cp /tmp/proovra-diagnostic-summary.cjs "$API":/tmp/proovra-diagnostic-summary.cjs && docker exec "$API" sha256sum /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs
```

```bash
umask 077 && docker exec "$API" node /tmp/proovra-diagnostic.cjs --expect-database="$DB" --trace-account=rodrigoduarte44@gmail.com > diag.json ; echo "diagnostic exit: $?"
```

```bash
docker exec -i "$API" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);console.log("valid JSON,",s.length,"bytes, sections:",Object.keys(o.sections||{}).join(", "))}catch(e){console.error("INVALID:",e.message);process.exit(1)}})' < diag.json
```

```bash
docker exec -i "$API" node /tmp/proovra-diagnostic-summary.cjs < diag.json ; echo "summary exit: $?"
```

### What to send back

Three things, and nothing else:

1. the full text the **summary** printed;
2. the **diagnostic exit code**;
3. the **summary exit code**.

Do **not** send `diag.json`, any secret or token, a provider payload, a full IP
address, or any other customer data. The summary is built to be safe to paste;
the raw document is not.

### Then destroy it

```bash
docker exec "$API" rm -f /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs && shred -u -z /tmp/find-api-container.sh /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs diag.json && ls -l diag.json 2>&1 | head -1
```

Keep `diag.json` only until the summary has been read and any follow-up
question answered from it. Do not archive it and do not move it off the host.
