/**
 * Sentry alert audit (2026-11-26) — the worker's Sentry scopes under PRODUCTION's
 * OpenTelemetry setup (OTEL_ENABLED=true: our NodeSDK in otel.ts, Sentry with
 * `skipOpenTelemetrySetup`).
 *
 * The production events this reproduces: a Redis DNS error on the ots-upgrade
 * queue carried `queue_name=search-indexing` and a search-index `job_id`; a
 * search reconciler tick and an API delivery sweep were filed under the health
 * probe's `GET /readyz` with a search job's tags. All of it was one collapsed
 * process-wide scope.
 *
 * Boots the REAL otel.ts and initSentry (a DSN on a closed local port; events are
 * read from the client before sending) and the REAL runJobWithTelemetryContext /
 * captureException / runBackgroundOperation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Seen = { message: string; transaction: string | null; tags: Record<string, unknown>; crumbs: string[] };
const seen: Seen[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let Sentry: typeof import("@sentry/node");
let captureException: typeof import("../src/sentry.js").captureException;
let runJobWithTelemetryContext: typeof import("../src/sentry.js").runJobWithTelemetryContext;
let runBackgroundOperation: typeof import("../src/background-work.js").runBackgroundOperation;

beforeAll(async () => {
  process.env.OTEL_ENABLED = "true";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9";
  process.env.SENTRY_DSN = "https://isolation@127.0.0.1:9/0";
  process.env.SENTRY_ENABLED = "true";
  const otel = await import("../src/otel.js");
  otel.initOpenTelemetry({ defaultServiceName: "proovra-worker", log: { info: () => undefined, warn: () => undefined } });
  const sentry = await import("../src/sentry.js");
  sentry.initSentry();
  ({ captureException, runJobWithTelemetryContext } = sentry);
  ({ runBackgroundOperation } = await import("../src/background-work.js"));
  Sentry = await import("@sentry/node");
  Sentry.getClient()!.on("beforeSendEvent", (event) => {
    seen.push({
      message: String(event.exception?.values?.[0]?.value ?? ""),
      transaction: event.transaction ?? null,
      tags: (event.tags ?? {}) as Record<string, unknown>,
      crumbs: (event.breadcrumbs ?? []).filter((b) => b.category === "test").map((b) => String(b.message)),
    });
  });
});

afterAll(async () => {
  await Sentry.close(200).catch(() => undefined);
});

const find = async (msg: string) => {
  for (let i = 0; i < 100 && !seen.some((s) => s.message === msg); i += 1) await sleep(20);
  const e = seen.find((s) => s.message === msg);
  expect(e, `no event "${msg}" among ${seen.map((s) => s.message).join(", ")}`).toBeDefined();
  return e!;
};

describe("worker Sentry isolation under the production OpenTelemetry setup", () => {
  it("a job's tags and breadcrumbs never reach a later, unrelated capture (the 2026-11-04 ots-upgrade event)", async () => {
    await runJobWithTelemetryContext(
      { jobKind: "RebuildSearchDocument", queueName: "search-indexing", jobId: "search-index-evidence.job-1" },
      async () => {
        Sentry.addBreadcrumb({ category: "test", message: "search job step" });
        await sleep(10);
      },
    );
    // The BullMQ `error` handler of another queue, later.
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        captureException(new Error("getaddrinfo EAI_AGAIN redis.example"), { requestId: "r-1", jobKind: "ots-upgrade" });
        resolve();
      }, 10),
    );
    const e = await find("getaddrinfo EAI_AGAIN redis.example");
    expect(e.tags.job_kind).toBe("ots-upgrade");
    expect(e.tags.queue_name).toBeUndefined();
    expect(e.tags.job_id).toBeUndefined();
    expect(e.transaction).toBe("queue.ots-upgrade");
    expect(e.crumbs).toEqual([]);
  });

  it("concurrent jobs keep their own tags", async () => {
    await Promise.all([
      runJobWithTelemetryContext({ jobKind: "report", queueName: "report", jobId: "job-A" }, async () => {
        await sleep(30);
        captureException(new Error("job A failed"));
      }),
      runJobWithTelemetryContext({ jobKind: "evidence-purge", queueName: "evidence-purge", jobId: "job-B" }, async () => {
        await sleep(10);
        captureException(new Error("job B failed"));
      }),
    ]);
    expect((await find("job A failed")).tags).toMatchObject({ job_id: "job-A", queue_name: "report" });
    expect((await find("job B failed")).tags).toMatchObject({ job_id: "job-B", queue_name: "evidence-purge" });
  });

  it("scheduled ticks run in their own scope, named background.<operation>, and inherit no job context", async () => {
    await Promise.all([
      runBackgroundOperation("search_index_reconciler", async () => {
        Sentry.addBreadcrumb({ category: "test", message: "reconciler step" });
        await sleep(20);
        captureException(new Error("reconciler unhealthy"), { kind: "worker.search_index_reconciler" });
      }),
      runBackgroundOperation("api_delivery_sweep", async () => {
        await sleep(40);
        captureException(new Error("fetch failed"), { sweep: "communication-retries", trigger: "interval" });
      }),
    ]);
    const r = await find("reconciler unhealthy");
    const d = await find("fetch failed");
    expect(r.transaction).toBe("background.search_index_reconciler");
    expect(r.crumbs).toEqual(["reconciler step"]);
    expect(d.transaction).toBe("background.api_delivery_sweep");
    expect(d.crumbs).toEqual([]);
    for (const e of [r, d]) {
      expect(e.transaction).not.toMatch(/readyz|GET/);
      expect(e.tags.job_id).toBeUndefined();
      expect(e.tags.queue_name).toBeUndefined();
    }
  });
});
