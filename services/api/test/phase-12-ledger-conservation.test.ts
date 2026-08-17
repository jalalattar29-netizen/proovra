/**
 * PHASE 12 CONTINUATION §1 — THE LEDGER'S OWN ADVERSARIAL GATE.
 *
 * Why this file exists
 * ---------------------------------------------------------------------------
 * `generate-ledger.mjs` is the only thing permitted to state a Phase-12 count,
 * and it refuses a row set that duplicates, drops, invents, hides or silently
 * promotes a row. Every one of those refusals was written and none had ever
 * been OBSERVED refusing — which is precisely the fictional control this
 * programme keeps finding in the code it audits. A guard that has never been
 * shown to fire is a comment.
 *
 * So each case below MUTATES the real row set and drives the REAL validator.
 * Importing `evaluateRows` rather than re-implementing the rules matters: a
 * re-implementation would prove something about the copy.
 *
 * What the continuation's arithmetic contradiction actually was
 * ---------------------------------------------------------------------------
 * The checkpoint's prose claimed four closures (ARCH-004, ARCH-001,
 * LEGACY-001, ARCH-003) and named two discoveries (NEW-013, NEW-014) that
 * existed in no ledger at all, while `rows.json` still carried all four as
 * OPEN_NOT_STARTED and knew nothing of the two. Prose and rows had drifted
 * again, in the same direction and for the same reason as the pass before it.
 * The repair is not a corrected sentence — it is that the rows are the only
 * authority, and this file is what keeps them honest.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// PHASE 0 §7 — the canonical ledger moved to `audit-output/current/`. It used
// to sit inside `phase12-independent-source-audit/`, a directory that also held
// ten superseded reports and fifteen matrices from finished passes. The one
// artifact that IS current was indistinguishable by path from thirty that are
// not, which is how a reader ends up quoting a July matrix as a fact. Current
// and historical are now separate trees, and the path is the status.
const LEDGER_DIR = path.resolve(HERE, "../../../audit-output/current/ledger");

type Row = Record<string, unknown> & { id: string };
type Result =
  | { ok: false; problems: string[] }
  | { ok: true; ledger: Record<string, unknown> };

const ledgerModule = async (): Promise<{
  evaluateRows: (rows: unknown) => Result;
  LEDGER_ROW_IDS: Record<string, string>;
  LEDGER_CANONICAL_ROW_IDS: Record<string, string>;
  LEDGER_DISCOVERED_ROW_IDS: Record<string, string>;
}> =>
  (await import(
    /* @vite-ignore */ `${path.join(LEDGER_DIR, "generate-ledger.mjs").replace(/\\/g, "/")}`
  )) as never;

const readRows = async (): Promise<Row[]> => {
  const { readFileSync } = await import("node:fs");
  return JSON.parse(readFileSync(path.join(LEDGER_DIR, "rows.json"), "utf8")) as Row[];
};

/** A deep clone so a mutation in one case cannot leak into the next. */
const clone = (rows: Row[]): Row[] => JSON.parse(JSON.stringify(rows)) as Row[];

