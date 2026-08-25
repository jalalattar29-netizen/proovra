#!/usr/bin/env node
/**
 * WORKSPACE-SCOPE CONVERGENCE — live static scope-authority verifier.
 *
 * The defect class this exists to prevent
 * ---------------------------------------
 * Two models in this schema are MIXED-OWNERSHIP: `Evidence` and `Case` both
 * have a NULLABLE `team_id`. New rows always carry a real workspace id (the
 * write paths bootstrap a personal workspace rather than writing NULL), but
 * databases that predate that change — local checkouts, restored snapshots,
 * production before the backfill — still hold rows where `team_id IS NULL`
 * and ownership is carried by `owner_user_id` alone.
 *
 * A read written as
 *
 *     prisma.evidence.count({ where: { teamId: activeWorkspaceId, ... } })
 *
 * silently omits every one of those rows. It does not error, it does not warn,
 * and it does not return a partial result an operator could notice: it returns
 * a smaller number that looks exactly like good news. That is how Operations
 * rendered "all clear" over a workspace whose Home was reporting CRITICAL.
 *
 * The canonical authority is `workspaceEvidenceWhere` / `workspaceCaseWhere`
 * in `src/services/workspace-personal-scope.service.ts`. They widen a personal
 * workspace's filter to the owner's NULL-team rows and leave a shared
 * workspace strict, so the fallback can never cross a tenant boundary: the
 * NULL arm is always conjoined with that workspace's single owner.
 *
 * What this script does
 * ---------------------
 * It COMPUTES the conclusion from the AST on every run rather than trusting a
 * hand-maintained table beside the code:
 *
 *   1. Enumerates production TypeScript (git-tracked, excluding tests,
 *      scripts, generated output and type declarations).
 *
 *   2. Finds every Prisma call SEMANTICALLY — a call expression on a
 *      `<client>.<model>.<operation>` property access — for the
 *      mixed-ownership models. Comments, doc blocks and strings that merely
 *      mention `teamId` are invisible to it, which is the false-positive
 *      class a regex scan cannot avoid.
 *
 *   3. Reads each call's own `where` argument as a TREE, descending through
 *      `AND` / `OR` / `NOT` arms and array literals, so a workspace predicate
 *      buried in an `OR` arm is seen exactly like a top-level one. Shorthand
 *      (`{ teamId }`) and longhand (`{ teamId: x }`) are the same fact here —
 *      the shorthand form is what hid a whole surface's worth of counters
 *      from the first version of this scan.
 *
 *   4. Classifies:
 *
 *        RECORD_LOOKUP  — the `where` pins a specific row by primary key or
 *                         another unique column. This is not a population
 *                         read; tenancy for these is enforced AFTER the read
 *                         by comparing the loaded row's teamId, and widening
 *                         them would be meaningless.
 *        CANONICAL      — the `where` is built from the canonical scope
 *                         authority: a direct `workspaceEvidenceWhere(...)` /
 *                         `workspaceCaseWhere(...)` call, a symbol
 *                         transitively derived from one, or a value whose
 *                         declared type is the branded `WorkspaceEvidenceScope`
 *                         / `WorkspaceCaseScope`.
 *        RELATION_SCOPED— the population is bounded through a relation whose
 *                         filter is itself canonical (e.g. a review workflow
 *                         scoped by `evidence: <canonical>`). The related
 *                         model is the ownership authority; re-deriving the
 *                         workspace locally would be a second one.
 *        CROSS_TENANT   — a deliberate platform-scope read (no workspace
 *                         predicate at all). Judged by the platform-scope
 *                         allowlist, not by this rule.
 *        ALLOWLISTED    — declared below with a stated, reviewed reason.
 *        VIOLATION      — a population read bounded by a raw workspace
 *                         predicate on a mixed-ownership model, with no
 *                         canonical authority anywhere in its `where`.
 *
 *   5. Independently flags UNBOUND_NULL: any `teamId: null` predicate that is
 *      not conjoined with an owner predicate in the same object. An unbound
 *      NULL arm is strictly worse than the omission it was written to fix —
 *      it returns every tenant's orphan rows to whoever asked.
 *
 * Exit codes: 0 clean, 1 violations, 2 the script itself could not run.
 *
 * Usage:
 *   node services/api/scripts/verify-workspace-scope-authorities.mjs
 *   node services/api/scripts/verify-workspace-scope-authorities.mjs --json
 */

