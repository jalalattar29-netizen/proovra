/**
 * PHASE 13 (NEW-047) — THE ADVERSARIAL BATTERY FOR STRUCTURAL REACHABILITY.
 *
 * WHAT WENT WRONG, AND WHY A BATTERY
 * ---------------------------------------------------------------------------
 * Two gates decided AUTHORITY and REACHABILITY questions by matching a regular
 * expression across a FIXED CHARACTER WINDOW:
 *
 *   verify-module-reachability.mjs
 *     /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*["']([^"']+)["']/g
 *
 *   phase-37-98-command-center-projection-consumption.test.ts
 *     /buildProjectionSummary[\s\S]{0,3000}prisma\.evidence\.count\(…teamId/
 *
 * A six-line explanatory comment written INSIDE a re-export brace list pushed
 * one statement past 400 characters. The edge to `rbac.service.ts` stopped being
 * followed, and a 940-line RBAC lifecycle authority was reported as an
 * unreachable production module. Nothing about the runtime had changed — the
 * finding was manufactured entirely by the shape of a comment.
 *
 * Both regexes are gone. The replacement reads the syntax tree. This file is the
 * proof that it reads it for the RIGHT REASONS, because a structural check that
 * happens to give the same answers by accident is no better than the window it
 * replaced. Every case below asserts the REASON — the resolution path, the
 * declaring file, the refusal code — never merely a boolean.
 *
 * Ten cases, in the order they are numbered in the finding:
 *
 *   1  the authority appears only inside a COMMENT              → NOT evidence
 *   2  the authority appears only inside a STRING LITERAL       → NOT evidence
 *   3  a valid call moved >2,000 lines from the declaration     → RESOLVES
 *   4  a wrapper function around the authority                  → RESOLVES
 *   5  an aliased import (`import { x as y }`)                  → RESOLVES
 *   6  a barrel re-export chain                                 → RESOLVES
 *   7  an unrelated local function sharing the name             → NOT the authority
 *   8  a DEAD function containing a valid-looking call          → DECLARED, NOT REACHED
 *   9  a dynamic unresolved import                              → REPORTED UNRESOLVED
 *  10  a large valid module with comments between the nodes     → RESOLVES
 *
 * Cases 3 and 10 are the two the old implementation got wrong: it rejected both,
 * for a reason that had nothing to do with the code. Case 10a is the finding
 * itself, written down.
 *
 * Case 11 is not from the finding. It pins the fixture indexer against the
 * production one, so the nine synthetic cases cannot drift into testing a
 * private copy of the analyzer.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { buildCallGraph, resolveCall } from "../scripts/capability-authority/call-graph.mjs";
import { prismaAccess } from "../scripts/capability-authority/tenant-binding.mjs";
import {
  indexModules,
  moduleSpecifiersOf,
  parseModule,
  reachesFrom,
  resolveAuthority,
  ts,
  whereKeysOf,
} from "../scripts/capability-authority/structural-reach.mjs";

// Case 11 parses the live API + worker + package trees through the compiler API.
vi.setConfig({ testTimeout: 300_000 });

// ---------------------------------------------------------------------------
// Harness
//
// Fixtures are held in memory and indexed by `indexModules`. They are NEVER
// written into the source tree: vitest runs suites in parallel, and a fixture
// that exists for even a second inside `services/api/src` makes the route
// inventory, the map-freshness gate and this very reachability gate fail on a
// file that does not exist. That lesson is already recorded in
// phase-13-tenant-binding-adversarial.test.ts.
// ---------------------------------------------------------------------------

type Source = { file: string; text: string };

/**
 * The thing every fixture is looking for: a tenant-scoped Prisma count.
 *
 * It is the same shape the real subject uses (`buildProjectionSummary`'s bounded
 * live fallback), so a fixture that "resolves" resolves to the same kind of fact
 * the production gate cares about.
 */
const TENANT_SCOPED_COUNT = `prisma.evidence.count({ where: { teamId, deletedAt: null } });`;

type CountHit = { model: string; where: { ok: boolean; keys?: string[]; reason?: string } };

