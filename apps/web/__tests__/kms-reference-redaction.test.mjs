/**
 * THE SIGNER PAGE MUST NOT PRINT AN AWS ACCOUNT ID.
 *
 * `/admin/platform/signers` rendered `kmsKeyArn` verbatim. The account id sits
 * in the middle of every ARN, and it is the one segment in that string that is
 * worth something to somebody who should not have it.
 *
 * These cases are the shapes the field actually takes, plus the ones it should
 * not be assumed never to take.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "apps/web/lib/privacy/kms-reference.ts");

/** The module is TypeScript with no runtime deps; strip the types and run it. */
async function load() {
  const ts = readFileSync(SRC, "utf8");
  const js = ts
    .replace(/^export type[\s\S]*?\n\};\n/m, "")
    .replace(/:\s*string \| null \| undefined/g, "")
    .replace(/\)\s*:\s*KmsReference \| null\s*\{/, ") {");
  const mod = await import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
  return mod.redactKmsKeyReference;
}

test("a key ARN loses the account id and keeps the region", async () => {
  const redact = await load();
  const out = redact(
    "arn:aws:kms:eu-west-1:123456789012:key/9f2c1a44-7b30-4de1-9c55-0a1b2c3d4e5f",
  );
  assert.equal(out.display, "key 9f2c1a44… · eu-west-1");
  assert.equal(out.redacted, true);
  assert.ok(!out.display.includes("123456789012"), "account id leaked");
});

test("an alias ARN keeps the human name, which is the useful part", async () => {
  const redact = await load();
  const out = redact("arn:aws:kms:us-east-2:999988887777:alias/proovra-signing-prod");
  assert.equal(out.display, "alias/proovra-signing-prod · us-east-2");
  assert.ok(!out.display.includes("999988887777"));
});

test("two signers on one key still compare equal after redaction", async () => {
  // The page's second job. A redaction that collapsed every key to the same
  // string would hide a real finding: two signers that should be independent.
  const redact = await load();
  const a = redact("arn:aws:kms:eu-west-1:1:key/aaaaaaaa-0000-0000-0000-000000000000");
  const b = redact("arn:aws:kms:eu-west-1:1:key/aaaaaaaa-0000-0000-0000-000000000000");
  const c = redact("arn:aws:kms:eu-west-1:1:key/bbbbbbbb-0000-0000-0000-000000000000");
  assert.equal(a.display, b.display);
  assert.notEqual(a.display, c.display);
});

test("a bare alias is not mangled", async () => {
  const redact = await load();
  assert.deepEqual(redact("alias/local-dev"), {
    display: "alias/local-dev",
    redacted: false,
  });
});

test("an unparseable value is shortened rather than trusted", async () => {
  // A value we cannot parse is exactly the value not to print in full.
  const redact = await load();
  const out = redact("some-unexpected-opaque-secret-material-value");
  assert.equal(out.display, "some-une…");
  assert.equal(out.redacted, true);
});

test("empty and null produce no row at all", async () => {
  const redact = await load();
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), null);
  assert.equal(redact("   "), null);
});
