/**
 * Phase M2 — C2PA provider worker-side tests.
 *
 * Exercises the bounded provider parse / aggregation logic in
 * `services/worker/src/c2pa/provider.ts` without invoking any
 * external `c2patool` binary. The provider's `parseToolStdoutToFileResult`
 * helper is exposed via `__testables` for this purpose.
 *
 * Goals:
 *   * No-manifest stdout → `not_present`.
 *   * Manifest-present stdout in `detect_only` mode → `present`,
 *     `validationStatus = not_checked`.
 *   * Manifest-present stdout with `validation` array of invalid
 *     codes → `invalid`, bounded `failureReason`.
 *   * Manifest-present stdout with valid signature info → `valid`.
 *   * Garbage stdout → `not_present` (NEVER throws, NEVER fabricates).
 *
 * Plus a source-contract check that the provider:
 *   * NEVER writes to the source path.
 *   * Has a bounded subprocess timeout.
 *   * Logs no raw key bytes.
 *
 * Note: the provider module imports `config.ts` which parses env at
 * load time. We satisfy the env schema with minimal stubs before
 * dynamic-importing the module under test.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

// Minimal env stubs — worker config requires these to be non-empty
// strings. The provider tests do NOT touch DB / S3 / signing in any
// way, so any non-empty string is fine.
function ensureWorkerEnvForProviderTests() {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.S3_ENDPOINT ??= "http://localhost:9000";
  process.env.S3_ACCESS_KEY ??= "test";
  process.env.S3_SECRET_KEY ??= "test";
  process.env.S3_BUCKET ??= "test-bucket";
}

type ParseFn = (input: {
  stdout: string;
  itemId: string | null;
  mediaType: string;
  mode: "disabled" | "detect_only" | "validate" | "embed_supported";
}) => {
  status: string;
  manifestDetected: boolean;
  validationStatus: string;
  claimSignatureStatus: string;
  claimGenerator: string | null;
  assertionsSummary: {
    total: number;
    actionsCount: number;
    thumbnailCount: number;
    hashCount: number;
    customCount: number;
  };
  ingredientsCount: number;
  failureReason: string | null;
  itemId: string | null;
};

let parseToolStdoutToFileResult: ParseFn;

beforeAll(async () => {
  ensureWorkerEnvForProviderTests();
  const { __testables } = await import("../src/c2pa/provider.js");
  parseToolStdoutToFileResult =
    __testables.parseToolStdoutToFileResult as unknown as ParseFn;
});

describe("M2 C2PA provider — parser", () => {
  it("garbage stdout → not_present (no throw)", () => {
    const r = parseToolStdoutToFileResult({
      stdout: "not json at all",
      itemId: null,
      mediaType: "image/jpeg",
      mode: "detect_only",
    });
    expect(r.status).toBe("not_present");
    expect(r.manifestDetected).toBe(false);
  });

  it("empty manifests block → not_present", () => {
    const r = parseToolStdoutToFileResult({
      stdout: JSON.stringify({ manifests: {}, active_manifest: null }),
      itemId: null,
      mediaType: "image/jpeg",
      mode: "detect_only",
    });
    expect(r.status).toBe("not_present");
  });

  it("manifest present in detect_only → present, validation not_checked", () => {
    const r = parseToolStdoutToFileResult({
      stdout: JSON.stringify({
        active_manifest: "m1",
        manifests: {
          m1: {
            claim_generator: "TestApp/1.0",
            ingredients: [],
            assertions: [
              { label: "c2pa.actions.v1" },
              { label: "c2pa.thumbnail.claim.jpeg" },
            ],
          },
        },
      }),
      itemId: "part-1",
      mediaType: "image/jpeg",
      mode: "detect_only",
    });
    expect(r.status).toBe("present");
    expect(r.manifestDetected).toBe(true);
    expect(r.validationStatus).toBe("not_checked");
    expect(r.claimSignatureStatus).toBe("not_evaluated");
    expect(r.claimGenerator).toBe("TestApp/1.0");
    expect(r.assertionsSummary.total).toBe(2);
    expect(r.assertionsSummary.actionsCount).toBe(1);
    expect(r.assertionsSummary.thumbnailCount).toBe(1);
    expect(r.itemId).toBe("part-1");
  });

  it("invalid validation entries → invalid + bounded failureReason", () => {
    const r = parseToolStdoutToFileResult({
      stdout: JSON.stringify({
        active_manifest: "m1",
        manifests: {
          m1: {
            claim_generator: "Gen",
            assertions: [],
            ingredients: [],
            validation_status: [
              { code: "claim_signature_invalid" },
            ],
            signature_info: { status: "invalid" },
          },
        },
      }),
      itemId: null,
      mediaType: "image/jpeg",
      mode: "validate",
    });
    expect(r.status).toBe("invalid");
    expect(r.validationStatus).toBe("invalid");
    expect([
      "signature_invalid",
      "unknown",
      "certificate_untrusted",
    ]).toContain(r.failureReason);
  });

  it("valid manifest with empty validation array → valid", () => {
    const r = parseToolStdoutToFileResult({
      stdout: JSON.stringify({
        active_manifest: "m1",
        manifests: {
          m1: {
            claim_generator: "Gen",
            assertions: [],
            ingredients: [{}],
            validation_status: [],
            signature_info: { status: "valid" },
          },
        },
      }),
      itemId: null,
      mediaType: "image/jpeg",
      mode: "validate",
    });
    expect(r.status).toBe("valid");
    expect(r.validationStatus).toBe("valid");
    expect(r.claimSignatureStatus).toBe("valid");
    expect(r.ingredientsCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Source contract — provider safety properties
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf-8");
}

describe("M2 C2PA provider — source contracts", () => {
  const src = read("services/worker/src/c2pa/provider.ts");

  it("never writes to or mutates source bytes", () => {
    expect(src).not.toMatch(/appendFile\(/);
    expect(src).not.toMatch(/PutObject|putObject/);
    expect(src).not.toMatch(/writeFile\([^,]*S3/);
  });

  it("has a bounded subprocess timeout wired to env.C2PA_TIMEOUT_MS", () => {
    expect(src).toContain("env.C2PA_TIMEOUT_MS");
    expect(src).toContain("timedOut");
  });

  it("never returns raw stdout / stderr in result fields", () => {
    expect(src).not.toMatch(/stderr:.*result/);
    expect(src).not.toMatch(/stdout:.*return/);
  });

  it("never logs or processes raw private key bytes", () => {
    expect(src).not.toMatch(/SIGNING_PRIVATE_KEY_PATH/);
    expect(src).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(src).not.toMatch(/BEGIN RSA PRIVATE KEY/);
  });

  it("media-type sniffing is bounded by a published allowlist", () => {
    expect(src).toContain("isC2paSupportedMediaType");
  });
});

// ---------------------------------------------------------------------------
// Source contract — ingest helper safety
// ---------------------------------------------------------------------------

describe("M2 C2PA ingest helper", () => {
  const src = read("services/worker/src/c2pa/ingest.ts");

  it("never reads the original file directly from disk", () => {
    expect(src).not.toMatch(/readFileSync\(/);
    expect(src).not.toMatch(/createReadStream\(/);
  });

  it("never blocks the finalize gate (only persists; failure is bounded)", () => {
    expect(src).toContain("persistC2paSummary");
    expect(src).toMatch(/catch\b/);
    expect(src).toContain("proovra.c2pa.persist_failure");
  });
});

// ---------------------------------------------------------------------------
// Source contract — package summary builder
// ---------------------------------------------------------------------------

describe("M2 C2PA package summary", () => {
  const src = read("services/worker/src/c2pa/package-summary.ts");

  it("never opens evidence bytes during package build", () => {
    expect(src).not.toMatch(/getObjectRange|getObject\(|readFileSync\(/);
  });

  it("uses the bounded `buildDisabledC2paSummary` for the disabled fallback", () => {
    expect(src).toContain("buildDisabledC2paSummary");
  });

  it("README disclaims authenticity / truth / admissibility", () => {
    expect(src).toContain("does NOT prove the content is true");
    expect(src).toContain("does NOT replace PROOVRA");
    expect(src).toContain("does NOT make any admissibility claim");
  });
});