import ts from "typescript";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");

// ---------------------------------------------------------------------------
// The models this rule governs.
//
// Derived from the schema fact that makes the defect possible — a NULLABLE
// `team_id` on a model whose rows are tenant data. A model whose `team_id` is
// NOT NULL cannot have the omission this script looks for, and forcing the
// canonical helper onto it would add an authority rather than remove one.
// ---------------------------------------------------------------------------
const MIXED_OWNERSHIP_MODELS = {
  evidence: {
    prismaModel: "Evidence",
    canonicalHelper: "workspaceEvidenceWhere",
    brandedType: "WorkspaceEvidenceScope",
    ownerField: "ownerUserId",
  },
  case: {
    prismaModel: "Case",
    canonicalHelper: "workspaceCaseWhere",
    brandedType: "WorkspaceCaseScope",
    ownerField: "ownerUserId",
  },
};

/**
 * Relation property names that carry a mixed-ownership model's ownership.
 *
 * A row on a dependent model (a review workflow, a reviewer comment, an
 * annotation) belongs to the workspace its Evidence belongs to. Scoping it
 * through `{ evidence: <canonical scope> }` consumes the ONE authority; giving
 * the dependent model its own workspace predicate creates a second one that
 * can — and on this codebase did — disagree.
 */
const OWNERSHIP_RELATIONS = new Set(["evidence", "case"]);

const READ_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

/**
 * Write operations are included deliberately. `updateMany` / `deleteMany`
 * bounded by a raw workspace predicate have the same blind spot as a read:
 * they silently skip the rows a strict filter cannot see, which turns a bulk
 * legal-hold or retention action into a partial one that reports success.
 */
const WRITE_OPERATIONS = new Set(["updateMany", "deleteMany"]);

const GOVERNED_OPERATIONS = new Set([...READ_OPERATIONS, ...WRITE_OPERATIONS]);

/** Predicate keys that pin one row, making the call a record lookup. */
const UNIQUE_PREDICATE_KEYS = new Set(["id", "evidenceId", "sha256", "slug"]);

/** Boolean combinators whose arms must be descended into. */
const COMBINATORS = new Set(["AND", "OR", "NOT"]);

// ---------------------------------------------------------------------------
// REVIEWED EXCEPTIONS.
//
// Every entry states WHY the raw predicate is correct there. An entry without
// a reason is not an exception, it is an unexamined violation with a comment.
//
// `symbol` is the enclosing function name; it is matched in addition to the
// file so that adding a new query to an allowlisted file does NOT inherit the
// exception. That is the property a file-level allowlist loses.
// ---------------------------------------------------------------------------
const ALLOWLIST = [
  {
    file: "src/services/workspace-personal-scope.service.ts",
    symbol: "*",
    reason:
      "The canonical authority itself. It is where the strict predicate and " +
      "the owner-bound NULL arm are DEFINED; it cannot consume itself.",
  },
  {
    file: "src/services/billing-enforcement.service.ts",
    symbol: "assertWorkspaceAllowsEvidenceCreation",
    reason:
      "Commercial metering, not a tenant population read. The personal branch " +
      "beside it is already owner-bound across both arms, and this branch " +
      "counts what a SHARED workspace consumed in a billing window. Routing " +
      "either through the workspace read authority would silently redefine " +
      "what the customer is charged for.",
  },
  {
    file: "src/services/admin/executive.service.ts",
    symbol: "*",
    reason:
      "PLATFORM console aggregate across all workspaces. It is explicitly " +
      "cross-tenant (`teamId: { not: null }`) and is gated by platform-admin " +
      "authority, never by workspace membership.",
  },
  {
    file: "src/routes/analytics.routes.ts",
    symbol: "computeTeamWorkspaceHealth",
    reason:
      "`groupBy({ by: ['teamId'] })` CANNOT attribute a NULL-team row to a " +
      "workspace — the grouping key is the very column that is absent, so a " +
      "widened read would return a `teamId: null` bucket the caller has no " +
      "workspace to assign it to. The correct fix for these rows is the " +
      "backfill (`scripts/backfill-personal-team-ownership.ts`), not a wider " +
      "read. The sibling `findMany` in the same function, which CAN carry the " +
      "canonical scope, was converged.",
  },
  {
    file: "src/routes/cases.routes.ts",
    symbol: "casesRoutes",
    reason:
      "`teamId: evidence.teamId` narrows to the workspace of the evidence " +
      "being attached, and Prisma renders a null value as `IS NULL` — so a " +
      "personal workspace's legacy NULL-team evidence already matches that " +
      "workspace's NULL-team cases. Widening it through the canonical helper " +
      "would BREAK the narrowing this query exists to perform. Cross-tenant " +
      "reach is prevented by the `eligibleOr` conjunct beside it, which admits " +
      "only cases the caller owns, has explicit access to, or reaches through " +
      "an ACTIVE membership.",
  },
  {
    file: "src/services/identity/org-security-policy.service.ts",
    symbol: "*",
    reason:
      "Org-managed-user sweep. The NULL arm is bound to a proven set of " +
      "managed user ids (`ownerUserId: { in: managedIds }`), which is the " +
      "same owner-binding the canonical helper applies, expressed over a set.",
  },
];

