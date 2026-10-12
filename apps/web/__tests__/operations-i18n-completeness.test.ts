/**
 * D10 — every Operations string exists, and is non-empty, in en, de and ar.
 *
 * The Operations dictionary is type-checked for SHAPE, but a type cannot
 * stop an empty string, and a nested record (severity, status, SLA, the
 * health page, the roll-up) is easy to leave half-written. This walks every
 * leaf of the English dictionary and requires the same leaf, non-empty, in
 * German and Arabic — and that a translated leaf keeps every `{placeholder}`
 * its English source fills.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { operationsDict, operationsCopyFor } from "@proovra/shared/i18n";

type Leaf = { path: string; value: unknown };

function leaves(node: unknown, path = ""): Leaf[] {
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      leaves(v, path ? `${path}.${k}` : k),
    );
  }
  return [{ path, value: node }];
}

function at(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined),
    root,
  );
}

const placeholders = (s: string) => new Set(Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]));

const EN = leaves(operationsDict.en);

test("the English Operations dictionary is non-trivial and has no empty string", () => {
  assert.ok(EN.length > 300, `expected the full vocabulary, found ${EN.length} keys`);
  for (const { path, value } of EN) {
    assert.equal(typeof value, "string", `en.${path} is not a string`);
    assert.ok((value as string).trim().length > 0, `en.${path} is empty`);
  }
});

for (const locale of ["de", "ar"] as const) {
  test(`every Operations key is present and non-empty in ${locale}`, () => {
    const dict = operationsDict[locale];
    const missing: string[] = [];
    for (const { path, value } of EN) {
      const v = at(dict, path);
      if (typeof v !== "string" || v.trim().length === 0) {
        missing.push(path);
        continue;
      }
      for (const p of placeholders(value as string)) {
        assert.ok(v.includes(`{${p}}`), `${locale}.${path} drops the {${p}} placeholder`);
      }
    }
    assert.deepEqual(missing, [], `${locale} is missing or empty at these keys`);
    // And no extra, untranslated-only keys either way.
    assert.equal(leaves(dict).length, EN.length, `${locale} has a different number of keys than en`);
  });

  test(`${locale} is actually translated, not a copy of English`, () => {
    const dict = operationsDict[locale];
    const same = EN.filter(({ path, value }) => at(dict, path) === value).map((l) => l.path);
    // Identifiers and proper nouns ("Info", "Job", "Trace", "Webhook"-style
    // tokens) may legitimately match; the bulk of the vocabulary may not.
    assert.ok(same.length < EN.length * 0.05, `${locale} repeats English at: ${same.join(", ")}`);
  });
}

test("an unwritten locale reads English rather than a half-translated page", () => {
  assert.equal(operationsCopyFor("fr"), operationsDict.en);
  assert.equal(operationsCopyFor("de"), operationsDict.de);
});