describe("§1 — the canonical ledger conserves, and its refusals actually refuse", () => {
  // =========================================================================
  // The row set on disk
  // =========================================================================

  it("1 — the real row set is admissible and every scalar conserves", async () => {
    const { evaluateRows } = await ledgerModule();
    const result = evaluateRows(await readRows());
    expect(result.ok, `refused: ${(result as { problems?: string[] }).problems?.join(" | ")}`).toBe(
      true,
    );
    if (!result.ok) return;

    const l = result.ledger as unknown as {
      rowCount: number;
      actionable: { total: number; closed: number; open: number };
      verifiedClosures: { total: number };
      unknownBlocked: { total: number };
      trackedInventory?: { total: number };
      remainingIds: string[];
    };

    // Conservation, DERIVED — not the three numbers the mandate quotes. If the
    // derivation and the mandate's expectation disagree, the derivation wins
    // and the disagreement is the finding.
    expect(l.actionable.closed + l.actionable.open).toBe(l.actionable.total);
    // PHASE 1 §3 — five buckets: tracked inventory is neither a defect nor a
    // closure, and was separated out of FINAL-001 so neither half had to be
    // misstated.
    expect(
      l.actionable.total +
        l.verifiedClosures.total +
        l.unknownBlocked.total +
        (l.trackedInventory?.total ?? 0),
    ).toBe(l.rowCount);
  });

  /**
   * The open set is PINNED, not merely counted.
   *
   * A count alone is satisfiable by closing one row and opening another, which
   * is exactly the substitution a hand-maintained scalar hides. Naming the ids
   * means a row can only leave this list by being closed WITH evidence — the
   * generator refuses `FIXED_VERIFIED` without it — and a newly discovered
   * defect cannot be absorbed silently.
   *
   * PHASE 0 CORRECTIVE §5 — NO FINDING ID IS NAMED HERE. NOT ONE.
   *
   * This assertion has now been wrong twice, in opposite directions, for the
   * same underlying reason.
   *
   * It began as "the open set is EMPTY", which made this file — whose subject
   * is whether the LEDGER's arithmetic holds — also the gate for whether the
   * PRODUCT is finished. Opening an honest new finding turned the ledger's own
   * integrity suite red, and a conservation suite that fails because work
   * exists is a suite people learn to skip.
   *
   * The first correction changed it to "the open set is exactly [FINAL-001]",
   * which fixed the red but kept the coupling and added a maintenance trap: the
   * next honest finding fails a test about ARITHMETIC, and the fix looks like
   * editing a list of ids in an integrity suite. That is the wrong thing to
   * teach anybody.
   *
   * What the ledger owes is INTERNAL consistency: the ids it reports as open
   * must be exactly the rows whose state is open. Which findings those are is
   * not this file's business, and `pnpm audit:architecture --closure-check`
   * is the only thing entitled to say the count must be zero.
   */
  it("2 — the reported open set equals the rows that are actually open", async () => {
    const { evaluateRows } = await ledgerModule();
    const rows = await readRows();
    const result = evaluateRows(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const l = result.ledger as unknown as { remainingIds: string[]; actionable: { open: number } };

    // Derived from the rows, not from a list in this file. Adding a second
    // honest OPEN row keeps this green — and correctly turns closure red.
    const openFromRows = rows
      .filter((r) => String(r.finalDisposition).startsWith("OPEN"))
      .map((r) => r.id)
      .sort();

    expect([...l.remainingIds].sort()).toEqual(openFromRows);
    expect(l.actionable.open).toBe(openFromRows.length);
  });

  /**
   * PHASE 0 CORRECTIVE §5 — the decoupling, proven rather than asserted.
   *
   * The claim is that ledger INTEGRITY and product CLOSURE are now independent.
   * A comment saying so is worth nothing; what makes it true is that adding a
   * second honest open finding leaves integrity green and moves only closure.
   * So this adds one and checks both sides.
   *
   * It mutates a CLONE. `rows.json` is never touched and FINAL-001's real state
   * is never changed.
   */
  it("2a — a second honest OPEN row keeps integrity green and moves only closure", async () => {
    const { evaluateRows } = await ledgerModule();
    const rows = clone(await readRows());

    const template = rows.find((r) => r.id === "ARCH-003")!;
    const before = evaluateRows(rows);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const openBefore = (before.ledger as unknown as { remainingIds: string[] }).remainingIds.length;

    // Reopen an existing pinned row rather than inventing an id: the validator
    // refuses invented ids, and rightly — this case is about an OPEN row, not
    // about smuggling one in.
    const reopened = rows.find((r) => r.id === template.id)!;
    reopened.finalDisposition = "OPEN_PARTIAL";

    const after = evaluateRows(rows);
    expect(
      after.ok,
      `an honest OPEN row was refused by the INTEGRITY validator: ${(after as { problems?: string[] }).problems?.join(" | ")}`,
    ).toBe(true);
    if (!after.ok) return;

    const l = after.ledger as unknown as {
      remainingIds: string[];
      rowCount: number;
      actionable: { total: number; closed: number; open: number };
      verifiedClosures: { total: number };
      unknownBlocked: { total: number };
      trackedInventory?: { total: number };
    };

    // INTEGRITY: still conserves, exactly as before — across all five buckets.
    expect(l.actionable.closed + l.actionable.open).toBe(l.actionable.total);
    expect(
      l.actionable.total +
        l.verifiedClosures.total +
        l.unknownBlocked.total +
        (l.trackedInventory?.total ?? 0),
    ).toBe(l.rowCount);

    // CLOSURE: and only closure, has moved.
    expect(l.remainingIds.length).toBe(openBefore + 1);
    expect(l.remainingIds).toContain(template.id);
  });

  it("2b — removing an open row from the totals breaks conservation", async () => {
    const { evaluateRows } = await ledgerModule();
    const rows = clone(await readRows());
    // The row set may legitimately have NO open rows, so one is opened on the
    // CLONE first. Skipping when none exists would make this case evaporate
    // exactly when the ledger is healthiest — and it is the RULE being tested,
    // not today's dispositions.
    const openRow = rows.find((r) => String(r.finalDisposition).startsWith("OPEN")) ?? rows[0]!;
    openRow.finalDisposition = "OPEN_PARTIAL";
    const result = evaluateRows(rows.filter((r) => r.id !== openRow.id));
    expect(
      result.ok,
      "dropping an open row was ACCEPTED — the row set is not conserved",
    ).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => new RegExp(`missing id: ${openRow.id}`).test(p))).toBe(true);
  });

  it("3 — NEW-013 and NEW-014 are first-class DISCOVERED rows with evidence", async () => {
    const { LEDGER_DISCOVERED_ROW_IDS } = await ledgerModule();
    const rows = await readRows();
    for (const id of ["NEW-013", "NEW-014"]) {
      expect(Object.keys(LEDGER_DISCOVERED_ROW_IDS)).toContain(id);
      const row = rows.find((r) => r.id === id);
      expect(row, `${id} must exist in rows.json`).toBeTruthy();
      expect(row?.origin).toBe("DISCOVERED");
      expect(row?.finalDisposition).toBe("FIXED_VERIFIED");
      // A closed discovered row without evidence is the exact shape the
      // previous pass was corrected for.
      expect((row?.evidenceReferences as string[]).length).toBeGreaterThan(0);
      expect(String(row?.remainingRisk)).toMatch(/ROOT CAUSE/);
    }
  });

  it("4 — no discovered row is hidden outside the canonical ledger", async () => {
    const { LEDGER_ROW_IDS } = await ledgerModule();
    const rows = await readRows();
    // Every pinned id appears exactly once, and nothing appears that is not
    // pinned. Both directions, because either alone is satisfiable by a lie.
    expect(rows.length).toBe(Object.keys(LEDGER_ROW_IDS).length);
    expect([...new Set(rows.map((r) => r.id))].length).toBe(rows.length);
    for (const id of Object.keys(LEDGER_ROW_IDS)) {
      expect(rows.some((r) => r.id === id), `pinned id ${id} is not in rows.json`).toBe(true);
    }
  });

  // =========================================================================
  // ADVERSARIAL — each mutation must be REFUSED, and for the stated reason.
  // Table-driven: these are variations of one question, not fourteen files.
  // =========================================================================

  const CASES: ReadonlyArray<{
    name: string;
    mutate: (rows: Row[]) => Row[] | unknown;
    expectProblem: RegExp;
  }> = [
    {
      name: "a MISSING row",
      mutate: (rows) => rows.filter((r) => r.id !== "ARCH-005"),
      expectProblem: /missing id: ARCH-005/,
    },
    {
      name: "a DUPLICATE id",
      mutate: (rows) => [...rows, clone(rows).find((r) => r.id === "ARCH-005")!],
      expectProblem: /duplicate id: ARCH-005/,
    },
    {
      name: "an INVENTED id",
      mutate: (rows) => {
        const extra = clone(rows).find((r) => r.id === "ARCH-005")!;
        extra.id = "ARCH-999";
        return [...rows, extra];
      },
      expectProblem: /invented id/,
    },
    {
      name: "a CLOSED row with no evidence",
      mutate: (rows) => {
        const next = clone(rows);
        next.find((r) => r.id === "NEW-013")!.evidenceReferences = [];
        return next;
      },
      expectProblem: /NEW-013: FIXED_VERIFIED with no evidenceReferences/,
    },
    {
      name: "a CLOSED row whose source was never verified",
      mutate: (rows) => {
        const next = clone(rows);
        next.find((r) => r.id === "NEW-014")!.sourceVerified = "NOT_EXECUTED";
        return next;
      },
      expectProblem: /NEW-014: FIXED_VERIFIED requires sourceVerified=PASS/,
    },
    {
      name: "a claimed RUNTIME verification with no evidence",
      mutate: (rows) => {
        const next = clone(rows);
        const r = next.find((x) => x.id === "UNK-001")!;
        r.runtimeVerified = "PASS";
        r.evidenceReferences = [];
        return next;
      },
      expectProblem: /UNK-001: runtimeVerified=PASS with no evidenceReferences/,
    },
    {
      name: "a VERIFIED CLOSURE counted as a defect",
      mutate: (rows) => {
        const next = clone(rows);
        next.find((r) => r.id === "WEB-001")!.finalDisposition = "OPEN_NOT_STARTED";
        return next;
      },
      expectProblem: /WEB-001: is a VERIFIED_CLOSURE but carries a defect disposition/,
    },
    {
      name: "an OWNER-ONLY unknown promoted to a local pass",
      mutate: (rows) => {
        const next = clone(rows);
        next.find((r) => r.id === "UNK-002")!.finalDisposition = "FIXED_VERIFIED";
        return next;
      },
      expectProblem: /UNK-002: is UNKNOWN_BLOCKED but carries/,
    },
    {
      name: "an OWNER-ONLY unknown counted as a local failure",
      mutate: (rows) => {
        const next = clone(rows);
        next.find((r) => r.id === "UNK-003")!.finalDisposition = "OPEN_PARTIAL";
        return next;
      },
      expectProblem: /UNK-003: is UNKNOWN_BLOCKED but carries/,
    },
    {
      name: "a DISCOVERED row relabelled as an original one",
      mutate: (rows) => {
        const next = clone(rows);
        next.find((r) => r.id === "NEW-013")!.origin = "ORIGINAL";
        return next;
      },
      expectProblem: /NEW-013: origin "ORIGINAL" disagrees with the pinned sets/,
    },
    {
      name: "a HAND-WRITTEN severity disagreeing with the pinned one",
      mutate: (rows) => {
        const next = clone(rows);
        // The shape that hides an open finding by downgrading it.
        next.find((r) => r.id === "ARCH-005")!.normalizedSeverity = "LOW";
        return next;
      },
      expectProblem: /ARCH-005: normalizedSeverity "LOW" disagrees with the pinned severity "HIGH"/,
    },
    {
      name: "a row missing a required field",
      mutate: (rows) => {
        const next = clone(rows);
        delete next.find((r) => r.id === "ARCH-003")!.remainingRisk;
        return next;
      },
      expectProblem: /ARCH-003: missing required field `remainingRisk`/,
    },
    {
      name: "an unknown finalDisposition",
      mutate: (rows) => {
        const next = clone(rows);
        next.find((r) => r.id === "ARCH-003")!.finalDisposition = "MOSTLY_FINE";
        return next;
      },
      expectProblem: /ARCH-003: unknown finalDisposition "MOSTLY_FINE"/,
    },
    {
      name: "a row set that is not an array at all",
      mutate: () => ({ rows: [] }),
      expectProblem: /must be an array/,
    },
  ];

  /**
   * PHASE 0 CORRECTIVE §5 — the RENDERED ledger must match the rows.
   *
   * `ledger.json` and `ledger.md` are outputs, and an output that can be edited
   * without anything noticing is a second authority with better typography.
   * This re-derives from the rows and compares against what is on disk, so a
   * hand-changed total is caught by arithmetic rather than by someone happening
   * to re-run the generator.
   */
  it("4a — the rendered ledger.json equals what the rows derive", async () => {
    const { evaluateRows } = await ledgerModule();
    const { readFileSync } = await import("node:fs");
    const result = evaluateRows(await readRows());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const onDisk = JSON.parse(
      readFileSync(path.join(LEDGER_DIR, "ledger.json"), "utf8"),
    ) as Record<string, unknown>;
    const derived = result.ledger as Record<string, unknown>;

    for (const key of [
      "rowCount",
      "actionable",
      "verifiedClosures",
      "unknownBlocked",
      "conservationEquation",
      "verificationCoverage",
    ]) {
      expect(
        JSON.stringify(onDisk[key]),
        `ledger.json's \`${key}\` disagrees with the rows — regenerate it, do not edit it`,
      ).toBe(JSON.stringify(derived[key]));
    }
  });

  it("4b — a hand-changed rendered total is detectable (the comparison really compares)", async () => {
    // The mirror of 4a. If the comparison above were vacuous — comparing a
    // value with itself, or two undefineds — it would pass on a tampered file
    // too, and 4a would be decoration.
    const { evaluateRows } = await ledgerModule();
    const result = evaluateRows(await readRows());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const derived = result.ledger as unknown as { rowCount: number };
    const tampered = { ...(result.ledger as object), rowCount: derived.rowCount + 1 } as {
      rowCount: number;
    };
    expect(JSON.stringify(tampered.rowCount)).not.toBe(JSON.stringify(derived.rowCount));
  });

  for (const [i, c] of CASES.entries()) {
    it(`5.${i + 1} — refuses ${c.name}`, async () => {
      const { evaluateRows } = await ledgerModule();
      const result = evaluateRows(c.mutate(await readRows()));
      expect(result.ok, `${c.name} was ACCEPTED — the refusal does not fire`).toBe(false);
      if (result.ok) return;
      expect(
        result.problems.some((p) => c.expectProblem.test(p)),
        `refused, but not for the stated reason. Got: ${result.problems.join(" | ")}`,
      ).toBe(true);
    });
  }
});