/** Hand every visited node to the REAL Prisma access detector. */
const countMatch = (node: unknown): CountHit | null => {
  const access = prismaAccess(node) as { model: string; op: string } | null;
  if (!access || access.op !== "count") return null;
  return { model: access.model, where: whereKeysOf(node) as CountHit["where"] };
};

function walkFixture(
  sources: Source[],
  file: string,
  name: string,
  opts: { maxDepth?: number } = {},
) {
  const cg = indexModules(sources);
  const start = resolveAuthority(cg, file, name);
  const walk = reachesFrom(cg, start, { match: countMatch, ...opts });
  return { cg, start, walk };
}

/** Filler that is CODE, so case 3 measures distance and not comment volume. */
const codeFiller = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `const filler${i} = ${i};`).join("\n");

/** Filler that is COMMENT, which is what actually broke the window regex. */
const commentFiller = (lines: number) =>
  Array.from(
    { length: lines },
    (_, i) => ` * Explanatory line ${i}: the rationale lives beside the code it explains.`,
  ).join("\n");

// ===========================================================================
// 1 — the authority name appears only inside a COMMENT
// ===========================================================================

describe("NEW-047 case 1 — a mention inside a COMMENT is not evidence", () => {
  const MODULE_LEVEL: Source = {
    file: "fixture/comment-only.ts",
    text: `
/**
 * This module deliberately does NOT import the RBAC authority. The specifier
 * below is documentation of where that authority lives:
 *
 *   import { assignRole } from "./rbac.service.js";
 *   export * from "./rbac.service.js";
 */
export const NOTHING = 1;
`,
  };

  it("a module specifier written in a comment produces no edge and no gap", () => {
    const { edges, unresolved } = moduleSpecifiersOf(MODULE_LEVEL.file, MODULE_LEVEL.text);
    // The REASON: a comment is trivia, not a node. There is no exclusion rule
    // for comments anywhere in the extractor — there cannot be a comment edge to
    // exclude, because the parser never produces an ImportDeclaration here.
    expect(edges).toEqual([]);
    // And it is not a GAP either. "I saw nothing" and "I could not look" are
    // different answers and the extractor must not confuse them.
    expect(unresolved).toEqual([]);
    expect(MODULE_LEVEL.text).toContain('"./rbac.service.js"');
  });

  it("a commented-out query is not reached", () => {
    const sources: Source[] = [
      {
        file: "fixture/comment-call.ts",
        text: `
export function entry(teamId: string) {
  // The bounded live fallback would look like this:
  //   ${TENANT_SCOPED_COUNT}
  /* ${TENANT_SCOPED_COUNT} */
  return teamId;
}
`,
      },
    ];
    const { start, walk } = walkFixture(sources, "fixture/comment-call.ts", "entry");
    // The start MUST resolve, or "not reached" would be an artefact of a failed
    // lookup rather than a measurement of the body.
    expect(start.ok).toBe(true);
    expect(start.via).toBe("DECLARATION");
    expect(walk.startResolved).toBe(true);
    expect(walk.evidence).toEqual([]);
    expect(walk.reached).toBe(false);
  });
});

// ===========================================================================
// 2 — the authority name appears only inside a STRING LITERAL
// ===========================================================================

describe("NEW-047 case 2 — a mention inside a STRING LITERAL is not evidence", () => {
  const MODULE_LEVEL: Source = {
    file: "fixture/string-only.ts",
    text: `
const HELP_TEXT = 'import { assignRole } from "./rbac.service.js";';
const TEMPLATE = \`export * from "./rbac.service.js";\`;
export const HELP = [HELP_TEXT, TEMPLATE];
`,
  };

  it("a specifier inside a string literal produces no edge", () => {
    const { edges, unresolved } = moduleSpecifiersOf(MODULE_LEVEL.file, MODULE_LEVEL.text);
    // The REASON: a string literal in expression position is an
    // ExpressionStatement's operand. Only `ImportDeclaration.moduleSpecifier`,
    // `ExportDeclaration.moduleSpecifier` and the first argument of
    // `import()`/`require()` are read as specifiers. There is no third place
    // for a string to become an edge.
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it("a query written as a string is not reached", () => {
    const sources: Source[] = [
      {
        file: "fixture/string-call.ts",
        text: `
export function entry(teamId: string) {
  const documentation = "${TENANT_SCOPED_COUNT.replace(/"/g, "'")}";
  const rendered = \`${TENANT_SCOPED_COUNT.replace(/`/g, "")}\`;
  return [documentation, rendered, teamId];
}
`,
      },
    ];
    const { walk } = walkFixture(sources, "fixture/string-call.ts", "entry");
    expect(walk.startResolved).toBe(true);
    expect(walk.evidence).toEqual([]);
    expect(walk.reached).toBe(false);
  });
});

