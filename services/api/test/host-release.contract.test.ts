/**
 * scripts/release/host-release.sh and infra/host/proovra-release-entry.sh — the
 * host side of the automatic backend release — EXECUTED with stub `docker`,
 * `git`, `curl` and `flock` on PATH and a scripted stand-in for
 * scripts/deploy-prod-pull.sh (which has its own contract test), so every
 * ordering and refusal is observable without a Docker daemon or a server.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const HOST_RELEASE = resolve(REPO, "scripts", "release", "host-release.sh");
const ENTRY = resolve(REPO, "infra", "host", "proovra-release-entry.sh");

const OLD = "71d2bcbba3f2e8613367febfa0da83faddd7509c";
const NEW = "4a37298fcc297514291d3cdbcbe193e2b643bafd";
const NEWER = "9e1f0c2d3b4a5968778695a4b3c2d1e0f9a8b7c6";
const SECRET = "postgresql://prod-user:SuperSecretPw@db.internal:5432/proovra";

// docker: state/running-<svc> holds the revision each service runs; a container id encodes it.
const DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
st="$STUB_STATE"; args="$*"; last="\${@: -1}"
rev_of_tag() { cat "$st/tag-$1" 2>/dev/null; }
case "$args" in
  "compose --env-file "*" -f "*" ps -q "*)
    # Like the real prod compose file: it does not even parse without these.
    [ -n "\${GHCR_OWNER:-}" ] || { echo 'error while interpolating services.proovra-api.image: required variable GHCR_OWNER is missing a value: GHCR_OWNER is required' >&2; exit 1; }
    [ -n "\${IMAGE_TAG:-}" ] || { echo 'error while interpolating services.proovra-api.image: required variable IMAGE_TAG is missing a value' >&2; exit 1; }
    [ -n "\${STUB_PS_FAIL:-}" ] && { echo 'Cannot connect to the Docker daemon' >&2; exit 1; }
    echo "WARN[0000] a compose warning on stdout"
    shift 5
    for s in "$@"; do r="$(cat "$st/running-$s" 2>/dev/null)"; [ -n "$r" ] && echo "cid-$s-$r-$(cat "$st/gen-$s" 2>/dev/null || echo 0)"; done; exit 0 ;;
  *"run --rm --no-deps -T --entrypoint bash pg-backup /ops/pg-backup.sh")
    [ -n "\${STUB_BACKUP_FAIL:-}" ] && { echo "pg-backup: FAILED — insufficient disk space"; exit 1; }
    echo "pg-backup: OK /backups/proovra-$(date -u +%Y%m%dT%H%M%SZ).dump (1048576 bytes, 120 tables, sha256 abc)"; exit 0 ;;
  *"run --rm --no-deps -T --entrypoint bash pg-backup -c "*)
    [ -n "\${STUB_PROOF_FAIL:-}" ] && { echo "sha256sum: WARNING: 1 computed checksum did NOT match"; exit 1; }
    echo 1048576; exit 0 ;;
  "inspect --format {{.Config.Image}} "*)
    s="$(echo "$last" | cut -d- -f2-3)"; r="$(echo "$last" | cut -d- -f4)"; echo "ghcr.io/owner/$s:sha-\${r:0:7}"; exit 0 ;;
  "inspect --format {{ index .Config.Labels "*)
    echo "$last" | cut -d- -f4; exit 0 ;;
  "inspect --format {{if .State.Health}}"*)
    s="$(echo "$last" | cut -d- -f2-3)"; [ "\${STUB_UNHEALTHY:-}" = "$s" ] && { echo unhealthy; exit 0; }; echo healthy; exit 0 ;;
  "exec "*) exit 0 ;;
  "pull -q "*) [ -n "\${STUB_PULL_FAIL:-}" ] && exit 1; exit 0 ;;
  "image inspect --format {{ index .Config.Labels "*)
    rev_of_tag "\${last##*:}"; exit 0 ;;
esac
echo "unexpected docker call: $args" >&2; exit 99
`;
// git: a linear history OLD < NEW < NEWER; checkout moves state/head.
const GIT = `#!/usr/bin/env bash
echo "git $*" >> "$STUB_LOG"
st="$STUB_STATE"
pos() { case "$1" in ${OLD}) echo 1 ;; ${NEW}) echo 2 ;; ${NEWER}) echo 3 ;; origin/main) echo "\${STUB_MAIN_POS:-2}" ;; *) echo 0 ;; esac; }
case "$1 $2" in
  "remote get-url") echo "git@github.com:Owner/proovra.git"; exit 0 ;;
  "diff --quiet") exit "\${STUB_DIRTY:-0}" ;;
  "cat-file -e") exit 0 ;;
  "rev-parse HEAD") cat "$st/head"; exit 0 ;;
  "checkout --quiet") echo "$4" > "$st/head"; exit 0 ;;
  "fetch --quiet") exit 0 ;;
  "merge-base --is-ancestor") a="$(pos "$3")"; b="$(pos "$4")"; [ "$a" -gt 0 ] && [ "$b" -gt 0 ] && [ "$a" -le "$b" ]; exit $? ;;
esac
if [ "$1" = show ]; then
  ref="\${2%%:*}"; path="\${2#*:}"
  case "$path" in
    packages/shared/src/release-contract.ts)
      e=5; [ "$ref" = "${OLD}" ] && e=4
      printf 'export const PRESENTATION_CONTRACT_VERSION = 1;\\nexport const PRESENTATION_CONTRACT_ROUTE_EPOCH = %s;\\n' "$e"; exit 0 ;;
    scripts/release/host-release.sh) cat "$STUB_HOST_RELEASE"; exit 0 ;;
  esac
fi
echo "unexpected git call: $*" >&2; exit 99
`;
// curl: /readyz OK unless STUB_READYZ_FAIL; /health answers as the running API.
const CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
st="$STUB_STATE"
case "$*" in
  *"/readyz") [ -n "\${STUB_READYZ_FAIL:-}" ] && exit 22; exit 0 ;;
  *"-D "*"/health")
    hdr=""; prev=""; for a in "$@"; do [ "$prev" = "-D" ] && hdr="$a"; prev="$a"; done
    r="$(cat "$st/running-proovra-api")"; e=5; [ "$r" = "${OLD}" ] && e=4; [ -n "\${STUB_LIVE_EPOCH:-}" ] && e="$STUB_LIVE_EPOCH"
    printf 'HTTP/1.1 200 OK\\r\\nX-Proovra-Contract: 1\\r\\nX-Proovra-Route-Epoch: %s\\r\\n\\r\\n' "$e" > "$hdr"
    printf '{"ok":true,"db":"up","revision":"%s"}' "$r"; exit 0 ;;
esac
exit 0
`;
const FLOCK = `#!/usr/bin/env bash
echo "flock $*" >> "$STUB_LOG"
exit "\${STUB_FLOCK_RC:-0}"
`;
// The established deploy script, scripted: it records its calls and moves state/running-*.
const DEPLOY = `#!/usr/bin/env bash
echo "deploy-prod-pull $* RELEASE_SHA=\${RELEASE_SHA:-} IMAGE_TAG=\${IMAGE_TAG:-} GHCR_OWNER=\${GHCR_OWNER:-}" >> "$STUB_LOG"
st="$STUB_STATE"
bump() { echo $(( $(cat "$st/gen-$1" 2>/dev/null || echo 0) + 1 )) > "$st/gen-$1"; }
case "\${1:-}" in
  --plan) echo "Currently running: sha-x — this is the rollback point."; exit "\${STUB_PLAN_RC:-0}" ;;
  --rollback)
    p="$(sed -n 's/^RELEASE_SHA=//p' .deploy-state/previous-release)"
    [ -n "\${STUB_ROLLBACK_FAIL:-}" ] && exit 1
    echo "$p" > "$st/running-proovra-api"; bump proovra-api; echo "$p" > "$st/running-proovra-worker"; bump proovra-worker; exit 0 ;;
esac
case "\${STUB_DEPLOY:-ok}" in
  ok) echo "$RELEASE_SHA" > "$st/running-proovra-worker"; bump proovra-worker; echo "$RELEASE_SHA" > "$st/running-proovra-api"; bump proovra-api; exit 0 ;;
  schema-gate) echo "ERROR: the database does not meet the schema requirements. Nothing was restarted."; exit 1 ;;
  api-unhealthy) echo "$RELEASE_SHA" > "$st/running-proovra-worker"; bump proovra-worker; echo "$RELEASE_SHA" > "$st/running-proovra-api"; bump proovra-api; echo "ERROR: proovra-api did not become healthy"; exit 1 ;;
  silent-wrong) echo "$RELEASE_SHA" > "$st/running-proovra-worker"; bump proovra-worker; bump proovra-api; exit 0 ;;
esac
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function stubWorld({ running = OLD, env = {} as Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "host-release-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const app = join(root, "app");
  for (const d of [bin, state, join(app, "scripts")]) mkdirSync(d, { recursive: true });
  const put = (p: string, body: string, mode = 0o755) => {
    writeFileSync(p, body.replace(/\r\n/g, "\n"));
    chmodSync(p, mode);
  };
  put(join(bin, "docker"), DOCKER);
  put(join(bin, "git"), GIT);
  put(join(bin, "curl"), CURL);
  put(join(bin, "flock"), FLOCK);
  put(join(app, "scripts", "deploy-prod-pull.sh"), DEPLOY);
  writeFileSync(join(app, ".env"), `DATABASE_URL=${SECRET}\n`);
  writeFileSync(join(state, "running-proovra-api"), running);
  writeFileSync(join(state, "running-proovra-worker"), env.STUB_WORKER_REV ?? running);
  writeFileSync(join(state, "head"), running);
  for (const r of [OLD, NEW, NEWER]) writeFileSync(join(state, `tag-sha-${r.slice(0, 7)}`), r);
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  const run = (args: string[], script = HOST_RELEASE, extraEnv: Record<string, string> = {}) => {
    const r = spawnSync("bash", [script, ...args], {
      cwd: app,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        STUB_LOG: log,
        STUB_STATE: state,
        STUB_HOST_RELEASE: HOST_RELEASE,
        PROOVRA_APP_DIR: app,
        PROOVRA_RELEASE_LOCK: join(root, "release.lock"),
        TMPDIR: root,
        ...env,
        ...extraEnv,
      },
    });
    const out = `${r.stdout}${r.stderr}`;
    const marks = Object.fromEntries(
      out.split("\n").map((l) => /^PROOVRA_RELEASE ([a-z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1], m![2]]),
    );
    return { status: r.status, out, marks, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
  };
  const running_ = () => ({
    api: readFileSync(join(state, "running-proovra-api"), "utf8").trim(),
    worker: readFileSync(join(state, "running-proovra-worker"), "utf8").trim(),
  });
  return { root, app, state, run, running: running_ };
}

describe("host-release.sh release", () => {
  it("records and proves the rollback point, backs up and proves the backup, plans, deploys, then verifies what runs", () => {
    const w = stubWorld();
    const r = w.run(["release", NEW]);
    expect(r.status, r.out).toBe(0);
    expect(r.marks.result).toBe("DEPLOYED");
    expect(r.marks.rollback_point).toBe(OLD);
    expect(r.marks.backup).toMatch(/^proovra-\d{8}T\d{6}Z\.dump$/);
    expect(r.marks.verified_epoch).toBe("5");
    expect(w.running()).toEqual({ api: NEW, worker: NEW });
    expect(readFileSync(join(w.app, ".deploy-state", "previous-release"), "utf8")).toBe(`RELEASE_SHA=${OLD}\nIMAGE_TAG=sha-${OLD.slice(0, 7)}\n`);

    const at = (re: RegExp) => r.calls.findIndex((l) => re.test(l));
    const order = [
      at(new RegExp(`^docker pull -q ghcr.io/owner/proovra-api:sha-${OLD.slice(0, 7)}$`)),
      at(/^git checkout --quiet --detach 4a37298f/),
      at(/pg-backup \/ops\/pg-backup\.sh$/),
      at(/pg-backup -c .*sha256sum -c .*pg_restore --list/),
      at(/^deploy-prod-pull --plan /),
      at(new RegExp(`^deploy-prod-pull  RELEASE_SHA=${NEW} IMAGE_TAG=sha-${NEW.slice(0, 7)} GHCR_OWNER=owner$`)),
      at(/^curl .*\/health$/),
    ];
    for (const i of order) expect(i, r.calls.join("\n")).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.out).not.toContain("SuperSecretPw");
  });

  it("a failed backup changes nothing: no deploy, the checkout is restored", () => {
    const w = stubWorld({ env: { STUB_BACKUP_FAIL: "1" } });
    const r = w.run(["release", NEW]);
    expect(r.status).toBe(10);
    expect(r.marks.result).toBe("REFUSED_BEFORE_CHANGE");
    expect(r.marks.reason).toBe("the database backup failed");
    expect(r.calls.some((l) => l.startsWith("deploy-prod-pull"))).toBe(false);
    expect(readFileSync(join(w.state, "head"), "utf8").trim()).toBe(OLD);
    expect(w.running()).toEqual({ api: OLD, worker: OLD });
  });

  it("a backup that does not verify (checksum / archive) also changes nothing", () => {
    const w = stubWorld({ env: { STUB_PROOF_FAIL: "1" } });
    const r = w.run(["release", NEW]);
    expect(r.status).toBe(10);
    expect(r.marks.reason).toMatch(/did not verify/);
    expect(r.calls.some((l) => l.startsWith("deploy-prod-pull"))).toBe(false);
  });

  it("refuses without a usable rollback point: mixed release, unprovable rollback image, a newer running release", () => {
    let w = stubWorld({ env: { STUB_WORKER_REV: NEW } });
    let r = w.run(["release", NEWER], HOST_RELEASE, { STUB_MAIN_POS: "3" });
    expect(r.status).toBe(10);
    expect(r.marks.reason).toMatch(/not one immutable release; no usable rollback point/);
    expect(r.calls.some((l) => / pg-backup /.test(l) || l.startsWith("deploy-prod-pull"))).toBe(false);

    w = stubWorld({ env: { STUB_PULL_FAIL: "1" } });
    r = w.run(["release", NEW]);
    expect(r.status).toBe(10);
    expect(r.marks.reason).toMatch(/rollback image .* cannot be pulled/);

    w = stubWorld({ running: NEWER });
    r = w.run(["release", NEW], HOST_RELEASE, { STUB_MAIN_POS: "3" });
    expect(r.status).toBe(10);
    expect(r.marks.reason).toMatch(/not an ancestor .* never deploy over a newer or diverged release/);
  });

  // 2026-11-24, first automatic release: the prod compose file does not parse
  // without GHCR_OWNER/IMAGE_TAG, the error was swallowed, and the live release
  // read as "none". The stub compose now refuses exactly like the real one.
  it("reads the live release although no release variables are exported yet (prod compose interpolation)", () => {
    const w = stubWorld();
    const r = w.run(["release", NEW], HOST_RELEASE, { GHCR_OWNER: "", IMAGE_TAG: "", RELEASE_SHA: "" });
    expect(r.status, r.out).toBe(0);
    expect(r.marks.running_api).toBe(OLD);
    expect(r.marks.running_worker).toBe(OLD);
    expect(r.out).not.toMatch(/WARN\[0000\].*(revision|image=)/);
  });

  it("containers that cannot be listed are 'unreadable' and refused, never read as 'none'", () => {
    const w = stubWorld({ env: { STUB_PS_FAIL: "1" } });
    const r = w.run(["release", NEW]);
    expect(r.status).toBe(10);
    expect(r.marks.running_api).toBe("unreadable");
    expect(r.out).toMatch(/compose ps: Cannot connect to the Docker daemon/);
    expect(r.calls.some((l) => / pg-backup /.test(l) || l.startsWith("deploy-prod-pull"))).toBe(false);
  });

  it("a deploy refused by its own gates before any restart is REFUSED_BEFORE_CHANGE, never a rollback", () => {
    const w = stubWorld({ env: { STUB_DEPLOY: "schema-gate" } });
    const r = w.run(["release", NEW]);
    expect(r.status).toBe(10);
    expect(r.marks.result).toBe("REFUSED_BEFORE_CHANGE");
    expect(r.calls.some((l) => /deploy-prod-pull --rollback/.test(l))).toBe(false);
  });

  it("a deploy that fails after a service changed is rolled back automatically, API first, and the rollback is verified", () => {
    const w = stubWorld({ env: { STUB_DEPLOY: "api-unhealthy" } });
    const r = w.run(["release", NEW]);
    expect(r.status).toBe(20);
    expect(r.marks.result).toBe("FAILED_ROLLED_BACK");
    expect(r.marks.rolled_back_to).toBe(OLD);
    expect(w.running()).toEqual({ api: OLD, worker: OLD });
    expect(r.calls.some((l) => /^deploy-prod-pull --rollback/.test(l))).toBe(true);
  });

  it("a deploy that 'succeeds' but does not verify (wrong image running) is rolled back too", () => {
    const w = stubWorld({ env: { STUB_DEPLOY: "silent-wrong" } });
    const r = w.run(["release", NEW]);
    expect(r.marks.result).toBe("FAILED_ROLLED_BACK");
    expect(r.out).toMatch(/VERIFY FAIL: proovra-api/);
    expect(r.status).toBe(20);
  });

  it("a rollback that does not verify is reported as needing an operator", () => {
    const w = stubWorld({ env: { STUB_DEPLOY: "api-unhealthy", STUB_ROLLBACK_FAIL: "1" } });
    const r = w.run(["release", NEW]);
    expect(r.status).toBe(30);
    expect(r.marks.result).toBe("FAILED_ROLLBACK_FAILED");
  });

  it("the wrong route epoch on /health is a failed verification", () => {
    const w = stubWorld({ env: { STUB_LIVE_EPOCH: "4" } });
    const r = w.run(["release", NEW]);
    expect(r.out).toMatch(/VERIFY FAIL: \/health .* route-epoch=4 \(want 5\)/);
    expect(r.marks.result).not.toBe("DEPLOYED");
  });

  it("a release that already runs is verified, not redeployed", () => {
    const w = stubWorld({ running: NEW });
    const r = w.run(["release", NEW]);
    expect(r.status).toBe(0);
    expect(r.marks.already_running).toBe("true");
    expect(r.calls.some((l) => l.startsWith("deploy-prod-pull") || / pg-backup /.test(l))).toBe(false);
  });
});

describe("host-release.sh rollback and status", () => {
  it("rolls back only the release named as running, to the recorded point, and verifies it", () => {
    const w = stubWorld({ running: NEW });
    mkdirSync(join(w.app, ".deploy-state"));
    writeFileSync(join(w.app, ".deploy-state", "previous-release"), `RELEASE_SHA=${OLD}\nIMAGE_TAG=sha-${OLD.slice(0, 7)}\n`);
    let r = w.run(["rollback", NEWER]);
    expect(r.status).toBe(40);
    expect(r.marks.result).toBe("ROLLBACK_REFUSED");
    expect(w.running().api).toBe(NEW);
    r = w.run(["rollback", NEW]);
    expect(r.status).toBe(0);
    expect(r.marks.result).toBe("ROLLED_BACK");
    expect(w.running()).toEqual({ api: OLD, worker: OLD });
  });

  it("status reports what runs and the recorded rollback point, read-only", () => {
    const w = stubWorld({ running: NEW });
    const r = w.run(["status"]);
    expect(r.status).toBe(0);
    expect(r.marks.revision_api).toBe(NEW);
    expect(r.marks.revision_worker).toBe(NEW);
    expect(r.marks.previous_release).toBe("none");
    expect(r.calls.some((l) => l.startsWith("deploy-prod-pull") || /git checkout/.test(l))).toBe(false);
  });
});

describe("proovra-release-entry.sh (the forced command)", () => {
  it("accepts only status / release <sha> / rollback <sha>, and nothing else reaches git or docker", () => {
    const w = stubWorld();
    for (const req of ["bash -i", "release", "release HEAD", `release ${NEW} extra`, "rm -rf /", "status now"]) {
      const r = w.run([], ENTRY, { SSH_ORIGINAL_COMMAND: req });
      expect(r.status, req).toBe(64);
      expect(r.calls, req).toEqual([]);
    }
  });

  it("refuses a commit that is not on origin/main, after the lock and a fetch", () => {
    const w = stubWorld();
    const r = w.run([], ENTRY, { SSH_ORIGINAL_COMMAND: `release ${NEWER}`, STUB_MAIN_POS: "2" });
    expect(r.status).toBe(10);
    expect(r.marks.reason).toMatch(/is not a commit on origin\/main/);
    expect(r.calls[0]).toMatch(/^flock -w 1800 9$/);
    expect(r.calls.some((l) => l.startsWith("deploy-prod-pull"))).toBe(false);
  });

  it("a held lock is LOCKED, and changes nothing", () => {
    const w = stubWorld();
    const r = w.run([], ENTRY, { SSH_ORIGINAL_COMMAND: `release ${NEW}`, STUB_FLOCK_RC: "1" });
    expect(r.status).toBe(75);
    expect(r.marks.result).toBe("LOCKED");
    expect(r.calls).toEqual(["flock -w 1800 9"]);
  });

  it("runs host-release.sh taken from the release commit itself", () => {
    const w = stubWorld();
    const r = w.run([], ENTRY, { SSH_ORIGINAL_COMMAND: `release ${NEW}` });
    expect(r.status, r.out).toBe(0);
    expect(r.marks.result).toBe("DEPLOYED");
    expect(r.calls).toContain(`git show ${NEW}:scripts/release/host-release.sh`);
    expect(existsSync(join(w.root, "release.lock"))).toBe(true);
  });
});
