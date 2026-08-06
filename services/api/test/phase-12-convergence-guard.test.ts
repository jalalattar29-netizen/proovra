/**
 * PHASE 12 — program-wide convergence guards (machine-enforced metrics).
 *
 * Accumulates the Step-0/Step-2 zero-metrics as executable contracts:
 *   - stale generated twins = 0 (no committed .js compiled beside a .ts/.tsx
 *     source anywhere in the app/service/package source trees);
 *   - dead parallel test population = 0 (no .test.js beside .test.ts in the
 *     API suite — vitest only executes *.test.ts, so a .js twin is an
 *     unexecuted stale copy that silently rots).
 *
 * 303 such twins (287 api-test + 16 web) were deleted in Phase 12 Step 0 —
 * this guard keeps them gone.
 */
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");

const SCAN_ROOTS = [
  "apps/web/app",
  "apps/web/lib",
  "apps/web/components",
  "apps/mobile/src",
  "apps/mobile/app",
  "services/api/src",
  "services/api/test",
  "services/worker/src",
  "packages/shared/src",
  "packages/shared-billing/src",
  "packages/shared-evidence-presentation/src",
  "packages/shared-runtime/src",
  "packages/ui/src",
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".next") continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}

describe("Phase 12 — stale generated twins = 0 (repo-wide)", () => {
  it("no committed .js/.jsx file shadows a same-name .ts/.tsx source", () => {
    const twins: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const f of walk(resolve(REPO, root))) {
        if (!/\.jsx?$/.test(f)) continue;
        if (/\.(config|test|spec)\.jsx?$|\.mjs$|\.cjs$/.test(f)) continue;
        const base = f.replace(/\.jsx?$/, "");
        if (existsSync(`${base}.ts`) || existsSync(`${base}.tsx`)) {
          twins.push(f.slice(REPO.length + 1));
        }
      }
    }
    expect(twins, `stale generated twins:\n${twins.join("\n")}`).toEqual([]);
  });

  it("no unexecuted .test.js population beside the vitest .test.ts suite", () => {
    const testDir = resolve(REPO, "services/api/test");
    const dead = readdirSync(testDir).filter((f) => f.endsWith(".test.js"));
    expect(dead, `unexecuted .test.js twins: ${dead.join(", ")}`).toEqual([]);
  });

  it("scan roots stay real (a renamed tree cannot silently drop coverage)", () => {
    const missing = SCAN_ROOTS.filter((r) => {
      const p = resolve(REPO, r);
      return !existsSync(p) || !statSync(p).isDirectory();
    });
    // shared-runtime/ui may legitimately restructure; everything else must exist.
    expect(missing.filter((m) => !/shared-runtime|packages\/ui/.test(m))).toEqual([]);
  });
});

// ===========================================================================
// PHASE 12 POINT 3 — SCHEMA RESURRECTION GUARD
//
// The Point 3 contract migrations physically remove three things:
//   * `case_legal_holds` and `legal_holds`  (20271108000000_legal_hold_legacy_removal)
//   * `evidence.case_id`                    (20271105000000_evidence_case_id_removal)
//
// A dropped TABLE is only half a removal. While `model CaseLegalHold` and
// `model LegalHold` were still declared in schema.prisma, `prisma migrate diff`
// against a fully-migrated database emitted CREATE TABLE for both — so the next
// migration anyone generated would have silently re-created the retired
// authority and undone the contract. `scripts/drift-check.mjs` cannot catch
// that: it compares the migration LEDGER to the database, not the schema to the
// database.
//
// These are source-level contracts precisely because they must hold WITHOUT a
// database. A future schema edit that reintroduces any of the six items below
// fails here, in CI, before a migration can be generated from it.
// ===========================================================================

const SCHEMA_PRISMA = readFileSync(
  resolve(REPO, "services/api/prisma/schema.prisma"),
  "utf8",
);

