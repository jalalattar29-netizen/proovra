/**
 * THE ONE RFC 3161 TOKEN VALIDATOR (ET-TSA-01, owner decision 5).
 *
 * A timestamp reply is only a claim until its token is validated. Until
 * 2026-09-29 the platform read the reply's TEXT (status line, imprint dump) and
 * persisted STAMPED — so anyone able to answer the TSA HTTP request (a
 * misconfigured TSA_URL, a proxy replaying a cached reply, a forged
 * self-signed "authority") could make PROOVRA certify an arbitrary genTime.
 *
 * `validateTsaToken` is the only function that may turn a granted reply into a
 * VALIDATED timestamp. It delegates the cryptography to `openssl ts -verify`,
 * which checks, in one pass:
 *   - the CMS signature over TSTInfo;
 *   - the signer certificate chain to the CONFIGURED trust anchor (never the
 *     system store: `-CAfile` is the only anchor);
 *   - the signer's timeStamping extended key usage;
 *   - signer validity at genTime (`-attime`), so a token signed by an
 *     expired or not-yet-valid certificate fails;
 *   - the message imprint and — when the query is supplied — the nonce, so a
 *     genuine token replayed for another request fails.
 * The accepted-policy check is ours (TSA_ACCEPTED_POLICY_OIDS, optional).
 *
 * TRUST CONFIGURATION CONTRACT (evidence-output incident, 2026-10-05):
 *   - TSA_TRUST_BUNDLE_PATH — REQUIRED. The installed official CA chain (root +
 *     the TSA's issuing CA) IS the trust authority: openssl anchors on it alone,
 *     never on a certificate the token carries. It must contain at least one
 *     self-signed root (partial chains are not accepted).
 *   - TSA_TRUST_ANCHOR_SHA256 — OPTIONAL additional pin. Fingerprints are
 *     computed from the installed bundle; when a pin is configured, EVERY root
 *     in the bundle must be pinned (intermediates need not be). It was mandatory
 *     in production, which duplicated the bundle and — because it demanded a
 *     pin for every certificate — refused a root+intermediate bundle pinned by
 *     its root.
 *   - TSA_ACCEPTED_POLICY_OIDS — OPTIONAL allowlist. The signed TSTInfo policy
 *     OID is always parsed and recorded (tsaPolicyOid); the list is enforced
 *     only when configured. It was mandatory in production although no
 *     provider contract supplies one.
 *
 * Trust anchors are ENVIRONMENT-SPECIFIC (TSA_TRUST_BUNDLE_PATH). Unset means
 * FAIL CLOSED: the token is kept, the record says FAILED with
 * `tsa_trust_anchor_not_configured`, and the validation CLI can validate the
 * kept token once an anchor is configured. A test anchor — any certificate
 * whose subject carries TEST_TSA_ANCHOR_SUBJECT_MARKER — is refused in
 * Production by identity, so a test bundle mounted by mistake cannot certify
 * anything there.
 *
 * Callers: timestamp.service.ts (issuance, with the query file) and
 * scripts/repair-tsa-failed-with-token.ts (later validation of a kept token,
 * with the digest and the token's genTime). Nothing else decides validity.
 */
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Subject marker carried by every locally minted test trust anchor. */
export const TEST_TSA_ANCHOR_SUBJECT_MARKER = "PROOVRA-TEST-TSA-ANCHOR";

const TIME_STAMPING_EKU = "1.3.6.1.5.5.7.3.8";

export type TsaValidationFailureCode =
  | "tsa_trust_anchor_not_configured"
  | "tsa_trust_anchor_refused"
  | "tsa_token_untrusted"
  | "tsa_token_signature_invalid"
  | "tsa_nonce_mismatch"
  | "tsa_message_imprint_mismatch"
  | "tsa_policy_not_accepted";

export type TsaValidationResult =
  | {
      ok: true;
      validatedAtUtc: Date;
      signerCertSha256: string | null;
      policyOid: string | null;
    }
  | { ok: false; code: TsaValidationFailureCode; reason: string };

const REASONS: Record<TsaValidationFailureCode, string> = {
  tsa_trust_anchor_not_configured:
    "The timestamp token was received but could not be validated: no timestamp trust anchor is configured for this environment.",
  tsa_trust_anchor_refused:
    "The timestamp token was not accepted: the configured trust anchor is a test certificate, which is never accepted in production.",
  tsa_token_untrusted:
    "The timestamp token was not accepted: its signer does not chain to the configured trust anchor or was not valid at the stamped time.",
  tsa_token_signature_invalid:
    "The timestamp token was not accepted: its signature did not verify.",
  tsa_nonce_mismatch:
    "The timestamp token was not accepted: it answers a different request (nonce mismatch).",
  tsa_message_imprint_mismatch:
    "The timestamp token was not accepted: it certifies a different digest than the one requested.",
  tsa_policy_not_accepted:
    "The timestamp token was not accepted: its policy is not one this environment accepts.",
};

export function tsaValidationReason(code: TsaValidationFailureCode): string {
  return REASONS[code];
}

