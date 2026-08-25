/**
 * PRISMA CLIENT IS GENERATED BEFORE ANYTHING THAT COMPILES AGAINST IT.
 *
 * THE CI FAILURE THIS PINS
 * ---------------------------------------------------------------------------
 * `pnpm run build:shared` compiles `@proovra/shared-runtime`, which imports
 * `PrismaClient`, `Prisma` and generated enums (`GovernanceReconciliationKind`,
 * `CustodyEventType`, …). Those types exist only after `prisma generate` has
 * run. Nothing in the chain ran it, and `dist/` and the generated client are
 * both gitignored — so a developer with a client from an earlier session built
 * fine and a clean checkout died with ~58 errors of the form
 *
 *     Module '"@prisma/client"' has no exported member 'PrismaClient'
 *
 * before either CI workflow reached its own "Generate Prisma client" step,
 * which both ran AFTER the build.
 *
 * WHAT THIS TEST CHECKS, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * It checks ORDER, by index, in the real scripts and the real workflows. A
 * guard that merely asserted the string `prisma:generate` appears somewhere
 * would have passed against both broken workflows — generation was present in
 * each of them, just afterwards. That is the exact failure mode, so position is
 * the only thing worth asserting.
 *
 * It is derived, not enumerated: any script whose chain compiles
 * `@proovra/shared-runtime` is subject to the rule, so a new consumer that
 * copies the chain without the generation step fails here rather than in
 * somebody's clean checkout.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const pkg = (rel: string) =>
  JSON.parse(read(rel)) as { scripts?: Record<string, string> };

/** Compiling this package is what requires the client to already exist. */
const RUNTIME_BUILD = "--filter @proovra/shared-runtime build";
/** The ONE generation command, however it is reached. */
const GENERATES = /pnpm (?:-w run prisma:generate|run prisma:generate|--filter proovra-api prisma:generate|prisma generate)/;

/** Every package manifest that could carry a build chain. */
const MANIFESTS = [
  "package.json",
  "services/api/package.json",
  "services/worker/package.json",
  "packages/shared-runtime/package.json",
  "apps/web/package.json",
  "apps/mobile/package.json",
] as const;

describe("the Prisma client is generated before shared-runtime is compiled", () => {
  it("there is exactly ONE generation authority at the root", () => {
    const root = pkg("package.json");
    expect(root.scripts?.["prisma:generate"]).toBe(
      "pnpm --filter proovra-api prisma:generate",
    );
    // Not two competing scripts that can drift: the API keeps the canonical
    // `prisma generate` invocation, the root delegates to it, and every chain
    // reaches one of those two.
    expect(pkg("services/api/package.json").scripts?.["prisma:generate"]).toBe(
      "prisma generate",
    );
  });

  it("every script chain that compiles shared-runtime generates first", () => {
    const violations: string[] = [];
    for (const manifest of MANIFESTS) {
      for (const [name, script] of Object.entries(pkg(manifest).scripts ?? {})) {
        const compilesAt = script.indexOf(RUNTIME_BUILD);
        if (compilesAt < 0) continue;
        const generate = GENERATES.exec(script);
        if (!generate) {
          violations.push(`${manifest} → "${name}" compiles shared-runtime and never generates`);
        } else if (generate.index > compilesAt) {
          violations.push(
            `${manifest} → "${name}" generates AFTER compiling shared-runtime`,
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("shared-runtime's own prebuild generates, so no caller can skip it", () => {
    // The load-bearing one: `prebuild` runs automatically before `build`, so a
    // chain reached by any route — root, api, worker, a future consumer — has
    // the client before tsc starts.
    const rt = pkg("packages/shared-runtime/package.json");
    expect(rt.scripts?.["build:deps"]).toMatch(GENERATES);
    expect(rt.scripts?.prebuild).toBe("pnpm run build:deps");
  });

  it("build:shared generates before its first compile step", () => {
    const chain = pkg("package.json").scripts?.["build:shared"] ?? "";
    const generate = GENERATES.exec(chain);
    expect(generate, "build:shared must generate the client").toBeTruthy();
    const firstCompile = chain.indexOf("build");
    expect(generate!.index).toBeLessThan(chain.indexOf(RUNTIME_BUILD));
    expect(firstCompile).toBeGreaterThanOrEqual(0);
  });
});

describe("the CI workflows do not re-order it back", () => {
  const WORKFLOWS = [
    ".github/workflows/playwright-e2e.yml",
    ".github/workflows/schema-reproducibility.yml",
  ] as const;

  it("no workflow runs a bare `prisma generate` step after build:shared", () => {
    // Both workflows did exactly this. The step existed; it was simply too
    // late, which is why presence is not the property worth checking.
    const violations: string[] = [];
    for (const wf of WORKFLOWS) {
      const body = read(wf);
      const buildAt = body.indexOf("pnpm run build:shared");
      if (buildAt < 0) continue;
      // Only executable lines: the comments explaining the fix name the
      // command, and a guard that tripped on its own rationale would be
      // deleted by the next person who read it.
      const runs = body
        .split(/\r?\n/)
        .map((line, i) => ({ line: line.trim(), i, at: body.indexOf(line) }))
        .filter((l) => !l.line.startsWith("#"))
        .filter((l) => /^(run:\s*)?pnpm (prisma generate|exec prisma generate)\b/.test(l.line));
      for (const r of runs) {
        if (r.at > buildAt) {
          violations.push(`${wf}: \`${r.line}\` runs after build:shared`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("each image build generates before it compiles shared-runtime", () => {
    // The Dockerfiles list the steps explicitly because they do not COPY every
    // package `build:shared` builds. They already had the right order; this
    // keeps it that way, since a correct order nobody checks is one edit from
    // being wrong.
    for (const df of ["services/api/Dockerfile", "services/worker/Dockerfile"]) {
      const body = read(df);
      const gen = body.indexOf("RUN pnpm --filter proovra-api prisma:generate");
      const compile = body.indexOf(`RUN pnpm ${RUNTIME_BUILD}`);
      expect(gen, `${df} must generate the Prisma client`).toBeGreaterThan(-1);
      expect(compile, `${df} must build shared-runtime`).toBeGreaterThan(-1);
      expect(gen, `${df} generates AFTER compiling shared-runtime`).toBeLessThan(compile);
    }
  });
});
