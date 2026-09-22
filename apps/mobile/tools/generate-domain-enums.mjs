/**
 * GENERATE the canonical domain enum values FROM the Prisma schema.
 *
 * `src/product/domain-display.ts` mirrored five Prisma enums verbatim — its own
 * header said so. The drift guard asserted the native table was internally
 * complete; it never read `schema.prisma`, so a new enum value on the canonical
 * side could not fail anything and would simply render as an unmapped string.
 *
 * The VALUES are now derived here. The LABEL and TONE tables stay authored in
 * `domain-display.ts`, deliberately: they are presentation, the backend already
 * returns human labels for the list/detail surfaces, and there is nothing to
 * derive them from. What matters is that a value cannot exist canonically and
 * be absent natively — `test/domain-enums-generated.test.mjs` fails on that.
 *
 * A canonical value does not always live in schema.prisma. The Collaboration
 * Team assignment vocabulary is authored in `packages/shared` as a frozen
 * tuple, and it is the same kind of fact: a value that exists canonically must
 * not be absent natively. Those are derived here too, from the shared source,
 * rather than retyped into a native module where nothing could catch a drift.
 *
 *   node apps/mobile/tools/generate-domain-enums.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = resolve(HERE, "../../../services/api/prisma/schema.prisma");
export const OUT_TS = resolve(HERE, "../src/product/domain-enums.generated.ts");
export const SHARED_COLLABORATION = resolve(
  HERE,
  "../../../packages/shared/src/collaboration-team.ts",
);
export const SHARED_OUTPUT_LIFECYCLE = resolve(
  HERE,
  "../../../packages/shared/src/evidence-output-lifecycle.ts",
);
/**
 * The ONE definition of "this review status is a verdict".
 *
 * Not a Prisma enum and not a shared tuple — a Set in an API module kept
 * dependency-free on purpose. Same kind of fact all the same: a value that
 * exists canonically must not be absent natively.
 */
export const REVIEW_STATUS_VOCABULARY = resolve(
  HERE,
  "../../../services/api/src/services/evidence-review/review-status-vocabulary.ts",
);

/** [exported Set name, source file]. */
export const DERIVED_SETS = [
  ["DECISION_DERIVED_WORKFLOW_STATUSES", REVIEW_STATUS_VOCABULARY],
];

/** Read one `export const NAME: ReadonlySet<string> = new Set([...])`. */
export function readSet(source, name) {
  const re = new RegExp(`export const ${name}[^=]*= new Set\\(\\[([\\s\\S]*?)\\]\\)`, "m");
  const m = re.exec(source);
  if (!m) throw new Error(`review-status-vocabulary.ts: ${name} not found`);
  return [...m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1]);
}

/** The enums Native renders. Adding one here makes it available natively. */
export const DERIVED_ENUMS = [
  ["EvidenceType", "EVIDENCE_TYPES"],
  ["EvidenceStatus", "EVIDENCE_STATUSES"],
  ["VerificationStatus", "VERIFICATION_STATUSES"],
  ["EvidenceLifecycleState", "EVIDENCE_LIFECYCLE_STATES"],
  ["CaseStatus", "CASE_STATUSES"],
  ["EvidenceLegalNoteType", "EVIDENCE_LEGAL_NOTE_TYPES"],
  ["EvidenceAnnotationType", "EVIDENCE_ANNOTATION_TYPES"],
  ["EvidenceAnnotationCoordinateSpace", "EVIDENCE_ANNOTATION_COORDINATE_SPACES"],
  ["EvidenceRelationshipType", "EVIDENCE_RELATIONSHIP_TYPES"],
  ["EvidenceReviewWorkflowStatus", "EVIDENCE_REVIEW_WORKFLOW_STATUSES"],
  ["EvidenceReviewWorkflowPriority", "EVIDENCE_REVIEW_WORKFLOW_PRIORITIES"],
];

/**
 * The `as const` tuples derived from `packages/shared`.
 *
 * [exported const name, native type name, source file]. The native name is
 * the shared type's own, so a reader moving between the two apps sees one
 * vocabulary; the source is carried per row so adding a tuple from another
 * shared module is one line rather than a second loop.
 */