// ===========================================================================
// 3 — a VALID call, more than 2,000 lines from the declaration
// ===========================================================================

describe("NEW-047 case 3 — distance is not a fact about the code", () => {
  const FAR: Source = {
    file: "fixture/far.ts",
    text: `
export function entry(teamId: string) {
  return authority(teamId);
}

${codeFiller(2500)}

function authority(teamId: string) {
  ${TENANT_SCOPED_COUNT}
  return teamId;
}
`,
  };

  it("resolves across 2,500 lines, and the distance is not why", () => {
    // Pin the fixture's own premise, so a future edit cannot quietly shrink it
    // back inside a window and make this case pass for the old wrong reason.
    const callAt = FAR.text.indexOf("authority(teamId);");
    const declAt = FAR.text.indexOf("function authority(");
    expect(FAR.text.split("\n").length).toBeGreaterThan(2500);
    expect(declAt - callAt).toBeGreaterThan(40_000);

    const { walk } = walkFixture([FAR], "fixture/far.ts", "entry");
    // The REASON it resolves: `resolveCall` looked the identifier up in the
    // file's declaration table. A declaration table has no coordinates.
    expect(walk.reached).toBe(true);
    expect(walk.evidence).toHaveLength(1);
    const hit = walk.evidence[0] as CountHit & { file: string };
    expect(hit.model).toBe("evidence");
    expect(hit.file).toBe("fixture/far.ts");
    expect(hit.where.ok).toBe(true);
    expect(hit.where.keys).toContain("teamId");
  });
});

// ===========================================================================
// 4 — a WRAPPER function around the authority
// ===========================================================================

describe("NEW-047 case 4 — a wrapper is followed, one hop at a time", () => {
  const WRAPPED: Source = {
    file: "fixture/wrapped.ts",
    text: `
export function entry(teamId: string) {
  return wrapper(teamId);
}

function wrapper(teamId: string) {
  return authority(teamId);
}

function authority(teamId: string) {
  ${TENANT_SCOPED_COUNT}
  return teamId;
}
`,
  };

  it("is reached through the wrapper, and only at the depth the wrapper implies", () => {
    // The REASON, pinned as a gradient rather than a boolean: the count becomes
    // reachable EXACTLY when the traversal is allowed the two hops the source
    // actually contains. A proximity check would have found it at depth 0, and
    // that coincidence is what this asserts is gone.
    expect(walkFixture([WRAPPED], "fixture/wrapped.ts", "entry", { maxDepth: 0 }).walk.reached).toBe(
      false,
    );
    expect(walkFixture([WRAPPED], "fixture/wrapped.ts", "entry", { maxDepth: 1 }).walk.reached).toBe(
      false,
    );

    const { walk } = walkFixture([WRAPPED], "fixture/wrapped.ts", "entry", { maxDepth: 2 });
    expect(walk.reached).toBe(true);
    expect(walk.functionsVisited).toBe(2);
    expect((walk.evidence[0] as CountHit).where.keys).toContain("teamId");
  });
});

// ===========================================================================
// 5 — an ALIASED import
// ===========================================================================

