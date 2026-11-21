/**
 * scripts/ops/pg-restore-drill-smoke.sh — the restore drill with an isolated,
 * authenticated API smoke (OPS closure 2, 2026-11-21), EXECUTED with a stub
 * `docker` on PATH so every decision it makes is observable without a daemon.
 *
 * The real end-to-end run (real PostgreSQL 17, Redis, MinIO and API image,
 * synthetic sign-in) is recorded in the closure output; these cases prove the
 * refusals and the cleanup boundary, which a successful run cannot show.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "..", "..", "..", "scripts", "ops", "pg-restore-drill-smoke.sh");
const PROD_URL = "postgresql://prod-user:SuperSecretPw@ep-prod.neon.tech:5432/proovra";

const DOCKER_STUB = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
st="$STUB_STATE"
args="$*"
case "$args" in
  "network create "*|"volume create "*) echo id; exit 0 ;;
  "run -d "*)
    for a in "$@"; do case "$a" in DATABASE_URL=*) printf '%s\\n' "$a" > "$st/api-env" ;; esac; done
    echo cid; exit 0 ;;
  "exec "*" pg_isready "*) exit 0 ;;
  "run --rm "*"pg-restore-drill.sh"*)
    [ "\${STUB_RESTORE_RC:-0}" = 0 ] || { echo "pg-restore-drill: FAILED — checksum mismatch"; exit 1; }
    echo "pg-restore-drill: DRILL_KEEP=1 — the restored database is kept as proovra_restore_drill_20261121000000_7"
    echo "pg-restore-drill: PASS — x"; exit 0 ;;
  "run --rm --network none "*"ls -1 /b") printf 'proovra-20261121T090000Z.dump\\nproovra-20261121T151057Z.dump\\nproovra-20261121T151057Z.dump.sha256\\n'; exit 0 ;;
  "run --rm --network none "*"wc -c < /b/"*) echo 1072479030; exit 0 ;;
  "run --rm "*) exit 0 ;;
  "inspect --format {{range .Config.Env}}"*)
    if [ -n "\${STUB_API_DB_URL:-}" ]; then echo "DATABASE_URL=$STUB_API_DB_URL"; else cat "$st/api-env"; fi; exit 0 ;;
  "inspect --format {{.State.Running}} "*) echo true; exit 0 ;;
  "exec -e P="*) printf 'scrypt$16384$8$1$%s$%s' 0123456789abcdef0123456789abcdef 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; exit 0 ;;
  "exec -i -e SMOKE_EMAIL="*) cat >/dev/null; echo "PASS GET /health 200"; exit "\${STUB_SMOKE_RC:-0}" ;;
  "exec -i "*" psql "*) cat >/dev/null; echo 9b2f8a3e-0000-4000-8000-000000000001; exit 0 ;;
  "exec "*" node -e "*) exit 0 ;;
  "logs "*) exit 0 ;;
  "ps -a --filter "*) printf '%s\\n' \${STUB_CONTAINERS:-}; exit 0 ;;
  "volume ls --filter "*) printf '%s\\n' \${STUB_VOLUMES:-}; exit 0 ;;
  "network ls --filter "*) printf '%s\\n' \${STUB_NETWORKS:-}; exit 0 ;;
  "rm -f -v "*|"volume rm "*|"network rm "*) exit 0 ;;
esac
echo "unexpected docker call: $args" >&2; exit 99
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function run(args: string[], env: Record<string, string | undefined>) {
  const root = mkdtempSync(join(tmpdir(), "drill-smoke-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const backups = join(root, "backups");
  for (const d of [bin, state, backups]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "docker"), DOCKER_STUB.replace(/\r\n/g, "\n"));
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(backups, "proovra-20261121T151057Z.dump"), "dump-bytes");
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      HOME: process.env.HOME ?? root,
      SYSTEMROOT: process.env.SYSTEMROOT,
      STUB_LOG: log,
      STUB_STATE: state,
      BACKUP_FILE: join(backups, "proovra-20261121T151057Z.dump").replace(/\\/g, "/"),
      DRILL_DISK_CHECK_PATH: root.replace(/\\/g, "/"),
      DRILL_FREE_MARGIN_MB: "0",
      API_IMAGE: "ghcr.io/owner/proovra-api:sha-75d078e",
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

describe("pg-restore-drill-smoke.sh", () => {
  it("a full run: internal network, bounded containers, no env file, no published port, the API given only the drill database, then its own cleanup", () => {
    const r = run([], {});
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/PASS — proovra-20261121T151057Z\.dump restored/);
    const network = r.calls.find((c) => c.startsWith("docker network create"))!;
    expect(network).toMatch(/^docker network create --internal --label proovra\.drill2=1 --label proovra\.drill2\.run=\S+ proovra-drill2-net-\S+$/);
    const runs = r.calls.filter((c) => c.startsWith("docker run "));
    expect(runs.length).toBeGreaterThanOrEqual(5);
    for (const c of runs) {
      expect(c).toMatch(/--network proovra-drill2-net-/);
      expect(c).not.toMatch(/--env-file|(^| )-p |--publish|--network host/);
    }
    for (const c of runs.filter((x) => x.startsWith("docker run -d "))) expect(c).toMatch(/--memory \d+m .*|--memory \d+m$/);
    const api = runs.find((c) => c.includes("ghcr.io/owner/proovra-api"))!;
    expect(api).toMatch(/PROOVRA_TEST_STACK=1/);
    expect(api).toMatch(/EMAIL_TRANSPORT=recording/);
    expect(api).toMatch(/DATABASE_URL=postgresql:\/\/restore:[0-9a-f]{32}@proovra-drill2-pg-\S+:5432\/proovra_restore_drill_20261121000000_7 /);
    // Cleanup: only this run's resources, by label and prefix.
    expect(r.calls.some((c) => /^docker ps -a --filter label=proovra\.drill2=1 --filter label=proovra\.drill2\.run=\S+ /.test(c))).toBe(true);
    expect(r.out).not.toMatch(/[0-9a-f]{32}/);
  });

  it("a backups directory this user cannot read (root-only in production) is listed and sized through a no-network container", () => {
    const r = run([], { BACKUP_FILE: "", BACKUP_DIR: "/opt/proovra/backups/postgres", DRILL_FREE_MARGIN_MB: "0" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/dump proovra-20261121T151057Z\.dump \(1022 MB\)/);
    const helpers = r.calls.filter((c) => c.startsWith("docker run --rm --network none "));
    expect(helpers).toHaveLength(2);
    for (const c of helpers) expect(c).toMatch(/-v \/opt\/proovra\/backups\/postgres:\/b:ro /);
    const restore = r.calls.find((c) => c.includes("pg-restore-drill.sh"))!;
    expect(restore).toMatch(/-v \/opt\/proovra\/backups\/postgres:\/backups:ro .*BACKUP_FILE=\/backups\/proovra-20261121T151057Z\.dump/);
  });

  it("refuses when this shell's DATABASE_URL names another server, before any container starts", () => {
    const r = run([], { DATABASE_URL: PROD_URL });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/refusing: DATABASE_URL is set in this shell and names another server/);
    expect(r.out).not.toContain("SuperSecretPw");
    expect(r.calls.filter((c) => /^docker (run|network create|volume create)/.test(c))).toEqual([]);
  });

  it("refuses DIRECT_URL the same way", () => {
    const r = run([], { DIRECT_URL: PROD_URL });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/refusing: DIRECT_URL is set in this shell/);
    expect(r.calls.filter((c) => c.startsWith("docker run"))).toEqual([]);
  });

  it("refuses, and removes what it made, when the API container's DATABASE_URL is not the drill container", () => {
    const r = run([], { STUB_API_DB_URL: PROD_URL, STUB_CONTAINERS: "proovra-drill2-api-x" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/refusing: the API's DATABASE_URL does not name this run's drill container/);
    expect(r.out).not.toContain("SuperSecretPw");
    expect(r.calls.some((c) => c.startsWith("docker exec -i -e SMOKE_EMAIL="))).toBe(false);
    expect(r.calls).toContain("docker rm -f -v proovra-drill2-api-x");
  });

  it("a failed restore stops before the API starts", () => {
    const r = run([], { STUB_RESTORE_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/FAILED — the restore drill failed/);
    expect(r.calls.some((c) => c.includes("proovra-api:sha-75d078e"))).toBe(false);
  });

  it("a failed smoke check fails the run", () => {
    const r = run([], { STUB_SMOKE_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/FAILED — the authenticated smoke did not pass/);
  });

  it("refuses without API_IMAGE, with a prefix that is not proovra-drill*, and with too little disk", () => {
    expect(run([], { API_IMAGE: "" }).out).toMatch(/API_IMAGE is required/);
    expect(run([], { DRILL_PREFIX: "proovra-" }).out).toMatch(/DRILL_PREFIX must start with 'proovra-drill'/);
    const disk = run([], { DRILL_FREE_MARGIN_MB: "999999999" });
    expect(disk.status).not.toBe(0);
    expect(disk.out).toMatch(/insufficient disk space/);
    expect(disk.calls.filter((c) => c.startsWith("docker run"))).toEqual([]);
  });

  it("cleanup removes only resources named with the prefix (and labelled), never anything else", () => {
    const r = run(["cleanup"], {
      STUB_CONTAINERS: "proovra-drill2-pg-1 proovra-api-1 proovra-drill2-api-1",
      STUB_VOLUMES: "proovra-drill2-pgdata-1 docker_redis_data",
      STUB_NETWORKS: "proovra-drill2-net-1 docker_default",
    });
    expect(r.status, r.out).toBe(0);
    const removals = r.calls.filter((c) => /^docker (rm|volume rm|network rm) /.test(c));
    expect(removals).toEqual([
      "docker rm -f -v proovra-drill2-pg-1",
      "docker rm -f -v proovra-drill2-api-1",
      "docker volume rm proovra-drill2-pgdata-1",
      "docker network rm proovra-drill2-net-1",
    ]);
    expect(r.calls.filter((c) => c.startsWith("docker ps -a")).every((c) => c.includes("--filter label=proovra.drill2=1"))).toBe(true);
  });
});
