/**
 * P10-g — the admin E2E shard count is one value, and it is conserved.
 *
 * The count lives in four places in playwright-e2e.yml (the matrix rows, the
 * `--shard=N/M` argument, the step name, the accounting call) and in the
 * accounting script's default. The script's prose and default said four
 * while the workflow ran five. And a matrix value once computed with an
 * addition inside `${{ }}` — which GitHub does not support — stopped the
 * workflow parsing, so no shard ran. These cases hold all of it together.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WF_DIR = resolve(REPO, ".github", "workflows");
const E2E = readFileSync(resolve(WF_DIR, "playwright-e2e.yml"), "utf8");
const ACCOUNTING = readFileSync(resolve(REPO, "scripts", "admin-shard-accounting.mjs"), "utf8");

function adminJob() {
  const start = E2E.indexOf("\n  admin-control-plane:\n");
  const end = E2E.indexOf("\n  admin-control-plane-accounting:\n");
  assert.ok(start > 0 && end > start, "admin jobs present");
  return E2E.slice(start, end);
}

test("the matrix rows, --shard, step name, accounting call and script default agree", () => {
  const job = adminJob();
  const rows = [...job.matchAll(/^\s+- shard: (\d+)$/gm)].map((m) => Number(m[1]));
  const n = rows.length;
  assert.deepEqual(rows, Array.from({ length: n }, (_, i) => i + 1), "shards are 1..N");
  assert.match(job, new RegExp(`--shard=\\$\\{\\{ matrix\\.shard \\}\\}/${n}\\b`));
  assert.match(job, new RegExp(`\\(shard \\$\\{\\{ matrix\\.shard \\}\\}/${n}\\)`));
  const call = /node scripts\/admin-shard-accounting\.mjs shard-reports (\d+) (\d+)/.exec(E2E);
  assert.ok(call, "accounting call present");
  assert.equal(Number(call[2]), n, "accounting shard count");
  assert.match(ACCOUNTING, new RegExp(`const SHARDS = Number\\(shardsRaw \\?\\? ${n}\\);`));
  assert.doesNotMatch(ACCOUNTING, /\b(four|FOUR) (admin )?shards\b/);
});

test("every shard row has its own ports, database, redis and build directory", () => {
  const job = adminJob();
  for (const key of ["api_port", "web_port", "pg_port", "redis_port", "db_name", "dist"]) {
    const values = [...job.matchAll(new RegExp(`^\\s+${key}: (\\S+)$`, "gm"))].map((m) => m[1]);
    assert.equal(new Set(values).size, values.length, `${key} values are unique: ${values.join(", ")}`);
    assert.ok(values.length >= 2, `${key} is set per row`);
  }
});

test("no workflow computes inside an expression", () => {
  for (const name of readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(resolve(WF_DIR, name), "utf8");
    const arithmetic = [...text.matchAll(/\$\{\{([^}]*)\}\}/g)]
      .map((m) => m[1])
      .filter((expr) => /[^=!<>]\s[+*/]\s|\s-\s\d/.test(expr));
    assert.deepEqual(arithmetic, [], `${name}: arithmetic in \${{ }}`);
  }
});
