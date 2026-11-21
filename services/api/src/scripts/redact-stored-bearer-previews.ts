/**
 * PRO-N1-06 / PRO-I1Z-01 — one-off redaction of intake BEARER links already
 * stored in `communication_messages.body_preview`. DRY RUN BY DEFAULT.
 *
 * Built image (the compiled file ships as dist/scripts/redact-stored-bearer-previews.js):
 *
 *   Dry run (read-only: the transaction is SET READ ONLY, so PostgreSQL refuses any write):
 *     node dist/scripts/redact-stored-bearer-previews.js [--samples=3]
 *
 *   Apply (owner-approved, after a backup and a reviewed dry run):
 *     REDACT_STORED_BEARER_PREVIEWS_APPLY=I_HAVE_OWNER_APPROVAL \
 *     node dist/scripts/redact-stored-bearer-previews.js --apply \
 *       --backup-id=<id of the pre-run dump> \
 *       --expect-database=<database fingerprint printed by the dry run> \
 *       --expect-count=<affectedCount printed by the dry run> \
 *       --expect-set-hash=<setHash printed by the dry run>
 *
 * SCOPE — exactly one table and the preview it stores:
 *   communication_messages.body_preview rows that contain an intake bearer link
 *   (`/intake/<token of 12+ characters>`). Only the token is replaced by the
 *   fixed marker `[secure-link]` (plus the value of a secret-named query
 *   parameter on that same intake URL, e.g. `?token=`); every other character
 *   of the preview is kept. The ONE companion column written on the same row is
 *   `body_resendable`, set to false where it was true: a retry sends the stored
 *   preview as the message (communication.service.ts, WORKFLOW-009), and a
 *   redacted preview is no longer the message, so leaving it true would make a
 *   retry deliver a dead link as a false success.
 *   `updated_at` is NOT touched (raw SQL, no Prisma @updatedAt).
 *
 * NOT TOUCHED: no row is deleted; notification_deliveries (counted read-only
 * for the record, never written), evidence, custody, reports, packages, intake
 * links and every other table; provider-side copies of messages already sent.
 *
 * SAFETY PROPERTIES
 *   - Dry run is the default and runs in a READ ONLY transaction.
 *   - The affected set is reported as sorted ids plus `setHash`
 *     (sha256 of the scope label and the sorted ids). Apply re-derives the set
 *     under row locks inside ONE transaction and REFUSES (rolls back, writes
 *     nothing) unless count, set hash and database fingerprint equal the
 *     validated dry run: a set that grew, shrank or changed is refused.
 *   - Every row is written compare-and-swap on the value read; a row that
 *     changed meanwhile aborts the whole transaction.
 *   - After the writes, still inside the transaction, the set is re-derived and
 *     must be empty; otherwise the transaction rolls back. A second run finds 0.
 *   - Token values are never printed: output is ids, counts, hashes and samples
 *     of the REDACTED preview, and the whole output is checked against every
 *     token read before it is written (a hit prints nothing and fails).
 *   - Refused misuse (exit 2, nothing written): unknown flags; --apply without
 *     the approval variable, a backup id, the expected count, set hash or
 *     database fingerprint; a set-hash or database mismatch.
 *
 * ROLLBACK: not reversible by design (the removed value is a live credential);
 * the pre-run backup named by --backup-id is the only way back.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@prisma/client";

export const REDACTION_MARKER = "[secure-link]";
export const SECRET_PARAM_MARKER = "[secure-token]";
export const SET_SCOPE_LABEL = "communication_messages.body_preview:intake-bearer:v1";
export const APPLY_APPROVAL_ENV = "REDACT_STORED_BEARER_PREVIEWS_APPLY";
export const APPLY_APPROVAL_VALUE = "I_HAVE_OWNER_APPROVAL";
const PREVIEW_MAX = 400; // VarChar(400)

// A token: URL-safe characters, never ending in '.' so a sentence's full stop
// after the link is kept. At least 12 characters so `/intake/help` is not a token.
const TOKEN = "[A-Za-z0-9_~%=+\\-](?:[A-Za-z0-9_~%=+.\\-]*[A-Za-z0-9_~%=+\\-])?";
const INTAKE_TOKEN_RE = new RegExp(`(/intake/)(${TOKEN})((?:[?#][^\\s<>"']*)?)`, "g");
const SECRET_PARAM_RE = /([?&](?:token|key|secret|auth|sig|signature|hash|password)=)([^&#\s<>"']+)/gi;

export type RedactionResult = { after: string; secrets: string[] };

/**
 * Replace only the bearer material of each intake link in `text`. Pure and
 * idempotent: the marker itself is not a token (it contains `[`), so a second
 * pass changes nothing.
 */
export function redactIntakeBearer(text: string): RedactionResult {
  const secrets: string[] = [];
  const after = text.replace(INTAKE_TOKEN_RE, (whole, head: string, token: string, tail: string) => {
    if (token.length < 12) return whole;
    secrets.push(token);
    const cleanTail = tail.replace(SECRET_PARAM_RE, (_m, key: string, value: string) => {
      if (value === SECRET_PARAM_MARKER) return `${key}${value}`;
      secrets.push(value);
      return `${key}${SECRET_PARAM_MARKER}`;
    });
    return `${head}${REDACTION_MARKER}${cleanTail}`;
  });
  return { after, secrets };
}

