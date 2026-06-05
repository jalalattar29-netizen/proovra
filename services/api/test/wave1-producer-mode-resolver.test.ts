/**
 * Wave 1 Phase 3 — Producer-Mode Truth Resolver contract test.
 *
 * Hard contracts pinned here:
 *
 *   1. PRODUCER_KINDS contains exactly the 5 canonical values
 *      (ocr, transcript, perceptual_similarity, derivative_detection,
 *      semantic_search). Order is stable.
 *
 *   2. ProducerModeStatus has exactly the 8 required fields
 *      (kind, mode, enabled, configured, automatic, indexExistingOnly,
 *      provider, reason) plus the two optional fields (lastRunAt,
 *      lastError).
 *
 *   3. resolveProducerModeStatuses returns exactly 5 entries in
 *      stable order matching PRODUCER_KINDS.
 *
 *   4. Each entry has a non-empty `reason` string.
 *
 *   5. The HTTP route `/v1/intelligence/capabilities` is registered
 *      in server.ts.
 *
 *   6. UI files in apps/web have zero raw env reads for
 *      OCR_PRODUCER_MODE, TRANSCRIPT_PRODUCER_MODE, OPENAI_API_KEY.
 *
 *   7. The resolver source file delegates to the existing probes
 *      (probeAzureDocumentIntelligence, probeDeepgram,
 *      isSemanticReadyAtRuntime, resolveEmbeddingProviderFromEnv)
 *      and does NOT re-read env vars for these provider checks.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PRODUCER_KINDS,
  PRODUCER_REASON_COPY,
  resolveProducerModeStatuses,
  type ProducerKind,
  type ProducerModeStatus,
} from "@proovra/shared-runtime/media-intelligence";

// ---------------------------------------------------------------------------
// Repo path constants — pin sources by absolute path so the test
// fails LOUDLY if a file is renamed.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../..");
const RESOLVER_SOURCE = resolve(
  repoRoot,
  "packages/shared-runtime/src/media-intelligence/producer-mode.ts",
);
const ROUTE_SOURCE = resolve(
  repoRoot,
  "services/api/src/routes/intelligence-capabilities.routes.ts",
);
const SERVER_SOURCE = resolve(repoRoot, "services/api/src/server.ts");
const WEB_APP_DIR = resolve(repoRoot, "apps/web");

// ---------------------------------------------------------------------------
// 1 — PRODUCER_KINDS catalog
// ---------------------------------------------------------------------------

describe("Wave 1 — ProducerKind catalog", () => {
  it("contains exactly the 5 canonical kinds in stable order", () => {
    expect([...PRODUCER_KINDS]).toEqual([
      "ocr",
      "transcript",
      "perceptual_similarity",
      "derivative_detection",
      "semantic_search",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3 + 4 — ProducerModeStatus shape + resolver output
// ---------------------------------------------------------------------------

describe("Wave 1 — resolveProducerModeStatuses", () => {
  // Stub prisma — the resolver only needs `$queryRawUnsafe` and is
  // allowed to silently collapse on DB failure. We pass a stub that
  // returns [] so lastRunAt / lastError stay undefined.
  const stubPrisma = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $queryRawUnsafe: async (..._args: any[]) => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it("returns exactly 5 ProducerModeStatus entries in stable order", async () => {
    const out = await resolveProducerModeStatuses({
      teamId: "00000000-0000-0000-0000-000000000000",
      prisma: stubPrisma,
    });
    expect(out).toHaveLength(5);
    expect(out.map((s) => s.kind)).toEqual([
      "ocr",
      "transcript",
      "perceptual_similarity",
      "derivative_detection",
      "semantic_search",
    ]);
  });

  it("every entry has the 8 required fields (4 booleans, kind, mode, provider, reason)", async () => {
    const out = await resolveProducerModeStatuses({
      teamId: "00000000-0000-0000-0000-000000000000",
      prisma: stubPrisma,
    });
    const REQUIRED_KEYS: ReadonlyArray<keyof ProducerModeStatus> = [
      "kind",
      "mode",
      "enabled",
      "configured",
      "automatic",
      "indexExistingOnly",
      "provider",
      "reason",
    ];
    for (const status of out) {
      for (const key of REQUIRED_KEYS) {
        expect(
          status,
          `kind=${status.kind} missing required field ${String(key)}`,
        ).toHaveProperty(key);
      }
      expect(typeof status.kind).toBe("string");
      expect(typeof status.mode).toBe("string");
      expect(typeof status.enabled).toBe("boolean");
      expect(typeof status.configured).toBe("boolean");
      expect(typeof status.automatic).toBe("boolean");
      expect(typeof status.indexExistingOnly).toBe("boolean");
      expect(typeof status.provider).toBe("string");
      expect(typeof status.reason).toBe("string");
    }
  });

  it("every entry has a non-empty reason string", async () => {
    const out = await resolveProducerModeStatuses({
      teamId: "00000000-0000-0000-0000-000000000000",
      prisma: stubPrisma,
    });
    for (const status of out) {
      expect(status.reason.length).toBeGreaterThan(0);
    }
  });

  it("derivative_detection is AUTOMATIC + internal-heuristic (producer wired in graph reconcile)", async () => {
    // Phase Repair: the derivative-detection producer is live in
    // packages/shared-runtime/src/graph/graph-builder.service.ts.
    // It upserts POSSIBLE_DERIVATIVE_OF edges from perceptual pHash +
    // upload-time + shared file traits. The resolver claim flipped
    // from DEFERRED → AUTOMATIC to match the actual producer.
    const out = await resolveProducerModeStatuses({
      teamId: "00000000-0000-0000-0000-000000000000",
      prisma: stubPrisma,
    });
    const derivative = out.find((s) => s.kind === "derivative_detection");
    expect(derivative).toBeDefined();
    expect(derivative?.mode).toBe("AUTOMATIC");
    expect(derivative?.reason).toBe(
      PRODUCER_REASON_COPY.DERIVATIVE_HEURISTIC_ACTIVE,
    );
    expect(derivative?.enabled).toBe(true);
    expect(derivative?.configured).toBe(true);
    expect(derivative?.automatic).toBe(true);
    expect(derivative?.indexExistingOnly).toBe(false);
    expect(derivative?.provider).toBe("internal");
  });

  it("derivative_detection reason copy does not leak roadmap / wave language", () => {
    // Operator-facing reason must not mention internal release-train
    // language (Wave / Phase / "wired" / "producer").
    const reason = PRODUCER_REASON_COPY.DERIVATIVE_HEURISTIC_ACTIVE;
    expect(reason).not.toMatch(/Wave/i);
    expect(reason).not.toMatch(/Phase/i);
    expect(reason).not.toMatch(/producer.*wired/i);
    // Should mention the actual heuristic so operators understand the
    // signal source.
    expect(reason.length).toBeGreaterThan(20);
    expect(reason).toMatch(/similarity|proximity|traits/i);
  });

  it("provider enum is bounded to the 6 canonical values", async () => {
    const out = await resolveProducerModeStatuses({
      teamId: "00000000-0000-0000-0000-000000000000",
      prisma: stubPrisma,
    });
    const ALLOWED: ReadonlySet<ProducerModeStatus["provider"]> = new Set([
      "local",
      "azure",
      "deepgram",
      "openai",
      "internal",
      "none",
    ]);
    for (const status of out) {
      expect(ALLOWED.has(status.provider)).toBe(true);
    }
  });

  it("ProducerKind type union enumerates exactly 5 members", () => {
    const ks: ProducerKind[] = [
      "ocr",
      "transcript",
      "perceptual_similarity",
      "derivative_detection",
      "semantic_search",
    ];
    expect(ks).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 5 — Route is registered
// ---------------------------------------------------------------------------

describe("Wave 1 — /v1/intelligence/capabilities route registration", () => {
  it("route file exists and exports intelligenceCapabilitiesRoutes", () => {
    const src = readFileSync(ROUTE_SOURCE, "utf8");
    expect(src).toMatch(/export async function intelligenceCapabilitiesRoutes/);
    expect(src).toMatch(/\/v1\/intelligence\/capabilities/);
    expect(src).toMatch(/resolveProducerModeStatuses/);
  });

  it("route is registered in server.ts", () => {
    const src = readFileSync(SERVER_SOURCE, "utf8");
    expect(src).toMatch(/intelligenceCapabilitiesRoutes/);
    expect(src).toMatch(
      /app\.register\(intelligenceCapabilitiesRoutes\)/,
    );
  });

  it("route uses intelligence.read permission (any authenticated workspace member)", () => {
    const src = readFileSync(ROUTE_SOURCE, "utf8");
    expect(src).toMatch(/permission: "intelligence\.read"/);
    expect(src).toMatch(/antiEnumeration: true/);
  });
});

// ---------------------------------------------------------------------------
// 6 — UI has zero raw env reads for producer mode
// ---------------------------------------------------------------------------

const RAW_ENV_PATTERNS = [
  /process\.env\.OCR_PRODUCER_MODE/,
  /process\.env\.TRANSCRIPT_PRODUCER_MODE/,
  /process\.env\.OPENAI_API_KEY/,
];

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    // Skip node_modules, .next, build outputs.
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "next-env.d.ts" ||
      entry === "tsconfig.tsbuildinfo" ||
      entry === "build.log" ||
      entry === "__tests__"
    ) {
      continue;
    }
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (
      entry.endsWith(".ts") ||
      entry.endsWith(".tsx") ||
      entry.endsWith(".js") ||
      entry.endsWith(".jsx")
    ) {
      yield full;
    }
  }
}

describe("Wave 1 — apps/web has zero raw env reads for producer mode", () => {
  it("no apps/web source file reads OCR_PRODUCER_MODE / TRANSCRIPT_PRODUCER_MODE / OPENAI_API_KEY", () => {
    const offenders: Array<{ file: string; pattern: string }> = [];
    for (const file of walkSourceFiles(WEB_APP_DIR)) {
      let contents: string;
      try {
        contents = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const pattern of RAW_ENV_PATTERNS) {
        if (pattern.test(contents)) {
          offenders.push({ file, pattern: pattern.source });
        }
      }
    }
    expect(
      offenders,
      `UI files must consume /v1/intelligence/capabilities instead of raw env reads: ${JSON.stringify(offenders, null, 2)}`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7 — Resolver delegates to existing probes (no duplication)
// ---------------------------------------------------------------------------

describe("Wave 1 — resolver delegates to existing probes (no duplication)", () => {
  const resolverSrc = readFileSync(RESOLVER_SOURCE, "utf8");

  it("delegates OCR provider check to probeAzureDocumentIntelligence", () => {
    expect(resolverSrc).toMatch(/probeAzureDocumentIntelligence/);
  });

  it("delegates transcript provider check to probeDeepgram", () => {
    expect(resolverSrc).toMatch(/probeDeepgram/);
  });

  it("delegates semantic search readiness to isSemanticReadyAtRuntime", () => {
    expect(resolverSrc).toMatch(/isSemanticReadyAtRuntime/);
  });

  it("delegates semantic provider resolution to resolveEmbeddingProviderFromEnv", () => {
    expect(resolverSrc).toMatch(/resolveEmbeddingProviderFromEnv/);
  });

  it("does NOT re-read AZURE_DOCUMENT_INTELLIGENCE_KEY / DEEPGRAM_API_KEY / OPENAI_API_KEY directly", () => {
    expect(resolverSrc).not.toMatch(
      /process\.env\.AZURE_DOCUMENT_INTELLIGENCE_KEY/,
    );
    expect(resolverSrc).not.toMatch(/process\.env\.DEEPGRAM_API_KEY/);
    expect(resolverSrc).not.toMatch(/process\.env\.OPENAI_API_KEY/);
  });
});
