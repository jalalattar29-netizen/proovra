/**
 * AUD-012 — the public legal copy states the evidence retention contract the
 * product enforces: ordinary evidence originals under S3 Object Lock in
 * COMPLIANCE mode for a minimum of 2,920 days (eight years) from sealing, not
 * shortenable, legal hold blocks purge. It used to say evidence was kept "per
 * customer-configured retention" and that Object Lock applied "where
 * configured" — which contradicted the product.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (slug: string) =>
  readFileSync(resolve(__dirname, "..", "content", "legal", "en", `${slug}.md`), "utf8");

const DISCLOSING = ["data-retention", "evidence-handling", "security", "toms", "dpa"];

test("every retention-disclosing document states the 2,920-day COMPLIANCE minimum", () => {
  for (const slug of DISCLOSING) {
    const doc = read(slug);
    assert.match(doc, /2,920 days \(eight years\)/, slug);
    assert.match(doc, /COMPLIANCE mode/, slug);
    assert.match(doc, /cannot be shortened/, slug);
    assert.match(doc, /legal hold blocks purge|Records under legal hold are not purged/, slug);
  }
});

test("no document still describes evidence retention as customer-configured or Object Lock as optional", () => {
  for (const slug of DISCLOSING) {
    const doc = read(slug);
    assert.doesNotMatch(doc, /Per customer-configured retention/i, slug);
    assert.doesNotMatch(doc, /Object Lock[^\n]*where configured/i, slug);
    assert.doesNotMatch(doc, /immutability or Object Lock\) where configured/i, slug);
  }
});

test("the contract figure matches the product's retention constant", async () => {
  const { EVIDENCE_OBJECT_RETENTION_DAYS } = await import("@proovra/shared");
  assert.equal(EVIDENCE_OBJECT_RETENTION_DAYS, 2920);
});
