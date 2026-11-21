/**
 * AUD-023 — the repository's PostgreSQL backup and restore drill
 * (scripts/ops/pg-backup.sh, scripts/ops/pg-restore-drill.sh), executed for
 * real, at the PRODUCTION major version. Production runs managed PostgreSQL 17
 * (17.12, 2026-11-21), so the SOURCE is a PostgreSQL 17 container this suite
 * starts and fills with the fully migrated schema copied from the canonical
 * integration database (`acquireIntegrationDatabase`, PostgreSQL 16 here and in
 * CI), and the scripts run in the same pinned pg17 client image the compose
 * `pg-backup` service uses. The drill TARGET is a second, separate PostgreSQL 17
 * container.
 *
 * OPS closure (2026-11-21) — the tracked service used a pg16 image, which cannot
 * dump a PG17 server, and nothing ran it. Also proven here: a client older than
 * the server fails FIRST with both versions named and is recorded as FAILED;
 * the free-space precheck refuses before writing anything (backup and drill);
 * the drill server runs with bounded WAL.
 *
 * The repository had no backup mechanism at all; the DR runbook could only say
 * "assumed / managed platform". These scripts make a snapshot-consistent
 * pg_dump with a SHA-256, per-table row counts and a schema fingerprint, and the
 * drill restores it into a fresh database on a DIFFERENT, disposable server and
 * requires every fact to match exactly.
 *
 * Proven here, each through the real scripts in the real PostgreSQL client
 * image (no host tooling):
 *   - backup + drill PASS on the fully migrated product schema plus a probe
 *     schema with tables, an index, a foreign key,
 *     an extension and an empty table (and a write after the backup that the
 *     drill must NOT see);
 *   - a corrupted dump is refused at the checksum, before any restore;
 *   - a recorded fact that does not match the restore (row count) fails;
 *   - the drill refuses to restore onto the production (source) server.
 *
 * Containers carry unique names and are removed afterwards.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireIntegrationDatabase } from "./integration-harness.js";

const RUN = randomUUID().slice(0, 8);
const NET = `aud023-drill-net-${RUN}`;
const DST = `aud023-drill-dst-${RUN}`;
/** The image the compose `pg-backup` service runs (infra/docker/docker-compose.prod.yml). */
const IMAGE = "pgvector/pgvector:pg17@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd";
/** The image the service used before: a PostgreSQL 16 client. */
const OLD_CLIENT_IMAGE = "pgvector/pgvector:pg16";
const SRC = `ops-drill-src-${RUN}`;
const OPS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const DST_ADMIN_URL = `postgresql://drill:drill-pass@${DST}:5432/postgres`;

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The integration database as the client container reaches it (via the host). */
function fromContainer(url: string): string {
  const u = new URL(url);
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") u.hostname = "host.docker.internal";
  u.search = "";
  return u.toString();
}

/** Run one of the ops scripts in the PostgreSQL client image, on the drill network. */
function runScript(script: string, env: Record<string, string>, backups: string, image: string = IMAGE) {
  return runInClientImage(["bash", `/ops/${script}`], env, backups, image);
}

