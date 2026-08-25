/**
 * STEP 8 — run the REAL `recordIncident` against the production-hybrid schema.
 *
 * A local experiment, not product code and not an operator tool: it WRITES, so
 * it may only ever be pointed at a disposable database. It refuses anything
 * that is not an explicitly local host, because the whole point of the probe
 * next to it is that nothing in this investigation touches production.
 *
 * What it establishes, which a synthetic error cannot:
 *   1. whether the writer's INSERT succeeds or fails against the hybrid, and
 *      with exactly which Prisma code and PostgreSQL SQLSTATE;
 *   2. if it succeeds, whether the SECOND call deduplicates — because the live
 *      unique index is on the LEGACY pair, and a unique index cannot
 *      deduplicate writes made to columns it does not cover.
 *
 * The second question is the one that matters most and the one a schema
 * comparison cannot answer. A workspace whose dedupe silently stopped working
 * does not look broken; it looks busy.
 */
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd().replace(/[\\/]+$/, "")}/index.js`);

const url = process.env.DATABASE_URL ?? "";
if (!/(^|@)(127\.0\.0\.1|localhost|host\.docker\.internal)[:/]/.test(url)) {
  console.error("REFUSED: this experiment WRITES. Point it at a local disposable database only.");
  process.exit(2);
}

const WS = process.env.HYBRID_WORKSPACE_ID;
if (!WS) {
  console.error("REFUSED: set HYBRID_WORKSPACE_ID.");
  process.exit(2);
}

const { PrismaClient } = require("@prisma/client");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

function describe(err) {
  const msg = String(err?.message ?? err).replace(/\s+/g, " ");
  const sql =
    msg.match(/Code:\s*`([0-9A-Za-z]{5})`/)?.[1] ??
    (typeof err?.code === "string" && !/^P\d{4}$/.test(err.code) ? err.code : null);
  return {
    prismaCode: /^P\d{4}$/.test(String(err?.code)) ? err.code : null,
    sqlState: sql,
    message: msg.slice(0, 500),
  };
}

const FINGERPRINT = `hybrid:experiment:${WS}`;

async function count() {
  const r = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "operational_incidents" WHERE "fingerprint" = $1`,
    FINGERPRINT,
  );
  return r[0].n;
}

const { recordIncident } = await import("../dist/services/observability/incident.service.js").catch(
  () => import("../src/services/observability/incident.service.js"),
);

console.log("=".repeat(78));
console.log("REAL recordIncident AGAINST THE PRODUCTION-HYBRID SCHEMA");
console.log("=".repeat(78));

for (const attempt of [1, 2]) {
  try {
    const res = await recordIncident(
      {
        teamId: WS,
        category: "REPORT",
        severity: "HIGH",
        fingerprint: FINGERPRINT,
        title: "hybrid experiment",
        safeSummary: "run the real writer against the hybrid schema",
      },
      prisma,
    );
    console.log(`attempt ${attempt}: SUCCEEDED  created=${res.created}  id=${res.incident.id}`);
  } catch (err) {
    const d = describe(err);
    console.log(`attempt ${attempt}: FAILED`);
    console.log(`   prisma code : ${d.prismaCode ?? "-"}`);
    console.log(`   pg SQLSTATE : ${d.sqlState ?? "-"}`);
    console.log(`   message     : ${d.message}`);
  }
}

const n = await count();
console.log("");
console.log(`rows for this fingerprint after TWO calls: ${n}`);
if (n > 1) {
  console.log("");
  console.log("DEDUPLICATION IS DEFEATED.");
  console.log("Two calls for ONE condition produced two rows. The live unique index is on the");
  console.log('LEGACY pair ("teamId", fingerprint); Prisma writes team_id, leaving "teamId" NULL,');
  console.log("and PostgreSQL treats NULLs as DISTINCT — so the constraint excludes nothing and");
  console.log("every re-observation opens a NEW condition instead of ticking occurrenceCount.");
}

// Which family did the write populate? Asked only while BOTH exist — after
// convergence the legacy half is gone and the question is meaningless, so the
// script must not fail on its own success.
const stillHybrid = await prisma.$queryRawUnsafe(
  `SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='operational_incidents'
      AND column_name IN ('teamId','safeSummary')`,
);
if (stillHybrid[0].n > 0) {
  const shape = await prisma.$queryRawUnsafe(
    `SELECT "team_id" IS NOT NULL AS canonical_team,
            "teamId"  IS NOT NULL AS legacy_team,
            "safe_summary" IS NOT NULL AS canonical_summary,
            "safeSummary"  IS NOT NULL AS legacy_summary
       FROM "operational_incidents" WHERE "fingerprint" = $1 LIMIT 1`,
    FINGERPRINT,
  );
  console.log("");
  console.log("which family did the writer populate?", JSON.stringify(shape[0] ?? {}));
} else {
  console.log("");
  console.log("schema is CONVERGED — only the canonical family exists.");
}

await prisma.$disconnect();
await pool.end();
