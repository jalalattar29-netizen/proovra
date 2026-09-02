/**
 * SHOW WHICH SIGNING KEY, WITHOUT SHOWING THE ACCOUNT IT LIVES IN.
 *
 * ===========================================================================
 * THE DEFECT THIS FIXES
 * ===========================================================================
 * `/admin/platform/signers` rendered `signer.kmsKeyArn` verbatim, in a table
 * row labelled "KMS alias / ARN reference". A KMS ARN looks like:
 *
 *     arn:aws:kms:eu-west-1:123456789012:key/9f2c1a44-…-b7e3
 *
 * Three of those five segments are infrastructure detail that no signer-page
 * task needs: the partition, the AWS ACCOUNT ID, and the full key UUID. The
 * account id in particular is the one value in that string that is useful to
 * somebody who should not have it, and platform-operations visibility is not
 * authorization to publish it into a browser.
 *
 * ===========================================================================
 * WHAT THE PAGE ACTUALLY NEEDS
 * ===========================================================================
 * Two questions, and no more:
 *
 *   "which key is this signer using?"      → the alias, or a stable short id
 *   "are these two signers on one key?"    → the same short id compares equal
 *
 * An ALIAS arn already carries a human name (`alias/proovra-signing-prod`),
 * which is the best possible answer and is not sensitive — it is a label
 * somebody chose. A KEY arn has no name, so it degrades to the first eight
 * characters of the key id, which still answers both questions.
 *
 * The region is kept. It is not a secret, it is on every status page, and it
 * is load-bearing during an incident: a signer in the wrong region is a real
 * finding an operator must be able to see.
 *
 * ===========================================================================
 * WHAT THIS IS NOT
 * ===========================================================================
 * Not a security boundary. The value is redacted at RENDER, so it is still in
 * the JSON the page fetched, and anyone who can open devtools can read it.
 * Removing it from the API projection is the real fix and belongs to the API.
 * This stops it being displayed, over the shoulder and in screenshots, which
 * is where it was actually leaking.
 */

export type KmsReference = {
  /** Safe to render. Never contains the account id. */
  display: string;
  /** True when the original was an ARN we understood and reduced. */
  redacted: boolean;
};

const ARN = /^arn:([^:]*):kms:([^:]*):([^:]*):(.+)$/;

export function redactKmsKeyReference(
  raw: string | null | undefined,
): KmsReference | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return null;

  const m = ARN.exec(value);
  if (!m) {
    // Not an ARN. It is already an alias, a key id, or something local.
    //
    // An alias is a name and stays whole. Anything else is treated as an
    // opaque identifier and shortened, because a value we cannot parse is
    // exactly the value we should not assume is safe to print in full.
    if (value.startsWith("alias/")) return { display: value, redacted: false };
    if (value.length <= 12) return { display: value, redacted: false };
    return { display: `${value.slice(0, 8)}…`, redacted: true };
  }

  const region = m[2] || "unknown-region";
  const resource = m[4] ?? "";

  if (resource.startsWith("alias/")) {
    return { display: `${resource} · ${region}`, redacted: true };
  }

  const keyId = resource.startsWith("key/") ? resource.slice(4) : resource;
  const short = keyId.length > 8 ? `${keyId.slice(0, 8)}…` : keyId;
  return { display: `key ${short} · ${region}`, redacted: true };
}