// ---------------------------------------------------------------------------
// File enumeration.
// ---------------------------------------------------------------------------
const PRODUCTION_ROOTS = [
  "services/api/src",
  "services/worker/src",
  "packages/shared-runtime/src",
  "packages/shared/src",
];

const EXCLUDED_SEGMENTS = [
  "/test/",
  "/tests/",
  "/__tests__/",
  "/dist/",
  "/node_modules/",
];

function listProductionFiles() {
  const out = execFileSync("git", ["ls-files", ...PRODUCTION_ROOTS], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .filter((f) => !f.endsWith(".d.ts"))
    .filter((f) => !f.includes(".test.") && !f.includes(".spec."))
    .filter((f) => !EXCLUDED_SEGMENTS.some((seg) => `/${f}`.includes(seg)));
}

// ---------------------------------------------------------------------------
// Intra-file taint: which symbols carry a canonical scope value.
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

function identifiersIn(text) {
  return text.match(IDENTIFIER_RE) ?? [];
}

const CANONICAL_HELPERS = new Set(
  Object.values(MIXED_OWNERSHIP_MODELS).map((m) => m.canonicalHelper),
);
const BRANDED_TYPES = new Set(
  Object.values(MIXED_OWNERSHIP_MODELS).map((m) => m.brandedType),
);

function mentionsCanonicalHelper(text) {
  return identifiersIn(text).some((id) => CANONICAL_HELPERS.has(id));
}

/**
 * Collects the names that hold a canonical scope, to a fixpoint.
 *
 * Three seeds, all structural rather than nominal:
 *   * a binding initialised (directly or through `await`) from a canonical
 *     helper call;
 *   * a binding, parameter or property whose written TYPE is one of the
 *     branded scope types — this is what lets the scope cross a function or
 *     module boundary without the scan having to follow it;
 *   * a property assigned a value that is already tainted, so a scope threaded
 *     through a context object (`ctx.evidenceWhere`) stays recognised.
 */
function collectCanonicalSymbols(sourceFile) {
  const tainted = new Set();
  const bindings = [];

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const typeText = node.type ? node.type.getText(sourceFile) : "";
      const initText = node.initializer
        ? node.initializer.getText(sourceFile)
        : "";
      bindings.push({ name: node.name.text, typeText, initText });
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      bindings.push({
        name: node.name.text,
        typeText: node.type ? node.type.getText(sourceFile) : "",
        initText: "",
      });
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      bindings.push({
        name: node.name.text,
        typeText: "",
        initText: node.initializer.getText(sourceFile),
      });
    }
    if (ts.isPropertySignature(node) && ts.isIdentifier(node.name)) {
      bindings.push({
        name: node.name.text,
        typeText: node.type ? node.type.getText(sourceFile) : "",
        initText: "",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const b of bindings) {
    if (identifiersIn(b.typeText).some((id) => BRANDED_TYPES.has(id))) {
      tainted.add(b.name);
    }
    if (mentionsCanonicalHelper(b.initText)) tainted.add(b.name);
  }

  let changed = true;
  let guard = 0;
  while (changed && guard < 32) {
    changed = false;
    guard += 1;
    for (const b of bindings) {
      if (tainted.has(b.name) || !b.initText) continue;
      if (identifiersIn(b.initText).some((id) => tainted.has(id))) {
        tainted.add(b.name);
        changed = true;
      }
    }
  }
  return tainted;
}

// ---------------------------------------------------------------------------
// `where` tree analysis.
// ---------------------------------------------------------------------------

/**
 * Walks a `where` expression and reports the workspace-relevant facts in it.
 *
 * The walk descends through combinator arms and array literals so that a
 * predicate's DEPTH never changes how it is judged. It reads shorthand and
 * longhand properties identically, because `{ teamId }` and `{ teamId: x }`
 * bound the same population.
 */
function analyseWhere(expr, sourceFile, taintedSymbols, model) {
  const facts = {
    workspacePredicates: [],
    unboundNullArms: [],
    hasUniquePredicate: false,
    canonicalReferences: [],
    relationScopes: [],
    /**
     * Arms that admit a row on OWNER identity alone, with no workspace
     * predicate beside them.
     *
     * This is the shape the "accessible cases" queries already use:
     *
     *     OR: [ { ownerUserId }, { access: { some: … } }, { teamId: { in: … } } ]
     *
     * The first arm reaches every row the caller owns INCLUDING the legacy
     * NULL-team ones, so the population has no personal omission to fix.
     * Rewriting it through the canonical helper would NARROW it — the helper
     * answers "one workspace", and this query deliberately answers "everything
     * this actor can reach". Recognising the shape is what keeps the rule from
     * demanding a change that would be a regression.
     */
    ownerInclusiveArms: [],
    referencedIdentifiers: new Set(),
  };
  if (!expr) return facts;

  for (const id of identifiersIn(expr.getText(sourceFile))) {
    facts.referencedIdentifiers.add(id);
    if (CANONICAL_HELPERS.has(id) || taintedSymbols.has(id)) {
      facts.canonicalReferences.push(id);
    }
  }

  const objectProperties = (obj) => {
    const props = new Map();
    let sawSpreadOfTainted = false;
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p)) {
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
          ? p.name.text
          : p.name.getText(sourceFile);
        props.set(key, { valueNode: p.initializer, shorthand: false });
      } else if (ts.isShorthandPropertyAssignment(p)) {
        props.set(p.name.text, { valueNode: p.name, shorthand: true });
      } else if (ts.isSpreadAssignment(p)) {
        const ids = identifiersIn(p.expression.getText(sourceFile));
        if (ids.some((id) => taintedSymbols.has(id) || CANONICAL_HELPERS.has(id))) {
          sawSpreadOfTainted = true;
        }
      }
    }
    return { props, sawSpreadOfTainted };
  };

  /**
   * `ownerBound` carries down the walk: it is true once ANY object on the
   * current conjunction path has constrained the owner.
   *
   * Without it the rule reads one object at a time and misses the commonest
   * safe shape there is —
   *
   *     { ownerUserId: <actor>, OR: [ { teamId: null }, { teamId: <personal> } ] }
   *
   * where the NULL arm is bound by an owner predicate its PARENT supplies.
   * Judging that arm unbound would report the billing meter, which is
   * owner-bound across every branch, as the exact defect this rule exists to
   * catch. An `OR` does NOT propagate the binding, because a sibling arm of an
   * OR is not conjoined with anything its siblings say.
   */
  const descend = (node, ownerBound = false) => {
    if (!node) return;
    if (ts.isParenthesizedExpression(node)) {
      return descend(node.expression, ownerBound);
    }
    if (ts.isAwaitExpression(node)) return descend(node.expression, ownerBound);
    if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) {
        if (ts.isSpreadElement(el)) descend(el.expression, ownerBound);
        else descend(el, ownerBound);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      descend(node.whenTrue, ownerBound);
      descend(node.whenFalse, ownerBound);
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) return;

    const { props, sawSpreadOfTainted } = objectProperties(node);
    if (sawSpreadOfTainted) facts.canonicalReferences.push("<spread>");

    for (const key of UNIQUE_PREDICATE_KEYS) {
      if (props.has(key)) facts.hasUniquePredicate = true;
    }

    const ownerField = MIXED_OWNERSHIP_MODELS[model].ownerField;
    // Once an object on this conjunction path constrains the owner, every
    // object CONJOINED beneath it inherits that binding.
    const ownerBoundHere = ownerBound || props.has(ownerField);
    if (props.has(ownerField) && !props.has("teamId")) {
      facts.ownerInclusiveArms.push({
        line:
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1,
        text: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 120),
      });
    }

    const teamEntry = props.get("teamId");
    if (teamEntry) {
      const valueText = teamEntry.shorthand
        ? "teamId"
        : teamEntry.valueNode.getText(sourceFile).replace(/\s+/g, " ");
      const isNullLiteral =
        !teamEntry.shorthand &&
        ts.isIdentifier(teamEntry.valueNode) === false &&
        teamEntry.valueNode.kind === ts.SyntaxKind.NullKeyword;
      if (isNullLiteral) {
        if (!ownerBoundHere) {
          facts.unboundNullArms.push({
            line:
              sourceFile.getLineAndCharacterOfPosition(
                teamEntry.valueNode.getStart(sourceFile),
              ).line + 1,
            text: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 160),
          });
        }
      } else {
        facts.workspacePredicates.push({
          line:
            sourceFile.getLineAndCharacterOfPosition(
              (teamEntry.shorthand ? teamEntry.valueNode : teamEntry.valueNode).getStart(
                sourceFile,
              ),
            ).line + 1,
          value: valueText,
          shorthand: teamEntry.shorthand,
        });
      }
    }

    for (const relation of OWNERSHIP_RELATIONS) {
      const rel = props.get(relation);
      if (!rel || rel.shorthand) continue;
      const relText = rel.valueNode.getText(sourceFile);
      if (
        identifiersIn(relText).some(
          (id) => taintedSymbols.has(id) || CANONICAL_HELPERS.has(id),
        )
      ) {
        facts.relationScopes.push(relation);
      }
    }

    for (const combinator of COMBINATORS) {
      if (!props.has(combinator)) continue;
      // What this object proved holds inside ALL THREE combinators, including
      // OR. `{ ownerUserId: X, OR: [ … ] }` is `X AND (a OR b)`: the owner
      // constraint is conjoined with the whole disjunction, so every arm is
      // bound by it.
      //
      // What does NOT carry is one OR arm's binding to its SIBLINGS, and that
      // falls out for free — each arm is descended separately with the same
      // INHERITED value, never with anything a sibling contributed.
      descend(props.get(combinator).valueNode, ownerBoundHere);
    }
  };

  descend(expr);
  return facts;
}