describe("NEW-047 case 5 — an aliased import resolves to the original export", () => {
  const SOURCES: Source[] = [
    {
      file: "fixture/alias-consumer.ts",
      text: `
import { authority as renamedLocally } from "./alias-impl.js";

export function entry(teamId: string) {
  return renamedLocally(teamId);
}
`,
    },
    {
      file: "fixture/alias-impl.ts",
      text: `
export function authority(teamId: string) {
  ${TENANT_SCOPED_COUNT}
  return teamId;
}
`,
    },
  ];

  it("follows the alias to the declaring module", () => {
    const { cg, walk } = walkFixture(SOURCES, "fixture/alias-consumer.ts", "entry");
    expect(walk.reached).toBe(true);
    // The REASON: the import table stores the ORIGINAL exported name
    // (`propertyName`), so the lookup in the target module asks for `authority`
    // and not for the local alias, which the target does not export.
    expect((walk.evidence[0] as CountHit & { file: string }).file).toBe("fixture/alias-impl.ts");

    const alias = resolveAuthority(cg, "fixture/alias-consumer.ts", "renamedLocally");
    expect(alias.ok).toBe(true);
    expect(alias.via).toBe("IMPORT");
    expect(alias.file).toBe("fixture/alias-impl.ts");
    expect(alias.name).toBe("authority");
  });

  it("the ORIGINAL name is not bound in the consumer, and is not invented", () => {
    const cg = indexModules(SOURCES);
    // `authority` is a name the consumer never binds. A global name index would
    // happily match it; this must not.
    const bogus = resolveAuthority(cg, "fixture/alias-consumer.ts", "authority");
    expect(bogus.ok).toBe(false);
    expect(bogus.reason).toBe("NO_DECLARATION");
  });
});

// ===========================================================================
// 6 — a BARREL re-export chain
// ===========================================================================

describe("NEW-047 case 6 — a barrel chain is followed to the implementation", () => {
  const SOURCES: Source[] = [
    {
      file: "fixture/barrel-consumer.ts",
      text: `
import { authority } from "./barrel.js";

export function entry(teamId: string) {
  return authority(teamId);
}
`,
    },
    { file: "fixture/barrel.ts", text: `export * from "./barrel-inner.js";\n` },
    {
      file: "fixture/barrel-inner.ts",
      text: `export { deepAuthority as authority } from "./barrel-impl.js";\n`,
    },
    {
      file: "fixture/barrel-impl.ts",
      text: `
export function deepAuthority(teamId: string) {
  ${TENANT_SCOPED_COUNT}
  return teamId;
}
`,
    },
  ];

  it("crosses `export *` and a RENAMED `export … from` to reach the declaration", () => {
    const { cg, walk } = walkFixture(SOURCES, "fixture/barrel-consumer.ts", "entry");
    expect(walk.reached).toBe(true);
    // The REASON: three distinct hops, each a real syntactic edge — a named
    // import, a star re-export, and a renamed re-export whose exported name does
    // not exist in the module that declares it.
    expect((walk.evidence[0] as CountHit & { file: string }).file).toBe("fixture/barrel-impl.ts");

    const throughBarrel = resolveAuthority(cg, "fixture/barrel.ts", "authority");
    expect(throughBarrel.ok).toBe(true);
    expect(throughBarrel.via).toBe("RE_EXPORT");
    expect(throughBarrel.file).toBe("fixture/barrel-impl.ts");
    expect(throughBarrel.name).toBe("deepAuthority");
  });

  it("the barrel's own module records the specifier as a RE_EXPORT edge", () => {
    const barrel = moduleSpecifiersOf("fixture/barrel.ts", SOURCES[1].text);
    expect(barrel.edges).toEqual([
      { spec: "./barrel-inner.js", kind: "EXPORT_STAR", line: 1, typeOnly: false, via: "LITERAL" },
    ]);
    const inner = moduleSpecifiersOf("fixture/barrel-inner.ts", SOURCES[2].text);
    expect(inner.edges[0]).toMatchObject({ spec: "./barrel-impl.js", kind: "RE_EXPORT" });
  });
});

// ===========================================================================
// 7 — an unrelated LOCAL function sharing the authority's name
// ===========================================================================

