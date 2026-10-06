/**
 * ET-Q-07 (2026-09-30) — RESURRECTION GUARD for the five retired queues.
 *
 * WHAT WAS RETIRED, AND WHY
 * ---------------------------------------------------------------------------
 *   mi-exif               ExtractExif
 *   mi-search-index       IndexMediaIntelligence
 *   graph-domain-sync     SyncTeamGraphDomain
 *   graph-timeline-sync   SyncTeamGraphTimeline
 *   org-health-refresh    RefreshOrgHealthProjection
 *
 * Each had a registered BullMQ consumer, a registry entry marked
 * CURRENT_RUNTIME, a legacy payload adapter, a replay policy, an Operations
 * inventory row and a suite of green contract tests — and NO PRODUCER. Every
 * one of their enqueue helpers had zero callers in every commit since it was
 * introduced, so none of the five ever received a job.
 *
 * The owner decision was to RETIRE all five rather than wire speculative
 * producers. This file replaces the per-queue contract tests that used to pin
 * their wiring: those tests were each true, and together they proved that five
 * chains nothing fed were correctly assembled.
 *
 * IF YOU ARE HERE BECAUSE THIS TEST FAILED
 * ---------------------------------------------------------------------------
 * A future feature that needs one of these queues MUST REINTRODUCE IT END TO
 * END — not by re-adding a name:
 *
 *   1. a PRODUCER with a real caller on a live path;
 *   2. a CONSUMER bound to it;
 *   3. IDEMPOTENCY (deterministic job id and/or a durable claim);
 *   4. bounded RETRIES from the registry's retry policy;
 *   5. RECONCILIATION — a module that really recovers a lost enqueue, declared
 *      in its RECOVERED_WORK_TYPES and named by the registry entry;
 *   6. a DLQ / terminal-failure path an operator can see;
 *   7. a RUNTIME PROOF that a job travels producer -> queue -> consumer.
 *
 * Only then remove the name from RETIRED below, in the same change, and say so
 * in the review. Deleting a name from this list to make a build green is
 * exactly the move this guard exists to make visible.
 *
 * WHY STRING LITERALS ARE READ FROM THE SYNTAX TREE
 * ---------------------------------------------------------------------------
 * The retirement notes in the source deliberately name the queues — in
 * comments. A text search would either trip on those notes or need a
 * comment-stripping regex, and the obvious one mis-handles `/*` inside a glob
 * string and silently skips real code. So each candidate file is parsed and
 * only STRING LITERAL nodes are inspected: a comment is not a node, and a name
 * in prose cannot fail or satisfy this guard.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CANONICAL_WORK_REGISTRY,
  DLQ_SINKS,
  JOB_NAMES,
  LEGACY_PAYLOAD_ADAPTERS,
  QUEUE_NAMES,
} from "@proovra/shared";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** Queue name -> the job name that used to ride it. */
const RETIRED: ReadonlyArray<{ queue: string; job: string; jobKey: string; queueKey: string }> = [
  { queue: "mi-exif", job: "ExtractExif", jobKey: "EXTRACT_EXIF", queueKey: "MI_EXIF" },
  {
    queue: "mi-search-index",
    job: "IndexMediaIntelligence",
    jobKey: "INDEX_MEDIA_INTELLIGENCE",
    queueKey: "MI_SEARCH_INDEX",
  },
  {
    queue: "graph-domain-sync",
    job: "SyncTeamGraphDomain",
    jobKey: "SYNC_TEAM_GRAPH_DOMAIN",
    queueKey: "GRAPH_DOMAIN_SYNC",
  },
  {
    queue: "graph-timeline-sync",
    job: "SyncTeamGraphTimeline",
    jobKey: "SYNC_TEAM_GRAPH_TIMELINE",
    queueKey: "GRAPH_TIMELINE_SYNC",
  },
  {
    queue: "org-health-refresh",
    job: "RefreshOrgHealthProjection",
    jobKey: "REFRESH_ORG_HEALTH_PROJECTION",
    queueKey: "ORG_HEALTH_REFRESH",
  },
];

