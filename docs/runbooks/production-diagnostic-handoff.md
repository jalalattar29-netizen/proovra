# Production diagnostic — operator handoff

**Audience:** an operator with shell access to the PROOVRA production host and
permission to run `docker`.
**Effect:** read-only. Nothing is written to the database, and nothing is left
on the host or in the container once step 9 completes.

The diagnostic answers what source code cannot: how many incidents there really
are, how many are the same condition wearing different rows, which alert signals
are backed by an incident, which evidence is stuck and in which overlapping
cohorts.

## Before you start

Two rules apply to every command below.

**Use the running container's existing environment.** Do not `source .env`, do
not `export DATABASE_URL`, do not pass `-e DATABASE_URL=...`. The container
already holds the credentials the API is really using, and a shell-supplied
value can silently point somewhere else — which is how a diagnostic ends up
profiling staging and printing production-shaped JSON.

**Do not assume the database name.** `dw` and `neondb` are both plausible and
neither is verified. Step 2 asks the running process what it is actually
connected to, and step 5 refuses to read anything if the answer does not match
what you pass it.

---

## 1 — Find the API container

Compose is not used here. `docker compose ps -q api` reads the compose file and
interpolates variables from `.env`, which is exactly the dependency this
procedure avoids; it also fails outright when run from the wrong directory.
Query the daemon directly instead.

```bash
docker ps --filter "label=com.docker.compose.service=api" --format '{{.ID}}  {{.Image}}  {{.Names}}'
```

If that returns nothing, the containers carry no compose labels. Match on the
image name instead and read the output before choosing:

```bash
docker ps --format '{{.ID}}  {{.Image}}  {{.Names}}  {{.Status}}'
```

Set `API` to the **container ID** of the API service — an ID, not a name, so a
rename or a second stack cannot redirect the following commands:

```bash
API=<container-id-from-above>
```

Confirm you picked the right one. This prints the container's own name and
proves `node` is present:

```bash
docker inspect --format '{{.Name}}  {{.Config.Image}}' "$API" && docker exec "$API" node --version
```

## 2 — Ask it which database it is connected to

This prints **one word and nothing else**. It reads `DATABASE_URL` from inside
the container — the value the API is actually using — and never displays it.

```bash
docker exec "$API" node -e 'const{Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL});p.query("select current_database() d").then(r=>{console.log(r.rows[0].d);return p.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
```

Record the output as `DB`:

```bash
DB=<the-single-word-printed-above>
```

> If this prints a connection error rather than a name, stop. Do not work around
> it by supplying a URL yourself — the error is telling you something true about
> the container's configuration.

## 3 — Put the diagnostic on the host and verify what you got

The scripts are not in the image. Copy them from a checkout of the repository:

```bash
scp services/api/scripts/proovra-diagnostic.cjs services/api/scripts/proovra-diagnostic-summary.cjs OPERATOR@HOST:/tmp/
```

Or fetch them on the host by commit SHA:

```bash
curl -fsSL -o /tmp/proovra-diagnostic.cjs "https://raw.githubusercontent.com/jalalattar29-netizen/proovra/58fddfd2c0b3689dd953639bc20693c0a45a80c9/services/api/scripts/proovra-diagnostic.cjs"
```

```bash
curl -fsSL -o /tmp/proovra-diagnostic-summary.cjs "https://raw.githubusercontent.com/jalalattar29-netizen/proovra/58fddfd2c0b3689dd953639bc20693c0a45a80c9/services/api/scripts/proovra-diagnostic-summary.cjs"
```

**Verify the bytes before running them against production.** Expected SHA-256,
for commit `58fddfd2c0b3689dd953639bc20693c0a45a80c9`:

| File | SHA-256 |
| --- | --- |
| `proovra-diagnostic.cjs` | `033638a886f493e1a44d00f8ce6e5bb5c9d8d4103780385be6d59ac9eb2ea615` |
| `proovra-diagnostic-summary.cjs` | `9e29b2b5edee805d5759c4cf2ccb59ba673b692bac9ad579db1e0184d09b9b97` |

```bash
sha256sum /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs
```