export function setHashOf(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  return createHash("sha256").update(`${SET_SCOPE_LABEL}\n${sorted.join("\n")}`).digest("hex");
}

export function databaseFingerprint(url: string | undefined): string {
  try {
    const u = new URL(url ?? "");
    return createHash("sha256").update(`${u.hostname}:${u.port}/${u.pathname}`).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

type Row = { id: string; body_preview: string | null; body_resendable: boolean };
type Tx = Pick<PrismaClient, "$queryRaw" | "$executeRaw" | "$executeRawUnsafe">;

export type PlannedRow = { id: string; before: string; after: string; secrets: string[]; resendable: boolean };

export type Plan = {
  scannedWithIntakePath: number;
  affected: PlannedRow[];
  ids: string[];
  setHash: string;
  overLengthIds: string[];
  resendableToClear: number;
  notificationDeliveriesMatching: number;
};

async function derive(tx: Tx, lock: boolean): Promise<Plan> {
  const rows = lock
    ? await tx.$queryRaw<Row[]>`
        SELECT id::text AS id, body_preview, body_resendable FROM communication_messages
         WHERE body_preview LIKE '%/intake/%' ORDER BY id FOR UPDATE`
    : await tx.$queryRaw<Row[]>`
        SELECT id::text AS id, body_preview, body_resendable FROM communication_messages
         WHERE body_preview LIKE '%/intake/%' ORDER BY id`;
  const affected: PlannedRow[] = [];
  for (const r of rows) {
    const before = r.body_preview ?? "";
    const { after, secrets } = redactIntakeBearer(before);
    if (after !== before) affected.push({ id: r.id, before, after, secrets, resendable: r.body_resendable });
  }
  // Read-only, for the record: the other preview table the original cleanup
  // scanned. Never written here (0 in production on 2026-11-21).
  const nd = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM notification_deliveries
     WHERE rendered_preview ~ '/intake/[A-Za-z0-9_~%=+.-]{12,}'`;
  const ids = affected.map((a) => a.id).sort();
  return {
    scannedWithIntakePath: rows.length,
    affected,
    ids,
    setHash: setHashOf(ids),
    overLengthIds: affected.filter((a) => a.after.length > PREVIEW_MAX).map((a) => a.id),
    resendableToClear: affected.filter((a) => a.resendable).length,
    notificationDeliveriesMatching: Number(nd[0]?.n ?? 0),
  };
}

/** Read-only: the PostgreSQL transaction refuses any write. */
export async function planBearerPreviewRedaction(client: PrismaClient): Promise<Plan> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return derive(tx as unknown as Tx, false);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

export class RedactionRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RedactionRefused";
  }
}

export type ApplyResult = { redacted: number; resendableCleared: number; ids: string[]; setHash: string; remainingAfter: number };

/**
 * One transaction: lock and re-derive the set, refuse unless it equals the
 * validated dry run, write compare-and-swap, prove the set is now empty.
 * Any refusal or mismatch rolls everything back.
 */
export async function applyBearerPreviewRedaction(
  client: PrismaClient,
  expected: { count: number; setHash: string },
): Promise<ApplyResult> {
  return client.$transaction(
    async (raw) => {
      const tx = raw as unknown as Tx;
      const plan = await derive(tx, true);
      if (plan.ids.length !== expected.count || plan.setHash !== expected.setHash) {
        throw new RedactionRefused(
          "SET_CHANGED",
          `the affected set is not the validated one (now ${plan.ids.length} rows, set hash ${plan.setHash}); nothing was written — run the dry run again and re-validate`,
        );
      }
      if (plan.overLengthIds.length > 0) {
        throw new RedactionRefused("OVER_LENGTH", `redaction would exceed ${PREVIEW_MAX} characters for: ${plan.overLengthIds.join(",")}`);
      }
      let resendableCleared = 0;
      for (const row of plan.affected) {
        const n = await tx.$executeRaw`
          UPDATE communication_messages
             SET body_preview = ${row.after}, body_resendable = false
           WHERE id = ${row.id}::uuid AND body_preview = ${row.before}`;
        if (n !== 1) throw new RedactionRefused("ROW_CHANGED", `row ${row.id} changed during the run; nothing was written`);
        if (row.resendable) resendableCleared += 1;
      }
      const afterPlan = await derive(tx, false);
      if (afterPlan.ids.length !== 0) {
        throw new RedactionRefused("NOT_CONVERGED", `${afterPlan.ids.length} rows still carry a bearer link after the writes; rolled back`);
      }
      return { redacted: plan.affected.length, resendableCleared, ids: plan.ids, setHash: plan.setHash, remainingAfter: 0 };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const KNOWN = new Set(["apply", "backup-id", "expect-count", "expect-set-hash", "expect-database", "samples"]);

export type CliIo = {
  argv: string[];
  env: Record<string, string | undefined>;
  client: PrismaClient;
  out: (s: string) => void;
  err: (s: string) => void;
};

function parse(argv: string[]): { flags: Set<string>; values: Map<string, string>; unknown: string[] } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const unknown: string[] = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !KNOWN.has(m[1]!)) {
      unknown.push(a.split("=")[0]!);
      continue;
    }
    if (m[2] === undefined) flags.add(m[1]!);
    else values.set(m[1]!, m[2]);
  }
  return { flags, values, unknown };
}

/** Never let a token reach the terminal, even through a sample. */
function emitChecked(io: CliIo, payload: unknown, secrets: readonly string[]): boolean {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (secrets.some((s) => s.length > 0 && text.includes(s))) {
    io.err("refused: the report would contain token material; nothing was printed\n");
    return false;
  }
  io.out(text);
  return true;
}

/** Returns the process exit code. */
export async function runRedactStoredBearerPreviewsCli(io: CliIo): Promise<number> {
  const { flags, values, unknown } = parse(io.argv);
  const refuse = (msg: string) => {
    io.err(`refused: ${msg}. Nothing was written.\n`);
    return 2;
  };
  if (unknown.length > 0) return refuse(`unknown argument(s) ${unknown.join(", ")}`);
  const database = databaseFingerprint(io.env.DATABASE_URL);
  const samples = Math.max(0, Math.min(Number(values.get("samples") ?? 3) || 0, 10));
  const apply = flags.has("apply");

  if (!apply) {
    for (const k of ["backup-id", "expect-count", "expect-set-hash", "expect-database"]) {
      if (values.has(k)) return refuse(`--${k} only has a meaning with --apply`);
    }
    const plan = await planBearerPreviewRedaction(io.client);
    const secrets = plan.affected.flatMap((a) => a.secrets);
    const ok = emitChecked(
      io,
      {
        script: "redact-stored-bearer-previews",
        mode: "DRY_RUN",
        readOnlyTransaction: true,
        database,
        scope: SET_SCOPE_LABEL,
        scannedWithIntakePath: plan.scannedWithIntakePath,
        affectedCount: plan.ids.length,
        setHash: plan.setHash,
        ids: plan.ids,
        resendableToClear: plan.resendableToClear,
        overLengthIds: plan.overLengthIds,
        notificationDeliveriesMatchingReadOnly: plan.notificationDeliveriesMatching,
        redactedSamples: plan.affected.slice(0, samples).map((a) => ({ id: a.id, after: a.after.slice(0, 200) })),
        next:
          plan.ids.length === 0
            ? "nothing to redact"
            : `validate the ids, take a backup, then apply with --expect-database=${database} --expect-count=${plan.ids.length} --expect-set-hash=${plan.setHash} --backup-id=<id>`,
      },
      secrets,
    );
    return ok ? 0 : 1;
  }

  if (io.env[APPLY_APPROVAL_ENV] !== APPLY_APPROVAL_VALUE) {
    return refuse(`--apply requires ${APPLY_APPROVAL_ENV}=${APPLY_APPROVAL_VALUE} after a reviewed dry run`);
  }
  const backupId = values.get("backup-id") ?? "";
  if (!/^[A-Za-z0-9._:@-]{6,160}$/.test(backupId)) return refuse("--apply requires --backup-id=<id of the pre-run backup> (6-160 of A-Z a-z 0-9 . _ : @ -)");
  const countRaw = values.get("expect-count") ?? "";
  if (!/^\d{1,7}$/.test(countRaw)) return refuse("--apply requires --expect-count=<affectedCount from the dry run>");
  const setHash = values.get("expect-set-hash") ?? "";
  if (!/^[0-9a-f]{64}$/.test(setHash)) return refuse("--apply requires --expect-set-hash=<setHash from the dry run>");
  const expectDb = values.get("expect-database") ?? "";
  if (!/^[0-9a-f]{16}$/.test(expectDb)) return refuse("--apply requires --expect-database=<database fingerprint from the dry run>");
  if (database === "unknown" || expectDb !== database) {
    return refuse(`this connection is database ${database}, not the validated ${expectDb}`);
  }
  try {
    const res = await applyBearerPreviewRedaction(io.client, { count: Number(countRaw), setHash });
    io.out(
      `${JSON.stringify(
        {
          script: "redact-stored-bearer-previews",
          mode: "APPLY",
          database,
          backupId,
          redacted: res.redacted,
          resendableCleared: res.resendableCleared,
          setHash: res.setHash,
          ids: res.ids,
          remainingAfterInTransaction: res.remainingAfter,
          next: "run the dry run again: affectedCount must be 0",
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof RedactionRefused) return refuse(`${e.code}: ${e.message}`);
    throw e;
  }
}

async function main(): Promise<void> {
  await import("../env.js");
  const { prisma } = await import("../db.js");
  try {
    process.exitCode = await runRedactStoredBearerPreviewsCli({
      argv: process.argv.slice(2),
      env: process.env,
      client: prisma,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  } catch (err) {
    // A driver message can quote the statement's parameters (the previews):
    // print the error's class only.
    process.stderr.write(`redact-stored-bearer-previews failed: ${err instanceof Error ? err.name : "error"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
