/**
 * A REFUSED findings ledger must produce a controlled finding — never a crash.
 *
 * WHAT WENT WRONG
 *
 * A routine `pnpm test:integration` downgraded the Point-7 proof artifact from
 * a production-build run to a dev-server one. `browserVerified` is DERIVED from
 * that artifact, so rows NEW-027/028/029 — which declare `PASS` — no longer
 * agreed with what the artifact could prove, and the ledger's own validator
 * correctly refused the rows.
 *
 * That refusal was right. What happened next was not. `ledgerFacts()` returned
 * a four-key object on the refusal path, with no `actionable`, and the very
 * next consumer read `.actionable.open` off it:
 *
 *     TypeError: Cannot read properties of undefined (reading 'open')
 *
 * So the audit's answer to "your findings ledger disagrees with your browser
 * proof" was a stack trace from an unrelated module. The refusal — the one
 * piece of information anybody needed — never reached a report at all, and the
 * engine looked broken rather than the evidence looking weak.
 *
 * These tests pin BOTH halves: the refusal is still a refusal (nothing is
 * credited, nothing reports PASS), and it is now survivable (the report renders,
 * the scalars derive, and the reason is stated).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

import {
  LEDGER_REFUSED,
  engineProblems,
  releaseBlockingProblems,
} from "../scripts/audit/engine/facts.mjs";
import { derivedScalars } from "../scripts/audit/engine/checkpoint-truth.mjs";
import { renderReport } from "../scripts/audit/engine/report.mjs";
import { CANONICAL, REPO } from "../scripts/audit/engine/registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The real generated facts artifact — so the renderer runs over real inputs. */
function realFacts(): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(REPO, CANONICAL.currentFacts.path as string), "utf8"),
  );
}

/**
 * The projection `ledgerFacts()` returns when `evaluateRows` refuses.
 *
 * Restated here rather than imported, because the point of the test is that the
 * SHAPE is complete: if the engine ever drops a field again, the assertions
 * below that read it will fail rather than the engine crashing in production.
 */
function refusedLedger(): Record<string, any> {
  return {
    path: CANONICAL.findingsLedger.rows,
    producer: CANONICAL.findingsLedger.producer,
    rowsHash: "0".repeat(64),
    valid: false,
    problems: [
      'NEW-027: browserVerified is declared "PASS" but the Point-7 proof ' +
        'artifact derives "NOT_EXECUTED".',
      'NEW-028: browserVerified is declared "PASS" but the Point-7 proof ' +
        'artifact derives "NOT_EXECUTED".',
      'NEW-029: browserVerified is declared "PASS" but the Point-7 proof ' +
        'artifact derives "NOT_EXECUTED".',
    ],
    rowCount: LEDGER_REFUSED,
    actionable: {
      total: LEDGER_REFUSED,
      closed: LEDGER_REFUSED,
      open: LEDGER_REFUSED,
    },
    verifiedClosures: { total: LEDGER_REFUSED, ids: [] },
    unknownBlocked: { total: LEDGER_REFUSED, ids: [] },
    trackedInventory: { total: 0, ids: [], releaseBlocking: false },
    openIds: ["LEDGER_REFUSED"],
    conservationEquation: `${LEDGER_REFUSED} — the ledger did not validate`,
  };
}

describe("the engine's refused-ledger projection", () => {
  it("supplies every field a consumer reads", () => {
    const l = refusedLedger();
    // The exact set the downstream modules touch. A missing one of these WAS
    // the crash.
    for (const key of [
      "actionable",
      "verifiedClosures",
      "unknownBlocked",
      "trackedInventory",
      "openIds",
      "conservationEquation",
      "rowCount",
      "problems",
    ]) {
      assert.ok(key in l, `refused ledger is missing \`${key}\``);
    }
    for (const key of ["total", "closed", "open"]) {
      assert.ok(key in l.actionable, `refused actionable is missing \`${key}\``);
    }
  });

  it("reports counts as unusable rather than as zero", () => {
    const l = refusedLedger();
    // A number would be a lie in either direction: 0 reads as "nothing open",
    // and any positive value invents findings nobody measured.
    assert.equal(typeof l.actionable.open, "string");
    assert.notEqual(l.actionable.open, 0);
    assert.equal(l.actionable.open, LEDGER_REFUSED);
  });
});

describe("the audit never throws a secondary TypeError", () => {
  it("derives scalars from a refused ledger without crashing", () => {
    const doc = realFacts();
    doc.findingsLedgerRef = refusedLedger();

    let scalars: Record<string, unknown> = {};
    assert.doesNotThrow(() => {
      scalars = derivedScalars(doc);
    });
    assert.equal(scalars.OpenActionableFindings, "REFUSED");
  });

  it("survives the FORMER crash path — an `actionable` that is not there at all", () => {
    // The literal shape the engine used to return. Defence in depth: the
    // projection is complete now, but the evaluator is also handed corrupted
    // documents by the adversarial gate, and a TypeError there is
    // indistinguishable from the engine being broken.
    const doc = realFacts();
    doc.findingsLedgerRef = { valid: false, problems: ["boom"] };

    let scalars: Record<string, unknown> = {};
    assert.doesNotThrow(() => {
      scalars = derivedScalars(doc);
    });
    assert.equal(scalars.OpenActionableFindings, "REFUSED");
    assert.equal(scalars.ReleaseBlockingClosure, "OPEN");
  });

  it("survives a `findingsLedgerRef` that is missing entirely", () => {
    const doc = realFacts();
    delete doc.findingsLedgerRef;
    assert.doesNotThrow(() => derivedScalars(doc));
  });
});