describe("Phase 12 Point 3 — dropped schema objects cannot be resurrected", () => {
  it("no `model CaseLegalHold` is declared", () => {
    expect(SCHEMA_PRISMA).not.toMatch(/^model\s+CaseLegalHold\s*\{/m);
  });

  it("no `model LegalHold` is declared", () => {
    // Anchored so it cannot match `model EvidenceLegalHold` (the canonical one).
    expect(SCHEMA_PRISMA).not.toMatch(/^model\s+LegalHold\s*\{/m);
  });

  it('nothing maps to "case_legal_holds" or "legal_holds"', () => {
    expect(SCHEMA_PRISMA).not.toMatch(/@@map\("case_legal_holds"\)/);
    expect(SCHEMA_PRISMA).not.toMatch(/@@map\("legal_holds"\)/);
  });

  it("no relation field is typed as either dropped model", () => {
    const relations = SCHEMA_PRISMA.split("\n").filter((l) =>
      /^\s+\w+\s+(CaseLegalHold|LegalHold)(\[\])?\??(\s|$)/.test(l),
    );
    expect(
      relations,
      `relation fields typed as a dropped model:\n${relations.join("\n")}`,
    ).toEqual([]);
  });

  it("model Evidence declares no `caseId` scalar (CaseEvidenceLink is the authority)", () => {
    const block = SCHEMA_PRISMA.match(/^model Evidence \{[\s\S]*?^\}/m);
    expect(block, "model Evidence must exist").toBeTruthy();
    expect(block![0]).not.toMatch(/^\s+caseId\s/m);
    expect(block![0]).not.toMatch(/@map\("case_id"\)/);
    // The replacement authority must still be wired.
    expect(block![0]).toMatch(/caseLinks\s+CaseEvidenceLink\[\]/);
  });

  it("the canonical EvidenceLegalHold model survives with its table mapping", () => {
    expect(SCHEMA_PRISMA).toMatch(/^model\s+EvidenceLegalHold\s*\{/m);
    expect(SCHEMA_PRISMA).toMatch(/@@map\("evidence_legal_holds"\)/);
  });

  it("exactly ONE module writes the canonical legal-hold store", () => {
    const WRITE_RE =
      /(prisma|client|db|tx)\s*\.\s*evidenceLegalHold\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
    const roots = ["services/api/src", "services/worker/src"];
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && WRITE_RE.test(readFileSync(p, "utf8"))) {
          writers.push(p.slice(REPO.length + 1).split(sep).join("/"));
        }
      }
    };
    for (const r of roots) walk(resolve(REPO, r));
    expect(
      writers.sort(),
      `canonical legal-hold writer modules (must be exactly one):\n${writers.join("\n")}`,
    ).toEqual(["services/api/src/services/governance/legal-hold.service.ts"]);
  });

  it("the retired case-only legal-hold service stays deleted", () => {
    expect(
      existsSync(
        resolve(REPO, "services/api/src/services/governance/case-legal-hold.service.ts"),
      ),
    ).toBe(false);
  });
});

// =============================================================================
// PHASE 12 POINT 4 — no-skip gate
//
// There is NO live-pending registry, because there is nothing to register: a
// test is either executed by the unit project or executed by the integration
// project. The four suites that used to be `describe.skip`ped and called
// "live pending" run faithfully against a disposable PostgreSQL 16 — the same
// `postgres:16-alpine` the repository already uses in CI — so calling them an
// external dependency was false.
//
// This gate therefore asserts the stronger property: nothing is skipped at
// all, and the two projects together execute every test file in `test/`.
// =============================================================================

const UNIT_CONFIG = resolve(REPO, "services/api/vitest.config.ts");
const INTEGRATION_CONFIG = resolve(REPO, "services/api/vitest.integration.config.ts");
const INTEGRATION_SUFFIX = ".integration.test.ts";

/** Every *.test.ts in the API suite, repo-relative with forward slashes. */
function apiTestFiles(): string[] {
  return walk(resolve(REPO, "services/api/test"))
    .filter((p) => p.endsWith(".test.ts"))
    .map((p) => p.slice(REPO.length + 1).split(sep).join("/"));
}

