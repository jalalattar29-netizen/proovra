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

/** The enums Native renders. Adding one here makes it available natively. */
export const DERIVED_ENUMS = [
  ["EvidenceType", "EVIDENCE_TYPES"],
  ["EvidenceStatus", "EVIDENCE_STATUSES"],
  ["VerificationStatus", "VERIFICATION_STATUSES"],
  ["EvidenceLifecycleState", "EVIDENCE_LIFECYCLE_STATES"],
  ["CaseStatus", "CASE_STATUSES"],
];

/**
 * The `as const` tuples derived from `packages/shared`.
 *
 * [exported const name, native type name]. The native name is the shared
 * type's own, so a reader moving between the two apps sees one vocabulary.
 */
export const DERIVED_SHARED_TUPLES = [
  ["COLLABORATION_TEAM_ASSIGNMENT_STATUSES", "CollaborationTeamAssignmentStatus"],
  ["COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES", "CollaborationTeamAssignmentPriority"],
  ["COLLABORATION_TEAM_ASSIGNMENT_TARGETS", "CollaborationTeamAssignmentTarget"],
  ["COLLABORATION_TEAM_ROLES", "CollaborationTeamRole"],
  ["COLLABORATION_TEAM_TYPES", "CollaborationTeamType"],
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
  const shared = readFileSync(SHARED_COLLABORATION, "utf8");
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

  for (const [constName, typeName] of DERIVED_SHARED_TUPLES) {
    const values = readSharedTuple(shared, constName);
    if (values.length === 0) {
      throw new Error(`collaboration-team.ts: ${constName} is empty`);
    }
    blocks.push(`/** \`@proovra/shared\` \`${constName}\`. */
export const ${constName} = [
${values.map((v) => `  "${v}",`).join("\n")}
] as const;
export type ${typeName} = (typeof ${constName})[number];
`);
  }

  return {
    source: `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Sources:   services/api/prisma/schema.prisma
 *            packages/shared/src/collaboration-team.ts
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
      ...DERIVED_SHARED_TUPLES.map(([c]) => [c, readSharedTuple(shared, c).length]),
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