/** A shell command in the client image, with the same mounts and user as runScript. */
function runInClientImage(command: string[], env: Record<string, string>, backups: string, image: string = IMAGE) {
  const res = spawnSync(
    "docker",
    [
      "run", "--rm", "--network", NET, "--add-host", "host.docker.internal:host-gateway",
      // The scripts write with `umask 077` (a dump is the whole database), so
      // the files belong to whoever ran them. Run as the invoking user, so this
      // suite can read what it wrote; as root, a Linux runner gets EACCES.
      ...(typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`]
        : []),
      "-v", `${OPS_DIR}:/ops:ro`,
      "-v", `${backups}:/backups`,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      image, ...command,
    ],
    { encoding: "utf8" },
  );
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}


function waitReady(name: string) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const r = spawnSync("docker", ["exec", name, "pg_isready", "-U", "drill"], { encoding: "utf8" });
    if (r.status === 0) {
      const q = spawnSync("docker", ["exec", name, "psql", "-U", "drill", "-d", "postgres", "-c", "SELECT 1"], { encoding: "utf8" });
      if (q.status === 0) return;
    }
    if (Date.now() > deadline) throw new Error(`${name} never became ready`);
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
  }
}

describe("AUD-023 — pg-backup.sh + pg-restore-drill.sh against disposable PostgreSQL 17", () => {
  let backups = "";
  let dumpName = "";
  let SRC_URL = "";
  let releaseDb: (() => Promise<void>) | null = null;
  let src: pg.Client | null = null;
  const psqlSrc = async (sql: string) => {
    await src!.query(sql);
  };

  beforeAll(async () => {
    backups = mkdtempSync(join(tmpdir(), "aud023-backups-"));
    const db = await acquireIntegrationDatabase();
    releaseDb = db.release;
    docker("network", "create", NET);
    // The PostgreSQL 17 source, reachable from the host on a random loopback port.
    docker(
      "run", "-d", "--name", SRC, "--network", NET, "-p", "127.0.0.1::5432",
      "-e", "POSTGRES_USER=drill", "-e", "POSTGRES_PASSWORD=drill-pass", "-e", "POSTGRES_DB=proovra",
      IMAGE,
    );
    docker(
      "run", "-d", "--name", DST, "--network", NET,
      "-e", "POSTGRES_USER=drill", "-e", "POSTGRES_PASSWORD=drill-pass", "-e", "POSTGRES_DB=proovra",
      IMAGE,
    );
    waitReady(SRC);
    waitReady(DST);
    // The fully migrated product schema and its rows, copied into the PG17 source
    // with the pg17 client (which can read the PG16 integration database).
    const copied = spawnSync(
      "docker",
      [
        "run", "--rm", "--network", NET, "--add-host", "host.docker.internal:host-gateway",
        "-e", `FROM_URL=${fromContainer(db.url)}`, "-e", `TO_URL=postgresql://drill:drill-pass@${SRC}:5432/proovra`,
        IMAGE, "bash", "-c",
        'set -o pipefail; pg_dump --no-owner --no-privileges "$FROM_URL" | psql -X -q -v ON_ERROR_STOP=1 "$TO_URL" >/dev/null',
      ],
      { encoding: "utf8" },
    );
    expect(copied.status, `${copied.stdout}\n${copied.stderr}`).toBe(0);
    const port = docker("port", SRC, "5432/tcp").split("\n")[0]!.replace(/^.*:/, "");
    SRC_URL = `postgresql://drill:drill-pass@${SRC}:5432/proovra`;
    src = new pg.Client({ connectionString: `postgresql://drill:drill-pass@127.0.0.1:${port}/proovra` });
    await src.connect();
    expect((await src.query("SHOW server_version_num")).rows[0].server_version_num).toMatch(/^17\d{4}$/);
    await psqlSrc(`
      DROP SCHEMA IF EXISTS app CASCADE;
      DROP TABLE IF EXISTS public.empty_table;
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE SCHEMA app;
      CREATE TABLE app.teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE);
      CREATE TABLE app.evidence (
        id bigserial PRIMARY KEY,
        team_id uuid NOT NULL REFERENCES app.teams(id),
        sha256 char(64) NOT NULL,
        embedding vector(3),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX evidence_team_created ON app.evidence (team_id, created_at DESC);
      INSERT INTO app.teams (name) SELECT 'team-' || g FROM generate_series(1, 7) g;
      INSERT INTO app.evidence (team_id, sha256, embedding)
        SELECT t.id, lpad(to_hex(g), 64, '0'), '[1,2,3]'
          FROM generate_series(1, 1234) g
          JOIN LATERAL (SELECT id FROM app.teams ORDER BY name OFFSET (g % 7) LIMIT 1) t ON true;
      CREATE TABLE public.empty_table (id int PRIMARY KEY);
    `);
  }, 240_000);

  afterAll(async () => {
    await src?.query("DROP SCHEMA IF EXISTS app CASCADE; DROP TABLE IF EXISTS public.empty_table;").catch(() => undefined);
    await src?.end().catch(() => undefined);
    await releaseDb?.();
    try {
      docker("rm", "-f", SRC);
    } catch {
      /* gone */
    }
    try {
      docker("rm", "-f", DST);
    } catch {
      /* gone */
    }
    try {
      docker("network", "rm", NET);
    } catch {
      /* gone */
    }
    if (backups) {
      try {
        rmSync(backups, { recursive: true, force: true });
      } catch {
        // A container may have left files this user cannot remove.
        spawnSync("docker", ["run", "--rm", "-v", `${backups}:/b`, "--entrypoint", "sh", IMAGE, "-c", "find /b -mindepth 1 -delete"]);
        rmSync(backups, { recursive: true, force: true });
      }
    }
  });

  it("backup writes a checksummed dump with snapshot-consistent row counts and a schema fingerprint", () => {
    const res = runScript("pg-backup.sh", { DATABASE_URL: SRC_URL, BACKUP_DIR: "/backups" }, backups);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toMatch(/pg-backup: OK \/backups\/proovra-\d{8}T\d{6}Z\.dump/);
    expect(res.out).not.toContain("drill-pass"); // the URL is never printed
    const files = readdirSync(backups).sort();
    dumpName = files.find((f) => f.endsWith(".dump"))!;
    const stem = dumpName.replace(/\.dump$/, "");
    expect(files).toEqual([dumpName, `${dumpName}.sha256`, `${stem}.counts`, `${stem}.schema`].sort());
    const counts = readFileSync(join(backups, `${stem}.counts`), "utf8");
    expect(counts).toContain("app.evidence|1234");
    expect(counts).toContain("app.teams|7");
    expect(counts).toContain("public.empty_table|0");
    const schema = readFileSync(join(backups, `${stem}.schema`), "utf8");
    expect(schema).toMatch(/idx\|app\.evidence_team_created\|CREATE INDEX evidence_team_created/);
    expect(schema).toMatch(/con\|app\.evidence_team_id_fkey\|f\|FOREIGN KEY \(team_id\) REFERENCES app\.teams\(id\)/);
  }, 180_000);

  // OPS closure — the production failure: the tracked image was pg16 and the
  // server is 17. It must fail FIRST, with both versions named, writing nothing.
  it("a PostgreSQL 16 client against the PostgreSQL 17 server fails first, names both versions, and writes nothing", () => {
    const before = readdirSync(backups).sort();
    const res = runScript("pg-backup.sh", { DATABASE_URL: SRC_URL, BACKUP_DIR: "/backups" }, backups, OLD_CLIENT_IMAGE);
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(
      /pg-backup: FAILED — version mismatch — pg_dump client is PostgreSQL 16 and the server is PostgreSQL 17; .*pgvector\/pgvector:pg17/,
    );
    expect(res.out).not.toContain("drill-pass");
    expect(readdirSync(backups).sort()).toEqual(before);
  }, 120_000);

  it("the free-space precheck refuses before anything is written, naming what is free and what is needed", () => {
    const before = readdirSync(backups).sort();
    // A margin no disk can satisfy drives the refusal path; the default margin
    // passed in the first case above (the allowed path).
    const res = runScript(
      "pg-backup.sh",
      { DATABASE_URL: SRC_URL, BACKUP_DIR: "/backups", BACKUP_FREE_MARGIN_MB: "900000000" },
      backups,
    );
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(
      /pg-backup: FAILED — insufficient disk space — \/backups has \d+ MB free and needs \d+ MB \(2 x the newest dump, \d+ MB, \+ 900000000 MB margin\)/,
    );
    expect(readdirSync(backups).sort()).toEqual(before);
  }, 120_000);

  it("the local drill refuses to start without scratch space for the restore", () => {
    const res = runScript(
      "pg-restore-drill-local.sh",
      { BACKUP_FILE: `/backups/${dumpName}`, DRILL_FREE_MARGIN_MB: "900000000" },
      backups,
    );
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/pg-restore-drill-local: FAILED — insufficient disk space — the drill scratch has \d+ MB free/);
    expect(res.out).not.toMatch(/restore OK/);
  }, 120_000);

  it("a pg_dump that cannot report its version fails loudly, before anything is written", () => {
    const before = readdirSync(backups).sort();
    const res = runInClientImage(
      [
        "bash", "-c",
        "mkdir -p /tmp/broken && printf '#!/bin/sh\\nexit 7\\n' > /tmp/broken/pg_dump && chmod +x /tmp/broken/pg_dump && PATH=/tmp/broken:$PATH bash /ops/pg-backup.sh",
      ],
      { DATABASE_URL: SRC_URL, BACKUP_DIR: "/backups" },
      backups,
    );
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/pg-backup: FAILED — could not run 'pg_dump --version' to read the client version/);
    expect(readdirSync(backups).sort()).toEqual(before);
  }, 120_000);

  it("the local drill fails loudly on a dump it cannot size, and leaves no scratch directory behind", () => {
    const res = runInClientImage(
      ["bash", "-c", "bash /ops/pg-restore-drill-local.sh; rc=$?; echo \"left=$(ls -d /tmp/proovra-drill-* 2>/dev/null | wc -l)\"; exit $rc"],
      { BACKUP_FILE: "/backups/does-not-exist.dump" },
      backups,
    );
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/pg-restore-drill-local: FAILED — could not size the dump/);
    expect(res.out).toMatch(/left=0/);
  }, 120_000);

  it("the local drill fails loudly when free space cannot be read, and leaves no scratch directory behind", () => {
    const res = runInClientImage(
      [
        "bash", "-c",
        "mkdir -p /tmp/broken && printf '#!/bin/sh\\nexit 3\\n' > /tmp/broken/df && chmod +x /tmp/broken/df && " +
          "PATH=/tmp/broken:$PATH bash /ops/pg-restore-drill-local.sh; rc=$?; echo \"left=$(ls -d /tmp/proovra-drill-* 2>/dev/null | wc -l)\"; exit $rc",
      ],
      { BACKUP_FILE: `/backups/${dumpName}` },
      backups,
    );
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/pg-restore-drill-local: FAILED — could not read the free space of the drill scratch/);
    expect(res.out).toMatch(/left=0/);
  }, 120_000);

  it("the drill restores into a fresh database on a disposable server and every fact matches", async () => {
    // Writes after the backup must not matter: the drill checks the BACKUP.
    await psqlSrc("INSERT INTO app.teams (name) VALUES ('written-after-backup');");
    const res = runScript(
      "pg-restore-drill.sh",
      { BACKUP_FILE: `/backups/${dumpName}`, DRILL_ADMIN_URL: DST_ADMIN_URL, DATABASE_URL: SRC_URL },
      backups,
    );
    expect(res.code, res.out).toBe(0);
    expect(res.out).toMatch(/PASS — .*: checksum, \d+ tables \/ \d+ rows and the schema fingerprint match exactly/);
    expect(res.out).not.toContain("drill-pass");
    // The drill database was dropped again.
    const left = docker("exec", DST, "psql", "-U", "drill", "-d", "postgres", "-A", "-t", "-c",
      "SELECT count(*) FROM pg_database WHERE datname LIKE 'proovra_restore_drill_%'");
    expect(left).toBe("0");
  }, 180_000);

  it("a corrupted dump is refused at the checksum, before anything is restored", () => {
    const bad = `tampered-${dumpName}`;
    copyFileSync(join(backups, dumpName), join(backups, bad));
    const stem = dumpName.replace(/\.dump$/, "");
    const badStem = bad.replace(/\.dump$/, "");
    copyFileSync(join(backups, `${stem}.counts`), join(backups, `${badStem}.counts`));
    copyFileSync(join(backups, `${stem}.schema`), join(backups, `${badStem}.schema`));
    writeFileSync(
      join(backups, `${bad}.sha256`),
      readFileSync(join(backups, `${dumpName}.sha256`), "utf8").replace(dumpName, bad),
    );
    const bytes = readFileSync(join(backups, bad));
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(join(backups, bad), bytes);
    const res = runScript("pg-restore-drill.sh", { BACKUP_FILE: `/backups/${bad}`, DRILL_ADMIN_URL: DST_ADMIN_URL }, backups);
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/checksum mismatch/);
    expect(res.out).not.toMatch(/restore OK/);
  }, 180_000);

  it("a restore that does not reproduce the recorded row counts fails the drill", () => {
    const stem = dumpName.replace(/\.dump$/, "");
    const countsPath = join(backups, `${stem}.counts`);
    const original = readFileSync(countsPath, "utf8");
    writeFileSync(countsPath, original.replace("app.evidence|1234", "app.evidence|1235"));
    try {
      const res = runScript("pg-restore-drill.sh", { BACKUP_FILE: `/backups/${dumpName}`, DRILL_ADMIN_URL: DST_ADMIN_URL }, backups);
      expect(res.code).not.toBe(0);
      expect(res.out).toMatch(/restored row counts differ/);
    } finally {
      writeFileSync(countsPath, original);
    }
  }, 180_000);

  // OPS-004 — the schedule itself. A script existing is not a backup running, so
  // this drives the same entry point the compose service runs, once.
  describe("the scheduled cycle", () => {
    const CYCLE_RUN = randomUUID().slice(0, 8);
    const BUCKET = `backup-proof-${CYCLE_RUN}`;
    const records = async () =>
      (
        await src!.query(
          `SELECT kind, outcome, backup_stamp, table_count, row_count::text AS row_count, sha256 FROM platform_backup_records ORDER BY recorded_at_utc`,
        )
      ).rows as Array<{ kind: string; outcome: string; backup_stamp: string | null; table_count: number | null; row_count: string | null; sha256: string | null }>;

    function runAws(script: string, env: Record<string, string>, dir: string = backups) {
      const res = spawnSync(
        "docker",
        [
          "run", "--rm", "--add-host", "host.docker.internal:host-gateway",
          // As in runInClientImage: the same user as the drill phase, so the
          // fetch directory it writes can be read and removed by that phase
          // (production runs both phases as root; a Linux runner does not).
          ...(typeof process.getuid === "function" && typeof process.getgid === "function"
            ? ["--user", `${process.getuid()}:${process.getgid()}`, "-e", "HOME=/tmp"]
            : []),
          "-v", `${OPS_DIR}:/ops:ro`, "-v", `${dir}:/backups`,
          "-e", `AWS_ACCESS_KEY_ID=${process.env.S3_ACCESS_KEY}`,
          "-e", `AWS_SECRET_ACCESS_KEY=${process.env.S3_SECRET_KEY}`,
          "-e", "AWS_DEFAULT_REGION=us-east-1",
          "-e", `AWS_ENDPOINT_URL=${fromContainer(process.env.S3_ENDPOINT!).replace(/\/$/, "")}`,
          ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          "--entrypoint", "bash", "amazon/aws-cli:2.17.0", "-c", script,
        ],
        { encoding: "utf8" },
      );
      return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
    }

    it("backs up, restore-tests in its own throwaway server, and records both; Prisma's URL parameters do not break it", async () => {
      await src!.query("DELETE FROM platform_backup_records");
      const res = runScript(
        "pg-backup-cycle.sh",
        { DATABASE_URL: `${SRC_URL}?schema=public&connection_limit=5`, BACKUP_DIR: "/backups", BACKUP_DRILL_EVERY_SECONDS: "0" },
        backups,
      );
      expect(res.code, res.out).toBe(0);
      expect(res.out).toMatch(/pg-backup: OK/);
      expect(res.out).toMatch(/pg-restore-drill: PASS/);
      // The drill server ran with bounded WAL (the production restore used
      // ~5.6 GB of disk with the defaults, ~3.5 GB bounded).
      expect(res.out).toMatch(/pg-restore-drill-local: drill server max_wal_size=256MB min_wal_size=80MB/);
      const rows = await records();
      expect(rows.map((r) => [r.kind, r.outcome])).toEqual([
        ["DATABASE_BACKUP", "SUCCEEDED"],
        ["RESTORE_DRILL", "SUCCEEDED"],
      ]);
      expect(rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(rows[0]!.row_count)).toBeGreaterThanOrEqual(1241);
      expect(rows[1]!.backup_stamp).toBe(rows[0]!.backup_stamp);
    }, 300_000);

    it("a backup that fails exits non-zero, leaves no dump, and is not reported as a success", () => {
      const before = readdirSync(backups).filter((f) => f.endsWith(".dump")).length;
      const res = runScript(
        "pg-backup-cycle.sh",
        { DATABASE_URL: "postgresql://nobody:wrong@host.docker.internal:1/none", BACKUP_DIR: "/backups" },
        backups,
      );
      expect(res.code).not.toBe(0);
      expect(readdirSync(backups).filter((f) => f.endsWith(".dump")).length).toBe(before);
    }, 120_000);

    it("a cycle in an older client image records FAILED, and its output says why", async () => {
      await src!.query("DELETE FROM platform_backup_records");
      const before = readdirSync(backups).filter((f) => f.endsWith(".dump")).length;
      const res = runScript(
        "pg-backup-cycle.sh",
        { DATABASE_URL: SRC_URL, BACKUP_DIR: "/backups", BACKUP_DRILL_EVERY_SECONDS: "0" },
        backups,
        OLD_CLIENT_IMAGE,
      );
      expect(res.code).not.toBe(0);
      expect(res.out).toMatch(/version mismatch — pg_dump client is PostgreSQL 16 and the server is PostgreSQL 17/);
      expect(res.out).not.toMatch(/pg-restore-drill/);
      expect((await records()).map((r) => [r.kind, r.outcome])).toEqual([["DATABASE_BACKUP", "FAILED"]]);
      expect(readdirSync(backups).filter((f) => f.endsWith(".dump")).length).toBe(before);
    }, 120_000);

    it("the off-host copy reaches another store, and its result is recorded on the next cycle", async () => {
      const made = runAws(`aws s3 mb s3://${BUCKET}`, {});
      expect(made.code, made.out).toBe(0);
      const copied = runAws("bash /ops/pg-backup-offhost.sh", { BACKUP_S3_URI: `s3://${BUCKET}/db`, BACKUP_DIR: "/backups" });
      expect(copied.code, copied.out).toBe(0);
      expect(copied.out).toMatch(/pg-backup-offhost: OK/);
      const listed = runAws(`aws s3 ls s3://${BUCKET}/db/`, {});
      expect(listed.out).toMatch(/proovra-\d{8}T\d{6}Z\.dump\s/);
      expect(listed.out).toMatch(/\.dump\.sha256/);

      const res = runScript("pg-backup-cycle.sh", { DATABASE_URL: SRC_URL, BACKUP_DIR: "/backups", BACKUP_DRILL_EVERY_SECONDS: "999999" }, backups);
      expect(res.code, res.out).toBe(0);
      expect((await records()).filter((r) => r.kind === "OFFHOST_COPY").map((r) => r.outcome)).toEqual(["SUCCEEDED"]);
      runAws(`aws s3 rb s3://${BUCKET} --force`, {});
    }, 300_000);

    // OPS closure 2 (2026-11-21) — the off-host copy is verified after upload
    // (all four artifacts, sizes, the checksum file), and the RETRIEVED copy is
    // proven to restore (pg-backup-offhost-verify.sh: fetch, then drill).
    describe("off-host verification", () => {
      const VBUCKET = `backup-verify-${CYCLE_RUN}`;
      const URI = `s3://${VBUCKET}/db`;
      const newestDump = () => readdirSync(backups).filter((f) => /^proovra-\d{8}T\d{6}Z\.dump$/.test(f)).sort().at(-1)!;

      beforeAll(() => {
        const made = runAws(`aws s3 mb s3://${VBUCKET}`, {});
        expect(made.code, made.out).toBe(0);
      });
      afterAll(() => {
        runAws(`aws s3 rb s3://${VBUCKET} --force`, {});
      });

      it("the copy carries the dump, its .sha256, .counts and .schema, and is verified at the destination", () => {
        const copied = runAws("bash /ops/pg-backup-offhost.sh", { BACKUP_S3_URI: URI, BACKUP_DIR: "/backups" });
        expect(copied.code, copied.out).toBe(0);
        expect(copied.out).toMatch(/pg-backup-offhost: OK proovra-\d{8}T\d{6}Z\.dump copied and verified \(4 artifacts, sizes and checksum file match\)/);
        const stem = newestDump().replace(/\.dump$/, "");
        const listed = runAws(`aws s3 ls ${URI}/`, {}).out;
        for (const ext of [".dump", ".dump.sha256", ".counts", ".schema"]) expect(listed).toContain(`${stem}${ext}`);
        expect(listed).not.toMatch(/offhost-status|offhost-verify|last-drill/);
        expect(readFileSync(join(backups, ".offhost-status"), "utf8")).toMatch(/ SUCCEEDED/);
      }, 300_000);

      it("an incomplete local backup is never copied as a success", () => {
        const partial = mkdtempSync(join(tmpdir(), "offhost-partial-"));
        try {
          const name = "proovra-20261121T000000Z.dump";
          writeFileSync(join(partial, name), "not a dump");
          writeFileSync(join(partial, `${name}.sha256`), `0000  ${name}\n`);
          const res = runAws("bash /ops/pg-backup-offhost.sh", { BACKUP_S3_URI: `s3://${VBUCKET}/partial`, BACKUP_DIR: "/backups" }, partial);
          expect(res.code).not.toBe(0);
          expect(res.out).toMatch(/FAILED — the local backup is incomplete: proovra-20261121T000000Z\.counts is missing/);
          expect(readFileSync(join(partial, ".offhost-status"), "utf8")).toMatch(/ FAILED/);
        } finally {
          rmSync(partial, { recursive: true, force: true });
        }
      }, 120_000);

      it("the newest off-host copy is retrieved, matches the uploaded .sha256, the local record and the database record, and restores", async () => {
        const fetched = runAws("bash /ops/pg-backup-offhost-verify.sh fetch", { BACKUP_S3_URI: URI, BACKUP_DIR: "/backups" });
        expect(fetched.code, fetched.out).toBe(0);
        expect(fetched.out).toContain(`newest off-host backup is ${newestDump()}`);
        expect(fetched.out).toMatch(/sha256 of the retrieved dump matches the uploaded \.sha256/);
        expect(fetched.out).toMatch(/sha256 matches the local record/);
        // The record the cycle wrote for this backup (the newest local dump).
        const sha = readFileSync(join(backups, `${newestDump()}.sha256`), "utf8").split(" ")[0]!;
        await src!.query("DELETE FROM platform_backup_records WHERE kind = 'DATABASE_BACKUP' AND sha256 = $1", [sha]);
        await src!.query(
          "INSERT INTO platform_backup_records (kind, outcome, backup_stamp, sha256) VALUES ('DATABASE_BACKUP', 'SUCCEEDED', $1, $2)",
          [newestDump().replace(/^proovra-|\.dump$/g, ""), sha],
        );
        const drilled = runInClientImage(["bash", "/ops/pg-backup-offhost-verify.sh", "drill"], { BACKUP_DIR: "/backups", DATABASE_URL: `${SRC_URL}?schema=public` }, backups);
        expect(drilled.code, drilled.out).toBe(0);
        expect(drilled.out).toMatch(/sha256 matches platform_backup_records/);
        expect(drilled.out).toMatch(/pg-restore-drill: PASS/);
        expect(drilled.out).toMatch(/pg-backup-offhost-verify: PASS — the off-host copy proovra-\d{8}T\d{6}Z\.dump was retrieved/);
        expect(readdirSync(backups)).not.toContain(".offhost-verify");
      }, 300_000);

      it("a tampered off-host dump is refused at the checksum, before any restore", () => {
        const name = newestDump();
        const t = runAws(`head -c 4096 /dev/urandom > /tmp/x && aws s3 cp /tmp/x ${URI}/${name} --only-show-errors`, {});
        expect(t.code, t.out).toBe(0);
        const res = runAws("bash /ops/pg-backup-offhost-verify.sh fetch", { BACKUP_S3_URI: URI, BACKUP_DIR: "/backups" });
        expect(res.code).not.toBe(0);
        expect(res.out).toMatch(/checksum mismatch — the retrieved proovra-.*\.dump hashes to [0-9a-f]{64}, the uploaded \.sha256 says/);
        expect(res.out).not.toMatch(/fetch OK/);
      }, 120_000);

      it("a substituted dump with a matching substituted .sha256 still fails against the local record", () => {
        const name = newestDump();
        const t = runAws(
          `head -c 4096 /dev/urandom > /tmp/${name} && (cd /tmp && sha256sum ${name} > ${name}.sha256) && ` +
            `aws s3 cp /tmp/${name} ${URI}/${name} --only-show-errors && aws s3 cp /tmp/${name}.sha256 ${URI}/${name}.sha256 --only-show-errors`,
          {},
        );
        expect(t.code, t.out).toBe(0);
        const res = runAws("bash /ops/pg-backup-offhost-verify.sh fetch", { BACKUP_S3_URI: URI, BACKUP_DIR: "/backups" });
        expect(res.code).not.toBe(0);
        expect(res.out).toMatch(/matches the uploaded \.sha256/);
        expect(res.out).toMatch(/checksum mismatch — the retrieved proovra-.*\.dump differs from the local record/);
      }, 120_000);

      it("the drill phase refuses to run without a fetch", () => {
        const res = runInClientImage(["bash", "/ops/pg-backup-offhost-verify.sh", "drill"], { BACKUP_DIR: "/backups", VERIFY_DIR: "/backups/.nothing-here" }, backups);
        expect(res.code).not.toBe(0);
        expect(res.out).toMatch(/nothing fetched: run the fetch phase first/);
      }, 60_000);
    });

    it("an off-host copy with no destination reports FAILED, never silence", () => {
      const res = runAws("bash /ops/pg-backup-offhost.sh", { BACKUP_S3_URI: "", BACKUP_DIR: "/backups" });
      expect(res.code).not.toBe(0);
      expect(readFileSync(join(backups, ".offhost-status"), "utf8")).toMatch(/ FAILED/);
    }, 120_000);

    it("a drill that is not due is not run", async () => {
      await src!.query("DELETE FROM platform_backup_records WHERE kind = 'RESTORE_DRILL'");
      const res = runScript("pg-backup-cycle.sh", { DATABASE_URL: SRC_URL, BACKUP_DIR: "/backups", BACKUP_DRILL_EVERY_SECONDS: "999999" }, backups);
      expect(res.code, res.out).toBe(0);
      expect((await records()).some((r) => r.kind === "RESTORE_DRILL")).toBe(false);
    }, 180_000);
  });

  it("the drill refuses to restore onto the production (source) server", () => {
    const res = runScript(
      "pg-restore-drill.sh",
      {
        BACKUP_FILE: `/backups/${dumpName}`,
        DRILL_ADMIN_URL: SRC_URL.replace(/\/[^/]*$/, "/postgres"),
        DATABASE_URL: SRC_URL,
      },
      backups,
    );
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/names the same server as DATABASE_URL/);
  }, 60_000);
});