export const DERIVED_SHARED_TUPLES = [
  ["COLLABORATION_TEAM_ASSIGNMENT_STATUSES", "CollaborationTeamAssignmentStatus", SHARED_COLLABORATION],
  ["COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES", "CollaborationTeamAssignmentPriority", SHARED_COLLABORATION],
  ["COLLABORATION_TEAM_ASSIGNMENT_TARGETS", "CollaborationTeamAssignmentTarget", SHARED_COLLABORATION],
  ["COLLABORATION_TEAM_ROLES", "CollaborationTeamRole", SHARED_COLLABORATION],
  ["COLLABORATION_TEAM_TYPES", "CollaborationTeamType", SHARED_COLLABORATION],
  ["GENERATION_REQUEST_OUTCOMES", "GenerationRequestOutcome", SHARED_OUTPUT_LIFECYCLE],
];

/** Read one `export const NAME = ["A", "B"] as const;` tuple's members. */
export function readSharedTuple(source, name) {
  const re = new RegExp(
    `export const ${name} = \\[([\\s\\S]*?)\\] as const;`,
    "m",
  );
  const m = re.exec(source);
  if (!m) throw new Error(`collaboration-team.ts: ${name} not found`);
  return [...m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1]);
}

/** Read one `enum Name { A B }` block's members, comments stripped. */
export function readEnum(schema, name) {
  const re = new RegExp(`^enum\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, "m");
  const m = re.exec(schema);
  if (!m) throw new Error(`schema.prisma: enum ${name} not found`);
  return m[1]
    .replace(/\/\/.*$/gm, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

export function generate() {
  const schema = readFileSync(SCHEMA, "utf8");
  const sourceCache = new Map();
  const sharedSource = (file) => {
    if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(file, "utf8"));
    return sourceCache.get(file);
  };
  const blocks = DERIVED_ENUMS.map(([prismaName, constName]) => {
    const values = readEnum(schema, prismaName);
    if (values.length === 0) throw new Error(`schema.prisma: enum ${prismaName} is empty`);
    // The Prisma enum name IS the TypeScript type name. Deriving it from the
    // plural const instead produced "EvidenceStatuse".
    const type = prismaName;
    return `/** Prisma enum \`${prismaName}\`. */
export const ${constName} = [
${values.map((v) => `  "${v}",`).join("\n")}
] as const;
export type ${type} = (typeof ${constName})[number];
`;
  });

  for (const [constName, typeName, file] of DERIVED_SHARED_TUPLES) {
    const values = readSharedTuple(sharedSource(file), constName);
    if (values.length === 0) {
      throw new Error(`${constName} is empty in its shared source`);
    }
    blocks.push(`/** \`@proovra/shared\` \`${constName}\`. */
export const ${constName} = [
${values.map((v) => `  "${v}",`).join("\n")}
] as const;
export type ${typeName} = (typeof ${constName})[number];
`);
  }

  for (const [constName, file] of DERIVED_SETS) {
    const values = readSet(sharedSource(file), constName);
    if (values.length === 0) throw new Error(`${constName} is empty in its source`);
    blocks.push(`/**
 * \`review-status-vocabulary.ts\` \`${constName}\`.
 *
 * Statuses only the decision authority may produce. A surface that OFFERED
 * one would be offering to forge a verdict.
 */
export const ${constName} = [
${values.map((v) => `  "${v}",`).join("\n")}
] as const;
`);
  }

  return {
    source: `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Sources:   services/api/prisma/schema.prisma
 *            packages/shared/src/collaboration-team.ts
 *            packages/shared/src/evidence-output-lifecycle.ts
 *            services/api/src/services/evidence-review/review-status-vocabulary.ts
 * Generator: apps/mobile/tools/generate-domain-enums.mjs
 * Guard:     apps/mobile/test/domain-enums-generated.test.mjs
 *
 * These are the canonical domain values, not a native copy of them. Labels and
 * tones remain authored in src/product/domain-display.ts, which must map every
 * value here or the guard fails.
 */

${blocks.join("\n")}`,
    counts: Object.fromEntries([
      ...DERIVED_ENUMS.map(([p, c]) => [c, readEnum(schema, p).length]),
      ...DERIVED_SHARED_TUPLES.map(([c, , file]) => [
        c,
        readSharedTuple(sharedSource(file), c).length,
      ]),
      ...DERIVED_SETS.map(([c, file]) => [c, readSet(sharedSource(file), c).length]),
    ]),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { source, counts } = generate();
  if (process.argv.includes("--check")) {
    if (readFileSync(OUT_TS, "utf8") !== source) {
      console.error("domain-enums.generated.ts is stale — re-run the generator");
      process.exit(1);
    }
    console.log("domain enums up to date", counts);
  } else {
    writeFileSync(OUT_TS, source);
    console.log("generated", OUT_TS, counts);
  }
}
