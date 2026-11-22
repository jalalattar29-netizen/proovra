/**
 * PRO-G2-01 — SECURITY CONTAINMENT of the reviewer share links on the records
 * of the CROSS_PARTY verification packages. DRY RUN BY DEFAULT.
 *
 * Built image (ships as dist/scripts/contain-cross-party-share-links.js):
 *
 *   Dry run (read-only: every statement runs in a SET TRANSACTION READ ONLY transaction):
 *     node dist/scripts/contain-cross-party-share-links.js
 *
 *   Apply (owner-approved, after a backup and an independently validated dry run):
 *     CONTAIN_CROSS_PARTY_SHARE_LINKS_APPLY=I_HAVE_OWNER_APPROVAL \
 *     node dist/scripts/contain-cross-party-share-links.js --apply \
 *       --backup-id=<id of the pre-run dump> \
 *       --expect-database=<database fingerprint printed by the dry run> \
 *       --expect-count=<containmentCount printed by the dry run> \
 *       --expect-set-hash=<setHash printed by the dry run>
 *
 *   Verify (read-only; after apply):
 *     node dist/scripts/contain-cross-party-share-links.js --verify [--expect-set-hash=<setHash of the apply>]
 *
 * THE SET (services/trust/g2-01-cross-party-access.ts, one rule for inventory,
 * dry run, apply and its in-transaction re-derivation): share links that are
 * OWNER_SHARE (reviewer shares), ACTIVE by the share authority (not revoked,
 * not expired, not exhausted), on the record of a package the holder inventory
 * classifies CROSS_PARTY in the defect window, and created in the record's
 * holding workspace (or before links carried one). REFUSED and listed, never
 * written: REPORT / PACKAGE links (the link an issued artifact printed;
 * non-revocable through share controls by contract: PRO-O1-04 / RG-18, DEC-09),
 * links created in another workspace, and every link of any other record.
 *
 * THE WRITE: each link is revoked through the canonical reviewer-share
 * revocation (verification-share.service.ts revokeOwnerShareLinkTx — the same
 * rule the owner route POST /v1/evidence/:id/verify-links/:linkId/revoke uses)
 * via revokeVerificationLinkForSecurityContainmentTx: revoked_at_utc set,
 * revoked_by_user_id NULL, revocation_reason SECURITY_CONTAINMENT_PRO_G2_01, and
 * the owner route's tenant audit action `verification.link_revoked` appended in
 * the same transaction (actor SYSTEM, authority PLATFORM_SECURITY_CONTAINMENT,
 * reason code, incident ref, backup id). No raw UPDATE in this file. No
 * record, report, package, custody or object row/byte is touched.
 *
 * ONE TRANSACTION FOR THE WHOLE SET: the link rows are locked (FOR UPDATE), the
 * set is re-derived and must equal the validated dry run (count, set hash,
 * database), every link is revoked, the set is re-derived again and must be
 * empty — otherwise everything rolls back, audit rows included. All or
 * nothing keeps the validated set and the outcome identical; the set is small.
 * Idempotent: a second dry run reports 0 and an apply against it is refused.
 *
 * NEVER AUTO-RESTORED: there is no restore mode. A revoked link stays revoked
 * (the share authority never reopens one); the holder can issue a new link in
 * the product. The pre-run backup named by --backup-id is the record of the
 * before-state.
 *
 * Output never carries a token, token hash, view-session hash, URL or audience
 * label; it is scanned against every secret value read (a hit prints nothing
 * and exits 1). Refused misuse exits 2 and writes nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { PrismaClient } from "@prisma/client";
import { verificationShareOutcomeOfRow, type VerificationShareRow } from "@proovra/shared-runtime";

import { revokeVerificationLinkForSecurityContainmentTx } from "../services/governance/verification-share.service.js";
import {
  CONTAINMENT_INCIDENT_REF,
  CONTAINMENT_REASON_CODE,
  CONTAINMENT_SET_SCOPE_LABEL,
  collectCrossPartyPackages,
  containmentSetHash,
  containmentSetOf,
  guardedJson,
  loadShareLinkRows,
  planContainmentSet,
  recordHolders,
  type ContainmentSet,
} from "../services/trust/g2-01-cross-party-access.js";

export const APPLY_APPROVAL_ENV = "CONTAIN_CROSS_PARTY_SHARE_LINKS_APPLY";
export const APPLY_APPROVAL_VALUE = "I_HAVE_OWNER_APPROVAL";

export function databaseFingerprint(url: string | undefined): string {
  try {
    const u = new URL(url ?? "");
    return createHash("sha256").update(`${u.hostname}:${u.port}/${u.pathname}`).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

export class ContainmentRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContainmentRefused";
  }
}

const linkSummary = (l: ContainmentSet["liveLinks"][number]) => ({
  linkId: l.linkId,
  evidenceId: l.evidenceId,
  purpose: l.purpose,
  family: l.family,
  createdAtUtc: l.createdAtUtc,
  expiresAtUtc: l.expiresAtUtc,
  useCount: l.useCount,
  maxUses: l.maxUses,
  linkTeamId: l.linkTeamId,
  holderTeamId: l.holderTeamId,
  packageIds: l.packageIds,
  revocable: l.revocable,
  why: l.containmentWhy,
});

export type ApplyResult = {
  revoked: number;
  auditRowsWritten: number;
  ids: string[];
  setHash: string;
  remainingAfterInTransaction: number;
  secrets: string[];
};

/**
 * Lock, re-derive, compare, revoke through the canonical service, re-derive.
 * Any refusal or mismatch rolls the whole transaction back.
 */