function enclosingSymbolName(node, sourceFile) {
  let current = node.parent;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText(sourceFile);
    }
    if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return "<module>";
}

function allowlistEntryFor(file, symbol) {
  return ALLOWLIST.find((entry) => {
    const fileMatches = file === `services/api/${entry.file}` || file === entry.file;
    if (!fileMatches) return false;
    return entry.symbol === "*" || entry.symbol === symbol;
  });
}

// ---------------------------------------------------------------------------
// Scan.
// ---------------------------------------------------------------------------

function scan() {
  const files = listProductionFiles();
  const findings = [];

  for (const file of files) {
    const absolute = resolve(REPO_ROOT, file);
    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    // Cheap pre-filter: a file that never names a governed model in a member
    // position cannot contain a governed call.
    if (!/\.(evidence|case)\s*\./.test(source)) continue;

    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const taintedSymbols = collectCanonicalSymbols(sourceFile);

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const operation = node.expression.name.text;
        const target = node.expression.expression;
        if (
          GOVERNED_OPERATIONS.has(operation) &&
          ts.isPropertyAccessExpression(target) &&
          Object.prototype.hasOwnProperty.call(
            MIXED_OWNERSHIP_MODELS,
            target.name.text,
          )
        ) {
          const model = target.name.text;
          const argument = node.arguments[0];
          let whereNode = null;
          if (argument && ts.isObjectLiteralExpression(argument)) {
            for (const p of argument.properties) {
              if (
                ts.isPropertyAssignment(p) &&
                (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
                p.name.text === "where"
              ) {
                whereNode = p.initializer;
              }
            }
          }
          const line =
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
              .line + 1;
          const symbol = enclosingSymbolName(node, sourceFile);
          const facts = analyseWhere(whereNode, sourceFile, taintedSymbols, model);
          const isFindUnique = operation.startsWith("findUnique");

          let classification;
          if (facts.canonicalReferences.length > 0) classification = "CANONICAL";
          else if (facts.relationScopes.length > 0) classification = "RELATION_SCOPED";
          else if (isFindUnique || facts.hasUniquePredicate)
            classification = "RECORD_LOOKUP";
          else if (facts.ownerInclusiveArms.length > 0)
            classification = "OWNER_INCLUSIVE";
          else if (facts.workspacePredicates.length === 0)
            classification = "CROSS_TENANT";
          else classification = "VIOLATION";

          const allowEntry = allowlistEntryFor(file, symbol);
          if (classification === "VIOLATION" && allowEntry) {
            classification = "ALLOWLISTED";
          }

          findings.push({
            file,
            line,
            symbol,
            model: MIXED_OWNERSHIP_MODELS[model].prismaModel,
            operation,
            classification,
            allowlistReason: allowEntry?.reason ?? null,
            workspacePredicates: facts.workspacePredicates,
            unboundNullArms: facts.unboundNullArms,
            where: whereNode
              ? whereNode.getText(sourceFile).replace(/\s+/g, " ").slice(0, 180)
              : "<none>",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

function main() {
  const findings = scan();
  const violations = findings.filter((f) => f.classification === "VIOLATION");
  const unboundNull = findings.filter(
    (f) => f.unboundNullArms.length > 0 && f.classification !== "ALLOWLISTED",
  );

  const summary = {};
  for (const f of findings) {
    summary[f.classification] = (summary[f.classification] ?? 0) + 1;
  }

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        { summary, violations, unboundNull, findings },
        null,
        2,
      ),
    );
    return violations.length > 0 || unboundNull.length > 0 ? 1 : 0;
  }

  console.log("WORKSPACE SCOPE AUTHORITY VERIFIER");
  console.log("==================================");
  console.log(`governed calls: ${findings.length}`);
  for (const [k, v] of Object.entries(summary).sort()) {
    console.log(`  ${k.padEnd(16)} ${v}`);
  }
  console.log("");

  if (violations.length > 0) {
    console.log(`VIOLATIONS (${violations.length})`);
    console.log("Mixed-ownership population bounded by a raw workspace predicate.");
    console.log("");
    for (const v of violations) {
      console.log(`  ${v.file}:${v.line}`);
      console.log(`    symbol : ${v.symbol}`);
      console.log(`    model  : ${v.model}.${v.operation}`);
      console.log(
        `    reason : workspace predicate ${v.workspacePredicates
          .map((p) => (p.shorthand ? "{ teamId }" : `teamId: ${p.value}`))
          .join(", ")} with no canonical scope in the where tree`);
      console.log(`    where  : ${v.where}`);
      console.log("");
    }
  }

  if (unboundNull.length > 0) {
    console.log(`UNBOUND NULL-TEAM ARMS (${unboundNull.length})`);
    console.log("A NULL-team arm must be conjoined with an owner predicate.");
    console.log("");
    for (const u of unboundNull) {
      console.log(`  ${u.file}:${u.line}  ${u.symbol}  ${u.model}.${u.operation}`);
      for (const arm of u.unboundNullArms) console.log(`    arm: ${arm.text}`);
      console.log("");
    }
  }

  if (violations.length === 0 && unboundNull.length === 0) {
    console.log("CLEAN — every mixed-ownership population read resolves through");
    console.log("the canonical workspace scope authority, a relation that does,");
    console.log("a unique-key lookup, or a reviewed exception.");
    return 0;
  }
  return 1;
}

try {
  process.exit(main());
} catch (err) {
  console.error("verifier failed to run:", err?.message ?? err);
  process.exit(2);
}
