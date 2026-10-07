/**
 * Validation of a KEPT timestamp token (ET-TSA-09).
 *
 * The provider is never re-contacted for finalized evidence (see the TSA
 * no-retry gate), so a reply that could not be validated when it arrived — no
 * anchor configured yet, or a legacy STAMPED row written before validation
 * existed — can only ever be validated from the bytes that were kept.
 *
 * This is the one decision the operator CLI (scripts/repair-tsa-failed-with-token.ts)
 * applies per row. It uses the SAME parser and the SAME validator as issuance;
 * the only difference is that the original query (and so its nonce) is gone,
 * so the token is checked against the digest the record sent and at its own
 * genTime.
 *
 * Preconditions for a positive answer, all required:
 *   - the reply is granted and carries a token;
 *   - its imprint equals the digest the record sent;
 *   - serial number AND genTime parse (the CLI's documented precondition,
 *     which it never used to enforce);
 *   - validate-tsa-token.ts accepts it.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { TsaValidationEvidence } from "@proovra/shared";

import { parseTsaReply } from "./parse-tsa-reply.js";
import { validateTsaToken } from "./validate-tsa-token.js";

const run = promisify(execFile);

export type KeptTokenDecision =
  | {
      ok: true;
      serialNumber: string;
      genTimeUtc: Date;
      messageImprint: string;
      policyOid: string | null;
      validatedAtUtc: Date;
      signerCertSha256: string | null;
      validationEvidence: TsaValidationEvidence;
    }
  | { ok: false; code: string; reason: string };

export async function evaluateKeptTsaToken(row: {
  tsaTokenBase64: string | null;
  tsaInputDigestHex: string | null;
  fileSha256: string | null;
}): Promise<KeptTokenDecision> {
  const refuse = (code: string, reason: string): KeptTokenDecision => ({ ok: false, code, reason });
  if (!row.tsaTokenBase64) return refuse("tsa_token_missing", "No timestamp token was kept for this record.");
  const digest = (row.tsaInputDigestHex ?? row.fileSha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    return refuse("tsa_request_digest_unknown", "The digest this record sent to the timestamp authority is not recorded.");
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "tsa-kept-"));
  const responseFile = path.join(workDir, "kept.tsr");
  try {
    await fs.writeFile(responseFile, Buffer.from(row.tsaTokenBase64, "base64"));
    let stdout: string;
    try {
      ({ stdout } = await run("openssl", ["ts", "-reply", "-in", responseFile, "-text"], { timeout: 15_000 }));
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").toLowerCase();
      return stderr.includes("token not present")
        ? refuse("tsa_token_missing", "The kept reply is granted but carries no timestamp token.")
        : refuse("tsa_response_parse_failed", "The kept reply could not be read.");
    }
    const parsed = parseTsaReply(stdout, digest);
    if (!parsed.granted) {
      return refuse(parsed.failureCode ?? "tsa_response_parse_failed", parsed.failureReason ?? "The kept reply is not a granted timestamp.");
    }
    if (!parsed.serialNumber || !parsed.genTimeUtc || !parsed.messageImprintHex) {
      return refuse("tsa_missing_serial_or_generation_time", "The kept token's serial number or generation time could not be read.");
    }
    const validation = await validateTsaToken({
      responseFile,
      digestHex: digest,
      workDir,
      genTimeUtc: parsed.genTimeUtc,
      policyOid: parsed.policyOid,
    });
    if (!validation.ok) return refuse(validation.code, validation.reason);
    return {
      ok: true,
      serialNumber: parsed.serialNumber,
      genTimeUtc: parsed.genTimeUtc,
      messageImprint: parsed.messageImprintHex,
      policyOid: validation.policyOid,
      validatedAtUtc: validation.validatedAtUtc,
      signerCertSha256: validation.signerCertSha256,
      validationEvidence: validation.evidence,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
