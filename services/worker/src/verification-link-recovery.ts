/**
 * ORPHANED REPORT-LINK RECOVERY — a bounded operator tool, never a runtime
 * guess.
 *
 * A small number of immutable reports printed a `pvs_` verification link
 * whose token row was never stored, so the link they carry answers 404. The
 * token is not a secret derived from anything: it is the exact string the
 * report printed. When — and only when — PROOVRA's own stored report proves
 * which link belongs to which record and version, the token's hash is
 * re-associated with that exact record/version as a REPORT link, which the
 * public route already serves as the record's canonical verification page.
 *
 * Recovery requires ALL of:
 *   - the report object is read from PROOVRA's own storage and its bytes match
 *     the SHA-256 recorded on the report row (no recorded digest → refused);
 *   - every verification link the PDF carries (link annotations AND visible
 *     text) names exactly ONE `pvs_` token, on the canonical verify host/path;
 *   - that token's hash is not already stored for another record;
 *   - the record is eligible for canonical verification (shared rule).
 * It never rewrites, regenerates or replaces a report or package, never prints
 * a token or hash, and is idempotent (an already-stored link is counted, not
 * re-inserted). Each recovery and its admin-audit row commit together.
 */
import type { PrismaClient } from "@prisma/client";

import {
  CANONICAL_VERIFICATION_ELIGIBILITY_SELECT,
  appendAdminAuditChainRowTx,
  hashVerificationShareToken,
  isVerificationShareTokenShape,
  mintVerificationShareTokenTx,
  resolveCanonicalVerificationEligibility,
} from "@proovra/shared-runtime";
import { createHash } from "node:crypto";

import { openPdf } from "./pdf/pdfjs-runtime.js";

export const DEFAULT_REPORT_VERIFY_BASE_URL = "https://app.proovra.com/verify";

/** Every verification URL a PDF carries, from its link annotations and its visible text. */
export async function extractPdfVerifyLinks(bytes: Uint8Array | Buffer): Promise<{ links: string[]; text: string[] }> {
  const doc = (await openPdf(bytes)) as unknown as {
    numPages: number;
    getPage(n: number): Promise<{
      getAnnotations(): Promise<Array<{ url?: string | null }>>;
      getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
    }>;
  };
  const links = new Set<string>();
  const text = new Set<string>();
  const RE = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9/_-]*verify\/(?:package\/)?[A-Za-z0-9_-]+/g;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    for (const a of await page.getAnnotations()) {
      if (typeof a.url === "string" && a.url.includes("/verify/")) links.add(a.url);
    }
    // A printed URL wraps across lines; joined text runs it into the next
    // words, so a `pvs_`/`pvr_` match is cut to exactly one token's length.
    const joined = (await page.getTextContent()).items.map((t) => t.str ?? "").join("");
    for (const m of joined.matchAll(RE)) text.add(trimToToken(m[0]));
  }
  return { links: [...links], text: [...text] };
}

function trimToToken(url: string): string {
  const at = url.lastIndexOf("/verify/");
  const head = url.slice(0, at + "/verify/".length);
  const seg = url.slice(at + "/verify/".length);
  const len = seg.startsWith("pvs_") ? 47 : seg.startsWith("pvr_") ? 31 : seg.length;
  return head + seg.slice(0, len);
}

export type LinkRecoveryDecision =
  | { kind: "NO_SHARE_LINK" }
  | { kind: "AMBIGUOUS" }
  | { kind: "WRONG_HOST" }
  | { kind: "CANDIDATE"; token: string };

/**
 * The one token a report is provably attributable to, or why there is none.
 * Pure: the same inputs always give the same answer.
 */