/** Strip block/line comments so a documented prohibition is not a violation. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

describe("Phase 12 Point 4 — no test is skipped in either project", () => {
  it("the live-pending registry is GONE (LivePending = 0)", () => {
    // Keeping an empty registry would preserve the idea that some tests are
    // legitimately un-runnable. None are.
    expect(existsSync(resolve(REPO, "docs/architecture/live-pending-registry.json"))).toBe(
      false,
    );
  });

  it("no runtime skip / todo / conditional gate anywhere in the API suite", () => {
    // `describe.skip`, `it.todo`, `runIf`, `skipIf` and the
    // `cond ? describe : describe.skip` idiom all remove a test from a run.
    const GATE_RE =
      /\b(?:describe|it|test|suite)\s*\.\s*(?:skip|todo|only)\b|\b(?:describe|it|test)\s*\.\s*(?:runIf|skipIf)\s*\(|(?:\?|:)\s*describe\s*\.\s*skip\b/;
    // Positive control: the detector must recognise each shape it claims to.
    // The sample strings are ASSEMBLED rather than written literally, so this
    // file does not trip its own scan — the alternative (exempting this file)
    // would blind the gate to a real skip added here later.
    const sample = (method: string, member: string) => `${method}.${member}("x", () => {})`;
    expect(GATE_RE.test(sample("describe", "skip"))).toBe(true);
    expect(GATE_RE.test(sample("describe", "runIf"))).toBe(true);
    expect(GATE_RE.test(sample("it", "todo"))).toBe(true);
    expect(GATE_RE.test(sample("describe", "each"))).toBe(false);
    expect(GATE_RE.test('describe("x", () => {})')).toBe(false);

    const offenders: string[] = [];
    for (const rel of apiTestFiles()) {
      if (GATE_RE.test(withoutComments(readFileSync(resolve(REPO, rel), "utf8")))) {
        offenders.push(rel);
      }
    }
    expect(
      offenders.sort(),
      `test files carrying a runtime skip/conditional gate:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no `.only` anywhere in the API suite (UnexpectedOnly = 0)", () => {
    const offenders = apiTestFiles().filter((rel) =>
      /\b(?:describe|it|test|suite)\s*\.\s*only\b/.test(
        readFileSync(resolve(REPO, rel), "utf8"),
      ),
    );
    expect(offenders.sort(), `files containing .only:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the two projects partition the suite — every test file is executed by exactly one", () => {
    const unit = readFileSync(UNIT_CONFIG, "utf8");
    const integration = readFileSync(INTEGRATION_CONFIG, "utf8");

    // The unit project runs every *.test.ts EXCEPT the integration suffix…
    expect(unit).toMatch(/include:\s*\["test\/\*\*\/\*\.test\.ts"\]/);
    expect(unit).toMatch(/"test\/\*\*\/\*\.integration\.test\.ts"/);
    // …and the integration project runs exactly that suffix.
    expect(integration).toMatch(/include:\s*\["test\/\*\*\/\*\.integration\.test\.ts"\]/);

    const files = apiTestFiles();
    const integrationFiles = files.filter((f) => f.endsWith(INTEGRATION_SUFFIX));
    const unitFiles = files.filter((f) => !f.endsWith(INTEGRATION_SUFFIX));
    // Both halves must be non-empty: an empty integration half would mean the
    // database suites had been quietly dropped rather than moved.
    expect(integrationFiles.length).toBeGreaterThan(0);
    expect(unitFiles.length).toBeGreaterThan(0);
    expect(unitFiles.length + integrationFiles.length).toBe(files.length);
  });

  it("the unit exclusion is narrow — one suffix, no directory or capability removed", () => {
    const unit = readFileSync(UNIT_CONFIG, "utf8");
    const excludeBlock = unit.slice(unit.indexOf("exclude:"), unit.indexOf("]", unit.indexOf("exclude:")));
    // node_modules/dist are vitest's own defaults, restated because declaring
    // `exclude` replaces them. Nothing else may be excluded.
    const entries = [...excludeBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(entries.sort()).toEqual(
      ["**/dist/**", "**/node_modules/**", "test/**/*.integration.test.ts"].sort(),
    );
  });

  it("no broad test exclusion in any runner config (BroadTestExclusions = 0)", () => {
    const CONFIGS = [
      "services/worker/vitest.config.ts",
      "apps/web/vitest.config.ts",
      "apps/web/vitest.render.config.ts",
      "apps/web/scripts/run-tests.mjs",
    ];
    // A pattern that removes whole families of tests from a run.
    const BROAD_RE =
      /exclude\s*:\s*\[[^\]]*(\*live\*|live\.|\*\*\/\*live|integration|e2e|contract|\.skip)/i;
    const offenders = CONFIGS.filter(
      (rel) =>
        existsSync(resolve(REPO, rel)) &&
        BROAD_RE.test(readFileSync(resolve(REPO, rel), "utf8")),
    );
    expect(
      offenders.sort(),
      `runner configs with a broad test exclusion:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the integration project is wired into package scripts and CI", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO, "services/api/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    // `test:integration` no longer invokes the runner directly: it PREPARES —
    // generating the Prisma client and building the workspace packages the API
    // imports — and only then runs. It had to. A clean checkout has no
    // `packages/shared-runtime/dist`, so the raw runner died during module
    // collection and reported the missing suites as "skipped", which is exactly
    // the failure this file exists to catch.
    //
    // So follow the chain instead of pinning one string: the runner must still
    // be reachable, and preparation must still come first.
    const entry = pkg.scripts["test:integration"];
    expect(entry).toContain("test:integration:prepare");
    expect(entry).toContain("test:integration:run");
    expect(entry.indexOf("test:integration:prepare")).toBeLessThan(
      entry.indexOf("test:integration:run"),
    );
    expect(pkg.scripts["test:integration:run"]).toMatch(
      /vitest run --config vitest\.integration\.config\.ts/,
    );

    // A suite nobody runs is the same as a skipped suite.
    const workflow = readFileSync(
      resolve(REPO, ".github/workflows/schema-reproducibility.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/test:integration/);
  });

  it("the integration suites acquire their database through the ONE canonical helper", () => {
    // A suite reading `process.env.TEST_DATABASE_URL` directly silently gets
    // `undefined` under testcontainers — that is how a gate ends up inert.
    const offenders: string[] = [];
    for (const rel of apiTestFiles().filter((f) => f.endsWith(INTEGRATION_SUFFIX))) {
      const src = readFileSync(resolve(REPO, rel), "utf8");
      if (/process\.env\.TEST_DATABASE_URL/.test(withoutComments(src))) offenders.push(rel);
      if (!/acquireIntegrationDatabase|bootIntegrationHarness/.test(src)) {
        offenders.push(`${rel} (no canonical database acquisition)`);
      }
    }
    expect(offenders.sort(), offenders.join("\n")).toEqual([]);
  });
});

// =============================================================================
// PHASE 12 POINT 4 — permanent resurrection gate.
//
// The Point-3/Point-4 convergences above are irreversible only if the code
// that made them true cannot come back. Each assertion here corresponds to a
// specific thing this phase removed or converged; the checks that already
// live in this file (schema-level Evidence.caseId, the dropped legal-hold
// models, generated twins, the one canonical legal-hold writer) are NOT
// repeated — this block adds the RUNTIME halves that had no guard.
// =============================================================================

const RUNTIME_ROOTS = ["services/api/src", "services/worker/src"];

function runtimeTsFiles(): string[] {
  const out: string[] = [];
  for (const r of RUNTIME_ROOTS) {
    for (const p of walk(resolve(REPO, r))) {
      if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
  }
  return out;
}

function relOf(p: string): string {
  return p.slice(REPO.length + 1).split(sep).join("/");
}

/**
 * Return the balanced `{...}` block starting at `open`, or "" when unbalanced.
 * Used instead of a fixed-size window so a delegate call is read exactly, and
 * a nested object cannot be mistaken for the end of an enclosing one.
 */
function balancedBlock(src: string, open: number): string {
  if (src[open] !== "{") return "";
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

/** Remove every `key: { ... }` sub-object, honouring nesting. */
function stripNestedObject(block: string, key: string): string {
  let out = block;
  const re = new RegExp("\\b" + key + "\\s*:\\s*\\{");
  for (;;) {
    const m = re.exec(out);
    if (!m) return out;
    const open = out.indexOf("{", m.index);
    const nested = balancedBlock(out, open);
    if (!nested) return out;
    out = out.slice(0, m.index) + out.slice(open + nested.length);
  }
}

/** Strip comments so a documented prohibition is not read as a violation. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

describe("Phase 12 Point 4 — resurrection gate (runtime)", () => {
  it("no runtime module reads or writes a legacy Legal-Hold Prisma model", () => {
    const LEGACY_DELEGATE =
      /\b(?:prisma|client|db|tx|defaultPrisma)\s*\.\s*(?:legalHold|caseLegalHold)\s*\.\s*[a-zA-Z]/;
    const files = runtimeTsFiles();
    expect(files.length, "the runtime scan found no source files").toBeGreaterThan(100);
    const offenders = files
      .filter((p) => LEGACY_DELEGATE.test(codeOnly(readFileSync(p, "utf8"))))
      .map(relOf);
    // Positive control: the pattern must recognise a legacy delegate call.
    expect(LEGACY_DELEGATE.test("await prisma.legalHold.count({})")).toBe(true);
    expect(LEGACY_DELEGATE.test("await prisma.evidenceLegalHold.count({})")).toBe(false);
    expect(
      offenders.sort(),
      "runtime modules touching the dropped legal-hold models:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("no runtime raw SQL targets the dropped legal-hold tables", () => {
    // `evidence_legal_holds` is the CANONICAL table and is explicitly allowed.
    const LEGACY_TABLE = /"?\b(?<!evidence_)(?:legal_holds|case_legal_holds)\b"?/;
    const offenders: string[] = [];
    for (const p of runtimeTsFiles()) {
      const code = codeOnly(readFileSync(p, "utf8"));
      // Only inside a raw-SQL call — a bare identifier in prose is not a read.
      for (const m of code.matchAll(/\$queryRaw(?:Unsafe)?|\$executeRaw(?:Unsafe)?/g)) {
        const window = code.slice(m.index ?? 0, (m.index ?? 0) + 2000);
        if (LEGACY_TABLE.test(window)) {
          offenders.push(relOf(p));
          break;
        }
      }
    }
    expect(
      offenders.sort(),
      "raw SQL referencing a dropped legal-hold table:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("no runtime module reads Evidence.caseId (CaseEvidenceLink is the authority)", () => {
    // The legacy scalar on the Evidence delegate specifically: an Evidence
    // select/where naming `caseId` directly rather than through `caseLinks`.
    const offenders: string[] = [];
    let inspected = 0;
    for (const p of runtimeTsFiles()) {
      const code = codeOnly(readFileSync(p, "utf8"));
      for (const m of code.matchAll(
        /\.\s*evidence\s*\.\s*(?:findMany|findFirst|findUnique|findUniqueOrThrow|create|createMany|update|updateMany|upsert|count|aggregate|groupBy)\s*\(\s*/g,
      )) {
        const start = m.index ?? 0;
        const open = start + m[0]!.length;
        // The delegate's OWN argument object, read with balanced braces so the
        // scan cannot bleed into unrelated code after the call.
        const args = balancedBlock(code, open);
        if (!args) continue;
        inspected += 1;
        // `caseLinks: { ... caseId ... }` is the CANONICAL read (and `case: {}`
        // is the relation); only a `caseId:` at the Evidence level itself is
        // the dropped legacy scalar.
        let stripped = stripNestedObject(args, "caseLinks");
        stripped = stripNestedObject(stripped, "case");
        if (/\bcaseId\s*:/.test(stripped)) offenders.push(relOf(p) + " @" + start);
      }
    }
    // A scan that matched nothing would pass forever after a refactor renamed
    // the delegate; assert it actually read the call sites it claims to cover.
    expect(
      inspected,
      "the Evidence-delegate scan matched no call sites — the detector is broken, not the tree",
    ).toBeGreaterThan(20);
    expect(
      offenders.sort(),
      "Evidence delegate calls naming the dropped caseId scalar:\n" + offenders.join("\n"),
    ).toEqual([]);

    // Positive control: the detector MUST flag the legacy shape when present.
    const legacySample =
      'await prisma.evidence.findMany({ where: { teamId }, select: { id: true, caseId: true } });';
    const sampleMatch = /\.\s*evidence\s*\.\s*findMany\s*\(\s*/.exec(legacySample)!;
    const sampleArgs = balancedBlock(
      legacySample,
      sampleMatch.index + sampleMatch[0].length,
    );
    expect(/\bcaseId\s*:/.test(stripNestedObject(sampleArgs, "caseLinks"))).toBe(true);
    // …and MUST NOT flag the canonical shape.
    const canonicalSample =
      'await prisma.evidence.findMany({ where: { teamId }, select: { id: true, caseLinks: { select: { caseId: true }, take: 1 } } });';
    const cMatch = /\.\s*evidence\s*\.\s*findMany\s*\(\s*/.exec(canonicalSample)!;
    const cArgs = balancedBlock(canonicalSample, cMatch.index + cMatch[0].length);
    expect(/\bcaseId\s*:/.test(stripNestedObject(cArgs, "caseLinks"))).toBe(false);
  });

  it("no audit writer below chainVersion 3 (NewAuditWritesBelowV3 = 0)", () => {
    const writers: Array<{ file: string; version: string }> = [];
    for (const p of runtimeTsFiles()) {
      const code = codeOnly(readFileSync(p, "utf8"));
      for (const m of code.matchAll(/adminAuditLog\s*\.\s*(?:create|createMany)\s*\(/g)) {
        const start = m.index ?? 0;
        const window = code.slice(start, start + 2500);
        const v = /chainVersion\s*:\s*(\d+)/.exec(window);
        writers.push({ file: relOf(p), version: v ? v[1]! : "MISSING" });
      }
    }
    // Every writer must exist AND declare 3 — an unversioned writer is as bad
    // as a V1/V2 one, because verification would then have to guess.
    expect(writers.length, "there must be at least one audit writer").toBeGreaterThan(0);
    const bad = writers.filter((w) => w.version !== "3");
    expect(
      bad,
      "audit writers not pinned to chainVersion 3:\n" +
        bad.map((b) => b.file + " -> " + b.version).join("\n"),
    ).toEqual([]);
  });

  it("no route path is registered twice (duplicate registration = 0)", () => {
    const seen = new Map<string, string[]>();
    for (const p of walk(resolve(REPO, "services/api/src/routes"))) {
      if (!p.endsWith(".ts")) continue;
      const code = codeOnly(readFileSync(p, "utf8"));
      for (const m of code.matchAll(
        /\bapp\s*\.\s*(get|post|put|patch|delete)\s*\(\s*"([^"]+)"/g,
      )) {
        const key = m[1]!.toUpperCase() + " " + m[2]!;
        const list = seen.get(key) ?? [];
        list.push(relOf(p));
        seen.set(key, list);
      }
    }
    const dupes = [...seen.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([key, files]) => key + " <- " + files.join(", "));
    expect(dupes.sort(), "routes registered more than once:\n" + dupes.join("\n")).toEqual([]);
  });

  it("every compatibility adapter is registered and carries a removal condition", () => {
    const registryPath = resolve(
      REPO,
      "docs/architecture/compatibility-adapter-registry.json",
    );
    expect(existsSync(registryPath)).toBe(true);
    const reg = JSON.parse(readFileSync(registryPath, "utf8")) as {
      metrics: Record<string, number>;
      adapters: Array<{
        id: string;
        /** Route adapters name the registering module; a service adapter
         *  names itself via `path`. Exactly one of the two is present. */
        module?: string;
        path?: string;
        removalCondition:
        | { conditions: string[]; executableCheck: string }
        | { sameAs: string }
        | null;
        method?: string;
        category: string;
        family?: string;
        repositoryCallers: string[];
        reasonRetained: string;
        canonicalReplacement: string;
      }>;
    };
    expect(reg.adapters.length).toBeGreaterThan(0);
    const conditionless: string[] = [];
    const incomplete: string[] = [];
    // CANONICAL_RUNTIME entries are NOT adapters: they are the current
    // implementation with live callers and no removal condition. They stay in
    // the file so the reclassification is visible, but they are excluded from
    // every adapter obligation below.
    const adapters = reg.adapters.filter((a) => a.category !== "CANONICAL_RUNTIME");
    const byId = new Map(reg.adapters.map((a) => [a.id, a]));
    /**
     * An adapter may state its condition by reference (`sameAs`) when it shares
     * a removal path with a sibling. Resolve the chain so a reference to a
     * conditionless — or missing — entry still counts as conditionless.
     */
    function resolveCondition(
      id: string,
      seen = new Set<string>(),
    ): { conditions: string[]; executableCheck: string } | null {
      if (seen.has(id)) return null;
      seen.add(id);
      const a = byId.get(id);
      const rc = a?.removalCondition;
      if (!rc) return null;
      if ("sameAs" in rc) return resolveCondition(rc.sameAs, seen);
      return rc;
    }
    for (const a of adapters) {
      const rc = resolveCondition(a.id);
      if (!rc || rc.conditions.length === 0) {
        conditionless.push(a.id);
      } else if (!rc.executableCheck) {
        conditionless.push(a.id + " (no executable check)");
      }
      if (!a.canonicalReplacement || !a.reasonRetained) incomplete.push(a.id);
      if (!Array.isArray(a.repositoryCallers)) incomplete.push(a.id + " (callers)");
      // The file it names must still exist, or the entry is stale. Route
      // adapters carry `module`; the service adapter carries `path`.
      const named = a.module ?? a.path ?? "";
      const filePath = named.split("#")[0]!;
      if (filePath.endsWith(".ts")) {
        expect(
          existsSync(resolve(REPO, filePath)),
          'adapter "' + a.id + '" names a file that no longer exists: ' + filePath,
        ).toBe(true);
      } else if (!named) {
        incomplete.push(a.id + " (no module/path)");
      }
    }
    expect(conditionless.sort(), "ConditionlessAdapters must be 0").toEqual([]);
    expect(
      incomplete.sort(),
      "every adapter needs a canonical replacement, a reason and a caller list",
    ).toEqual([]);
    expect(reg.metrics.conditionlessAdapters).toBe(0);
    expect(reg.metrics.unregisteredCompatibilityAdapters).toBe(0);
  });

  it("no temporary or one-off script is reachable from runtime or package scripts", () => {
    // A temp artifact is anything matching these shapes; none may be imported
    // by runtime code or invoked by a package script.
    const TEMP_RE = /(\.tmp\.|[-_]tmp\b|\bscratch\b|\bthrowaway\b|ledger-append)/i;
    const offenders: string[] = [];
    for (const p of runtimeTsFiles()) {
      const code = codeOnly(readFileSync(p, "utf8"));
      for (const m of code.matchAll(/from\s+"([^"]+)"|import\s*\(\s*"([^"]+)"/g)) {
        const spec = m[1] ?? m[2] ?? "";
        if (TEMP_RE.test(spec)) offenders.push(relOf(p) + " -> " + spec);
      }
    }
    for (const pkg of [
      "package.json",
      "services/api/package.json",
      "services/worker/package.json",
      "apps/web/package.json",
    ]) {
      const abs = resolve(REPO, pkg);
      if (!existsSync(abs)) continue;
      const scripts = (
        JSON.parse(readFileSync(abs, "utf8")) as { scripts?: Record<string, string> }
      ).scripts;
      for (const [name, cmd] of Object.entries(scripts ?? {})) {
        if (TEMP_RE.test(cmd)) offenders.push(pkg + ' script "' + name + '" -> ' + cmd);
      }
    }
    expect(
      offenders.sort(),
      "temporary artifacts reachable from runtime/CI:\n" + offenders.join("\n"),
    ).toEqual([]);
    // And the Point-4 temporary ledger artifact specifically stays gone.
    expect(existsSync(resolve(REPO, "ledger-append.tmp.md"))).toBe(false);
    expect(
      existsSync(resolve(REPO, "docs/architecture/ledger-append.tmp.md")),
    ).toBe(false);
  });
});

describe("Phase 12 Point 4 — unified owner-pending registry", () => {
  const registryPath = resolve(
    REPO,
    "docs/architecture/compatibility-adapter-registry.json",
  );
  type OwnerEntry = {
    id: string;
    category: string;
    target: string;
    currentCallers: string;
    canonicalReplacement: string;
    readinessCommand: string;
    blockingConditions: string[];
    ownerAction: string;
    postMigrationRemoval: string;
    verificationCommand: string;
    rollbackOrStop: string;
    applied: boolean;
    migration?: string;
  };
  const reg = JSON.parse(readFileSync(registryPath, "utf8")) as {
    adapters: Array<{
      id: string;
      method?: string;
      path?: string;
      category: string;
      family?: string;
    }>;
    categories: {
      counts: Record<string, number>;
      namedEntries: Record<string, string[]>;
      legalHoldRouteCount: number;
    };
    metrics: Record<string, number>;
    ownerPending: { entries: OwnerEntry[]; metrics: Record<string, number> };
  };

  it("there is exactly ONE owner-pending list, and it is complete", () => {
    expect(reg.ownerPending.entries.length).toBeGreaterThan(0);
    for (const e of reg.ownerPending.entries) {
      const where = `owner-pending entry "${e.id}"`;
      for (const field of [
        "target",
        "currentCallers",
        "canonicalReplacement",
        "readinessCommand",
        "ownerAction",
        "postMigrationRemoval",
        "verificationCommand",
        "rollbackOrStop",
      ] as const) {
        expect(String(e[field] ?? ""), `${where}: ${field}`).not.toHaveLength(0);
      }
      expect(e.blockingConditions.length, `${where}: blockingConditions`).toBeGreaterThan(0);
      // Nothing in this registry may claim to have been applied remotely.
      expect(e.applied, `${where} must not be marked applied`).toBe(false);
    }
    expect(reg.ownerPending.metrics.remoteMigrationsApplied).toBe(0);
    expect(reg.ownerPending.metrics.unregisteredOwnerMigrationItems).toBe(0);
    expect(reg.ownerPending.metrics.registryCategoryAmbiguity).toBe(0);
  });

  it("a migration is never counted as a runtime adapter (RegistryCategoryAmbiguity = 0)", () => {
    // Every entry carries an explicit category, and the counts are DERIVED
    // from those categories rather than asserted independently.
    const c = reg.categories.counts;
    expect(c.totalRegistryEntries).toBe(reg.adapters.length);
    const routes = reg.adapters.filter((a) => a.category === "RUNTIME_COMPATIBILITY_ROUTE");
    const services = reg.adapters.filter((a) => a.category === "RUNTIME_COMPATIBILITY_SERVICE");
    const canonical = reg.adapters.filter((a) => a.category === "CANONICAL_RUNTIME");
    expect(c.runtimeCompatibilityRoutes).toBe(routes.length);
    expect(c.runtimeCompatibilityServices).toBe(services.length);
    expect(c.canonicalRuntimeReclassified).toBe(canonical.length);
    expect(routes.length + services.length + canonical.length).toBe(reg.adapters.length);
    for (const a of reg.adapters) {
      expect(a.category, `entry ${a.id} needs a category`).toBeTruthy();
      expect(a.id).not.toMatch(/^d{14}_/);
    }
    // Every compatibility route is NAMED (UnnamedAdapters = 0).
    expect(reg.categories.namedEntries.RUNTIME_COMPATIBILITY_ROUTE.length).toBe(routes.length);
    for (const a of routes) {
      expect(reg.categories.namedEntries.RUNTIME_COMPATIBILITY_ROUTE.join(" | ")).toContain(a.path);
    }
    expect(reg.metrics.unnamedAdapters).toBe(0);
    expect(reg.metrics.misclassifiedMigrationsAsAdapters).toBe(0);
  });

  it("every unapplied migration named by the registry exists on disk", () => {
    const migrations = reg.ownerPending.entries
      .filter((e) => e.category === "OWNER_MIGRATION")
      .map((e) => e.migration!);
    expect(migrations.length).toBe(reg.categories.counts.ownerMigrations);
    for (const m of migrations) {
      expect(existsSync(resolve(REPO, m, "migration.sql")), `missing: ${m}`).toBe(true);
    }
  });

  it("the six Legal-Hold compatibility routes are registered as a single owner-pending item", () => {
    const entry = reg.ownerPending.entries.find(
      (e) => e.category === "OWNER_MIGRATION_PENDING_COMPATIBILITY",
    );
    expect(entry, "the compatibility-route retention must be owner-registered").toBeTruthy();
    const governanceAdapters = reg.adapters.filter((a) => a.family === "LEGAL_HOLD" && a.category === "RUNTIME_COMPATIBILITY_ROUTE");
    // Exactly SIX Legal-Hold compatibility routes — the seventh compatibility
    // route belongs to a different family and is named separately.
    expect(governanceAdapters.length).toBe(6);
    expect(reg.categories.legalHoldRouteCount).toBe(6);
    for (const a of governanceAdapters) {
      expect(entry!.target).toContain(a.path!);
    }
  });
});
