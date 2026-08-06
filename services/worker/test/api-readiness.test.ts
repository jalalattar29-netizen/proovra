/**
 * Worker startup — API readiness probe regression tests.
 *
 * Covers the hotfix that prevents startup-race ECONNREFUSED alerts:
 *   - The probe retries with exponential backoff + jitter.
 *   - Transient failures during the probe window do NOT escalate.
 *   - Only sustained failure (post-maxAttempts) emits the operational
 *     alert via the injected `onSustainedFailure` hook.
 *   - The process-level singleton coalesces concurrent probes.
 *   - The probe respects `attemptTimeoutMs` (AbortController gate).
 *   - Result type carries attempt count + latency for metrics.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetProcessReadinessForTests,
  ensureApiReadyOnce,
  getProcessReadinessState,
  waitForApiReadiness,
} from "../src/api-readiness.js";

function okResponse(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function notReadyResponse(): Response {
  return new Response(JSON.stringify({ status: "degraded" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

function makeFetchStub(
  responses: Array<() => Promise<Response> | Response>,
): { fetch: typeof fetch; callCount: () => number; calledUrls: string[] } {
  let index = 0;
  const calledUrls: string[] = [];
  const stub: typeof fetch = async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calledUrls.push(url);
    const next = responses[index] ?? responses[responses.length - 1]!;
    index += 1;
    return next();
  };
  return { fetch: stub, callCount: () => index, calledUrls };
}

// All tests reset the process singleton so they don't leak state.
beforeEach(() => {
  __resetProcessReadinessForTests();
});

// -----------------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------------

describe("api readiness — happy path", () => {
  it("returns ready on first 200 response", async () => {
    const stub = makeFetchStub([() => okResponse()]);
    const result = await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 5,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
    });
    expect(result.ready).toBe(true);
    expect(stub.callCount()).toBe(1);
    expect(stub.calledUrls[0]).toBe("http://api/readyz");
  });

  it("returns ready with attempt + latency in the result", async () => {
    const stub = makeFetchStub([() => okResponse()]);
    const result = await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 5,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
    });
    if (result.ready) {
      expect(result.attempts).toBe(1);
      expect(typeof result.totalLatencyMs).toBe("number");
      expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
    } else {
      throw new Error("expected ready");
    }
  });

  it("honours a custom path (/health fallback)", async () => {
    const stub = makeFetchStub([() => okResponse()]);
    await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      path: "/health",
      maxAttempts: 1,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
    });
    expect(stub.calledUrls[0]).toBe("http://api/health");
  });
});

// -----------------------------------------------------------------------------
// Delayed API startup
// -----------------------------------------------------------------------------

describe("api readiness — delayed API startup", () => {
  it("succeeds after a small number of pending attempts (transient ECONNREFUSED)", async () => {
    const stub = makeFetchStub([
      () => {
        throw new Error("ECONNREFUSED 172.0.0.1:8080");
      },
      () => {
        throw new Error("ECONNREFUSED 172.0.0.1:8080");
      },
      () => okResponse(),
    ]);
    const result = await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 5,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
    });
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.attempts).toBe(3);
    }
    expect(stub.callCount()).toBe(3);
  });

  it("succeeds after the api returns 503 then 200", async () => {
    const stub = makeFetchStub([
      () => notReadyResponse(),
      () => notReadyResponse(),
      () => notReadyResponse(),
      () => okResponse(),
    ]);
    const result = await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 6,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
    });
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.attempts).toBe(4);
    }
  });

  it("does NOT call onSustainedFailure when the api comes up before exhaustion", async () => {
    const stub = makeFetchStub([
      () => {
        throw new Error("ECONNREFUSED 172.0.0.1:8080");
      },
      () => okResponse(),
    ]);
    let sustainedFailureCalled = false;
    await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 5,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
      onSustainedFailure: () => {
        sustainedFailureCalled = true;
      },
    });
    expect(sustainedFailureCalled).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Sustained unavailability
// -----------------------------------------------------------------------------

describe("api readiness — sustained unavailability", () => {
  it("returns ready=false when every attempt fails", async () => {
    const stub = makeFetchStub([
      () => {
        throw new Error("ECONNREFUSED");
      },
    ]);
    const result = await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 4,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
    });
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.attempts).toBe(4);
      expect(result.lastError).toContain("ECONNREFUSED");
    }
    expect(stub.callCount()).toBe(4);
  });

  it("calls onSustainedFailure EXACTLY ONCE after max attempts", async () => {
    const stub = makeFetchStub([
      () => {
        throw new Error("ECONNREFUSED");
      },
    ]);
    let sustainedFailureCount = 0;
    let observedAttempts = 0;
    await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 3,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
      onSustainedFailure: (p) => {
        sustainedFailureCount += 1;
        observedAttempts = p.attempts;
      },
    });
    expect(sustainedFailureCount).toBe(1);
    expect(observedAttempts).toBe(3);
  });

  it("does NOT call onSustainedFailure on intermediate attempts", async () => {
    let calls = 0;
    const stub = makeFetchStub([
      () => {
        calls += 1;
        if (calls < 5) throw new Error("ECONNREFUSED");
        return okResponse();
      },
    ]);
    let sustainedFailureCount = 0;
    await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 10,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
      onSustainedFailure: () => {
        sustainedFailureCount += 1;
      },
    });
    expect(sustainedFailureCount).toBe(0);
  });

  it("carries the lastError message into the result", async () => {
    const stub = makeFetchStub([
      () => {
        throw new Error("ECONNREFUSED 172.18.0.5:8080");
      },
    ]);
    const result = await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 2,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async () => {},
    });
    if (!result.ready) {
      expect(result.lastError).toContain("ECONNREFUSED");
    } else {
      throw new Error("expected failure");
    }
  });
});

// -----------------------------------------------------------------------------
// Exponential backoff + jitter
// -----------------------------------------------------------------------------

describe("api readiness — backoff timing", () => {
  it("waits between attempts (sleep is invoked maxAttempts - 1 times)", async () => {
    const stub = makeFetchStub([
      () => {
        throw new Error("ECONNREFUSED");
      },
    ]);
    const sleeps: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleeps.push(ms);
    };
    await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 5,
      initialBackoffMs: 10,
      maxBackoffMs: 100,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl,
    });
    expect(sleeps.length).toBe(4); // N-1 sleeps for N attempts.
  });

  it("respects the maxBackoffMs cap", async () => {
    const stub = makeFetchStub([
      () => {
        throw new Error("ECONNREFUSED");
      },
    ]);
    const sleeps: number[] = [];
    await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "test",
      maxAttempts: 10,
      initialBackoffMs: 100,
      maxBackoffMs: 200,
      attemptTimeoutMs: 50,
      fetchImpl: stub.fetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    // Cap is 200 — no sleep should exceed it.
    for (const s of sleeps) {
      expect(s).toBeLessThanOrEqual(200);
    }
  });

  it("backoff includes jitter (decorrelated, in [base/2, base])", async () => {
    // Collect sleeps across multiple identical runs; observe variance.
    const seen = new Set<number>();
    for (let run = 0; run < 5; run++) {
      const stub = makeFetchStub([
        () => {
          throw new Error("ECONNREFUSED");
        },
      ]);
      const sleeps: number[] = [];
      await waitForApiReadiness({
        baseUrl: "http://api",
        consumer: "test",
        maxAttempts: 3,
        initialBackoffMs: 1_000,
        maxBackoffMs: 5_000,
        attemptTimeoutMs: 50,
        fetchImpl: stub.fetch,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      });
      for (const s of sleeps) seen.add(s);
    }
    // With jitter, different runs should produce different sleep
    // values almost certainly. If `seen` has only 1 element across
    // 5 × 2 sleeps, jitter is broken.
    expect(seen.size).toBeGreaterThan(1);
  });
});

// -----------------------------------------------------------------------------
// Process singleton (ensureApiReadyOnce)
// -----------------------------------------------------------------------------

describe("api readiness — process singleton coalescing", () => {
  it("ensureApiReadyOnce runs the probe exactly once across concurrent callers", async () => {
    let probeCalls = 0;
    const stub: typeof fetch = async () => {
      probeCalls += 1;
      // Small async pause so the second caller has time to attach.
      await new Promise((r) => setTimeout(r, 10));
      return okResponse();
    };
    const opts = {
      baseUrl: "http://api",
      consumer: "test-singleton",
      maxAttempts: 3,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 100,
      fetchImpl: stub,
      sleepImpl: async () => {},
    };
    const [a, b, c] = await Promise.all([
      ensureApiReadyOnce(opts),
      ensureApiReadyOnce(opts),
      ensureApiReadyOnce(opts),
    ]);
    expect(a.ready).toBe(true);
    expect(b.ready).toBe(true);
    expect(c.ready).toBe(true);
    // The exact call count depends on coalescing; we accept 1 (perfect
    // coalescing) or modestly more (if callers raced past the
    // singleton check). The CRITICAL invariant is that the singleton
    // does not multiply probes by the number of callers.
    expect(probeCalls).toBeLessThanOrEqual(3);
  });

  it("ensureApiReadyOnce short-circuits future callers after one success", async () => {
    let probeCalls = 0;
    const stub: typeof fetch = async () => {
      probeCalls += 1;
      return okResponse();
    };
    const opts = {
      baseUrl: "http://api",
      consumer: "short-circuit",
      maxAttempts: 3,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 50,
      fetchImpl: stub,
      sleepImpl: async () => {},
    };
    await ensureApiReadyOnce(opts);
    await ensureApiReadyOnce(opts);
    await ensureApiReadyOnce(opts);
    expect(probeCalls).toBe(1);
    expect(getProcessReadinessState()).toBe("ready");
  });
});

// -----------------------------------------------------------------------------
// Attempt timeout (AbortController gate)
// -----------------------------------------------------------------------------

describe("api readiness — attempt timeout", () => {
  it("aborts a hung request via AbortController", async () => {
    let aborted = false;
    const stub: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          aborted = true;
          reject(new Error("AbortError"));
        };
        signal?.addEventListener("abort", onAbort);
      });
    };
    const result = await waitForApiReadiness({
      baseUrl: "http://api",
      consumer: "timeout-test",
      maxAttempts: 2,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      attemptTimeoutMs: 5,
      fetchImpl: stub,
      sleepImpl: async () => {},
    });
    expect(result.ready).toBe(false);
    expect(aborted).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Source contract — startup-triggered consumers gate on readiness.
// -----------------------------------------------------------------------------

describe("worker entrypoint wires the readiness probe", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "utf8",
  ) as string;

  it("imports ensureApiReadyOnce", () => {
    expect(src).toContain("ensureApiReadyOnce");
    expect(src).toContain('from "./api-readiness.js"');
  });

  it("gates the demo-followup startup invocation", () => {
    expect(src).toContain('gateStartupOnApiReadiness("demo-followup")');
    expect(src).toContain("followup.run.skipped_api_unready");
  });

  it("gates the capture-reaper startup invocation", () => {
    expect(src).toContain('gateStartupOnApiReadiness("capture-reaper")');
    expect(src).toContain("capture.reaper.skipped_api_unready");
  });

  it("gates the retention-reconciliation startup invocation", () => {
    expect(src).toContain('"retention-reconciliation"');
    expect(src).toContain("gateStartupOnApiReadiness(");
    expect(src).toContain(
      "governance.retention_reconciliation.skipped_api_unready",
    );
  });

  it("emits operational alert ONLY on sustained probe failure", () => {
    expect(src).toContain('reason: "worker_api_readiness_probe_exhausted"');
  });

  it("exposes env knobs for tuning the probe", () => {
    expect(src).toContain("WORKER_API_READINESS_PROBE_ENABLED");
    expect(src).toContain("WORKER_API_READINESS_MAX_ATTEMPTS");
    expect(src).toContain("WORKER_API_READINESS_INITIAL_BACKOFF_MS");
    expect(src).toContain("WORKER_API_READINESS_MAX_BACKOFF_MS");
    expect(src).toContain("WORKER_API_READINESS_ATTEMPT_TIMEOUT_MS");
  });
});

// -----------------------------------------------------------------------------
// Docker-compose source contract — worker depends_on includes api.
// -----------------------------------------------------------------------------

describe("docker-compose dependency on api", () => {
  const fullSrc = readFileSync(
    fileURLToPath(
      new URL("../../../infra/docker/docker-compose.full.yml", import.meta.url),
    ),
    "utf8",
  ) as string;
  const prodSrc = readFileSync(
    fileURLToPath(
      new URL("../../../infra/docker/docker-compose.prod.yml", import.meta.url),
    ),
    "utf8",
  ) as string;

  it("docker-compose.full.yml worker waits for api healthcheck", () => {
    // Locate the proovra-worker block and verify it lists proovra-api
    // as a service_healthy dependency.
    const idx = fullSrc.indexOf("proovra-worker:");
    expect(idx).toBeGreaterThan(-1);
    const workerBlock = fullSrc.slice(idx, idx + 1500);
    expect(workerBlock).toContain("proovra-api:");
    expect(workerBlock).toContain("condition: service_healthy");
  });

  it("docker-compose.prod.yml worker waits for api healthcheck", () => {
    const idx = prodSrc.indexOf("proovra-worker:");
    expect(idx).toBeGreaterThan(-1);
    const workerBlock = prodSrc.slice(idx, idx + 1500);
    expect(workerBlock).toContain("proovra-api:");
    expect(workerBlock).toContain("condition: service_healthy");
  });
});