function fail(code: TsaValidationFailureCode): TsaValidationResult {
  return { ok: false, code, reason: REASONS[code] };
}

/**
 * UC-TRUST-006 — production is NODE_ENV=production OR PROOVRA_ENV naming
 * production. The test-anchor refusal and the policy requirement used to key
 * on NODE_ENV alone.
 */
export function isTsaProductionEnv(env: NodeJS.ProcessEnv): boolean {
  const node = (env.NODE_ENV ?? "").trim().toLowerCase();
  const proovra = (env.PROOVRA_ENV ?? "").trim().toLowerCase();
  return node === "production" || proovra === "production" || proovra === "prod";
}
const isProduction = isTsaProductionEnv;

/** TSA_TRUST_ANCHOR_SHA256 — comma-separated SHA-256 fingerprints the bundle's anchors must match. */
function pinnedAnchorFingerprints(env: NodeJS.ProcessEnv): string[] {
  return (env.TSA_TRUST_ANCHOR_SHA256 ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/:/g, ""))
    .filter(Boolean);
}

function splitPem(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/** The exact, bounded reason a trust bundle cannot be used (readiness names it). */
export type TsaTrustBundleIssue =
  | "tsa_trust_bundle_path_not_set"
  | "tsa_trust_bundle_unreadable"
  | "tsa_trust_bundle_no_certificates"
  | "tsa_trust_bundle_no_root"
  | "tsa_trust_anchor_test_certificate"
  | "tsa_trust_anchor_pin_mismatch";

export type TsaTrustBundleInspection =
  | {
      ok: true;
      path: string;
      /** SHA-256 (lower hex) of every certificate in the bundle, computed here. */
      certificateSha256: string[];
      /** SHA-256 of the bundle's self-signed roots — the anchors openssl ends on. */
      rootSha256: string[];
    }
  | { ok: false; issue: TsaTrustBundleIssue; rootSha256?: string[] };

const fp = (c: X509Certificate) => c.fingerprint256.replace(/:/g, "").toLowerCase();

function isSelfSignedRoot(c: X509Certificate): boolean {
  try {
    return c.checkIssued(c) && c.verify(c.publicKey);
  } catch {
    return false;
  }
}

/**
 * Read the installed bundle and decide whether it can anchor validation. Pure
 * reads: no network, nothing written. The pin, when configured, must cover
 * every self-signed root in the bundle.
 */
export async function inspectTsaTrustBundle(env: NodeJS.ProcessEnv = process.env): Promise<TsaTrustBundleInspection> {
  const p = env.TSA_TRUST_BUNDLE_PATH?.trim();
  if (!p) return { ok: false, issue: "tsa_trust_bundle_path_not_set" };
  let text: string;
  try {
    text = await readFile(p, "utf8");
  } catch {
    return { ok: false, issue: "tsa_trust_bundle_unreadable" };
  }
  let certs: X509Certificate[];
  try {
    certs = splitPem(text).map((pem) => new X509Certificate(pem));
  } catch {
    return { ok: false, issue: "tsa_trust_bundle_unreadable" };
  }
  if (certs.length === 0) return { ok: false, issue: "tsa_trust_bundle_no_certificates" };
  const roots = certs.filter(isSelfSignedRoot);
  const rootSha256 = roots.map(fp);
  if (roots.length === 0) return { ok: false, issue: "tsa_trust_bundle_no_root" };
  if (isProduction(env) && certs.some((c) => c.subject.includes(TEST_TSA_ANCHOR_SUBJECT_MARKER))) {
    return { ok: false, issue: "tsa_trust_anchor_test_certificate", rootSha256 };
  }
  const pins = pinnedAnchorFingerprints(env);
  if (pins.length > 0 && !rootSha256.every((r) => pins.includes(r))) {
    return { ok: false, issue: "tsa_trust_anchor_pin_mismatch", rootSha256 };
  }
  return { ok: true, path: p, certificateSha256: certs.map(fp), rootSha256 };
}

async function resolveTrustAnchor(
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; path: string } | { ok: false; code: TsaValidationFailureCode }> {
  const inspection = await inspectTsaTrustBundle(env);
  if (inspection.ok) return { ok: true, path: inspection.path };
  // A test certificate or a pin the bundle does not satisfy is a REFUSAL of
  // the anchor; every other issue means there is no usable anchor.
  return {
    ok: false,
    code:
      inspection.issue === "tsa_trust_anchor_test_certificate" || inspection.issue === "tsa_trust_anchor_pin_mismatch"
        ? "tsa_trust_anchor_refused"
        : "tsa_trust_anchor_not_configured",
  };
}

function acceptedPolicies(env: NodeJS.ProcessEnv): string[] {
  return (env.TSA_ACCEPTED_POLICY_OIDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Bounded classification of `openssl ts -verify` diagnostics. */
function classifyVerifyFailure(stderr: string): TsaValidationFailureCode {
  const s = stderr.toLowerCase();
  if (s.includes("nonce")) return "tsa_nonce_mismatch";
  if (s.includes("message imprint mismatch")) return "tsa_message_imprint_mismatch";
  if (
    s.includes("certificate verify error") ||
    s.includes("unable to get local issuer") ||
    s.includes("self-signed") ||
    s.includes("self signed") ||
    s.includes("certificate has expired") ||
    s.includes("not yet valid") ||
    s.includes("unsupported certificate purpose") ||
    s.includes("invalid signer certificate purpose") ||
    s.includes("ess signing certificate error")
  ) {
    return "tsa_token_untrusted";
  }
  return "tsa_token_signature_invalid";
}

async function signerFingerprint(responseFile: string, workDir: string): Promise<string | null> {
  const tokenFile = path.join(workDir, "token.der");
  try {
    await run("openssl", ["ts", "-reply", "-in", responseFile, "-token_out", "-out", tokenFile], { timeout: 20_000 });
    const { stdout } = await run("openssl", ["pkcs7", "-inform", "DER", "-in", tokenFile, "-print_certs"], { timeout: 20_000 });
    for (const pem of splitPem(stdout)) {
      const cert = new X509Certificate(pem);
      if (Array.isArray(cert.keyUsage) && cert.keyUsage.includes(TIME_STAMPING_EKU)) {
        return cert.fingerprint256.replace(/:/g, "").toLowerCase();
      }
    }
  } catch {
    // The token already verified; an unreadable certificate list only means
    // the fingerprint projection stays empty.
  }
  return null;
}

export async function validateTsaToken(input: {
  responseFile: string;
  workDir: string;
  /** The query we sent — lets openssl check the nonce too. Preferred. */
  queryFile?: string;
  /** Used when the query is gone (later validation of a kept token). */
  digestHex?: string;
  genTimeUtc: Date | null;
  policyOid: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<TsaValidationResult> {
  const env = input.env ?? process.env;
  const anchor = await resolveTrustAnchor(env);
  if (!anchor.ok) return fail(anchor.code);

  const policies = acceptedPolicies(env);
  // The allowlist is enforced when configured. Unconfigured, the token's
  // signed policy OID is still parsed, returned and recorded (tsaPolicyOid);
  // trust rests on the installed CA chain, not on a list no provider supplied.
  if (policies.length > 0 && (!input.policyOid || !policies.includes(input.policyOid))) {
    return fail("tsa_policy_not_accepted");
  }
  // UC-TRUST-006 — without a parsed genTime the signer's validity can only be
  // checked "now", not at the stamped time; such a token is not validated.
  if (!input.genTimeUtc) {
    return fail("tsa_token_untrusted");
  }

  const args = ["ts", "-verify", "-in", input.responseFile, "-CAfile", anchor.path];
  if (input.queryFile) args.push("-queryfile", input.queryFile);
  else if (input.digestHex) args.push("-digest", input.digestHex);
  else throw new Error("validateTsaToken: queryFile or digestHex is required");
  if (input.genTimeUtc) args.push("-attime", String(Math.floor(input.genTimeUtc.getTime() / 1000)));

  try {
    const { stdout } = await run("openssl", args, { timeout: 20_000 });
    if (!/Verification:\s*OK/i.test(stdout)) return fail("tsa_token_signature_invalid");
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return fail(classifyVerifyFailure(`${e.stdout ?? ""}\n${e.stderr ?? ""}`));
  }

  return {
    ok: true,
    validatedAtUtc: new Date(),
    signerCertSha256: await signerFingerprint(input.responseFile, input.workDir),
    policyOid: input.policyOid,
  };
}

/**
 * UC-TRUST-006 — what a readiness check reports about the RFC 3161 trust
 * configuration, without contacting anything. Empty = ready. Readiness and
 * the operations surface call this so a production deploy without an anchor or
 * a policy list is seen BEFORE every timestamp silently records FAILED.
 */
/**
 * THE one reading of TSA_ENABLED. The timestamp service and the readiness check
 * used to read it differently ("true" only, untrimmed vs "true" or "1",
 * trimmed), so `TSA_ENABLED=1` made /readyz report trust problems for a TSA
 * that was not running, and ` true` did the opposite.
 */
export function isTsaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.TSA_ENABLED ?? "").trim().toLowerCase();
  return value === "true" || value === "1";
}

export async function tsaTrustConfigurationIssues(env: NodeJS.ProcessEnv = process.env): Promise<TsaTrustBundleIssue[]> {
  if (!isTsaEnabled(env)) return [];
  // The minimum secure configuration is a readable official bundle with a
  // root (and, when configured, satisfying the pin). The policy allowlist and
  // the pin are optional additions, never readiness requirements.
  const inspection = await inspectTsaTrustBundle(env);
  return inspection.ok ? [] : [inspection.issue];
}

/** Writes a curl config carrying the credentials, so they never enter argv. */
export async function writeCurlCredentialConfig(file: string, username: string, password: string): Promise<void> {
  const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  await writeFile(file, `user = ${quote(`${username}:${password}`)}\n`, { mode: 0o600 });
}
