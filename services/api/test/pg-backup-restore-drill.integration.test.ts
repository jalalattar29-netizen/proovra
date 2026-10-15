/**
 * AUD-023 — the repository's PostgreSQL backup and restore drill
 * (scripts/ops/pg-backup.sh, scripts/ops/pg-restore-drill.sh), executed for
 * real against disposable PostgreSQL 16 containers.
 *
 * The repository had no backup mechanism at all; the DR runbook could only say
 * "assumed / managed platform". These scripts make a snapshot-consistent
 * pg_dump with a SHA-256, per-table row counts and a schema fingerprint, and the
 * drill restores it into a fresh database on a DIFFERENT, disposable server and
 * requires every fact to match exactly.
 *
 * Proven here, each through the real scripts in the real PostgreSQL client
 * image (no host tooling):
 *   - backup + drill PASS on a database with tables, an index, a foreign key,
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

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = randomUUID().slice(0, 8);
const NET = `aud023-drill-net-${RUN}`;
const SRC = `aud023-drill-src-${RUN}`;
const DST = `aud023-drill-dst-${RUN}`;
const IMAGE = "pgvector/pgvector:pg16";
const OPS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const SRC_URL = `postgresql://drill:drill-pass@${SRC}:5432/proovra`;
const DST_ADMIN_URL = `postgresql://drill:drill-pass@${DST}:5432/postgres`;

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Run one of the ops scripts in the PostgreSQL client image, on the drill network. */
function runScript(script: string, env: Record<string, string>, backups: string) {
  const res = spawnSync(
    "docker",
    [
      "run", "--rm", "--network", NET,
      "-v", `${OPS_DIR}:/ops:ro`,
      "-v", `${backups}:/backups`,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      IMAGE, "bash", `/ops/${script}`,
    ],
    { encoding: "utf8" },
  );
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function psqlSrc(sql: string): string {
  return docker("exec", SRC, "psql", "-U", "drill", "-d", "proovra", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql);
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

describe("AUD-023 — pg-backup.sh + pg-restore-drill.sh against disposable PostgreSQL 16", () => {
  let backups = "";
  let dumpName = "";

  beforeAll(() => {
    backups = mkdtempSync(join(tmpdir(), "aud023-backups-"));
    docker("network", "create", NET);
    for (const name of [SRC, DST]) {
      docker(
        "run", "-d", "--name", name, "--network", NET,
        "-e", "POSTGRES_USER=drill", "-e", "POSTGRES_PASSWORD=drill-pass", "-e", "POSTGRES_DB=proovra",
        IMAGE,
      );
    }
    waitReady(SRC);
    waitReady(DST);
    psqlSrc(`
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

  afterAll(() => {
    for (const name of [SRC, DST]) {
      try {
        docker("rm", "-f", name);
      } catch {
        /* gone */
      }
    }
    try {
      docker("network", "rm", NET);
    } catch {
      /* gone */
    }
    if (backups) rmSync(backups, { recursive: true, force: true });
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
    expect(schema).toMatch(/con\|app\.evidence_team_id_fkey\|FOREIGN KEY \(team_id\) REFERENCES app\.teams\(id\)/);
  }, 180_000);

  it("the drill restores into a fresh database on a disposable server and every fact matches", () => {
    // Writes after the backup must not matter: the drill checks the BACKUP.
    psqlSrc("INSERT INTO app.teams (name) VALUES ('written-after-backup');");
    const res = runScript(
      "pg-restore-drill.sh",
      { BACKUP_FILE: `/backups/${dumpName}`, DRILL_ADMIN_URL: DST_ADMIN_URL, DATABASE_URL: SRC_URL },
      backups,
    );
    expect(res.code, res.out).toBe(0);
    expect(res.out).toMatch(/PASS — .*: checksum, \d+ tables \/ 1241 rows and the schema fingerprint match exactly/);
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

  it("the drill refuses to restore onto the production (source) server", () => {
    const res = runScript(
      "pg-restore-drill.sh",
      {
        BACKUP_FILE: `/backups/${dumpName}`,
        DRILL_ADMIN_URL: `postgresql://drill:drill-pass@${SRC}:5432/postgres`,
        DATABASE_URL: SRC_URL,
      },
      backups,
    );
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/names the same server as DATABASE_URL/);
  }, 60_000);
});