const RETIRED_QUEUES = RETIRED.map((r) => r.queue);
const RETIRED_JOBS = RETIRED.map((r) => r.job);

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), "utf8");
}

/** Every `.ts` / `.tsx` file under a directory, skipping build output. */
function walkSources(absDir: string): string[] {
  const out: string[] = [];
  const stack = [absDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".next") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
    }
  }
  return out;
}

/** `services/<x>/src` and `packages/<x>/src` — every one that exists. */
function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["services", "packages"]) {
    const groupDir = resolve(REPO, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const src = join(groupDir, name, "src");
      if (existsSync(src) && statSync(src).isDirectory()) roots.push(src);
    }
  }
  return roots;
}

type LiteralHit = { file: string; line: number; text: string; context: string };

/**
 * String-literal nodes in `source` whose value is one of `names`.
 *
 * `context` reports what the literal is an argument of, so a failure says
 * `new Queue("mi-exif")` rather than just a line number.
 */
function retiredLiteralsIn(absFile: string, names: ReadonlyArray<string>): LiteralHit[] {
  const text = readFileSync(absFile, "utf8");
  // Cheap pre-filter: parsing ~thousands of files to find nothing is wasted
  // work, and a file that does not contain the characters cannot contain the
  // literal. Comments still pass this filter; the AST walk below is what
  // excludes them.
  if (!names.some((n) => text.includes(n))) return [];
  const sf = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true);
  const hits: LiteralHit[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      names.includes(node.text)
    ) {
      const parent = node.parent;
      let context = ts.SyntaxKind[parent.kind] ?? "unknown";
      if (ts.isNewExpression(parent) || ts.isCallExpression(parent)) {
        context = `${ts.isNewExpression(parent) ? "new " : ""}${parent.expression.getText(sf)}(…)`;
      }
      hits.push({
        file: relative(REPO, absFile).replace(/\\/g, "/"),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        text: node.text,
        context,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const describeHits = (hits: LiteralHit[]): string =>
  hits.map((h) => `${h.file}:${h.line}  "${h.text}"  in ${h.context}`).join("\n");

describe("ET-Q-07 — the five producerless queues stay retired", () => {
  it("the guard itself names exactly the five", () => {
    // If this list is edited, the edit is the review surface — see the header.
    expect(RETIRED_QUEUES).toEqual([
      "mi-exif",
      "mi-search-index",
      "graph-domain-sync",
      "graph-timeline-sync",
      "org-health-refresh",
    ]);
  });

  it("none of them is in QUEUE_NAMES, by value or by key", () => {
    const values = Object.values(QUEUE_NAMES) as string[];
    const keys = Object.keys(QUEUE_NAMES);
    for (const r of RETIRED) {
      expect(values, `QUEUE_NAMES still carries "${r.queue}"`).not.toContain(r.queue);
      expect(keys, `QUEUE_NAMES still declares ${r.queueKey}`).not.toContain(r.queueKey);
    }
  });

  it("none of their job names is in JOB_NAMES, by value or by key", () => {
    const values = Object.values(JOB_NAMES) as string[];
    const keys = Object.keys(JOB_NAMES);
    for (const r of RETIRED) {
      expect(values, `JOB_NAMES still carries "${r.job}"`).not.toContain(r.job);
      expect(keys, `JOB_NAMES still declares ${r.jobKey}`).not.toContain(r.jobKey);
    }
  });

  it("the canonical work registry has no entry for any of them", () => {
    const offenders = CANONICAL_WORK_REGISTRY.filter(
      (e) =>
        (e.queueName !== null && RETIRED_QUEUES.includes(e.queueName)) ||
        RETIRED_JOBS.includes(e.workName) ||
        (e.jobIdPrefix !== null && RETIRED_QUEUES.includes(e.jobIdPrefix)),
    ).map((e) => `${e.workName} (queue=${e.queueName}, prefix=${e.jobIdPrefix})`);
    expect(offenders, offenders.join("\n")).toEqual([]);

    const sinks = DLQ_SINKS.filter(
      (s) => RETIRED_QUEUES.includes(s.queueName) || RETIRED_QUEUES.includes(s.sourceQueue),
    ).map((s) => `${s.queueName} <- ${s.sourceQueue}`);
    expect(sinks, sinks.join("\n")).toEqual([]);
  });

  it("no legacy payload adapter or drain command still claims them", () => {
    const offenders = LEGACY_PAYLOAD_ADAPTERS.filter(
      (a) =>
        RETIRED_JOBS.includes(a.jobName) ||
        RETIRED_QUEUES.some(
          (q) =>
            a.backlogCommand.includes(`--queue=${q}`) ||
            a.drainCommand.includes(`--queue=${q}`) ||
            a.removalCondition.includes(`--queue=${q}`),
        ),
    ).map((a) => a.jobName);
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  it("the worker entrypoint registers no consumer for any of them", () => {
    const abs = resolve(REPO, "services/worker/src/index.ts");
    const hits = retiredLiteralsIn(abs, RETIRED_QUEUES);
    // Covers `safeRegisterWorker("<name>", …)`, the `WorkerKind` union members
    // and the REGISTERED_WORKERS / shutdown tuples: all four are string
    // literals in this one file.
    expect(hits, describeHits(hits)).toEqual([]);

    // And none of their Queue objects or processors is imported back in.
    const index = read("services/worker/src/index.ts");
    for (const symbol of [
      "exifQueue",
      "miSearchIndexQueue",
      "graphDomainSyncQueue",
      "graphTimelineSyncQueue",
      "orgHealthRefreshQueue",
      "processExifQueueJob",
      "processMiSearchIndexJob",
      "processGraphDomainSyncJob",
      "processGraphTimelineSyncJob",
      "processOrgHealthRefreshJob",
    ]) {
      expect(
        new RegExp(`\\b${symbol}\\b`).test(index),
        `services/worker/src/index.ts references ${symbol}`,
      ).toBe(false);
    }
  });

  it("the API's Operations inventory, replay matrix and diagnostics carry no label or row for them", () => {
    const files = [
      "services/api/src/services/operations/queue-inventory.service.ts",
      "services/api/src/services/operations/queue-replay-safety.service.ts",
      "services/api/src/services/investigation-diagnostics.service.ts",
    ];
    const hits = files.flatMap((rel) => {
      expect(existsSync(resolve(REPO, rel)), `${rel} moved — repoint this guard`).toBe(true);
      return retiredLiteralsIn(resolve(REPO, rel), [...RETIRED_QUEUES, ...RETIRED_JOBS]);
    });
    expect(hits, describeHits(hits)).toEqual([]);
  });

  it(
    "no source file under services/*/src or packages/*/src constructs a Queue or Worker for — or otherwise names — any of them",
    () => {
      const roots = sourceRoots();
      // The scan must actually reach the three trees that could host a queue.
      const rel = roots.map((r) => relative(REPO, r).replace(/\\/g, "/"));
      expect(rel).toEqual(
        expect.arrayContaining([
          "services/api/src",
          "services/worker/src",
          "packages/shared/src",
          "packages/shared-runtime/src",
        ]),
      );

      const files = roots.flatMap(walkSources);
      expect(files.length, "the scan found almost no files — it is not scanning").toBeGreaterThan(500);

      const hits = files.flatMap((f) => retiredLiteralsIn(f, RETIRED_QUEUES));

      // The specific thing the finding was about, reported first and by name.
      const constructed = hits.filter((h) => /^new (Queue|Worker|QueueEvents)\(/.test(h.context));
      expect(
        constructed,
        `a BullMQ Queue/Worker is constructed for a retired queue:\n${describeHits(constructed)}`,
      ).toEqual([]);

      // …and the broader rule that makes it robust: the name does not appear
      // as a string literal ANYWHERE in runtime source. A queue reintroduced
      // through a constant, a map key or a helper argument still needs the
      // literal to exist somewhere, and this is where it is caught.
      expect(
        hits,
        `a retired queue name is a string literal in runtime source:\n${describeHits(hits)}`,
      ).toEqual([]);
    },
    120_000,
  );
});
