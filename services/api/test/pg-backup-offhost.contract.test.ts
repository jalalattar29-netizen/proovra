/**
 * pg-backup-offhost.sh against a destination that REFUSES to overwrite (R2 bucket
 * lock), with a scripted `aws` stand-in on PATH. Production evidence (2026-11-26):
 * `aws s3 sync` re-sent backups that were already there, the bucket refused with
 * ObjectLockedByBucketPolicy, and every hourly run from 2026-11-22 15:23Z was
 * FAILED although the newest backup itself had uploaded.
 *
 * What must hold:
 *   - each artifact is an immutable key: absent → uploaded and read back by SHA-256;
 *     present → never re-sent, its CONTENT verified (size alone is not identity);
 *   - a different object under a key is a CONFLICT: reported, left untouched,
 *     never success; nothing is ever overwritten or deleted remotely;
 *   - the newest backup is verified on its own and its result is the one recorded,
 *     whatever happens to older backups;
 *   - a verified object is not downloaded again on the next run.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const SCRIPT = resolve(REPO, "scripts", "ops", "pg-backup-offhost.sh");

// The stand-in for `aws`: `s3 ls`, `s3 cp <local> s3://…` (refused when the key
// exists, like an R2 bucket lock) and `s3 cp s3://… -`. Anything else is refused
// loudly, so a `sync`, `rm` or `s3api delete-*` would fail the test.
const AWS = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB/calls"
store="$STUB/bucket"
key() { local u="$1"; printf '%s' "\${u#s3://}"; }
case "$1 $2" in
  "s3 ls")
    k="$(key "$3")"; d="$store/$(dirname "$k")"; b="$(basename "$k")"
    for f in "$d/$b"*; do [ -f "$f" ] && printf '2026-11-26 10:00:00 %s %s\\n' "$(wc -c <"$f" | tr -d ' ')" "$(basename "$f")"; done
    exit 0 ;;
  "s3 cp")
    src="$3"; dst="$4"
    if [ "\${src#s3://}" != "$src" ]; then
      f="$store/$(key "$src")"
      [ -f "$f" ] || { echo "download failed: NoSuchKey" >&2; exit 1; }
      cat "$f"; exit 0
    fi
    f="$store/$(key "$dst")"
    if [ -e "$f" ]; then
      echo "upload failed: $src to $dst An error occurred (ObjectLockedByBucketPolicy) when calling the PutObject operation: The object is locked by the bucket policy." >&2
      exit 1
    fi
    mkdir -p "$(dirname "$f")"; cp "$src" "$f"
    if [ -n "\${STUB_CORRUPT:-}" ] && [ "$(basename "$f")" = "$STUB_CORRUPT" ]; then printf 'X' | dd of="$f" bs=1 seek=0 conv=notrunc 2>/dev/null; fi
    exit 0 ;;
  *) echo "stub aws: refused: $*" >&2; exit 97 ;;
esac
`;

const OLD = "20261125T214931Z";
const MID = "20261126T095138Z";
const NEW = "20261126T095447Z";
const PREFIX = "bk/postgres";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function world(stamps = [OLD, MID, NEW]) {
  const root = mkdtempSync(join(tmpdir(), "offhost-"));
  roots.push(root);
  const bin = join(root, "bin");
  const backups = join(root, "backups");
  const stub = join(root, "stub");
  for (const d of [bin, backups, join(stub, "bucket", PREFIX)]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "aws"), AWS);
  chmodSync(join(bin, "aws"), 0o755);
  writeFileSync(join(stub, "calls"), "");
  const files: Record<string, Buffer> = {};
  for (const s of stamps) {
    const dump = randomBytes(4096);
    files[`proovra-${s}.dump`] = dump;
    files[`proovra-${s}.dump.sha256`] = Buffer.from(`${sha(dump)}  proovra-${s}.dump\n`);
    files[`proovra-${s}.counts`] = Buffer.from(`evidence|${s.length}\nusers|3\n`);
    files[`proovra-${s}.schema`] = Buffer.from(`schema-fingerprint-${s}\n`);
  }
  for (const [n, b] of Object.entries(files)) writeFileSync(join(backups, n), b);
  const remote = (name: string) => join(stub, "bucket", PREFIX, name);
  const seedRemote = (name: string, content: Buffer) => writeFileSync(remote(name), content);
  const run = (extra: Record<string, string> = {}) => {
    writeFileSync(join(stub, "calls"), "");
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, STUB: stub, BACKUP_DIR: backups, BACKUP_S3_URI: `s3://${PREFIX}`, ...extra },
    });
    return {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      calls: readFileSync(join(stub, "calls"), "utf8").split("\n").filter(Boolean),
      statusLine: existsSync(join(backups, ".offhost-status")) ? readFileSync(join(backups, ".offhost-status"), "utf8").trim() : "",
    };
  };
  return { root, backups, files, remote, seedRemote, run };
}

const uploads = (calls: string[]) => calls.filter((c) => /^s3 cp (?!s3:\/\/)\S+ s3:\/\//.test(c));
/** The object names the ledger remembers as verified (one "<name> <sha256>" per line). */
const ledgerNames = (backups: string) => {
  const f = join(backups, ".offhost-verified");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0]) : [];
};
const downloads = (calls: string[]) => calls.filter((c) => /^s3 cp s3:\/\/\S+ -/.test(c));