export async function applyContainment(
  client: PrismaClient,
  expected: { count: number; setHash: string; backupId: string },
  now: Date = new Date(),
): Promise<ApplyResult> {
  const { packages } = await collectCrossPartyPackages({ hashSalt: randomBytes(32).toString("hex") });
  const holders = recordHolders(packages);
  const evidenceIds = [...holders.keys()];
  return client.$transaction(
    async (tx) => {
      const locked = await loadShareLinkRows(tx as unknown as PrismaClient, evidenceIds, true);
      const plan = containmentSetOf(locked, holders, now);
      if (plan.ids.length !== expected.count || plan.setHash !== expected.setHash) {
        throw new ContainmentRefused(
          "SET_CHANGED",
          `the containment set is not the validated one (now ${plan.ids.length} links, set hash ${plan.setHash}); nothing was written — run the dry run again and re-validate`,
        );
      }
      const correlationId = `pro-g2-01-contain:${plan.setHash.slice(0, 16)}`;
      let revoked = 0;
      for (const link of plan.eligible) {
        const r = await revokeVerificationLinkForSecurityContainmentTx(tx, {
          evidenceId: link.evidenceId,
          linkId: link.linkId,
          reasonCode: CONTAINMENT_REASON_CODE,
          incidentRef: CONTAINMENT_INCIDENT_REF,
          backupId: expected.backupId,
          correlationId,
          now,
        });
        if (!r.changed) throw new ContainmentRefused("ROW_CHANGED", `link ${link.linkId} was not revoked by this run; rolled back`);
        revoked += 1;
      }
      const afterRows = await loadShareLinkRows(tx as unknown as PrismaClient, evidenceIds, false);
      const after = containmentSetOf(afterRows, holders, now);
      const notRevoked = afterRows.filter(
        (r) => plan.ids.includes(r.id) && (r.revoked_at_utc === null || r.revocation_reason !== CONTAINMENT_REASON_CODE),
      );
      if (after.ids.length !== 0 || notRevoked.length !== 0) {
        throw new ContainmentRefused("NOT_CONVERGED", `${after.ids.length} links still eligible after the writes; rolled back`);
      }
      const audits = await tx.adminAuditLog.count({
        where: { action: "verification.link_revoked", reasonCode: CONTAINMENT_REASON_CODE, requestId: correlationId },
      });
      if (audits !== revoked) throw new ContainmentRefused("AUDIT_MISSING", `${audits} audit rows for ${revoked} revocations; rolled back`);
      return { revoked, auditRowsWritten: audits, ids: plan.ids, setHash: plan.setHash, remainingAfterInTransaction: 0, secrets: plan.secrets };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

export type VerifyResult = {
  contained: number;
  setHash: string;
  stillGrantingAccess: number;
  missingAudit: number;
  links: Array<{ linkId: string; evidenceId: string; state: string; publicResolverOutcome: string; publicResolverOutcomeAnySession: string; auditRowPresent: boolean }>;
  secrets: string[];
};

/**
 * Read-only proof per contained link: the row, by id, through the public
 * resolver's own decision (verificationShareOutcomeOfRow — what
 * GET /public/verify/:token answers once the token's hash found the row), with
 * no view session and with a fresh one; and its audit row.
 */
export async function verifyContainment(client: PrismaClient, now: Date = new Date()): Promise<VerifyResult> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const rows = (await tx.verificationShareToken.findMany({
        where: { revocationReason: CONTAINMENT_REASON_CODE },
        orderBy: { id: "asc" },
      })) as VerificationShareRow[];
      const audits = await tx.adminAuditLog.findMany({
        where: { action: "verification.link_revoked", reasonCode: CONTAINMENT_REASON_CODE },
        select: { metadata: true },
      });
      const audited = new Set(
        audits.map((a) => (a.metadata && typeof a.metadata === "object" ? (a.metadata as { linkId?: unknown }).linkId : null)).filter(
          (x): x is string => typeof x === "string",
        ),
      );
      const session = randomBytes(24).toString("base64url");
      const links = rows.map((r) => {
        const plain = verificationShareOutcomeOfRow(r, now);
        const withSession = verificationShareOutcomeOfRow(r, now, session);
        return {
          linkId: r.id,
          evidenceId: r.evidenceId,
          state: plain.outcome === "GONE" ? plain.state : "ACTIVE",
          publicResolverOutcome: plain.outcome,
          publicResolverOutcomeAnySession: withSession.outcome,
          auditRowPresent: audited.has(r.id),
        };
      });
      return {
        contained: links.length,
        setHash: containmentSetHash(links.map((l) => l.linkId)),
        stillGrantingAccess: links.filter((l) => l.publicResolverOutcome !== "GONE" || l.publicResolverOutcomeAnySession !== "GONE").length,
        missingAudit: links.filter((l) => !l.auditRowPresent).length,
        links,
        secrets: rows.flatMap((r) => [r.tokenHash, r.lastUseSessionHash ?? ""]).filter((s) => s.length > 0),
      };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const KNOWN = new Set(["apply", "verify", "backup-id", "expect-count", "expect-set-hash", "expect-database"]);
const REFUSED = ["restore", "unrevoke", "rollback", "force", "all"];

export type ContainCliIo = {
  argv: string[];
  env: Record<string, string | undefined>;
  client: PrismaClient;
  out: (s: string) => void;
  err: (s: string) => void;
  now?: Date;
};

function parse(argv: string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const unknown: string[] = [];
  const refused: string[] = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m && REFUSED.includes(m[1]!)) refused.push(m[1]!);
    else if (!m || !KNOWN.has(m[1]!)) unknown.push(a.split("=")[0]!);
    else if (m[2] === undefined) flags.add(m[1]!);
    else values.set(m[1]!, m[2]);
  }
  return { flags, values, unknown, refused };
}

export async function runContainCrossPartyShareLinksCli(io: ContainCliIo): Promise<number> {
  const { flags, values, unknown, refused } = parse(io.argv);
  const refuse = (msg: string) => {
    io.err(`refused: ${msg}. Nothing was written.\n`);
    return 2;
  };
  if (refused.length > 0) return refuse(`--${refused[0]} is not supported: containment is never restored or widened by this tool`);
  if (unknown.length > 0) return refuse(`unknown argument(s) ${unknown.join(", ")}`);
  const now = io.now ?? new Date();
  const database = databaseFingerprint(io.env.DATABASE_URL);
  const emit = (payload: unknown, secrets: readonly string[]) => {
    const text = guardedJson(payload, secrets);
    if (text === null) {
      io.err("refused: the report would contain token, hash or URL material; nothing was printed\n");
      return false;
    }
    io.out(text);
    return true;
  };
  if (flags.has("apply") && flags.has("verify")) return refuse("--apply and --verify are separate runs");

  if (flags.has("verify")) {
    for (const k of ["backup-id", "expect-count", "expect-database"]) if (values.has(k)) return refuse(`--${k} has no meaning with --verify`);
    const expectHash = values.get("expect-set-hash");
    if (expectHash !== undefined && !/^[0-9a-f]{64}$/.test(expectHash)) return refuse("--expect-set-hash must be 64 hex characters");
    const v = await verifyContainment(io.client, now);
    const hashMatches = expectHash === undefined ? null : expectHash === v.setHash;
    const ok = emit(
      {
        script: "contain-cross-party-share-links",
        mode: "VERIFY",
        readOnlyTransaction: true,
        database,
        reasonCode: CONTAINMENT_REASON_CODE,
        contained: v.contained,
        setHash: v.setHash,
        expectedSetHashMatches: hashMatches,
        stillGrantingAccess: v.stillGrantingAccess,
        missingAudit: v.missingAudit,
        method: "each row by id through verificationShareOutcomeOfRow, the public verify resolver's decision after its hash lookup; no token, no HTTP",
        links: v.links,
      },
      v.secrets,
    );
    if (!ok) return 1;
    return v.stillGrantingAccess === 0 && v.missingAudit === 0 && hashMatches !== false ? 0 : 3;
  }

  if (!flags.has("apply")) {
    for (const k of ["backup-id", "expect-count", "expect-set-hash", "expect-database"]) {
      if (values.has(k)) return refuse(`--${k} only has a meaning with --apply`);
    }
    const { packages } = await collectCrossPartyPackages({ hashSalt: randomBytes(32).toString("hex") });
    const plan = await planContainmentSet(io.client, packages, now);
    const ok = emit(
      {
        script: "contain-cross-party-share-links",
        mode: "DRY_RUN",
        readOnlyTransaction: true,
        database,
        scope: CONTAINMENT_SET_SCOPE_LABEL,
        observedAtUtc: now.toISOString(),
        crossPartyPackages: packages.length,
        crossPartyRecords: recordHolders(packages).size,
        liveLinksOnCrossPartyRecords: plan.liveLinks.length,
        containmentCount: plan.ids.length,
        setHash: plan.setHash,
        ids: plan.ids,
        eligible: plan.eligible.map(linkSummary),
        refusedLiveLinks: plan.refused.map(linkSummary),
        next:
          plan.ids.length === 0
            ? "nothing to contain"
            : `validate the ids independently, take a backup, then apply with --expect-database=${database} --expect-count=${plan.ids.length} --expect-set-hash=${plan.setHash} --backup-id=<id>`,
      },
      plan.secrets,
    );
    return ok ? 0 : 1;
  }

  if (io.env[APPLY_APPROVAL_ENV] !== APPLY_APPROVAL_VALUE) {
    return refuse(`--apply requires ${APPLY_APPROVAL_ENV}=${APPLY_APPROVAL_VALUE} after a reviewed dry run`);
  }
  const backupId = values.get("backup-id") ?? "";
  if (!/^[A-Za-z0-9._:@-]{6,160}$/.test(backupId)) return refuse("--apply requires --backup-id=<id of the pre-run backup> (6-160 of A-Z a-z 0-9 . _ : @ -)");
  const countRaw = values.get("expect-count") ?? "";
  if (!/^\d{1,6}$/.test(countRaw)) return refuse("--apply requires --expect-count=<containmentCount from the dry run>");
  if (Number(countRaw) === 0) return refuse("--expect-count=0: there is nothing to contain");
  const setHash = values.get("expect-set-hash") ?? "";
  if (!/^[0-9a-f]{64}$/.test(setHash)) return refuse("--apply requires --expect-set-hash=<setHash from the dry run>");
  const expectDb = values.get("expect-database") ?? "";
  if (!/^[0-9a-f]{16}$/.test(expectDb)) return refuse("--apply requires --expect-database=<database fingerprint from the dry run>");
  if (database === "unknown" || expectDb !== database) return refuse(`this connection is database ${database}, not the validated ${expectDb}`);
  try {
    const res = await applyContainment(io.client, { count: Number(countRaw), setHash, backupId }, now);
    const ok = emit(
      {
        script: "contain-cross-party-share-links",
        mode: "APPLY",
        database,
        backupId,
        reasonCode: CONTAINMENT_REASON_CODE,
        revoked: res.revoked,
        auditRowsWritten: res.auditRowsWritten,
        setHash: res.setHash,
        ids: res.ids,
        remainingAfterInTransaction: res.remainingAfterInTransaction,
        next: "run the dry run again (containmentCount must be 0), then --verify",
      },
      res.secrets,
    );
    return ok ? 0 : 1;
  } catch (e) {
    if (e instanceof ContainmentRefused) return refuse(`${e.code}: ${e.message}`);
    throw e;
  }
}

async function main(): Promise<void> {
  await import("../env.js");
  const { prisma } = await import("../db.js");
  try {
    process.exitCode = await runContainCrossPartyShareLinksCli({
      argv: process.argv.slice(2),
      env: process.env,
      client: prisma,
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  } catch (err) {
    process.stderr.write(`contain-cross-party-share-links failed: ${err instanceof Error ? err.name : "error"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
