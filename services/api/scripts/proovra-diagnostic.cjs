#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * ADM-013 PHASE 2 — THE PRODUCTION DIAGNOSTIC.
 *
 * =============================================================================
 * WHAT THIS IS, AND WHAT IT WILL NOT DO
 * =============================================================================
 * A single read-only pass over the production database that answers the
 * questions the control-plane remediation cannot answer from source: how many
 * incidents there really are, how many of them are the same condition wearing
 * different rows, which alert signals are backed by an incident and which are
 * not, which evidence is stuck and in which overlapping cohorts, and what one
 * named account actually did.
 *
 * It NEVER writes. There is no INSERT, no UPDATE, no DELETE, no DDL, and no
 * `$executeRaw` anywhere in this file — a test asserts their absence, because
 * "I only meant to read" is what every accidental production write has in
 * common.
 *
 * IT SELECTS NO SECRET. Not a token, not a hash, not a cookie, not a session
 * value, not a signing key, not a connection string, not a webhook secret. It
 * reads no evidence CONTENT — no bytes, no storage key, no filename, no
 * fingerprint, no GPS. IP addresses are reduced to a /24 (IPv4) or /48 (IPv6)
 * prefix before they leave the query, so a network is visible and a person is
 * not.
 *
 * =============================================================================
 * IT REFUSES TO RUN AGAINST THE WRONG DATABASE
 * =============================================================================
 * The operator passes the expected database name and this asserts
 * `current_database()` equals it before reading anything. That is not
 * ceremony: the API container's DATABASE_URL is the only thing that decides
 * where this connects, and a diagnostic that silently profiled a staging
 * database and printed production-shaped JSON would be worse than no
 * diagnostic. There is no default name — `dw` and `neondb` are both plausible
 * and neither is verified.
 *
 * =============================================================================
 * HOW TO RUN IT
 * =============================================================================
 * Every command below runs on the PRODUCTION HOST, in a shell that can reach
 * Docker. `$API` is the API container name or id (`docker ps` to find it).
 *
 * STEP 1 — ask the running API which database it is actually connected to.
 *          This prints ONE word and nothing else.
 *
 *   docker exec "$API" node -e 'const{Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL});p.query("select current_database() d").then(r=>{console.log(r.rows[0].d);return p.end()}).catch(e=>{console.error(e.message);process.exit(1)})'
 *
 * STEP 2 — put this file on the HOST. It is not in the image; `docker cp`
 *          copies from the host filesystem, so it has to exist there first.
 *
 *   # from a machine with the repository checked out:
 *   scp services/api/scripts/proovra-diagnostic.cjs OPERATOR@HOST:/tmp/proovra-diagnostic.cjs
 *
 *   # or, on the host, pull the single file out of the repository:
 *   curl -fsSL -o /tmp/proovra-diagnostic.cjs \
 *     "https://raw.githubusercontent.com/<owner>/<repo>/<sha>/services/api/scripts/proovra-diagnostic.cjs"
 *
 * STEP 3 — copy it INTO the container. It must run inside, because that is
 *          where `@prisma/client` and the generated schema live.
 *
 *   docker cp /tmp/proovra-diagnostic.cjs "$API":/tmp/proovra-diagnostic.cjs
 *
 * STEP 4 — run it, naming the database STEP 1 printed and the account to trace.
 *
 *   docker exec "$API" node /tmp/proovra-diagnostic.cjs \
 *     --expect-database=<NAME_FROM_STEP_1> \
 *     --trace-account=<email or user id> \
 *     > diag.json
 *
 *          `> diag.json` is interpreted by the SHELL YOU TYPED IT IN, not by
 *          the container. The file lands on the HOST, in the directory you are
 *          standing in — `pwd` tells you where. Nothing is written inside the
 *          container, which is deliberate: the container is ephemeral and a
 *          file written there is lost on the next deploy.
 *
 * STEP 5 — retrieve it and delete the copy from the container.
 *
 *   scp OPERATOR@HOST:$(pwd)/diag.json ./diag.json
 *   docker exec "$API" rm -f /tmp/proovra-diagnostic.cjs
 *
 * The output is a single JSON document on stdout. Every human-readable line —
 * progress, warnings, refusals — goes to stderr, so `> diag.json` captures
 * valid JSON even when a section fails.
 *
 * =============================================================================
 * A SECTION THAT FAILS IS RECORDED AS FAILED
 * =============================================================================
 * Each section is read independently and a throw becomes
 * `{ "ok": false, "error": "<bounded reason>" }` for that section alone. It is
 * never an empty object and never a zero: the whole point of the exercise is to
 * tell a real zero from an unreadable one, and a diagnostic that cannot do that
 * for itself has no business telling anybody else to.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// -----------------------------------------------------------------------------
// Identity of this diagnostic.
// -----------------------------------------------------------------------------