describe("pg-backup-offhost.sh: immutable keys on a bucket that refuses overwrites", () => {
  it("uploads every artifact of every backup, verifies each by SHA-256, records the newest SUCCEEDED, and never syncs or deletes", () => {
    const w = world();
    const r = w.run();
    expect(r.status, r.out).toBe(0);
    expect(r.statusLine).toBe(`${NEW} SUCCEEDED`);
    expect(r.out).toContain(`pg-backup-offhost: OK proovra-${NEW}.dump copied and verified`);
    for (const [name, content] of Object.entries(w.files)) {
      expect(readFileSync(w.remote(name)).equals(content), name).toBe(true);
    }
    expect(uploads(r.calls)).toHaveLength(12);
    expect(downloads(r.calls)).toHaveLength(12); // each object read back once
    expect(r.calls.some((c) => /\b(sync|rm|delete|s3api)\b/.test(c))).toBe(false);
    // The newest backup is handled before any older one.
    const firstUpload = uploads(r.calls)[0]!;
    expect(firstUpload).toContain(`proovra-${NEW}.`);
    expect(r.out).not.toMatch(/ObjectLockedByBucketPolicy/);
  });

  it("a second run re-sends nothing and downloads nothing: verified objects are remembered", () => {
    const w = world();
    expect(w.run().status).toBe(0);
    const again = w.run();
    expect(again.status, again.out).toBe(0);
    expect(again.statusLine).toBe(`${NEW} SUCCEEDED`);
    expect(uploads(again.calls)).toHaveLength(0);
    expect(downloads(again.calls)).toHaveLength(0);
    expect(again.out).not.toMatch(/ObjectLockedByBucketPolicy|CONFLICT|FAILED/);
  });

  it("backups the bucket already holds with identical content (the sync era) are verified by content, not re-sent", () => {
    const w = world();
    for (const s of [OLD, MID]) for (const ext of ["dump", "dump.sha256", "counts", "schema"]) {
      const n = `proovra-${s}.${ext}`;
      w.seedRemote(n, w.files[n]!);
    }
    const r = w.run();
    expect(r.status, r.out).toBe(0);
    expect(r.statusLine).toBe(`${NEW} SUCCEEDED`);
    expect(uploads(r.calls).every((c) => c.includes(`proovra-${NEW}.`))).toBe(true);
    expect(uploads(r.calls)).toHaveLength(4);
    expect(downloads(r.calls)).toHaveLength(12);
    expect(r.out).not.toMatch(/ObjectLockedByBucketPolicy|CONFLICT/);
  });

  it("an OLDER key holding different content (same size) is a CONFLICT: left untouched, reported, and the newest still records SUCCEEDED", () => {
    const w = world();
    const n = `proovra-${OLD}.dump`;
    const other = Buffer.from(w.files[n]!);
    other[0] = other[0]! ^ 0xff;
    w.seedRemote(n, other);
    const r = w.run();
    expect(r.statusLine).toBe(`${NEW} SUCCEEDED`);
    expect(r.out).toContain(`pg-backup-offhost: CONFLICT — ${n} already exists at the destination with different content`);
    expect(r.out).toMatch(/WARNING — 1 older backup\(s\) are not verified/);
    expect(readFileSync(w.remote(n)).equals(other)).toBe(true); // never overwritten
    expect(uploads(r.calls).some((c) => c.includes(`${n} `))).toBe(false);
    expect(readFileSync(join(w.backups, ".offhost-conflicts"), "utf8").trim()).toBe(n);
    // The conflicting object is never remembered as verified.
    expect(ledgerNames(w.backups)).not.toContain(n);
    expect(r.status).toBe(0);
  });

  it("an older key with a different SIZE is a conflict without downloading it", () => {
    const w = world();
    const n = `proovra-${MID}.counts`;
    w.seedRemote(n, Buffer.from("a different, longer counts file\n"));
    const r = w.run();
    expect(r.statusLine).toBe(`${NEW} SUCCEEDED`);
    expect(r.out).toContain(`pg-backup-offhost: CONFLICT — ${n} already exists at the destination with`);
    expect(downloads(r.calls).some((c) => c.includes(n))).toBe(false);
  });

  it("the NEWEST key holding different content makes the run FAILED (a conflict is never success) and is not overwritten", () => {
    const w = world();
    const n = `proovra-${NEW}.dump`;
    const other = Buffer.from(w.files[n]!);
    other[10] = other[10]! ^ 0x01;
    w.seedRemote(n, other);
    const r = w.run();
    expect(r.status).not.toBe(0);
    expect(r.statusLine).toBe(`${NEW} FAILED`);
    expect(r.out).toContain(`pg-backup-offhost: FAILED — proovra-${NEW} is CONFLICT at the destination`);
    expect(readFileSync(w.remote(n)).equals(other)).toBe(true);
    // Older backups are still copied and verified.
    expect(readFileSync(w.remote(`proovra-${OLD}.dump`)).equals(w.files[`proovra-${OLD}.dump`]!)).toBe(true);
  });

  it("an upload that reads back with a different SHA-256 is FAILED and never remembered as verified", () => {
    const w = world([NEW]);
    const n = `proovra-${NEW}.dump`;
    const r = w.run({ STUB_CORRUPT: n });
    expect(r.status).not.toBe(0);
    expect(r.statusLine).toBe(`${NEW} FAILED`);
    expect(r.out).toContain(`pg-backup-offhost: FAILED — ${n} read back with a different SHA-256 after upload`);
    expect(ledgerNames(w.backups)).not.toContain(n);
  });

  it("an incomplete newest backup is FAILED; an unset destination is FAILED; nothing is uploaded in either case", () => {
    const w = world([NEW]);
    rmSync(join(w.backups, `proovra-${NEW}.counts`));
    const r = w.run();
    expect(r.statusLine).toBe(`${NEW} FAILED`);
    expect(r.out).toContain(`the local backup is incomplete: proovra-${NEW}.counts is missing`);
    expect(uploads(r.calls)).toHaveLength(0);

    const v = world([NEW]);
    const u = v.run({ BACKUP_S3_URI: "" });
    expect(u.statusLine).toBe(`${NEW} FAILED`);
    expect(u.out).toContain("BACKUP_S3_URI is not set");
    expect(u.calls).toHaveLength(0);
  });

  it("dotfiles in the backup directory (status, ledger, verify scratch) never reach the bucket", () => {
    const w = world([NEW]);
    mkdirSync(join(w.backups, ".offhost-verify"), { recursive: true });
    writeFileSync(join(w.backups, ".offhost-verify", "proovra-x.dump"), "scratch");
    writeFileSync(join(w.backups, ".last-drill"), "1");
    const r = w.run();
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => /\/\.(offhost|last)/.test(c))).toBe(false);
  });
});