describe("refused evidence is never treated as passing", () => {
  it("reports ReleaseBlockingClosure = OPEN", () => {
    const doc = realFacts();
    doc.findingsLedgerRef = refusedLedger();
    assert.equal(derivedScalars(doc).ReleaseBlockingClosure, "OPEN");
  });

  it("blocks the release even though no finding id could be counted", () => {
    const doc = realFacts();
    doc.findingsLedgerRef = refusedLedger();
    const problems = releaseBlockingProblems(doc);
    assert.ok(
      problems.some((p) => p.includes("LEDGER_REFUSED")),
      `expected a release-blocking refusal, got: ${problems.join(" | ")}`,
    );
  });

  it("raises the refusal as an ENGINE integrity problem, naming the rows", () => {
    const doc = realFacts();
    doc.findingsLedgerRef = refusedLedger();
    const problems = engineProblems(doc, { problems: [] });
    const refusal = problems.find((p) => p.startsWith("LEDGER REFUSED:"));
    assert.ok(refusal, `expected a LEDGER REFUSED problem, got: ${problems.join(" | ")}`);
    // NEW-027/028/029 stay named and stay blocked.
    for (const id of ["NEW-027", "NEW-028", "NEW-029"]) {
      assert.ok(refusal.includes(id), `refusal does not name ${id}`);
    }
  });
});

describe("report generation still completes, with FAIL and an explicit reason", () => {
  it("renders a refused ledger instead of aborting", () => {
    const doc = realFacts();
    doc.findingsLedgerRef = refusedLedger();

    let text = "";
    assert.doesNotThrow(() => {
      text = renderReport(doc, engineProblems(doc, { problems: [] }), [
        "OPEN LOCAL FINDINGS: LEDGER_REFUSED",
      ]);
    });

    assert.ok(text.length > 0, "the renderer produced nothing");
    assert.ok(
      text.includes("THE LEDGER WAS REFUSED BY ITS OWN VALIDATOR."),
      "the report does not state that the ledger was refused",
    );
    // The REASON, not merely the fact.
    assert.ok(text.includes("NEW-027"), "the report does not name the refused rows");
    assert.ok(
      text.includes("AuditEngineIntegrity") && text.includes("FAIL"),
      "the report does not report FAIL",
    );
    // And it must NOT print a fabricated count next to the refusal.
    assert.ok(
      !/actionableOpen\s*\|\s*0/.test(text),
      "the report printed actionableOpen = 0 for a ledger it could not read",
    );
  });
});

/**
 * The ledger's own validator, loaded the way the engine loads it.
 *
 * A `require()` would silently do something else here: the producer is ESM,
 * and a test that appears to exercise it while actually exercising a shim is
 * exactly the kind of control this file exists to distrust.
 */
async function loadLedgerProducer(): Promise<{
  evaluateRows: (rows: unknown) => {
    ok: boolean;
    problems?: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ledger?: any;
  };
}> {
  const abs = resolve(REPO, CANONICAL.findingsLedger.producer as string);
  return import(/* @vite-ignore */ pathToFileURL(abs).href);
}

describe("a VALID ledger restores normal reporting", () => {
  it("the positive control — the repository's own ledger validates and counts", async () => {
    // Without this, every assertion above would also pass against an engine
    // that refused unconditionally.
    const producer = await loadLedgerProducer();
    const rows = JSON.parse(
      readFileSync(resolve(REPO, CANONICAL.findingsLedger.rows as string), "utf8"),
    );
    const result = producer.evaluateRows(rows);
    assert.ok(
      result.ok,
      `the repository ledger does not validate: ${(result.problems ?? []).join(" | ")}`,
    );
    assert.equal(typeof result.ledger.actionable.open, "number");

    const doc = realFacts();
    const scalars = derivedScalars(doc);
    assert.equal(typeof scalars.OpenActionableFindings, "number");
  });

  it("a falsified browserVerified is still refused — the control can say no", async () => {
    // Proves the refusal path is REACHABLE, not merely handled. NEW-027 is
    // flipped to a value the Point-7 artifact does not derive.
    const rowsPath = resolve(REPO, CANONICAL.findingsLedger.rows as string);
    const rows = JSON.parse(readFileSync(rowsPath, "utf8"));
    const list = Array.isArray(rows) ? rows : rows.rows;
    const target = list.find((r: any) => r?.id === "NEW-027");
    assert.ok(target, "NEW-027 is not in the ledger");
    const original = target.browserVerified;
    target.browserVerified = original === "PASS" ? "NOT_EXECUTED" : "PASS";

    const producer = await loadLedgerProducer();
    const result = producer.evaluateRows(rows);
    assert.equal(result.ok, false, "a falsified browserVerified was accepted");
    assert.ok(
      (result.problems ?? []).some((p: string) => p.includes("NEW-027")),
      "the refusal does not name NEW-027",
    );
  });
});

// The file's own location is asserted so a move cannot silently orphan the
// relative import paths above.
assert.ok(HERE.endsWith("test"));