> Both files are LF-only in git, so these hashes hold whether the checkout you
> copied from is Linux, macOS or Windows. **If a hash does not match, stop** —
> a transfer that altered the bytes has also altered what the script does, and
> the self-hash the diagnostic reports in step 5 would then attest to a file
> nobody reviewed.

## 4 — Copy them into the container

They must run inside, where `@prisma/client` and the generated schema live.

```bash
docker cp /tmp/proovra-diagnostic.cjs "$API":/tmp/proovra-diagnostic.cjs && docker cp /tmp/proovra-diagnostic-summary.cjs "$API":/tmp/proovra-diagnostic-summary.cjs
```

Confirm the bytes survived the copy — `docker cp` through a storage driver is
one more place a file can change:

```bash
docker exec "$API" sha256sum /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs
```

## 5 — Run it, saving the output on the host

`> diag.json` is interpreted by **your** shell, not the container, so the file
lands on the host in your current directory. Nothing is written inside the
container, which is deliberate: it is ephemeral, and a file left there is lost
on the next deploy and forgotten before then.

Restrict the file's permissions before anything is written into it:

```bash
umask 077
```

```bash
docker exec "$API" node /tmp/proovra-diagnostic.cjs --expect-database="$DB" --trace-account=<email-or-user-id> > diag.json
```

Progress, warnings and refusals go to **stderr**, so they appear on your screen
while `diag.json` receives only JSON. If the script refuses because
`current_database()` does not equal `$DB`, that refusal is the point of the
check — re-run step 2 rather than editing the argument.

`--trace-account` is optional. Omit it entirely if no individual account is
under investigation; the section then records that none was requested. Only an
exact email or an exact user id resolves — a display name never does, because
matching on a name is how a trace ends up describing the wrong person.

Confirm the file is yours alone:

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
and for a resolved account trace only the fact that it resolved. This is the
output that is safe to put on a shared screen.

The reader uses only Node builtins, so this works with no Node on the host:

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
content**: no bytes, no storage key, no filename, no fingerprint, no GPS. Ids
are per-run pseudonyms, emails reduce to a domain, IPs to a /24 or /48 network.
A test asserts the absence of `INSERT`, `UPDATE`, `DELETE`, DDL and
`$executeRaw` anywhere in the script.

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
assistant. Do not commit it: the repository ignores nothing by that name and
committing it would place production shape data in git history permanently.

## 9 — Destroy the output when the review is finished

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
> SSD with wear levelling, or where the file was written to a snapshotted
> volume, earlier copies of those blocks can survive the overwrite. Treat `shred`
> as making casual recovery impractical, not as making recovery impossible. If
> the output must be provably destroyed, the host disk — not the file — is what
> has to be handled.

Also clear it from anywhere it was copied: your terminal scrollback, a tmux
buffer, `~/.bash_history` if you pasted content rather than a path, and any
local copy you `scp`-ed off the host.

---

## Summary of the ten commands

```bash
docker ps --filter "label=com.docker.compose.service=api" --format '{{.ID}}  {{.Image}}  {{.Names}}'
API=<container-id>
docker exec "$API" node -e 'const{Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL});p.query("select current_database() d").then(r=>{console.log(r.rows[0].d);return p.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
DB=<name-printed>
sha256sum /tmp/proovra-diagnostic.cjs /tmp/proovra-diagnostic-summary.cjs
docker cp /tmp/proovra-diagnostic.cjs "$API":/tmp/proovra-diagnostic.cjs && docker cp /tmp/proovra-diagnostic-summary.cjs "$API":/tmp/proovra-diagnostic-summary.cjs
umask 077 && docker exec "$API" node /tmp/proovra-diagnostic.cjs --expect-database="$DB" > diag.json
docker exec -i "$API" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s);console.log("valid JSON,",s.length,"bytes")}catch(e){console.error("INVALID:",e.message);process.exit(1)}})' < diag.json
docker exec -i "$API" node /tmp/proovra-diagnostic-summary.cjs < diag.json
docker exec "$API" rm -f /tmp/proovra-diagnostic*.cjs && shred -u -z diag.json /tmp/proovra-diagnostic*.cjs
```
