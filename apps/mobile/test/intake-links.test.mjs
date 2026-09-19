/**
 * GUARD — native intake-links projection (Master Program §9, F). Parses the
 * enriched list (item.link.*, lifecycle fallback), maps status→tone, and NEVER
 * surfaces a link URL/token (a server secret). Pure module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/intake-links.ts"), "utf8")
  .replace(/^import type .*$/m, "")
  .replace(/^import \{ humanizeEnum \}.*$/m, "function humanizeEnum(v){return v.charAt(0)+v.slice(1).toLowerCase().replace(/_/g,' ');}");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const TONES = new Set(["verified", "pending", "risk", "neutral", "governance", "info"]);

test("parses enriched items (item.link + lifecycle), drops rows without an id", () => {
  const rows = mod.parseIntakeLinks({
    items: [
      {
        link: { id: "l1", workflowTemplateName: "Incident intake", recipientLabel: "Acme", status: "SENT", usedCount: 1, maxUses: 3, expiresAtUtc: "2026-10-01T00:00:00Z" },
        lifecycle: { state: "OPENED" },
      },
      { link: { workflowTemplateName: "no id" } },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].templateName, "Incident intake");
  assert.equal(rows[0].status, "OPENED"); // lifecycle.state wins over link.status
  assert.equal(rows[0].maxUses, 3);
});

test("the projection carries NO url/token field (server secret)", () => {
  const rows = mod.parseIntakeLinks({ items: [{ link: { id: "l1", status: "ACTIVE" } }] });
  const keys = Object.keys(rows[0]);
  assert.ok(!keys.some((k) => /url|token|secret/i.test(k)), `no url/token key: ${keys.join(",")}`);
});

test("status maps to a legal tone; revoked is risk; unknown neutral", () => {
  assert.ok(TONES.has(mod.intakeStatusDisplay("SENT").tone));
  assert.equal(mod.intakeStatusDisplay("REVOKED").tone, "risk");
  assert.equal(mod.intakeStatusDisplay("SUBMITTED").tone, "verified");
  assert.equal(mod.intakeStatusDisplay("WHATEVER").tone, "neutral");
});

test("empty/garbage envelope → empty list", () => {
  assert.deepEqual(mod.parseIntakeLinks(null), []);
  assert.deepEqual(mod.parseIntakeLinks({}), []);
});
