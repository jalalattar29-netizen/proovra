/**
 * G7 — public claims state what the product does (AUD-0005, AUD-0006,
 * AUD-0007, AUD-0009). Each assertion ties the page text to the fact in code.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

test("AUD-0005 — Object Lock is included on every plan, as the storage applies it (8 years, COMPLIANCE)", () => {
  const lifecycle = read("packages/shared/src/evidence-retention-lifecycle.ts");
  assert.match(lifecycle, /2920|2,920/);
  const pricing = read("apps/web/app/pricing/page.tsx");
  const row = pricing.slice(pricing.indexOf('label: "Object Lock / immutable storage (8 years)"'));
  assert.ok(row.length > 0, "the Object Lock row exists");
  const values = row.slice(row.indexOf("values: ["), row.indexOf("]") + 1);
  assert.equal((values.match(/"Included"/g) ?? []).length, 5, values);
  assert.doesNotMatch(values, /Not included/);
});

test("AUD-0006 — no end-to-end or AES-256-in-transit claim; transport and storage encryption are named", () => {
  const platform = read("apps/web/app/platform/page.tsx");
  assert.doesNotMatch(platform, /End-to-End Encryption/);
  assert.doesNotMatch(platform, /AES-256 encryption at rest and in transit/);
  assert.match(platform, /TLS in transit; storage-provider encryption at rest/);
  const mobile = read("apps/mobile/src/ui/capture-intro.tsx");
  assert.doesNotMatch(mobile, /title: "End-to-end protected"/);
});

test("AUD-0007 — every key-gated media provider the code integrates is in the register", () => {
  const disclosure = read("services/api/src/services/ai/ai-capability-disclosure.service.ts");
  const register = read("apps/web/content/legal/en/subprocessors.md");
  for (const provider of ["Azure Document Intelligence", "Deepgram"]) {
    assert.match(disclosure, new RegExp(provider));
  }
  assert.match(register, /\| Microsoft Azure — AI Document Intelligence \|/);
  assert.match(register, /\| Deepgram \|/);
});

test("AUD-0009 — no certification heading while the certification registry is empty", () => {
  const registry = read("apps/web/lib/marketing/certifications.ts");
  const section = read("apps/web/components/marketing/IntegrationsComplianceSection.tsx");
  if (/RECORDED_CERTIFICATIONS[^=]*=\s*\[\s*\]/.test(registry)) {
    assert.doesNotMatch(section, /Certifications/);
  }
});