describe("NEW-047 case 7 — a shared name is not a shared identity", () => {
  const SOURCES: Source[] = [
    {
      file: "fixture/shadow.ts",
      text: `
export function entry(teamId: string) {
  return authority(teamId);
}

/** A local helper that happens to be called \`authority\`. It queries nothing. */
function authority(teamId: string) {
  return teamId.trim();
}
`,
    },
    {
      file: "fixture/shadow-real.ts",
      text: `
export function authority(teamId: string) {
  ${TENANT_SCOPED_COUNT}
  return teamId;
}
`,
    },
  ];

  it("resolves to the LOCAL declaration and never to the same-named authority", () => {
    const { cg, walk } = walkFixture(SOURCES, "fixture/shadow.ts", "entry");
    // The REASON: name resolution is per-file. The local declaration table is
    // consulted first and there is no global name index to fall through to —
    // that fallback is the documented defect `call-graph.mjs` exists to avoid.
    expect(walk.startResolved).toBe(true);
    expect(walk.reached).toBe(false);
    expect(walk.evidence).toEqual([]);

    const local = resolveAuthority(cg, "fixture/shadow.ts", "authority");
    expect(local.ok).toBe(true);
    expect(local.via).toBe("DECLARATION");
    expect(local.file).toBe("fixture/shadow.ts");
  });

  it("the REAL authority is still found when a module actually names it", () => {
    // The paired positive. A resolver that answers "no" to everything would pass
    // the case above and be useless.
    const { walk } = walkFixture(SOURCES, "fixture/shadow-real.ts", "authority");
    expect(walk.reached).toBe(true);
    expect((walk.evidence[0] as CountHit & { file: string }).file).toBe("fixture/shadow-real.ts");
  });
});

// ===========================================================================
// 8 — a DEAD function containing a valid-looking call
// ===========================================================================

describe("NEW-047 case 8 — DECLARED is not REACHED", () => {
  const SOURCES: Source[] = [
    {
      file: "fixture/dead.ts",
      text: `
export function entry(teamId: string) {
  return teamId;
}

/** Declared, exported, syntactically perfect — and called by nobody. */
export function deadPath(teamId: string) {
  ${TENANT_SCOPED_COUNT}
  return teamId;
}
`,
    },
  ];

  it("a sibling function's query is not credited to the entrypoint", () => {
    const { cg, walk } = walkFixture(SOURCES, "fixture/dead.ts", "entry");
    expect(walk.startResolved).toBe(true);
    expect(walk.reached).toBe(false);
    expect(walk.evidence).toEqual([]);

    // The REASON, stated as the distinction the finding asks for: the dead
    // function IS a declaration — `resolveAuthority` finds it — and it is NOT
    // reached. A window regex cannot express the difference; this is exactly the
    // false positive that would have satisfied the 3000-character check in
    // phase-37-98 while `buildProjectionSummary` queried nothing at all.
    const declared = resolveAuthority(cg, "fixture/dead.ts", "deadPath");
    expect(declared.ok).toBe(true);
    expect(declared.via).toBe("DECLARATION");

    const fromDead = reachesFrom(cg, declared, { match: countMatch });
    expect(fromDead.reached).toBe(true);
  });
});

// ===========================================================================
// 9 — a DYNAMIC, unresolvable import
// ===========================================================================

