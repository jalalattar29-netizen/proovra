/**
 * OPERATOR COMMAND — `pnpm --filter proovra-api ops:deployment-safety-check [--registry]`
 *
 * Prints THE deployment safety report (src/ops/deployment-safety.ts) as JSON:
 * booleans, counts and closed enums only — never a value, path, key,
 * fingerprint or secret. `--registry` also asks the signing-key registry
 * whether the repository's committed fixture key is registered / unrevoked
 * (read-only; one SELECT of public keys).
 *
 * Exit code: 0 SAFE or NOT_A_DEPLOYMENT, 2 UNSAFE, 1 the check itself failed.
 * Read-only: it writes nothing anywhere.
 */
import "../env.js";

import { buildDeploymentSafetyReport, readCommittedFixtureRegistration } from "../ops/deployment-safety.js";

async function main(): Promise<number> {
  const withRegistry = process.argv.includes("--registry");
  let registry: Awaited<ReturnType<typeof readCommittedFixtureRegistration>> | null = null;
  if (withRegistry) {
    const { prisma } = await import("../db.js");
    try {
      registry = await readCommittedFixtureRegistration(prisma as never);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  }
  const report = buildDeploymentSafetyReport(process.env, registry);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
  return report.verdict === "UNSAFE" ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // The error NAME only: a driver message can carry a connection string.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ verdict: "CHECK_FAILED", error: err instanceof Error ? err.name : "unknown" }));
    process.exit(1);
  },
);
