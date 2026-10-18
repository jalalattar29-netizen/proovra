/**
 * VERIFICATION DISCLOSURE — FLEET REPORT AND RECONCILIATION (2026-10-18).
 *
 *   tsx src/scripts/verification-disclosure-fleet.ts report
 *   tsx src/scripts/verification-disclosure-fleet.ts reconcile [--apply] [--batch=500] [--after=<evidenceId>] [--max-batches=N]
 *
 * report — READ ONLY. Aggregates only (never an id, a name, an email or a
 *   coordinate): the retired publication state × access state × disclosure
 *   policy; canonical references by lifecycle; active reviewer links; package
 *   seal kinds (legacy seals); reports without a recorded otsState; parts whose
 *   storage key embeds a file name; records with coordinates. Run it before and
 *   after the migration.
 *
 * reconcile — the deploy window. The migration maps the retired publication
 *   state once. If the PREVIOUS image kept running for a while after the
 *   migration (rolling deploy), it could still publish, unpublish or suspend a
 *   record — writes the new image never reads. reconcile re-applies the
 *   migration's mapping ONLY to records whose policy no owner has set under the
 *   new model (verification_disclosure_version = 0 and never changed), and
 *   closes recipient links that predate the migration on records that are not
 *   PUBLISHED (as the migration did). It never touches a record an owner has
 *   decided, never enables location, never touches access, evidence bytes,
 *   hashes, custody, reports, packages or storage.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply. Bounded (one keyset
 * page per batch, ordered by id), resumable (the last cursor is printed; pass
 * it back as --after), idempotent and race-safe (every write is a
 * compare-and-swap on the exact state that was read). Exact counts are printed.
 * DATABASE_URL comes from the operator's environment; no credential is
 * embedded. Exit 4 on any failed write.
 */
import { prisma } from "../db.js";

const MIGRATION = "20281018000000_verification_disclosure_policy";

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
}

type Row = Record<string, unknown>;
const q = <T = Row>(sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...params);
const n = (v: unknown) => Number(v ?? 0);

export async function fleetReport(): Promise<Record<string, unknown>> {
  const hasPolicy =
    (await q<{ n: unknown }>(
      `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'evidence' AND column_name = 'verification_disclosure_mode'`,
    ))[0]!.n !== BigInt(0);
  const policyCols = hasPolicy ? `, verification_disclosure_mode AS mode, show_recorded_location AS location` : ``;
  const states = await q(
    `SELECT public_verify_state::text AS publication, verification_access_state AS access${policyCols}, count(*) AS n
       FROM evidence GROUP BY 1, 2${hasPolicy ? ", 3, 4" : ""} ORDER BY 1, 2${hasPolicy ? ", 3, 4" : ""}`,
  );
  const references = await q(
    `SELECT lifecycle_state::text AS lifecycle, (verification_ref IS NOT NULL) AS has_reference, count(*) AS n
       FROM evidence WHERE status IN ('SIGNED', 'REPORTED') GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const links = await q(
    `SELECT purpose, (revoked_at_utc IS NULL AND (expires_at_utc IS NULL OR expires_at_utc > now()) AND (max_uses IS NULL OR use_count < max_uses)) AS active,
            coalesce(revocation_reason, '') AS reason, count(*) AS n
       FROM verification_share_tokens GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  );
  const packages = await q(
    `SELECT CASE
              WHEN coalesce(package_format_version, 0) < 5 OR seal_sha256 IS NULL THEN 'UNSEALED_LEGACY'
              WHEN seal_signing_key_id IS NULL THEN 'SEALED_WITHOUT_KEY_ID'
              ELSE 'SEALED_WITH_KEY_ID'
            END AS seal, count(*) AS n
       FROM verification_packages GROUP BY 1 ORDER BY 1`,
  );
  const reportsMissingOtsState = await q(
    `SELECT count(*) AS n FROM reports WHERE anchor_snapshot IS NULL OR NOT (anchor_snapshot ? 'otsState')`,
  );
  const nameBearingKeys = await q(
    `SELECT count(*) AS n FROM evidence_parts WHERE storage_key ~ '/parts/[0-9]+-[^/]+$'`,
  );
  const withCoordinates = await q(`SELECT count(*) AS n FROM evidence WHERE lat IS NOT NULL AND lng IS NOT NULL`);
  return {
    policyColumnsPresent: hasPolicy,
    states: states.map((r) => ({ ...r, n: n(r.n) })),
    referencesByLifecycle: references.map((r) => ({ ...r, n: n(r.n) })),
    shareLinks: links.map((r) => ({ ...r, n: n(r.n) })),
    packagesBySeal: packages.map((r) => ({ ...r, n: n(r.n) })),
    reportsMissingOtsState: n(reportsMissingOtsState[0]?.n),
    partsWithNameBearingStorageKey: n(nameBearingKeys[0]?.n),
    recordsWithCoordinates: n(withCoordinates[0]?.n),
  };
}