describe("NEW-047 case 9 — an unresolvable specifier is REPORTED, never assumed", () => {
  it("a parameter-valued specifier is a counted gap, not an absent edge", () => {
    const text = `
export async function entry(specifier: string) {
  const mod = await import(specifier);
  return mod;
}
`;
    const { edges, unresolved } = moduleSpecifiersOf("fixture/dynamic-param.ts", text);
    expect(edges).toEqual([]);
    expect(unresolved).toHaveLength(1);
    // The REASON is the payload: kind, line and the source expression, so a
    // human can go and decide what it means. Silence in either direction — an
    // assumed edge or an assumed absence — is the failure mode.
    expect(unresolved[0]).toMatchObject({
      kind: "DYNAMIC_IMPORT_COMPUTED",
      expression: "specifier",
    });
    expect(unresolved[0].line).toBe(3);
  });

  it("a template WITH substitutions and a concatenation are both gaps", () => {
    const text = [
      "const dir = 'services';",
      "export async function a(name: string) { return import(`./${dir}/${name}.js`); }",
      "export async function b(name: string) { return import('./base/' + name); }",
      "export async function c() { return require(process.env.MOD_PATH as string); }",
    ].join("\n");
    const { edges, unresolved } = moduleSpecifiersOf("fixture/dynamic-computed.ts", text);
    expect(edges).toEqual([]);
    expect(unresolved.map((u) => u.kind).sort()).toEqual([
      "DYNAMIC_IMPORT_COMPUTED",
      "DYNAMIC_IMPORT_COMPUTED",
      "REQUIRE_COMPUTED",
    ]);
  });

  it("the call graph refuses the same call with a named reason", () => {
    const sources: Source[] = [
      {
        file: "fixture/dynamic-call.ts",
        text: `
export async function entry(specifier: string) {
  const { authority } = await import(specifier);
  return authority();
}
`,
      },
    ];
    const cg = indexModules(sources);
    const sf = parseModule(sources[0].file, sources[0].text);
    let importCall: unknown = null;
    const visit = (node: unknown): void => {
      const callee = (node as { expression?: { kind?: number } }).expression;
      if (
        importCall === null &&
        ts.isCallExpression(node) &&
        callee?.kind === ts.SyntaxKind.ImportKeyword
      ) {
        importCall = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(importCall).not.toBeNull();
    const resolved = resolveCall(importCall, sources[0].file, cg);
    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toBe("DYNAMIC_IMPORT_UNRESOLVED");
  });

  it("the local-const fold is EXACTLY-ONCE, and never a guess", () => {
    // A single `const` bound to a string literal is a value the tree states, and
    // it is folded — that is how the two optional-dependency imports in the live
    // tree (`@aws-sdk/client-sts`, `ffprobe-static`) stop being phantom gaps.
    const single = moduleSpecifiersOf(
      "fixture/fold-ok.ts",
      `
export async function entry() {
  const optionalModule = "@aws-sdk/client-sts";
  return import(optionalModule);
}
`,
    );
    expect(single.unresolved).toEqual([]);
    expect(single.edges[0]).toMatchObject({ spec: "@aws-sdk/client-sts", via: "LOCAL_CONST" });

    // Bound twice in the same file: the identifier at the import site might mean
    // either binding, and choosing one would be the "close enough" reasoning
    // this whole change removes.
    const ambiguous = moduleSpecifiersOf(
      "fixture/fold-ambiguous.ts",
      `
export async function a() {
  const optionalModule = "@aws-sdk/client-sts";
  return import(optionalModule);
}
export async function b() {
  const optionalModule = "ffprobe-static";
  return optionalModule;
}
`,
    );
    expect(ambiguous.edges).toEqual([]);
    expect(ambiguous.unresolved).toHaveLength(1);
    expect(ambiguous.unresolved[0].kind).toBe("DYNAMIC_IMPORT_COMPUTED");

    // A `let` can be reassigned between the declaration and the use.
    const reassignable = moduleSpecifiersOf(
      "fixture/fold-let.ts",
      `
export async function entry(flag: boolean) {
  let optionalModule = "@aws-sdk/client-sts";
  if (flag) optionalModule = "ffprobe-static";
  return import(optionalModule);
}
`,
    );
    expect(reassignable.edges).toEqual([]);
    expect(reassignable.unresolved).toHaveLength(1);
  });
});

// ===========================================================================
// 10 — a large valid module with COMMENTS between the relevant nodes
// ===========================================================================

describe("NEW-047 case 10 — the regression itself: comments between the nodes", () => {
  it("10a. a re-export brace list with a comment in it still yields its edge", () => {
    // This IS the finding. The comment sits inside the brace list, pushing
    // `from "./rbac.service.js"` past the 400-character window the old regex
    // allowed between the `export` keyword and its specifier.
    const text = `
export {
  assignRole,
  // ──────────────────────────────────────────────────────────────────────
  // Role assignment and revocation are one authority on purpose: the
  // lifecycle transitions have to agree about what an ACTIVE membership is,
  // and two modules deciding that separately is how a revoked reviewer keeps
  // a capability. The rationale lives here, beside the export, because that
  // is where the next person changing it will be looking.
  // ──────────────────────────────────────────────────────────────────────
  revokeRole,
} from "./rbac.service.js";
`;
    // Pin the premise: the statement really does exceed the old window.
    const statement = text.slice(text.indexOf("export {"), text.indexOf(";", text.indexOf("from")));
    expect(statement.length).toBeGreaterThan(400);

    const { edges, unresolved } = moduleSpecifiersOf("fixture/reexport-with-comment.ts", text);
    // The REASON: `ExportDeclaration.moduleSpecifier` is a child of the
    // statement node. Comments are trivia attached between tokens and change no
    // node's identity, so the distance they add is not a quantity the extractor
    // can observe.
    expect(unresolved).toEqual([]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ spec: "./rbac.service.js", kind: "RE_EXPORT" });
  });

  it("10b. a large module with a docblock between caller and callee still resolves", () => {
    const source: Source = {
      file: "fixture/commented.ts",
      text: `
export function entry(teamId: string) {
  return authority(teamId);
}

/**
${commentFiller(300)}
 */

${codeFiller(1200)}

/**
${commentFiller(300)}
 */
function authority(teamId: string) {
  ${TENANT_SCOPED_COUNT}
  return teamId;
}
`,
    };
    const callAt = source.text.indexOf("authority(teamId);");
    const declAt = source.text.indexOf("function authority(");
    expect(declAt - callAt).toBeGreaterThan(50_000);

    const { walk } = walkFixture([source], "fixture/commented.ts", "entry");
    expect(walk.reached).toBe(true);
    const hit = walk.evidence[0] as CountHit & { file: string };
    expect(hit.model).toBe("evidence");
    expect(hit.where.ok).toBe(true);
    expect(hit.where.keys).toContain("teamId");
  });

  it("10c. a `where` that only PROJECTS the tenant column is not scoped", () => {
    // The other half of case 10's window: `[\\s\\S]{0,80}teamId` accepted the
    // column appearing anywhere near the call, including in a `select`. Reading
    // the predicate's keys structurally makes that impossible.
    const source: Source = {
      file: "fixture/projection.ts",
      text: `
export function entry(userId: string) {
  prisma.evidence.count({ where: { userId }, select: { id: true, teamId: true } });
  return userId;
}
`,
    };
    const { walk } = walkFixture([source], "fixture/projection.ts", "entry");
    expect(walk.reached).toBe(true);
    const hit = walk.evidence[0] as CountHit;
    expect(hit.where.ok).toBe(true);
    expect(hit.where.keys).toEqual(["userId"]);
    expect(hit.where.keys).not.toContain("teamId");
  });
});

// ===========================================================================
// 11 — the fixture indexer is pinned to the production one
// ===========================================================================

describe("NEW-047 case 11 — the fixture index cannot drift from the live index", () => {
  /**
   * The nine synthetic cases above run through `indexModules`, because
   * `buildCallGraph()` reads a fixed set of roots from disk and a fixture cannot
   * be written into the production tree. That is only honest if the two indexers
   * agree, so this compares them on REAL modules: same declarations, same import
   * table, same re-export edges.
   *
   * Every resolution DECISION in this suite is already made by `call-graph.mjs`
   * (`lookupExport`, `resolveCall`, `traverse`). This case closes the remaining
   * gap — that the tables those decisions read are built the same way.
   */
  const REAL = [
    "services/api/src/services/dashboard/projections/refresh-org-health.service.ts",
    "services/api/src/services/dashboard/command-center.service.ts",
  ];

  it("agrees with buildCallGraph on declarations, imports and re-exports", () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const sources: Source[] = REAL.map((file) => ({
      file,
      text: readFileSync(`${repoRoot}${file}`, "utf8"),
    }));
    const mine = indexModules(sources);
    const live = buildCallGraph();

    for (const file of REAL) {
      const a = mine.graph.get(file);
      const b = live.graph.get(file);
      expect(b, `${file} is not indexed by buildCallGraph`).toBeTruthy();

      // Descriptor-table rows are the one thing `indexModules` deliberately does
      // not synthesise, and the live indexer suffixes its extra rows `@altN`.
      const liveDecls = [...b.decls.keys()].filter((k: string) => !k.includes("@alt")).sort();
      expect([...a.decls.keys()].sort()).toEqual(liveDecls);

      // Only the edges BOTH indexers can see: `indexModules` is given two files
      // and cannot resolve a specifier pointing outside that set.
      for (const [local, binding] of a.imports) {
        expect(b.imports.get(local)).toEqual(binding);
      }
      expect(a.reExports).toEqual(b.reExports.filter((f: string) => mine.fileSet.has(f)));
    }
  });
});