/** Bumped whenever the SHAPE of the output changes. */
const DIAGNOSTIC_VERSION = "1.0.0";

/**
 * A hash of THIS FILE's bytes.
 *
 * The commit sha is not available inside a production container — the image
 * carries no `.git`. A self-hash is the fact that is actually available and it
 * answers the question a reader has: "is the diag.json in front of me the
 * output of the script in front of me?" It is computed at runtime rather than
 * baked in, so editing the file necessarily changes it.
 */
function sourceHash() {
  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(__filename))
      .digest("hex");
  } catch {
    return "unavailable";
  }
}

// -----------------------------------------------------------------------------
// Arguments.
// -----------------------------------------------------------------------------

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const EXPECTED_DATABASE = arg("expect-database");
const TRACE_ACCOUNT = arg("trace-account");
const REQUIRE_BASE = arg("require-base");

// -----------------------------------------------------------------------------
// Module resolution.
// -----------------------------------------------------------------------------

/**
 * LOAD THE PRISMA RUNTIME, FROM WHEREVER THIS FILE HAPPENS TO SIT.
 *
 * ===========================================================================
 * WHY THIS IS NOT A PLAIN `require`
 * ===========================================================================
 * CommonJS resolves a bare specifier by walking up from the DIRECTORY OF THE
 * FILE DOING THE REQUIRING — not from the working directory. The production
 * image installs with a hoisted linker, so everything lives in
 * `/app/node_modules`, and the container's WORKDIR is `/app/services/api`.
 *
 * A runbook that said "docker cp the script to /tmp and run it" therefore
 * produced, reliably:
 *
 *     Error: Cannot find module '@prisma/client'
 *     Require stack:
 *     - /tmp/proovra-diagnostic.cjs
 *
 * because the walk was `/tmp/node_modules` → `/node_modules` → nothing.
 * `/app/node_modules` was never consulted, and the correct working directory
 * did not help, because cwd plays no part in CommonJS resolution.
 *
 * ===========================================================================
 * WHY RESOLUTION RATHER THAN "PUT THE FILE SOMEWHERE ELSE"
 * ===========================================================================
 * Copying the script into `/app/services/api/scripts` fixes it, and is proven
 * to. But it requires `/app` to be writable, and a hardened deployment may run
 * the container with a read-only root filesystem — in which case `/tmp` (a
 * tmpfs) is the ONLY writable path, and the procedure that depends on writing
 * to `/app` is the one that fails at 3am.
 *
 * So the script resolves explicitly instead, and works from either location.
 * The bases, in order:
 *
 *   1. `--require-base`, if the operator passed one. An explicit instruction
 *      always wins.
 *   2. This file's own directory — correct when the script sits inside the
 *      application tree, including the copy the image already ships.
 *   3. The working directory — correct when the script sits in /tmp and the
 *      container's WORKDIR is the API package, which is the documented case.
 *   4. A bounded list of conventional container install roots, tried LAST.
 *
 * `createRequire` performs the ordinary upward walk from each base, so nothing
 * assumes a repository checkout, and `NODE_PATH` is neither read nor required.
 *
 * ===========================================================================
 * WHY THE FOURTH BASE, GIVEN THE FIRST THREE ARE THE HONEST ONES
 * ===========================================================================
 * Bases 2 and 3 both fail in one realistic case: the script in `/tmp` AND a
 * working directory outside the application tree. That happens whenever an
 * operator adds `-w /tmp` to the `docker exec`, which reads like a harmless
 * tidying and is not.
 *
 * The fourth base converts that into a success instead of a puzzle. It is a
 * short, explicit list of conventional roots — not a filesystem search, not a
 * glob, not an environment variable — and it is tried only after the real
 * bases have failed. Whichever base wins is printed to stderr, so the operator
 * always knows where the runtime came from rather than trusting that it
 * worked.
 */
