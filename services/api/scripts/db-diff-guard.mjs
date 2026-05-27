#!/usr/bin/env node
/**
 * Phase 2.7X Stage 2 — Destructive-diff guard.
 *
 * Reads a SQL string from stdin (or from a file passed via `--file`)
 * and refuses to print it if it contains any destructive operation
 * targeting a runtime-protected table from the drift catalog
 * (`protected-runtime-tables.mjs`).
 *
 * Intended workflow:
 *
 *   pnpm exec prisma migrate diff \
 *     --from-config-datasource --to-schema prisma/schema.prisma --script \
 *     | pnpm db:diff-guard
 *
 * If the diff is safe, the guard echoes it to stdout (so it can be
 * piped into a migration file). If unsafe, it prints a refusal to
 * stderr listing every protected destructive op and exits non-zero.
 *
 * This script exists because Phase 2.7X Stage 1 surfaced a class of
 * risk that the per-migration-file `migration-risk-scan` cannot
 * catch alone: ad-hoc diffs computed against the live DB can
 * silently propose DROP TABLE on the 13 drift-catalog tables. The
 * guard inspects the SQL BEFORE it ever lands in a `migration.sql`
 * file.
 *
 * Exit codes:
 *   0  diff is safe; echoed to stdout
 *   1  internal error (no stdin and no --file)
 *   9  destructive op on a protected runtime table — refused
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROTECTED_RUNTIME_TABLES,
  findProtectedDestructiveOps,
} from "./protected-runtime-tables.mjs";

const args = process.argv.slice(2);
const filePathArg = args.find((a) => a.startsWith("--file="));

async function readStdin() {
  return new Promise((res, rej) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => res(buf));
    process.stdin.on("error", rej);
  });
}

async function main() {
  let sql;
  if (filePathArg) {
    const filePath = resolve(process.cwd(), filePathArg.slice("--file=".length));
    try {
      sql = readFileSync(filePath, "utf8");
    } catch (err) {
      process.stderr.write(
        `[db-diff-guard] cannot read --file ${filePath}: ${(err)?.message ?? err}\n`,
      );
      process.exit(1);
    }
  } else if (!process.stdin.isTTY) {
    sql = await readStdin();
  } else {
    process.stderr.write(
      "[db-diff-guard] REFUSED: no SQL on stdin and no --file=<path>.\n" +
        "  Usage:\n" +
        "    cat my-diff.sql | pnpm db:diff-guard\n" +
        "    pnpm db:diff-guard --file=my-diff.sql\n",
    );
    process.exit(1);
  }

  const hits = findProtectedDestructiveOps(sql ?? "");
  if (hits.length === 0) {
    process.stdout.write(sql ?? "");
    process.stderr.write(
      `\n[db-diff-guard] OK — no destructive ops detected against\n` +
        `  any of the ${PROTECTED_RUNTIME_TABLES.length} runtime-protected tables\n` +
        `  in the drift catalog.\n\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `\n───────────────────────────────────────────────────────────────\n` +
      `  db-diff-guard: REFUSED — destructive op on protected table(s)\n` +
      `───────────────────────────────────────────────────────────────\n` +
      `  ${hits.length} destructive op(s) detected against the drift\n` +
      `  catalog (services/api/scripts/protected-runtime-tables.mjs).\n` +
      `  Each of these tables is referenced by runtime code paths\n` +
      `  (worker, API, frontend) — dropping any of them would break\n` +
      `  production even though they're missing from schema.prisma.\n\n`,
  );
  for (const h of hits) {
    process.stderr.write(`    ${h.op} on "${h.table}":\n`);
    process.stderr.write(`      ${h.line.slice(0, 100)}\n`);
  }
  process.stderr.write(
    `\n  How to proceed safely:\n` +
      `    1. If your intent was Stage 1-style additive work, FILTER\n` +
      `       the diff to remove these destructive lines and save the\n` +
      `       result as a migration.\n` +
      `    2. If you really intend to remove a protected table, you\n` +
      `       must FIRST: (a) remove its consumers from the runtime\n` +
      `       (worker/API/frontend), (b) remove it from\n` +
      `       \`runtime/schema-validation.ts\`, (c) remove it from\n` +
      `       \`protected-runtime-tables.mjs\`, then (d) write the\n` +
      `       DROP migration as a separate explicit change.\n` +
      `    3. See docs/operations/MIGRATION_DISCIPLINE.md and the\n` +
      `       Phase 2.7X Stage 2 readiness doc.\n\n`,
  );
  process.exit(9);
}

main().catch((err) => {
  process.stderr.write(`[db-diff-guard] internal error: ${err?.message ?? err}\n`);
  process.exit(1);
});
