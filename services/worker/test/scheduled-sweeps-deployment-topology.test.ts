/**
 * THE ONLY REAPER (AND THE INTEGRITY RECHECK) MUST ACTUALLY BE DEPLOYED AND
 * STARTED — structural proof (2026-09-30).
 *
 * The API's in-process capture-draft sweep is retired (ET-SEC-24). The worker
 * process is therefore the only place abandoned capture drafts and evidence
 * reservations are expired, and the only place the integrity recheck (ET-SM-07)
 * runs. That is only true in production if:
 *
 *   - the deployment manifest runs the worker process, restarts it, and health
 *     checks it;
 *   - the worker image's command is the entry point that starts the sweeps;
 *   - the sweeps are started by the worker, AFTER its bootstrap chain (secrets,
 *     signer, Object Lock), and stopped on shutdown;
 *   - nothing in the repository's manifests disables them;
 *   - each sweep runs under the recorded reconciliation run, so the platform
 *     health snapshot can see it stop.
 *
 * What this cannot prove is the content of the production host's env file
 * (/opt/proovra/app/.env): CAPTURE_DRAFT_REAPER_ENABLED and
 * INTEGRITY_RECHECK_ENABLED must not be set to false there. The platform
 * health snapshot reports either sweep as stopped if they are.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const read = (...p: string[]) => readFileSync(resolve(REPO, ...p), "utf8");

const INDEX = read("services", "worker", "src", "index.ts");
const REAPER = read("services", "worker", "src", "capture-reaper.ts");
const RECHECK = read("services", "worker", "src", "integrity-recheck.ts");
const PROD_COMPOSE = read("infra", "docker", "docker-compose.prod.yml");
const DOCKERFILE = read("services", "worker", "Dockerfile");

/** The YAML block of one compose service, up to the next top-level service key. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]!) || /^[A-Za-z]/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("the worker sweeps are deployed and started", () => {
  it("the production manifest runs the worker process, restarts it and health-checks it", () => {
    const worker = serviceBlock(PROD_COMPOSE, "proovra-worker");
    expect(worker, "docker-compose.prod.yml must define the proovra-worker service").not.toBe("");
    expect(worker).toMatch(/image: ghcr\.io\/\$\{GHCR_OWNER[^}]*\}\/proovra-worker:\$\{IMAGE_TAG/);
    expect(worker).toMatch(/restart: unless-stopped/);
    expect(worker).toMatch(/healthcheck:\s*\n\s*test: \[.*localhost:8090\/health/);
    // It is not profile-gated or scaled to zero.
    expect(worker).not.toMatch(/^\s+profiles:/m);
    expect(worker).not.toMatch(/replicas:\s*0/);
  });

  it("the worker image runs the entry point that starts the schedulers", () => {
    expect(DOCKERFILE).toMatch(/CMD \["node", "--experimental-specifier-resolution=node", "dist\/index\.js"\]/);
  });

  it("no manifest in the repository disables either sweep", () => {
    const dir = resolve(REPO, "infra", "docker");
    const manifests = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, readFileSync(resolve(dir, f), "utf8")] as const);
    expect(manifests.length).toBeGreaterThan(0);
    for (const [name, body] of manifests) {
      expect(body, name).not.toMatch(/CAPTURE_DRAFT_REAPER_ENABLED\s*[:=]\s*["']?(false|0)/i);
      expect(body, name).not.toMatch(/INTEGRITY_RECHECK_ENABLED\s*[:=]\s*["']?(false|0)/i);
    }
    for (const example of ["services/worker/.env.example", "services/api/.env.example"]) {
      const p = resolve(REPO, example);
      if (!existsSync(p)) continue;
      const body = readFileSync(p, "utf8");
      expect(body, example).not.toMatch(/^CAPTURE_DRAFT_REAPER_ENABLED=(false|0)/m);
      expect(body, example).not.toMatch(/^INTEGRITY_RECHECK_ENABLED=(false|0)/m);
    }
  });

  it("both sweeps default ON", () => {
    expect(INDEX).toMatch(/envBoolean\(\s*"CAPTURE_DRAFT_REAPER_ENABLED",\s*true\s*\)/);
    expect(INDEX).toMatch(/envBoolean\("INTEGRITY_RECHECK_ENABLED", true\)/);
  });

  it("both schedulers start only after the bootstrap chain, and stop on shutdown", () => {
    const open = INDEX.indexOf("    openConsumers();\n");
    const bootstrap = INDEX.lastIndexOf("await bootstrapObjectLockVerification();", open);
    const startReaper = INDEX.indexOf("    startCaptureDraftReaperScheduler();", open);
    const startRecheck = INDEX.indexOf("    startIntegrityRecheckScheduler();", open);
    expect(bootstrap).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(bootstrap);
    expect(startReaper).toBeGreaterThan(open);
    expect(startRecheck).toBeGreaterThan(open);
    // Started exactly once each — never at module evaluation.
    expect(INDEX.match(/^\s*startCaptureDraftReaperScheduler\(\);/gm)?.length).toBe(1);
    expect(INDEX.match(/^\s*startIntegrityRecheckScheduler\(\);/gm)?.length).toBe(1);
    expect(INDEX).toMatch(/^\s*stopCaptureDraftReaperScheduler\(\);/m);
    expect(INDEX).toMatch(/^\s*stopIntegrityRecheckScheduler\(\);/m);
  });

  it("each scheduler calls the RECORDED run, and a failed run pages an operator", () => {
    expect(INDEX).toMatch(/await runCaptureReaperSweep\(\{ trigger, deleteObject \}\)/);
    expect(INDEX).toMatch(/reason: "capture_reaper_run_failed"/);
    expect(INDEX).toMatch(/await runIntegrityRecheckSweep\(\{ trigger, limit: integrityRecheckBatch \}\)/);
    expect(INDEX).toMatch(/reason: "integrity_recheck_run_failed"/);
    // The scheduler does not reach around the recorded run to the raw passes.
    expect(INDEX).not.toMatch(/\breapExpiredCaptureDrafts\(/);
    expect(INDEX).not.toMatch(/\breleaseExpiredReservations\(/);
  });

  it("both runs go through the reconciliation-run authority under their own kind", () => {
    expect(REAPER).toMatch(/runGovernanceReconciliation\(prisma, \{\s*kind: prismaPkg\.GovernanceReconciliationKind\.CAPTURE_REAPER,/);
    expect(RECHECK).toMatch(/runGovernanceReconciliation\(prisma, \{\s*kind: prismaPkg\.GovernanceReconciliationKind\.INTEGRITY_RECHECK,/);
    // A failure of the reaper run is rethrown, not swallowed inside it.
    expect(REAPER).toMatch(/if \(run\.error\) throw run\.error;/);
  });

  it("the retired API sweep is gone: no job, no CLI, no in-process timer, no configuration", () => {
    expect(existsSync(resolve(REPO, "services", "api", "src", "jobs", "capture-draft-expiry.job.ts"))).toBe(false);
    expect(existsSync(resolve(REPO, "services", "api", "scripts", "sweep-capture-drafts.ts"))).toBe(false);
    const server = read("services", "api", "src", "server.ts");
    expect(server).not.toMatch(/CAPTURE_DRAFT_SWEEP/);
    expect(server).not.toMatch(/CaptureDraftExpirySweep/);
    const apiPackage = read("services", "api", "package.json");
    expect(apiPackage).not.toMatch(/sweep-capture-drafts/);
    expect(PROD_COMPOSE).not.toMatch(/CAPTURE_DRAFT_SWEEP/);
  });
});