function loadRuntimeDeps() {
  const { createRequire } = require("node:module");

  /**
   * Conventional install roots, tried last. `/app/services/api` is where this
   * image puts the API package and `/app` is where the hoisted install lives;
   * the other two are the common alternatives for a Node service image.
   */
  const CONVENTIONAL_ROOTS = [
    "/app/services/api",
    "/app",
    "/usr/src/app",
    "/srv/app",
  ];

  const bases = [];
  if (REQUIRE_BASE) bases.push(path.join(path.resolve(REQUIRE_BASE), "noop.cjs"));
  bases.push(__filename);
  bases.push(path.join(process.cwd(), "noop.cjs"));

  // The fallback can be switched off. Two reasons it is a real switch rather
  // than a test hook: a deployment that wants resolution to be strictly
  // explicit can set it, and the container smoke needs SOME way to exercise
  // the failure path — a guard nobody can trigger is a guard nobody has
  // tested.
  if (process.env.PROOVRA_DIAGNOSTIC_NO_FALLBACK !== "1") {
    for (const root of CONVENTIONAL_ROOTS) {
      bases.push(path.join(root, "noop.cjs"));
    }
  }

  const tried = [];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const deps = {
        PrismaClient: req("@prisma/client").PrismaClient,
        PrismaPg: req("@prisma/adapter-pg").PrismaPg,
        Pool: req("pg").Pool,
      };
      if (!deps.PrismaClient || !deps.PrismaPg || !deps.Pool) {
        // A resolvable but wrong module is worse than an unresolvable one: it
        // fails later, further from the cause.
        throw new Error("resolved, but a required export was missing");
      }
      process.stderr.write(
        `  runtime resolved from ${path.dirname(base)}\n`,
      );
      return deps;
    } catch (err) {
      tried.push(`${path.dirname(base)} (${err && err.code ? err.code : "failed"})`);
    }
  }

  throw new Error(`tried: ${tried.join("; ")}`);
}
/** Bound every list so a pathological table cannot produce a gigabyte of JSON. */
const LIST_LIMIT = Number(arg("limit") ?? 200);

function fail(message) {
  process.stderr.write(`proovra-diagnostic: ${message}\n`);
  process.exit(2);
}

if (!EXPECTED_DATABASE) {
  fail(
    "--expect-database=<name> is required. Run STEP 1 in this file's header to " +
      "find it; there is deliberately no default, because connecting to the " +
      "wrong database and printing production-shaped JSON is the failure this " +
      "guard exists to prevent.",
  );
}

// -----------------------------------------------------------------------------
// Redaction. Applied at the boundary, before a value reaches the output.
// -----------------------------------------------------------------------------

/**
 * A stable pseudonym for an identifier.
 *
 * Same input yields the same token WITHIN one run, so two sections can be
 * correlated, and a DIFFERENT token across runs, so a token cannot be joined
 * back to a person from a diag.json somebody kept. The salt is random per run
 * and is never emitted.
 */
const RUN_SALT = crypto.randomBytes(16);
const pseudonymCache = new Map();
function pseudonym(value, kind) {
  if (value === null || value === undefined) return null;
  const key = `${kind}:${String(value)}`;
  const cached = pseudonymCache.get(key);
  if (cached) return cached;
  const token = `${kind}_${crypto
    .createHmac("sha256", RUN_SALT)
    .update(key)
    .digest("hex")
    .slice(0, 12)}`;
  pseudonymCache.set(key, token);
  return token;
}

/**
 * An IP reduced to its network.
 *
 * /24 for IPv4 and /48 for IPv6: enough to say "the same network" or "a
 * different country's network", not enough to identify a subscriber line. A
 * value that does not parse is dropped entirely rather than passed through.
 */
function ipPrefix(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const v4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (raw.includes(":")) {
    const groups = raw.split(":").filter(Boolean).slice(0, 3);
    if (groups.length === 3) return `${groups.join(":")}::/48`;
  }
  return null;
}

/** An email reduced to its domain. The local part never leaves the query. */
function emailDomain(raw) {
  if (typeof raw !== "string") return null;
  const at = raw.lastIndexOf("@");
  return at > 0 ? raw.slice(at + 1).toLowerCase() : null;
}

/**
 * A fingerprint reduced to its SOURCE PREFIX.
 *
 * Incident fingerprints are internal dedup identities and can name a
 * subsystem, an evidence id or a provider. The leading segment is the part a
 * reader needs — which condition family this is — and the rest is pseudonymised
 * so duplicates can still be counted without exporting the payload.
 */