export function decideReportLinkRecovery(
  found: { links: string[]; text: string[] },
  verifyBaseUrl: string = DEFAULT_REPORT_VERIFY_BASE_URL,
): LinkRecoveryDecision {
  const base = new URL(verifyBaseUrl.replace(/\/+$/, ""));
  const tokens = new Set<string>();
  let wrongHost = false;
  for (const raw of [...found.links, ...found.text]) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const seg = url.pathname.split("/").pop() ?? "";
    if (!seg.startsWith("pvs_")) continue;
    if (url.host !== base.host || url.pathname !== `${base.pathname}/${seg}` || url.search || url.hash) {
      wrongHost = true;
      continue;
    }
    if (isVerificationShareTokenShape(seg)) tokens.add(seg);
  }
  if (tokens.size === 0) return wrongHost ? { kind: "WRONG_HOST" } : { kind: "NO_SHARE_LINK" };
  if (tokens.size > 1 || wrongHost) return { kind: "AMBIGUOUS" };
  return { kind: "CANDIDATE", token: [...tokens][0]! };
}

export type ReadFailureReason = "MISSING_OBJECT" | "STORAGE_PERMISSION" | "STORAGE_READ_FAILED" | "INVALID_PDF" | "OTHER";

/** A read failure's bounded reason (no identifiers). */
export function classifyReadFailure(err: unknown, stage: "storage" | "pdf"): ReadFailureReason {
  if (stage === "pdf") return "INVALID_PDF";
  const e = err as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const code = String(e?.name ?? e?.Code ?? e?.code ?? "");
  const status = e?.$metadata?.httpStatusCode;
  if (/NoSuchKey|NotFound|NoSuchVersion/i.test(code) || status === 404) return "MISSING_OBJECT";
  if (/AccessDenied|Forbidden/i.test(code) || status === 403) return "STORAGE_PERMISSION";
  if (code || status) return "STORAGE_READ_FAILED";
  return "OTHER";
}

export type LinkRecoverySummary = {
  mode: "DRY-RUN" | "APPLY";
  scanned: number;
  readFailed: Record<ReadFailureReason, number>;
  noRecordedDigest: number;
  shaMismatch: number;
  withShareLink: number;
  recoverable: number;
  recovered: number;
  alreadyPresent: number;
  ambiguous: number;
  wrongHost: number;
  refusedConflict: number;
  refusedIneligible: number;
  failed: number;
  /** Bounded review list: record id prefix and report version only. */
  recoverableReview: string[];
};

type Reader = (bucket: string, key: string) => Promise<Buffer>;