export async function reconcile(opts: { apply: boolean; batch: number; after: string | null; maxBatches: number | null }) {
  const migrated = await q<{ finished_at: Date | null }>(
    `SELECT finished_at FROM _prisma_migrations WHERE migration_name = $1 AND rolled_back_at IS NULL`,
    MIGRATION,
  );
  const migratedAt = migrated[0]?.finished_at ?? null;
  if (!migratedAt) {
    console.error(`[disclosure-reconcile] ${MIGRATION} is not applied; nothing to reconcile.`);
    process.exitCode = 3;
    return null;
  }
  const counts = { scanned: 0, policyDrift: 0, policyReconciled: 0, linksDrift: 0, linksClosed: 0, skippedRowMoved: 0, failed: 0 };
  let cursor = opts.after;
  let batches = 0;
  for (;;) {
    if (opts.maxBatches !== null && batches >= opts.maxBatches) break;
    batches += 1;
    const rows = await q<{ id: string; publication: string; mode: string }>(
      `SELECT id, public_verify_state::text AS publication, verification_disclosure_mode AS mode
         FROM evidence
        WHERE ($1::uuid IS NULL OR id > $1::uuid)
          AND verification_disclosure_version = 0 AND verification_disclosure_changed_at_utc IS NULL
        ORDER BY id LIMIT $2`,
      cursor,
      opts.batch,
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      counts.scanned += 1;
      const target = r.publication === "PUBLISHED" ? "CONTENT_PREVIEW" : "VERIFICATION_ONLY";
      if (r.mode !== target) {
        counts.policyDrift += 1;
        if (opts.apply) {
          try {
            const changed = await prisma.$executeRawUnsafe(
              `UPDATE evidence SET verification_disclosure_mode = $2, show_recorded_location = false
                WHERE id = $1::uuid AND verification_disclosure_mode = $3 AND public_verify_state::text = $4
                  AND verification_disclosure_version = 0 AND verification_disclosure_changed_at_utc IS NULL`,
              r.id,
              target,
              r.mode,
              r.publication,
            );
            if (changed === 1) counts.policyReconciled += 1;
            else counts.skippedRowMoved += 1;
          } catch {
            counts.failed += 1;
          }
        }
      }
      if (r.publication !== "PUBLISHED") {
        const stale = await q<{ n: unknown }>(
          `SELECT count(*) AS n FROM verification_share_tokens
            WHERE evidence_id = $1::uuid AND purpose = 'OWNER_SHARE' AND revoked_at_utc IS NULL AND created_at_utc < $2`,
          r.id,
          migratedAt,
        );
        const drift = n(stale[0]?.n);
        counts.linksDrift += drift;
        if (opts.apply && drift > 0) {
          try {
            counts.linksClosed += await prisma.$executeRawUnsafe(
              `UPDATE verification_share_tokens SET revoked_at_utc = now(), revocation_reason = 'DISCLOSURE_MODEL_MIGRATION'
                WHERE evidence_id = $1::uuid AND purpose = 'OWNER_SHARE' AND revoked_at_utc IS NULL AND created_at_utc < $2`,
              r.id,
              migratedAt,
            );
          } catch {
            counts.failed += 1;
          }
        }
      }
    }
    cursor = rows[rows.length - 1]!.id;
    console.log(`[disclosure-reconcile] batch ${batches} cursor=${cursor} ${JSON.stringify(counts)}`);
    if (rows.length < opts.batch) break;
  }
  console.log(`[disclosure-reconcile] ${opts.apply ? "APPLIED" : "DRY RUN"} ${JSON.stringify({ ...counts, lastCursor: cursor })}`);
  if (counts.failed > 0) process.exitCode = 4;
  return counts;
}

async function main() {
  const mode = process.argv[2];
  try {
    if (mode === "report") {
      console.log(JSON.stringify(await fleetReport(), null, 2));
    } else if (mode === "reconcile") {
      await reconcile({
        apply: arg("apply") === "true",
        batch: Math.max(1, Math.min(Number(arg("batch") ?? 500) || 500, 5000)),
        after: arg("after"),
        maxBatches: arg("max-batches") ? Number(arg("max-batches")) : null,
      });
    } else {
      console.error("usage: verification-disclosure-fleet.ts report | reconcile [--apply] [--batch=500] [--after=<id>] [--max-batches=N]");
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /verification-disclosure-fleet\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