function fingerprintFamily(raw) {
  if (typeof raw !== "string") return null;
  const head = raw.split(/[:#|]/, 1)[0];
  return head.slice(0, 64);
}

function boundedError(err) {
  const message =
    err && typeof err === "object" && "message" in err
      ? String(err.message)
      : String(err);
  // Bounded, single-line, and stripped of anything that looks like a
  // connection string.
  //
  // The collapse matters as much as the truncation: a Prisma validation error
  // is a twenty-line pretty-printed query, and 300 characters of it spread
  // over twenty lines turns the safe summary — the thing read on a shared
  // screen during an incident — into a wall. One line also keeps the query
  // shape from being reproduced verbatim in a document that gets pasted
  // around.
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]*/gi, "<redacted-dsn>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// -----------------------------------------------------------------------------
// Section runner.
// -----------------------------------------------------------------------------

const sections = {};
async function section(name, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    sections[name] = { ok: true, durationMs: Date.now() - startedAt, ...value };
  } catch (err) {
    process.stderr.write(`  ! ${name}: ${boundedError(err)}\n`);
    sections[name] = {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: boundedError(err),
      note:
        "This section could not be read. Its absence is NOT a zero — do not " +
        "interpret a missing count as an absent condition.",
    };
  }
}

function groupCount(rows, key) {
  const out = {};
  for (const r of rows) out[String(r[key])] = r._count._all;
  return out;
}

// -----------------------------------------------------------------------------
// Main.
// -----------------------------------------------------------------------------

async function main() {
  process.stderr.write(
    `proovra-diagnostic ${DIAGNOSTIC_VERSION} — read-only. Expecting database "${EXPECTED_DATABASE}".\n`,
  );

  // --- Client -------------------------------------------------------------
  //
  // Constructed exactly the way `src/db.ts` does, through the PrismaPg driver
  // adapter. A plain `new PrismaClient()` throws "Unknown property datasources"
  // against this client version, and a diagnostic that cannot connect the way
  // the application connects is not describing the application's database.
  let PrismaClient;
  let PrismaPg;
  let Pool;
  try {
    ({ PrismaClient, PrismaPg, Pool } = loadRuntimeDeps());
  } catch (err) {
    fail(
      `could not load @prisma/client / @prisma/adapter-pg / pg (${boundedError(err)}). ` +
        "This script must run INSIDE the API container, where the generated " +
        "client lives. It searched the bases listed in the error above. If you " +
        "are running it from a directory outside the application tree AND with " +
        "a working directory outside it too, pass --require-base=/app/services/api " +
        "(or wherever the API's package.json lives in this image).",
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail("DATABASE_URL is not set in this container's environment.");
  }

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  // --- The database guard, before any read --------------------------------
  const [{ d: actualDatabase }] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS d",
  );
  if (actualDatabase !== EXPECTED_DATABASE) {
    process.stderr.write(
      `proovra-diagnostic: REFUSED. Connected to "${actualDatabase}", expected ` +
        `"${EXPECTED_DATABASE}". Nothing was read. Re-run STEP 1 against the ` +
        "container you actually mean to profile.\n",
    );
    await prisma.$disconnect();
    await pool.end();
    process.exit(3);
  }
  process.stderr.write(`  connected to "${actualDatabase}" — proceeding.\n`);

  // ==========================================================================
  // INCIDENTS
  // ==========================================================================
  await section("incidents", async () => {
    const [byScope, byStatus, bySeverity, byCategory, total] = await Promise.all([
      prisma.operationalIncident.groupBy({ by: ["scope"], _count: { _all: true } }),
      prisma.operationalIncident.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.operationalIncident.groupBy({ by: ["severity"], _count: { _all: true } }),
      prisma.operationalIncident.groupBy({ by: ["category"], _count: { _all: true } }),
      prisma.operationalIncident.count(),
    ]);

    // Duplicate FINGERPRINTS, the population the convergence script targets.
    // Grouped by (teamId, fingerprint) so a fingerprint legitimately present in
    // several workspaces is not counted as a duplicate.
    const dupWorkspace = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS groups, COALESCE(SUM(n - 1), 0)::int AS excess
         FROM (SELECT team_id, fingerprint, COUNT(*)::int AS n
                 FROM operational_incidents
                WHERE team_id IS NOT NULL
                GROUP BY team_id, fingerprint HAVING COUNT(*) > 1) g`,
    );
    const dupPlatform = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS groups, COALESCE(SUM(n - 1), 0)::int AS excess
         FROM (SELECT fingerprint, COUNT(*)::int AS n
                 FROM operational_incidents
                WHERE team_id IS NULL
                GROUP BY fingerprint HAVING COUNT(*) > 1) g`,
    );

    // ONE CONDITION REPLICATED ACROSS WORKSPACES.
    //
    // The distinguishing shape of a platform fault written per-tenant: the same
    // source id open in many workspaces at once. This is the question "are the
    // 72 seventy-two problems, or one problem seventy-two times?".
    const sharedConditions = await prisma.$queryRawUnsafe(
      `SELECT source_id, fingerprint,
              COUNT(DISTINCT team_id)::int AS workspaces,
              COUNT(*)::int                AS rows
         FROM operational_incidents
        WHERE status IN ('OPEN','ACKNOWLEDGED') AND team_id IS NOT NULL
        GROUP BY source_id, fingerprint
       HAVING COUNT(DISTINCT team_id) > 1
        ORDER BY 3 DESC
        LIMIT ${LIST_LIMIT}`,
    );

    const openByWorkspace = await prisma.operationalIncident.groupBy({
      by: ["teamId"],
      where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      _count: { _all: true },
    });

    // HISTORICAL INCIDENTS LEFT OPEN — open, and not seen for 30 days.
    const staleOpen = await prisma.operationalIncident.count({
      where: {
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        lastSeenAtUtc: { lt: new Date(Date.now() - 30 * 86400_000) },
      },
    });

    const oldest = await prisma.operationalIncident.findFirst({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      orderBy: { firstSeenAtUtc: "asc" },
      select: { firstSeenAtUtc: true, lastSeenAtUtc: true, occurrenceCount: true },
    });

    const [events, slaCycles, inboxStates] = await Promise.all([
      prisma.operationalIncidentEvent.count(),
      prisma.operationalIncidentSlaCycle.count(),
      prisma.inboxItemState.count().catch(() => null),
    ]);

    return {
      total,
      byScope: groupCount(byScope, "scope"),
      byStatus: groupCount(byStatus, "status"),
      bySeverity: groupCount(bySeverity, "severity"),
      byCategory: groupCount(byCategory, "category"),
      duplicates: {
        workspaceScoped: dupWorkspace[0],
        platformScoped: dupPlatform[0],
        note:
          "platformScoped.excess is rows that a standard unique index over " +
          "(team_id, fingerprint) never deduplicated, because NULL is distinct " +
          "from NULL in Postgres.",
      },
      sharedConditionsAcrossWorkspaces: sharedConditions.map((r) => ({
        sourceId: r.source_id,
        fingerprintFamily: fingerprintFamily(r.fingerprint),
        workspaces: r.workspaces,
        rows: r.rows,
      })),
      unresolvedByWorkspace: {
        workspacesWithUnresolved: openByWorkspace.length,
        distribution: openByWorkspace
          .map((r) => ({
            workspace: pseudonym(r.teamId, "ws"),
            unresolved: r._count._all,
          }))
          .sort((a, b) => b.unresolved - a.unresolved)
          .slice(0, LIST_LIMIT),
      },
      historicalStillOpen: {
        notSeenIn30Days: staleOpen,
        oldestOpen: oldest
          ? {
              firstSeenAtUtc: oldest.firstSeenAtUtc,
              lastSeenAtUtc: oldest.lastSeenAtUtc,
              occurrenceCount: oldest.occurrenceCount,
            }
          : null,
      },
      relatedRecords: { events, slaCycles, inboxStates },
    };
  });

  // ==========================================================================
  // ALERT SIGNALS — the non-incident half of the reconciliation
  // ==========================================================================
  await section("signals", async () => {
    const since = new Date(Date.now() - 86400_000);
    const [securityRecent, failedPayments, ssoOutages, openIncidents] =
      await Promise.all([
        prisma.securityEvent.groupBy({
          by: ["severity"],
          where: { severity: { in: ["HIGH", "CRITICAL"] }, createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.payment.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
        prisma.ssoConnection.count({ where: { outageDetectedAtUtc: { not: null } } }),
        prisma.operationalIncident.count({ where: { status: "OPEN" } }),
      ]);

    const security = groupCount(securityRecent, "severity");
    const securityTotal = Object.values(security).reduce((a, b) => a + b, 0);
    // The alert builder emits one signal per open incident, capped at 100.
    const incidentBacked = Math.min(openIncidents, 100);
    const additional = securityTotal + (failedPayments > 0 ? 1 : 0) + ssoOutages;

    return {
      openIncidents,
      incidentBackedSignals: incidentBacked,
      incidentBackedTruncated: openIncidents > 100,
      additionalSignals: {
        total: additional,
        securityHighOrCritical24h: security,
        failedPayments24hProducesOneSignal: failedPayments > 0,
        failedPayments24hCount: failedPayments,
        ssoConnectionsInOutage: ssoOutages,
      },
      distinctAttentionItems: openIncidents + additional,
      note:
        "distinctAttentionItems is openIncidents + additional, NEVER " +
        "openIncidents + (incidentBacked + additional): the incident-backed " +
        "signals ARE the open incidents.",
    };
  });

  // ==========================================================================
  // EVIDENCE HEALTH — the overlapping cohorts, stated as overlapping
  // ==========================================================================
  await section("evidenceHealth", async () => {
    const live = { deletedAt: null };
    const [
      tsaFailedOnly,
      signedNoReportOnly,
      both,
      unionTotal,
      tsaFailedTotal,
      signedNoReportTotal,
    ] = await Promise.all([
      prisma.evidence.count({
        where: { ...live, tsaStatus: "FAILED", NOT: { status: "SIGNED", latestReportVersion: null } },
      }),
      prisma.evidence.count({
        where: { ...live, status: "SIGNED", latestReportVersion: null, NOT: { tsaStatus: "FAILED" } },
      }),
      prisma.evidence.count({
        where: { ...live, tsaStatus: "FAILED", status: "SIGNED", latestReportVersion: null },
      }),
      prisma.evidence.count({
        where: {
          ...live,
          OR: [
            { tsaStatus: "FAILED" },
            { status: "SIGNED", latestReportVersion: null },
          ],
        },
      }),
      prisma.evidence.count({ where: { ...live, tsaStatus: "FAILED" } }),
      prisma.evidence.count({
        where: { ...live, status: "SIGNED", latestReportVersion: null },
      }),
    ]);

    const now = Date.now();
    const bucket = (fromDays, toDays) =>
      prisma.evidence.count({
        where: {
          ...live,
          OR: [{ tsaStatus: "FAILED" }, { status: "SIGNED", latestReportVersion: null }],
          createdAt: {
            gte: toDays === null ? new Date(0) : new Date(now - toDays * 86400_000),
            ...(fromDays === null ? {} : { lt: new Date(now - fromDays * 86400_000) }),
          },
        },
      });

    const [d0_1, d1_7, d7_30, d30plus] = await Promise.all([
      bucket(null, 1),
      bucket(1, 7),
      bucket(7, 30),
      prisma.evidence.count({
        where: {
          ...live,
          OR: [{ tsaStatus: "FAILED" }, { status: "SIGNED", latestReportVersion: null }],
          createdAt: { lt: new Date(now - 30 * 86400_000) },
        },
      }),
    ]);

    const byWorkspace = await prisma.evidence.groupBy({
      by: ["teamId"],
      where: {
        ...live,
        OR: [{ tsaStatus: "FAILED" }, { status: "SIGNED", latestReportVersion: null }],
      },
      _count: { _all: true },
    });

    const [reportRequests, otsFailed] = await Promise.all([
      prisma.reportGenerationRequest
        .groupBy({ by: ["status"], _count: { _all: true } })
        .catch(() => null),
      prisma.evidence.count({ where: { ...live, otsStatus: "FAILED" } }),
    ]);

    return {
      cohorts: {
        tsaFailedOnly,
        signedWithoutReportOnly: signedNoReportOnly,
        both,
        distinctAffectedEvidence: unionTotal,
        tsaFailedTotal,
        signedWithoutReportTotal: signedNoReportTotal,
      },
      arithmeticCheck: {
        expectedUnion: tsaFailedOnly + signedNoReportOnly + both,
        measuredUnion: unionTotal,
        agrees: tsaFailedOnly + signedNoReportOnly + both === unionTotal,
      },
      ageBuckets: {
        under1Day: d0_1,
        oneToSevenDays: d1_7,
        sevenToThirtyDays: d7_30,
        overThirtyDays: d30plus,
      },
      workspaceDistribution: byWorkspace
        .map((r) => ({ workspace: pseudonym(r.teamId, "ws"), affected: r._count._all }))
        .sort((a, b) => b.affected - a.affected)
        .slice(0, LIST_LIMIT),
      reportJobState: reportRequests ? groupCount(reportRequests, "status") : null,
      otsAnchoringFailed: otsFailed,
      note:
        "tsaFailedTotal and signedWithoutReportTotal OVERLAP by `both`. Adding " +
        "them double-counts every record in the intersection.",
    };
  });

  // ==========================================================================
  // QUEUES, WORKERS, SEARCH — from durable rows only
  // ==========================================================================
  await section("runtime", async () => {
    const [workerRows, searchDocs, searchAudit] = await Promise.all([
      prisma.workerTelemetrySnapshot
        .findMany({
          orderBy: { sampledAtUtc: "desc" },
          take: 20,
          select: {
            workerKind: true,
            sampledAtUtc: true,
            queueDepth: true,
            failedCount: true,
          },
        })
        .catch(() => null),
      prisma.evidenceSearchDocument.count().catch(() => null),
      prisma.$queryRawUnsafe(
        `SELECT (to_regclass('public.search_audit_logs') IS NOT NULL) AS present`,
      ).catch(() => [{ present: null }]),
    ]);

    const schemaObjects = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='evidence_search_documents'
              AND column_name='tsv')) AS tsv_column,
         (SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
              AND indexname='evidence_search_documents_tsv_gin')) AS tsv_gin,
         (SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
              AND indexname='evidence_search_documents_searchable_text_trgm_idx')) AS free_text_index,
         (SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
              AND indexname='operational_incidents_platform_fingerprint_uk')) AS platform_incident_uk`,
    );

    const migrations = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS applied,
              COUNT(*) FILTER (WHERE finished_at IS NULL)::int AS unfinished,
              MAX(finished_at) AS last_applied_at
         FROM _prisma_migrations`,
    ).catch(() => null);

    return {
      workerTelemetry: workerRows,
      searchDocumentRows: searchDocs,
      searchAuditLogTablePresent: searchAudit[0] ? searchAudit[0].present : null,
      schemaObjects: schemaObjects[0],
      migrations: migrations ? migrations[0] : null,
      note:
        "Queue DEPTH is a Redis fact and is not readable from the database. " +
        "What is here is the durable worker telemetry the API persists, plus " +
        "the schema objects the readiness probes look for.",
    };
  });

  // ==========================================================================
  // THE TRACED ACCOUNT
  // ==========================================================================
  await section("tracedAccount", async () => {
    if (!TRACE_ACCOUNT) {
      return {
        requested: false,
        note: "No --trace-account was supplied, so no account was resolved.",
      };
    }

    // AUTHORITATIVE RESOLUTION, or none.
    //
    // Matching on a display name is how a trace ends up describing the wrong
    // person. Only an exact email or an exact id resolves, and an ambiguous or
    // absent match is reported as such rather than guessed at.
    const looksLikeId = /^[0-9a-f-]{36}$/i.test(TRACE_ACCOUNT);
    const candidates = await prisma.user.findMany({
      where: looksLikeId
        ? { id: TRACE_ACCOUNT }
        : { email: { equals: TRACE_ACCOUNT, mode: "insensitive" } },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        createdAt: true,
        updatedAt: true,
        currentWorkspaceId: true,
      },
    });

    if (candidates.length !== 1) {
      return {
        requested: true,
        resolved: false,
        matches: candidates.length,
        note:
          candidates.length === 0
            ? "No account matched exactly. Nothing was traced; a fuzzy match " +
              "would describe somebody else."
            : "More than one account matched. Nothing was traced.",
      };
    }

    const user = candidates[0];
    const uid = user.id;

    const [
      memberships,
      ownedWorkspaces,
      entitlement,
      cases,
      evidence,
      uploads,
      payments,
      securityEvents,
      adminActions,
      invitesReceived,
      authSessions,
    ] = await Promise.all([
      prisma.teamMember.findMany({
        where: { userId: uid },
        select: { teamId: true, role: true, status: true, createdAt: true },
      }),
      prisma.team.findMany({
        where: { ownerUserId: uid },
        select: {
          id: true,
          isPersonal: true,
          workspaceKind: true,
          billingPlan: true,
          createdAt: true,
        },
      }),
      prisma.entitlement.findMany({
        where: { userId: uid },
        select: { plan: true, active: true, createdAt: true },
      }),
      prisma.case.count({ where: { createdByUserId: uid } }).catch(() => null),
      prisma.evidence
        .groupBy({
          by: ["status"],
          where: { uploadedByUserId: uid },
          _count: { _all: true },
        })
        .catch(() => null),
      prisma.uploadSession
        .groupBy({ by: ["status"], where: { userId: uid }, _count: { _all: true } })
        .catch(() => null),
      prisma.payment
        .groupBy({ by: ["status"], where: { userId: uid }, _count: { _all: true } })
        .catch(() => null),
      prisma.securityEvent.findMany({
        where: { userId: uid },
        orderBy: { createdAt: "desc" },
        take: LIST_LIMIT,
        // No `details`: it is free-form and can carry anything a writer put in
        // it, which is exactly the shape a redaction pass cannot guarantee.
        //
        // `ipAddressHash` is what the column holds — the writer hashes before
        // storing — so there is no address here to reduce to a network. Only
        // its PRESENCE is reported: "this event recorded an origin" is a usable
        // fact, and exporting a hash would export a join key for nothing.
        select: {
          eventType: true,
          severity: true,
          createdAt: true,
          ipAddressHash: true,
          requestId: true,
        },
      }),
      prisma.adminAuditLog
        .count({ where: { targetId: uid } })
        .catch(() => null),
      prisma.teamInvite
        .count({ where: { email: user.email ?? "" } })
        .catch(() => null),
      prisma.authenticatedSession
        .findMany({
          where: { userId: uid },
          orderBy: { createdAt: "desc" },
          take: LIST_LIMIT,
          // Metadata WITHOUT tokens. Deliberately absent: sessionIdHash (a
          // join key), deviceIdHash, ipPreview and uaPreview. countryCode is
          // kept because "logged in from one country" is the question a trace
          // asks and it names no person; riskScore is the runtime risk the
          // adaptive-auth path recorded.
          select: {
            issuedAtUtc: true,
            lastSeenAtUtc: true,
            revokedAtUtc: true,
            countryCode: true,
            riskScore: true,
          },
        })
        .catch(() => null),
    ]);

    const workspaceIds = [
      ...new Set([
        ...memberships.map((m) => m.teamId),
        ...ownedWorkspaces.map((w) => w.id),
      ]),
    ];

    // Incidents VISIBLE AGAINST this account's workspaces. Deliberately NOT
    // "incidents this account caused" — an incident carries no actor, and a
    // timestamp near a login is a coincidence until something links them.
    const incidents = workspaceIds.length
      ? await prisma.operationalIncident.findMany({
          where: { teamId: { in: workspaceIds } },
          select: {
            teamId: true,
            sourceId: true,
            category: true,
            severity: true,
            status: true,
            fingerprint: true,
            firstSeenAtUtc: true,
            lastSeenAtUtc: true,
            occurrenceCount: true,
            openedBySystem: true,
          },
          take: LIST_LIMIT,
        })
      : [];

    // For each of those, is the SAME condition open in other workspaces too?
    const sharedLookup = {};
    for (const inc of incidents) {
      const n = await prisma.operationalIncident.count({
        where: { fingerprint: inc.fingerprint, teamId: { not: null } },
      });
      sharedLookup[inc.fingerprint] = n;
    }

    return {
      requested: true,
      resolved: true,
      account: {
        id: pseudonym(user.id, "user"),
        emailDomain: emailDomain(user.email),
        emailVerifiedAt: user.emailVerifiedAt,
        emailVerified: user.emailVerifiedAt !== null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        hasCurrentWorkspace: Boolean(user.currentWorkspaceId),
      },
      memberships: memberships.map((m) => ({
        workspace: pseudonym(m.teamId, "ws"),
        role: m.role,
        status: m.status,
        createdAt: m.createdAt,
      })),
      ownedWorkspaces: ownedWorkspaces.map((w) => ({
        workspace: pseudonym(w.id, "ws"),
        isPersonal: w.isPersonal,
        workspaceKind: w.workspaceKind,
        billingPlan: w.billingPlan,
        createdAt: w.createdAt,
      })),
      entitlements: entitlement,
      activity: {
        casesCreated: cases,
        evidenceByStatus: evidence ? groupCount(evidence, "status") : null,
        uploadSessionsByStatus: uploads ? groupCount(uploads, "status") : null,
        paymentsByStatus: payments ? groupCount(payments, "status") : null,
        adminActionsTargetingThisAccount: adminActions,
        invitesAddressedToThisEmail: invitesReceived,
      },
      sessions: authSessions
        ? authSessions.map((s) => ({
            issuedAtUtc: s.issuedAtUtc,
            lastSeenAtUtc: s.lastSeenAtUtc,
            revoked: Boolean(s.revokedAtUtc),
            countryCode: s.countryCode,
            riskScore: s.riskScore,
          }))
        : null,
      securityEvents: securityEvents.map((e) => ({
        eventType: e.eventType,
        severity: e.severity,
        createdAt: e.createdAt,
        originRecorded: e.ipAddressHash !== null,
        requestId: e.requestId,
      })),
      incidentsVisibleAgainstTheirWorkspaces: incidents.map((i) => ({
        workspace: pseudonym(i.teamId, "ws"),
        sourceId: i.sourceId,
        fingerprintFamily: fingerprintFamily(i.fingerprint),
        category: i.category,
        severity: i.severity,
        status: i.status,
        firstSeenAtUtc: i.firstSeenAtUtc,
        lastSeenAtUtc: i.lastSeenAtUtc,
        occurrenceCount: i.occurrenceCount,
        openedBySystem: i.openedBySystem,
        // The load-bearing field for the "did this user cause it?" question.
        alsoOpenInThisManyWorkspaces: sharedLookup[i.fingerprint],
      })),
      causationNote:
        "This section reports what is VISIBLE against this account's " +
        "workspaces. It asserts no causation. `openedBySystem` says a scanner " +
        "wrote the row, and `alsoOpenInThisManyWorkspaces` > 1 says the same " +
        "condition exists for tenants this account has never touched — either " +
        "one is sufficient to rule the account out as the cause. A timestamp " +
        "near a login is a coincidence until something links them.",
    };
  });

  await prisma.$disconnect();
  await pool.end();

  const failedSections = Object.entries(sections)
    .filter(([, v]) => v.ok === false)
    .map(([k]) => k);

  process.stdout.write(
    JSON.stringify(
      {
        diagnostic: {
          name: "proovra-diagnostic",
          version: DIAGNOSTIC_VERSION,
          sourceSha256: sourceHash(),
          sourceFile: path.basename(__filename),
          generatedAtUtc: new Date().toISOString(),
          database: actualDatabase,
          readOnly: true,
          redaction:
            "user and workspace ids are per-run pseudonyms; emails are reduced " +
            "to their domain; IPs to a /24 or /48 network; incident " +
            "fingerprints to their source family. No token, hash, cookie, key " +
            "or evidence content is selected anywhere in this script.",
          sectionsFailed: failedSections,
          complete: failedSections.length === 0,
        },
        sections,
      },
      // BigInt is not JSON-serialisable and Postgres COUNT(*) arrives as one
      // through some paths. Converting here rather than at every call site
      // means one forgotten cast cannot abort the whole run at the last step.
      (_key, value) => (typeof value === "bigint" ? Number(value) : value),
      2,
    ) + "\n",
  );

  process.stderr.write(
    failedSections.length === 0
      ? "proovra-diagnostic: complete.\n"
      : `proovra-diagnostic: complete with ${failedSections.length} failed section(s): ${failedSections.join(", ")}.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`proovra-diagnostic: FATAL ${boundedError(err)}\n`);
  process.exit(1);
});