export async function recoverOrphanedReportLinks(options: {
  prisma: PrismaClient;
  readObject: Reader;
  apply?: boolean;
  verifyBaseUrl?: string;
  now?: Date;
}): Promise<LinkRecoverySummary> {
  const { prisma } = options;
  const apply = options.apply === true;
  const verifyBaseUrl = options.verifyBaseUrl ?? DEFAULT_REPORT_VERIFY_BASE_URL;
  const s: LinkRecoverySummary = {
    mode: apply ? "APPLY" : "DRY-RUN",
    scanned: 0,
    readFailed: { MISSING_OBJECT: 0, STORAGE_PERMISSION: 0, STORAGE_READ_FAILED: 0, INVALID_PDF: 0, OTHER: 0 },
    noRecordedDigest: 0,
    shaMismatch: 0,
    withShareLink: 0,
    recoverable: 0,
    recovered: 0,
    alreadyPresent: 0,
    ambiguous: 0,
    wrongHost: 0,
    refusedConflict: 0,
    refusedIneligible: 0,
    failed: 0,
    recoverableReview: [],
  };
  const reports = await prisma.report.findMany({
    orderBy: [{ evidenceId: "asc" }, { version: "asc" }],
    select: { evidenceId: true, version: true, storageBucket: true, storageKey: true, pdfSha256: true },
  });
  for (const r of reports) {
    s.scanned += 1;
    let bytes: Buffer;
    try {
      bytes = await options.readObject(r.storageBucket, r.storageKey);
    } catch (err) {
      s.readFailed[classifyReadFailure(err, "storage")] += 1;
      continue;
    }
    if (!r.pdfSha256) {
      s.noRecordedDigest += 1;
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== r.pdfSha256) {
      s.shaMismatch += 1;
      continue;
    }
    let found: { links: string[]; text: string[] };
    try {
      found = await extractPdfVerifyLinks(bytes);
    } catch (err) {
      s.readFailed[classifyReadFailure(err, "pdf")] += 1;
      continue;
    }
    const decision = decideReportLinkRecovery(found, verifyBaseUrl);
    if (decision.kind === "NO_SHARE_LINK") continue;
    s.withShareLink += 1;
    if (decision.kind === "AMBIGUOUS") {
      s.ambiguous += 1;
      continue;
    }
    if (decision.kind === "WRONG_HOST") {
      s.wrongHost += 1;
      continue;
    }
    const tokenHash = hashVerificationShareToken(decision.token);
    const existing = await prisma.verificationShareToken.findUnique({
      where: { tokenHash },
      select: { evidenceId: true },
    });
    if (existing) {
      if (existing.evidenceId === r.evidenceId) s.alreadyPresent += 1;
      else s.refusedConflict += 1;
      continue;
    }
    const evidence = await prisma.evidence.findUnique({
      where: { id: r.evidenceId },
      select: { teamId: true, ...CANONICAL_VERIFICATION_ELIGIBILITY_SELECT },
    });
    if (!resolveCanonicalVerificationEligibility(evidence).eligible) {
      s.refusedIneligible += 1;
      continue;
    }
    s.recoverable += 1;
    if (s.recoverableReview.length < 50) s.recoverableReview.push(`${r.evidenceId.slice(0, 8)}…/v${r.version}`);
    if (!apply) continue;
    try {
      const now = options.now ?? new Date();
      const outcome = await prisma.$transaction(async (tx) => {
        // Re-checked under the transaction: a concurrent run converges.
        const again = await tx.verificationShareToken.findUnique({ where: { tokenHash }, select: { evidenceId: true } });
        if (again) return again.evidenceId === r.evidenceId ? "PRESENT" : "CONFLICT";
        const minted = await mintVerificationShareTokenTx(tx, {
          evidenceId: r.evidenceId,
          teamId: evidence!.teamId ?? null,
          purpose: "REPORT",
          reportVersion: r.version,
          audience: `Report version ${r.version} (recovered from the stored report)`,
          token: decision.token,
          now,
        });
        await appendAdminAuditChainRowTx(
          tx,
          {
            userId: null,
            isPublic: false,
            action: "verification.report_link_recovered",
            category: "verification",
            severity: "info",
            source: "worker",
            outcome: "success",
            resourceType: "evidence_verification",
            resourceId: r.evidenceId,
            requestId: null,
            organizationId: null,
            workspaceId: evidence!.teamId ?? null,
            actorType: "WORKER",
            actorDisplay: "Report link recovery",
            actorAuthority: "worker:verification-link-recovery",
            targetDisplay: `Report version ${r.version}`,
            previousState: "ORPHANED",
            requestedState: null,
            resultingState: "RECOVERED",
            reasonCode: "REPORT_LINK_RECOVERED",
            eventVersion: 2,
            // The link row's id and the report version — never the token or its hash.
            metadata: { linkId: minted.id, reportVersion: r.version, reportSha256: r.pdfSha256 },
            ipAddress: null,
            userAgent: null,
          },
          now,
        );
        return "RECOVERED";
      });
      if (outcome === "RECOVERED") s.recovered += 1;
      else if (outcome === "PRESENT") s.alreadyPresent += 1;
      else s.refusedConflict += 1;
    } catch (err) {
      s.failed += 1;
      console.error(`[verification-link-recovery] FAILED for ${r.evidenceId.slice(0, 8)}…/v${r.version}: ${(err as Error).message}`);
    }
  }
  return s;
}
