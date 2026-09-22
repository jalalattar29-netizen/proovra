/**
 * GUARD — the domain enum VALUES are derived from the Prisma schema.
 *
 * `domain-display.ts` used to redeclare five Prisma enums verbatim (its own
 * header said so). `domain-display.test.mjs` asserted the native table was
 * internally complete — it never read `schema.prisma` — so a value added
 * canonically could not fail anything and would render as an unmapped raw
 * string. Deriving the values turned that into a compile error, and on the very
 * first run it found one: `TRASHED` had been missing from the lifecycle table
 * all along.
 *
 * Labels and tones stay authored (they are presentation, and the backend
 * already returns human labels for list/detail). What this proves is that no
 * canonical value can exist without a native mapping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

import {
  generate,
  readEnum,
  DERIVED_ENUMS,
  OUT_TS,
  SCHEMA,
  DERIVED_SHARED_TUPLES,
  readSharedTuple,
  SHARED_COLLABORATION,
} from "../tools/generate-domain-enums.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(SCHEMA, "utf8");

/** Load domain-display for real, with its native-only imports stubbed. */
async function loadDisplay() {
  const src = readFileSync(resolve(HERE, "../src/product/domain-display.ts"), "utf8")
    .replace(/import type \{ ProovraStatusTone \} from "@proovra\/ui";/, "")
    .replace(/from "\.\/domain-enums\.generated"/g, `from "${
      "data:text/javascript," +
      encodeURIComponent(
        ts.transpileModule(readFileSync(OUT_TS, "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      )
    }"`);
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

test("the checked-in enum module matches a fresh generation", () => {
  assert.equal(
    readFileSync(OUT_TS, "utf8"),
    generate().source,
    "domain-enums.generated.ts is stale — run: node tools/generate-domain-enums.mjs",
  );
});

test("every derived enum is read from the schema and is non-empty", () => {
  for (const [prismaName] of DERIVED_ENUMS) {
    const values = readEnum(schema, prismaName);
    assert.ok(values.length > 0, `${prismaName} parsed as empty`);
    for (const v of values) assert.match(v, /^[A-Z][A-Z0-9_]*$/, `${prismaName}.${v}`);
  }
});

test("schema comments are not parsed as enum members", () => {
  // EvidenceAcquisitionMode and CustodyEventType carry long `//` commentary
  // between members; a naive line scan captures prose as a value.
  const values = readEnum(schema, "EvidenceLifecycleState");
  assert.ok(values.includes("TRASHED"));
  assert.ok(!values.some((v) => v.includes(" ")));
});

test("a missing enum is a loud failure, not an empty list", () => {
  assert.throws(() => readEnum(schema, "NoSuchEnumHere"), /not found/);
});

test("every canonical value has a native label and tone", async () => {
  const d = await loadDisplay();
  const cases = [
    ["EvidenceType", d.evidenceTypeLabel, (r) => typeof r === "string" && r.length > 0],
    ["EvidenceStatus", d.evidenceStatusDisplay, (r) => r.label && r.tone],
    ["VerificationStatus", d.verificationStatusDisplay, (r) => r.label && r.tone],
    ["EvidenceLifecycleState", d.evidenceLifecycleDisplay, (r) => r.label && r.tone],
    ["CaseStatus", d.caseStatusDisplay, (r) => r.label && r.tone],
  ];
  for (const [prismaName, fn, ok] of cases) {
    for (const value of readEnum(schema, prismaName)) {
      const rendered = fn(value);
      assert.ok(ok(rendered), `${prismaName}.${value} has no native mapping`);
      // An unmapped value falls through to the humanizer, which would render
      // "Trashed" instead of the product's word. Catch that too.
      const label = typeof rendered === "string" ? rendered : rendered.label;
      assert.notEqual(
        label,
        value,
        `${prismaName}.${value} is falling through to the raw value`,
      );
    }
  }
});

test("TRASHED renders the scope vocabulary the library uses", async () => {
  const d = await loadDisplay();
  assert.equal(d.evidenceLifecycleDisplay("TRASHED").label, "In trash");
});

test("tones stay inside the canonical badge-tone contract", async () => {
  const d = await loadDisplay();
  const ALLOWED = new Set(["verified", "pending", "risk", "governance", "neutral", "info"]);
  for (const [prismaName] of DERIVED_ENUMS) {
    const fn =
      prismaName === "EvidenceType"
        ? null
        : {
            EvidenceStatus: d.evidenceStatusDisplay,
            VerificationStatus: d.verificationStatusDisplay,
            EvidenceLifecycleState: d.evidenceLifecycleDisplay,
            CaseStatus: d.caseStatusDisplay,
          }[prismaName];
    if (!fn) continue;
    for (const value of readEnum(schema, prismaName)) {
      assert.ok(ALLOWED.has(fn(value).tone), `${prismaName}.${value} uses an unknown tone`);
    }
  }
});

test("domain-display no longer declares the canonical values itself", () => {
  const src = readFileSync(resolve(HERE, "../src/product/domain-display.ts"), "utf8");
  for (const [, constName] of DERIVED_ENUMS) {
    assert.doesNotMatch(
      src,
      new RegExp(`export const ${constName}\\s*=\\s*\\[`),
      `${constName} is declared locally again — it must come from the schema`,
    );
  }
});

/* ------------------------------------------------------------------ carried
 * Behavioural cases carried over from the deleted domain-display.test.mjs.
 * Its coverage assertions compared the module's tables to the module's own
 * exported lists — self-referential, and the reason TRASHED went unnoticed.
 * These four are real behaviour and are kept.
 */

test("evidence types map to human labels", async () => {
  const d = await loadDisplay();
  assert.equal(d.evidenceTypeLabel("PHOTO"), "Photo");
  assert.equal(d.evidenceTypeLabel("DOCUMENT"), "Document");
});

test("unknown values fail safely (humanized, neutral) — never a raw enum badge", async () => {
  const d = await loadDisplay();
  const unknown = d.evidenceStatusDisplay("SOME_NEW_BACKEND_STATE");
  assert.equal(unknown.label, "Some New Backend State");
  assert.equal(unknown.tone, "neutral");
  assert.equal(d.evidenceTypeLabel(null), "File");
  assert.equal(d.caseStatusDisplay(undefined).label, "Unknown");
});

test("integrity honesty — failure is risk, unverified is never 'verified'", async () => {
  const d = await loadDisplay();
  assert.equal(d.verificationStatusDisplay("FAILED").tone, "risk");
  assert.equal(d.evidenceStatusDisplay("FAILED_HASH_MISMATCH").tone, "risk");
  assert.notEqual(d.verificationStatusDisplay("REVIEW_REQUIRED").tone, "verified");
  assert.notEqual(d.verificationStatusDisplay("MATERIALS_AVAILABLE").tone, "verified");
});

/* ------------------------------ values that live in packages/shared, not Prisma */

test("the collaboration assignment vocabulary is read from the shared source", () => {
  const shared = readFileSync(SHARED_COLLABORATION, "utf8");
  for (const [constName] of DERIVED_SHARED_TUPLES) {
    const values = readSharedTuple(shared, constName);
    assert.ok(values.length > 0, `${constName} is empty`);
    // Every value the shared tuple declares must reach the native module, or a
    // new canonical status would render natively as an unmapped string.
    for (const v of values) {
      assert.match(readFileSync(OUT_TS, "utf8"), new RegExp(`"${v}"`));
    }
  }
});

test("a tuple that is not there fails loudly rather than silently emitting nothing", () => {
  const shared = readFileSync(SHARED_COLLABORATION, "utf8");
  assert.throws(() => readSharedTuple(shared, "NO_SUCH_TUPLE"), /not found/);
});

test("the three assignment tuples carry exactly the canonical values", () => {
  const shared = readFileSync(SHARED_COLLABORATION, "utf8");
  assert.deepEqual(readSharedTuple(shared, "COLLABORATION_TEAM_ASSIGNMENT_TARGETS"), [
    "CASE",
    "EVIDENCE",
    "REVIEW",
  ]);
  assert.deepEqual(readSharedTuple(shared, "COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES"), [
    "LOW",
    "NORMAL",
    "HIGH",
    "URGENT",
  ]);
  assert.deepEqual(readSharedTuple(shared, "COLLABORATION_TEAM_ASSIGNMENT_STATUSES"), [
    "OPEN",
    "IN_PROGRESS",
    "COMPLETED",
    "REASSIGNED",
    "CANCELLED",
  ]);
});
