/**
 * UC-LCH-002 — capture monitoring lint.
 *
 *   * every EVIDENCE_ACQUISITION_MODE has a failure-rate rule;
 *   * the three contract-break denial codes each have a rule;
 *   * every rule's counter exists in the bounded registry (COUNTER_NAMES) —
 *     an alert on a counter nothing bumps is a silent alert;
 *   * every rule links a runbook anchor that exists;
 *   * counters have no series until first increment, so NoData must be OK.
 *
 * Lives in the web suite because it is the suite that already imports
 * @proovra/shared; the counter registry is read as text so this test needs no
 * dependency on @proovra/shared-runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EVIDENCE_ACQUISITION_MODES } from "@proovra/shared";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const RULES = read("infra/grafana/alerts/proovra-capture-alerts.yaml");
const RUNBOOK = read("docs/operations/capture-runbook.md");
const METRICS = read("packages/shared-runtime/src/ops/metrics.service.ts");

type Rule = { uid: string; block: string };
function rules(): Rule[] {
  const parts = RULES.split(/\n(?=      - uid: )/).slice(1);
  return parts.map((block) => ({ uid: /- uid: (\S+)/.exec(block)![1], block }));
}
const kebab = (m: string) => m.toLowerCase().replace(/_/g, "-");

function counterNames(): Set<string> {
  const start = METRICS.indexOf("export const COUNTER_NAMES = [");
  const end = METRICS.indexOf("] as const;", start);
  assert.ok(start > -1 && end > start, "COUNTER_NAMES catalog not found");
  return new Set([...METRICS.slice(start, end).matchAll(/^\s*"([a-z0-9_]+)",/gm)].map((m) => m[1]));
}

test("the rules file parses into a non-trivial rule list", () => {
  assert.ok(rules().length >= EVIDENCE_ACQUISITION_MODES.length + 3);
});

test("every acquisition mode has a failure-rate rule", () => {
  const uids = new Set(rules().map((r) => r.uid));
  const missing = EVIDENCE_ACQUISITION_MODES.filter(
    (m) => !uids.has(`proovra-capture-failed-${kebab(m)}`),
  );
  assert.deepEqual(missing, [], `acquisition modes without a failure-rate rule: ${missing.join(", ")}`);
  for (const mode of EVIDENCE_ACQUISITION_MODES) {
    const rule = rules().find((r) => r.uid === `proovra-capture-failed-${kebab(mode)}`)!;
    assert.match(rule.block, new RegExp(`capture_failed_${mode.toLowerCase()}_total`));
    assert.match(rule.block, /rate\(/, `${mode}: a failure RATE rule`);
  }
});

test("the contract-break denial codes each have a rule", () => {
  const uids = rules().map((r) => r.uid);
  for (const uid of [
    "proovra-capture-continuous-manifest-invalid",
    "proovra-capture-screen-manifest-invalid",
    "proovra-capture-extension-oauth-failed",
  ]) {
    assert.ok(uids.includes(uid), `missing ${uid}`);
  }
});

test("every rule links an existing runbook anchor and treats NoData as OK", () => {
  for (const { uid, block } of rules()) {
    const anchor = /runbook_url: docs\/operations\/capture-runbook\.md#(\S+)/.exec(block)?.[1];
    assert.ok(anchor, `${uid}: runbook_url missing`);
    assert.ok(RUNBOOK.includes(`## ${anchor}\n`), `${uid}: runbook anchor ## ${anchor} missing`);
    assert.match(block, /noDataState: OK/, `${uid}: counters start empty; NoData must not page`);
  }
});

test("every counter a capture rule reads exists in the bounded registry", () => {
  const registry = counterNames();
  const missing = new Set<string>();
  for (const { block } of rules()) {
    for (const tok of block.match(/[a-z][a-z0-9_]+_total\b/g) ?? []) {
      if (!registry.has(tok)) missing.add(tok);
    }
  }
  assert.deepEqual(
    [...missing],
    [],
    `capture alert counters not in COUNTER_NAMES (nothing bumps them, so the alert is silent): ${[...missing].join(", ")}`,
  );
});
