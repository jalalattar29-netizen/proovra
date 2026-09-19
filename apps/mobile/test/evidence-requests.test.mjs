/**
 * GUARD — native evidence-requests projection (Master Program §8, E). Parses the
 * authenticated list/detail shape defensively and maps status → an honest tone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/evidence-requests.ts"), "utf8")
  .replace(/^import type .*$/m, "")
  .replace(/^import \{ humanizeEnum \}.*$/m, "function humanizeEnum(v){return v.charAt(0)+v.slice(1).toLowerCase().replace(/_/g,' ');}");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const TONES = new Set(["verified", "pending", "risk", "neutral", "governance", "info"]);

test("parses the list, dropping rows without an id", () => {
  const items = mod.parseEvidenceRequestList({
    requests: [
      { id: "r1", title: "Send photos", status: "OPEN", dueAtUtc: "2026-09-20T00:00:00Z" },
      { title: "no id" },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Send photos");
});

test("parses detail with deliverables; null when no request", () => {
  const d = mod.parseEvidenceRequestDetail({
    request: {
      id: "r1", title: "Send photos", status: "IN_PROGRESS", instructions: "Please upload",
      deliverables: [
        { id: "d1", title: "Front photo", required: true, status: "PENDING", fulfilledCount: 0 },
        { title: "bad" },
      ],
    },
  });
  assert.equal(d.instructions, "Please upload");
  assert.equal(d.deliverables.length, 1);
  assert.equal(d.deliverables[0].required, true);
  assert.equal(mod.parseEvidenceRequestDetail({}), null);
});

test("every status maps to a legal tone; unknown → neutral", () => {
  for (const st of mod.EVIDENCE_REQUEST_STATUSES) {
    const d = mod.requestStatusDisplay(st);
    assert.ok(TONES.has(d.tone), `${st} → ${d.tone}`);
    assert.ok(d.label.length > 0);
  }
  assert.equal(mod.requestStatusDisplay("FULFILLED").tone, "verified");
  assert.equal(mod.requestStatusDisplay("SOMETHING_NEW").tone, "neutral");
});
