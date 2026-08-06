/**
 * PHASE 12 — queue / producer / payload census (machine-enforced).
 *
 * Sources of truth parsed directly:
 *   - services/api/src/queue/*.ts       → API-side producer queue-name constants
 *   - services/worker/src/queue.ts      → worker-side queue-name constants
 *   - services/worker/src/index.ts      → Worker(...) registrations
 *
 * Metrics enforced:
 *   - orphan producers = 0 (every API-enqueued queue has a worker consumer)
 *   - duplicate workers = 0 (exactly one Worker registration per queue)
 *   - payload tenant-trust = 0 (every processor module reloads persisted
 *     state via prisma; a processor that legitimately needs no DB must be
 *     listed in NO_DB_PROCESSORS with a reason)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * ANY `const NAME = "literal"` declaration, from any module. Used to resolve
 * queue/job-name constants that a process aliases from the shared package.
 */
function literalConstants(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*["']([A-Za-z0-9_.-]+)["']\s*;/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * PHASE 12 POINT 4 PASS C2/C4 — queue and job names may live in
 * `@proovra/shared` so the producing and consuming processes cannot drift.
 * The census resolves through that indirection instead of demanding a
 * duplicated literal in each process (which is the very drift it guards).
 */
const SHARED_CONSTANTS = (() => {
  const out = new Map<string, string>();
  const dir = resolve(REPO, "packages/shared/src");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    for (const [k, v] of literalConstants(read(`packages/shared/src/${f}`))) out.set(k, v);
  }
  return out;
})();

/**
 * PHASE 12 POINT 5 — members of the canonical `QUEUE_NAMES` object.
 *
 * Queue names now live in ONE object literal in
 * `packages/shared/src/queue-integrity/names.ts`, so a transport client declares
 * `const fooQueueName = QUEUE_NAMES.FOO`. The census has to follow that
 * indirection, otherwise convergence onto the single authority would read as
 * "unresolved" — the census would fail precisely because the drift it exists to
 * catch had been eliminated.
 */
const QUEUE_NAMES_MEMBERS = (() => {
  const out = new Map<string, string>();
  const body = read("packages/shared/src/queue-integrity/names.ts");
  const block = body.match(/export const QUEUE_NAMES = \{([\s\S]*?)\n\} as const;/);
  if (block) {
    for (const m of block[1].matchAll(/([A-Z0-9_]+):\s*["']([a-z0-9_.-]+)["']/g)) {
      out.set(m[1], m[2]);
    }
  }
  return out;
})();

/** name-constant → literal from `const fooQueueName = "bar"` declarations. */
function queueNameConstants(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/const\s+([A-Za-z0-9_]*[qQ]ueueName)\s*=\s*[^"'\n]*["']([a-z0-9_.-]+)["']/g)) {
    out.set(m[1], m[2]);
  }
  // Aliases of a shared constant: `const fooQueueName = FOO_QUEUE_NAME;`
  for (const m of body.matchAll(/const\s+([A-Za-z0-9_]*[qQ]ueueName)\s*=\s*([A-Za-z0-9_]+)\s*;/g)) {
    const shared = SHARED_CONSTANTS.get(m[2]);
    if (shared) out.set(m[1], shared);
  }
  // Members of the canonical registry: `const fooQueueName = QUEUE_NAMES.FOO;`
  for (const m of body.matchAll(/const\s+([A-Za-z0-9_]*[qQ]ueueName)\s*=\s*QUEUE_NAMES\.([A-Z0-9_]+)\s*;/g)) {
    const shared = QUEUE_NAMES_MEMBERS.get(m[2]);
    if (shared) out.set(m[1], shared);
  }
  return out;
}

// ── API producers ───────────────────────────────────────────────────────────
const apiQueueDir = resolve(REPO, "services/api/src/queue");
const apiConstants = new Map<string, string>();
for (const f of readdirSync(apiQueueDir)) {
  if (!f.endsWith(".ts")) continue;
  for (const [k, v] of queueNameConstants(read(`services/api/src/queue/${f}`))) apiConstants.set(k, v);
}
const apiProducerQueues = new Set(apiConstants.values());

// ── worker side ─────────────────────────────────────────────────────────────
const workerQueueBody = read("services/worker/src/queue.ts");
const workerConstants = queueNameConstants(workerQueueBody);
const workerIndex = read("services/worker/src/index.ts");

/** Worker registrations: `new Worker(<identifier | "literal">` in index.ts. */
const workerRegs: string[] = [];
for (const m of workerIndex.matchAll(/new Worker(?:<[^>]*>)?\(\s*(?:["']([a-z0-9_.-]+)["']|([A-Za-z0-9_]+))/g)) {
  const literal = m[1];
  const ident = m[2];
  if (literal) workerRegs.push(literal);
  else if (ident) {
    const resolved = workerConstants.get(ident) ?? apiConstants.get(ident);
    workerRegs.push(resolved ?? `<unresolved:${ident}>`);
  }
}

describe("Phase 12 — queue census", () => {
  it("every worker registration resolves to a literal queue name", () => {
    expect(workerRegs.filter((r) => r.startsWith("<unresolved:")), workerRegs.join(",")).toEqual([]);
  });

  it("orphan producers = 0: every API producer queue has exactly one worker consumer", () => {
    const missing = [...apiProducerQueues].filter((q) => !workerRegs.includes(q));
    expect(missing, `producer queues with no worker: ${missing.join(", ")}`).toEqual([]);
  });

  it("duplicate workers = 0: one Worker registration per queue", () => {
    const counts = new Map<string, number>();
    for (const r of workerRegs) counts.set(r, (counts.get(r) ?? 0) + 1);
    const dups = [...counts.entries()].filter(([, c]) => c > 1);
    expect(dups, `duplicate consumers: ${dups.map(([q, c]) => `${q}×${c}`).join(", ")}`).toEqual([]);
  });

  it("payload tenant-trust = 0: every processor reloads persisted state (or is justified)", () => {
    // Processors that legitimately run without a DB reload — each entry needs
    // a reason; anything else importing nothing from prisma fails.
    const NO_DB_PROCESSORS: Record<string, string> = {};
    const dir = resolve(REPO, "services/worker/src");
    const processors = readdirSync(dir).filter((f) => f.endsWith(".processor.ts"));
    expect(processors.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of processors) {
      if (NO_DB_PROCESSORS[f]) continue;
      const body = read(`services/worker/src/${f}`);
      const reloads = /prisma\.|\.findUnique|\.findFirst|\.findMany/.test(body);
      if (!reloads) offenders.push(f);
    }
    expect(offenders, `processors with no persisted reload: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no processor trusts a payload tenant field for authorization-relevant writes", () => {
    // A processor may carry ids in the payload, but any `where:` that binds a
    // tenant column directly from `job.data` without a prior reload is a
    // trust violation. Heuristic: flag `job.data.teamId`/`job.data.organizationId`
    // used inside a `where:` object literal on the same line.
    const dir = resolve(REPO, "services/worker/src");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const body = read(`services/worker/src/${f}`);
      for (const line of body.split("\n")) {
        if (/where:\s*\{[^}]*job\.data\.(teamId|organizationId)/.test(line)) {
          offenders.push(`${f}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

// ── PHASE 12 strengthening — exact job-name parity + payload-field registry ──
describe("Phase 12 — job-name parity + payload field classification", () => {
  const jobNameDecls = (body: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const m of body.matchAll(/const\s+([A-Za-z0-9_]+JobName)\s*=\s*["']([A-Za-z0-9_.-]+)["']/g)) out.set(m[1], m[2]);
    // Same shared-constant indirection as the queue names above.
    for (const m of body.matchAll(/const\s+([A-Za-z0-9_]+JobName)\s*=\s*([A-Za-z0-9_]+)\s*;/g)) {
      const shared = SHARED_CONSTANTS.get(m[2]);
      if (shared) out.set(m[1], shared);
    }
    return out;
  };

  it("api-declared and worker-declared job names agree (no drifted duplicate constants)", () => {
    const apiNames = new Map<string, string>();
    const dir = resolve(REPO, "services/api/src/queue");
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      for (const [k, v] of jobNameDecls(read(`services/api/src/queue/${f}`))) apiNames.set(k, v);
    }
    const workerNames = jobNameDecls(read("services/worker/src/queue.ts"));
    // Every constant declared on BOTH sides must bind the SAME literal.
    const drift: string[] = [];
    for (const [k, v] of apiNames) {
      const w = workerNames.get(k);
      if (w !== undefined && w !== v) drift.push(`${k}: api="${v}" worker="${w}"`);
    }
    expect(drift, drift.join("; ")).toEqual([]);
    // Every api-side job name literal must exist somewhere in the worker
    // (constant or literal) — a produced job nobody consumes is an orphan.
    // The corpus is read RECURSIVELY (processors live in subdirectories) and a
    // job name the worker imports from the shared package counts as consumed:
    // the shared constant IS the agreement between the two processes.
    const workerCorpus = (function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".ts")) out.push(readFileSync(full, "utf8"));
      }
      return out;
    })(resolve(REPO, "services/worker/src")).join("\n");
    const consumedLiterals = new Set<string>();
    for (const [name, literal] of SHARED_CONSTANTS) {
      if (workerCorpus.includes(name)) consumedLiterals.add(literal);
    }
    const orphans = [...apiNames.values()].filter(
      (lit) => !workerCorpus.includes(lit) && !consumedLiterals.has(lit),
    );
    expect(orphans, `api job names with no worker reference: ${orphans.join(", ")}`).toEqual([]);
  });

  it("payload tenant fields are UNTRUSTED_HINT everywhere: no payload field may name policy/plan/capability", () => {
    // Field classification registry: RECORD_IDENTIFIER (ids the consumer
    // reloads), IDEMPOTENCY_KEY, OBSERVABILITY_ONLY, UNTRUSTED_HINT
    // (teamId/organizationId — scoping hints; every processor reloads
    // persisted state, proven above), FORBIDDEN (authority inputs).
    const FORBIDDEN_FIELD = /^(policyVersion|policyId|plan|planType|capabilities|capability|isPersonal|workspaceKind|legalHold|retentionDays|storageQuota)\??:/;
    const dir = resolve(REPO, "services/api/src/queue");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const body = read(`services/api/src/queue/${f}`);
      // scan payload type/interface bodies
      for (const tm of body.matchAll(/(?:type|interface)\s+([A-Za-z0-9_]*Payload)[^{]*\{([\s\S]*?)\n\}/g)) {
        for (const line of tm[2].split("\n")) {
          const t = line.trim();
          if (FORBIDDEN_FIELD.test(t)) offenders.push(`${f}#${tm[1]}: ${t.slice(0, 60)}`);
        }
      }
    }
    expect(offenders, `FORBIDDEN authority fields in job payloads:\n${offenders.join("\n")}`).toEqual([]);
  });
});
