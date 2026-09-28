/**
 * DESTRUCTION CERTIFICATE AUDIT — READ-ONLY (2026-09-29).
 *
 * Before 2026-09-29 the destruction executor deleted each object by KEY and
 * verified with a HEAD by KEY. On a versioned bucket (every Object Lock bucket
 * is one) that writes a delete marker, answers 404, and leaves every locked
 * version in place — so a V2 certificate ("storageDeletionVerified: true") may
 * attest to a destruction whose bytes still exist.
 *
 * This script inventories every DESTROYED record and reports, per record,
 * whether any object VERSION survives under the record's key prefixes and the
 * latest retain-until among them. It WRITES NOTHING: no row, no object, no
 * certificate. Correction is a separate, authorized procedure (see
 * docs/architecture/evidence-output-lifecycle-2026-09-29.md §Destruction).
 *
 *   pnpm --filter proovra-api exec tsx src/scripts/destruction-certificate-audit.ts [--limit=500] [--json]
 *
 * Output identifies records by the first 8 characters of their id only.
 */
import { HeadObjectCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";

import { prisma } from "../db.js";
import { s3 } from "../storage.js";

type Finding = {
  evidence: string;
  certificateVersion: string | null;
  survivingVersions: number;
  deleteMarkers: number;
  latestRetainUntilUtc: string | null;
  legalHoldVersions: number;
  classification:
    | "V3_OR_LATER"
    | "V2_BYTES_REMAIN_RETAINED"
    | "V2_BYTES_REMAIN_NOT_RETAINED"
    | "V2_NO_BYTES_FOUND"
    | "INVENTORY_FAILED";
};

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function inventoryPrefix(bucket: string, prefix: string) {
  let surviving = 0;
  let markers = 0;
  let legal = 0;
  let latest: number | null = null;
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
      }),
    );
    markers += res.DeleteMarkers?.length ?? 0;
    for (const v of res.Versions ?? []) {
      surviving++;
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: v.Key!, VersionId: v.VersionId ?? "null" }),
      );
      if (String(head.ObjectLockLegalHoldStatus ?? "").toUpperCase() === "ON") legal++;
      const until = head.ObjectLockRetainUntilDate?.getTime() ?? null;
      if (until !== null) latest = Math.max(latest ?? 0, until);
    }
    if (!res.IsTruncated) break;
    keyMarker = res.NextKeyMarker;
    versionMarker = res.NextVersionIdMarker;
  }
  return { surviving, markers, legal, latest };
}

async function main() {
  const limit = Math.max(1, Math.min(Number(arg("limit") ?? 500), 5000));
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) throw new Error("S3_BUCKET is required");

  const destroyed = await prisma.evidence.findMany({
    where: { lifecycleState: "DESTROYED" },
    select: { id: true },
    orderBy: { destroyedAtUtc: "asc" },
    take: limit,
  });

  const findings: Finding[] = [];
  for (const ev of destroyed) {
    const purge = await prisma.custodyEvent.findFirst({
      where: { evidenceId: ev.id, eventType: "EVIDENCE_PURGED" },
      orderBy: { sequence: "desc" },
      select: { payload: true },
    });
    const certificateVersion =
      (purge?.payload as { certificateVersion?: string } | null)?.certificateVersion ?? null;
    try {
      let surviving = 0;
      let markers = 0;
      let legal = 0;
      let latest: number | null = null;
      for (const prefix of [
        `evidence/${ev.id}/`,
        `reports/${ev.id}/`,
        `verification/${ev.id}/`,
        `internal/package-staging/${ev.id}/`,
      ]) {
        const r = await inventoryPrefix(bucket, prefix);
        surviving += r.surviving;
        markers += r.markers;
        legal += r.legal;
        if (r.latest !== null) latest = Math.max(latest ?? 0, r.latest);
      }
      const v2 = certificateVersion !== "PROOVRA_EVIDENCE_DESTRUCTION_CERT_V3";
      findings.push({
        evidence: ev.id.slice(0, 8),
        certificateVersion,
        survivingVersions: surviving,
        deleteMarkers: markers,
        latestRetainUntilUtc: latest === null ? null : new Date(latest).toISOString(),
        legalHoldVersions: legal,
        classification: !v2
          ? "V3_OR_LATER"
          : surviving === 0
            ? "V2_NO_BYTES_FOUND"
            : latest !== null && latest > Date.now()
              ? "V2_BYTES_REMAIN_RETAINED"
              : "V2_BYTES_REMAIN_NOT_RETAINED",
      });
    } catch {
      findings.push({
        evidence: ev.id.slice(0, 8),
        certificateVersion,
        survivingVersions: -1,
        deleteMarkers: -1,
        latestRetainUntilUtc: null,
        legalHoldVersions: -1,
        classification: "INVENTORY_FAILED",
      });
    }
  }

  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.classification] = (acc[f.classification] ?? 0) + 1;
    return acc;
  }, {});
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ scanned: findings.length, counts, findings }, null, 2));
  } else {
    console.log(`[destruction-audit] scanned=${findings.length} ${JSON.stringify(counts)}`);
    for (const f of findings.filter((x) => x.classification !== "V3_OR_LATER" && x.classification !== "V2_NO_BYTES_FOUND")) {
      console.log(
        `[destruction-audit] ${f.evidence} ${f.classification} versions=${f.survivingVersions} retainUntil=${f.latestRetainUntilUtc ?? "-"} legalHold=${f.legalHoldVersions}`,
      );
    }
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[destruction-audit] failed", err instanceof Error ? err.message : err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
