/**
 * OPENAI_API_KEY HAS ONE RESOLVER (2026-11-26).
 *
 * Once production could read its secrets bundle, the AI features resolved
 * OPENAI_API_KEY from the bundle while semantic-search embeddings (API and
 * Worker) still read process.env directly: one process, two keys, and a stale
 * bundle value broke only some features. Every reader now goes through the
 * secrets authority (bundle first, then the trimmed environment value).
 *
 *   (a) BEHAVIOUR: the API embedding factory takes the bundle's key over the
 *       environment's, and the environment's when the bundle lacks it.
 *   (b) STRUCTURE: no API or Worker source reads process.env.OPENAI_API_KEY.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  initSecretsAuthority,
  resetRecordingSecretsProvider,
  resetSecretsAuthority,
  scriptSecretsProvider,
  setSecretsProvider,
  recordingSecretsProvider,
} from "@proovra/shared-runtime";

import { buildEmbeddingProviderFromEnv, OpenAIEmbeddingProvider } from "../src/services/search/embedding-provider.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const silent = { info: () => {}, warn: () => {} };

function embeddingEnv(envKey: string | undefined): void {
  process.env.SEMANTIC_SEARCH_ENABLED = "true";
  process.env.SEMANTIC_EMBEDDINGS_PROVIDER = "openai";
  process.env.SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND = "true";
  if (envKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = envKey;
  process.env.AWS_SECRETS_MODE = "optional";
}

function keyOf(p: unknown): string {
  expect(p).toBeInstanceOf(OpenAIEmbeddingProvider);
  return (p as unknown as { apiKey: string }).apiKey;
}

afterEach(() => {
  setSecretsProvider(null);
  resetSecretsAuthority();
  resetRecordingSecretsProvider();
});

describe("(a) the API embedding factory resolves OPENAI_API_KEY through the secrets authority", () => {
  it("takes the bundle's key over a different environment key", async () => {
    embeddingEnv("sk-proj-from-environment");
    setSecretsProvider(recordingSecretsProvider);
    scriptSecretsProvider([{ kind: "secret", payload: { OPENAI_API_KEY: "sk-proj-from-bundle" } }]);
    await initSecretsAuthority(silent);
    expect(keyOf(buildEmbeddingProviderFromEnv())).toBe("sk-proj-from-bundle");
  });

  it("falls back to the trimmed environment key when the bundle does not hold it", async () => {
    embeddingEnv("  sk-proj-from-environment  ");
    setSecretsProvider(recordingSecretsProvider);
    scriptSecretsProvider([{ kind: "secret", payload: { OTHER: "x" } }]);
    await initSecretsAuthority(silent);
    expect(keyOf(buildEmbeddingProviderFromEnv())).toBe("sk-proj-from-environment");
  });

  it("uses the bundle's key even when the environment holds none", async () => {
    embeddingEnv(undefined);
    setSecretsProvider(recordingSecretsProvider);
    scriptSecretsProvider([{ kind: "secret", payload: { OPENAI_API_KEY: "sk-proj-from-bundle" } }]);
    await initSecretsAuthority(silent);
    expect(keyOf(buildEmbeddingProviderFromEnv())).toBe("sk-proj-from-bundle");
  });
});

describe("(b) no API or Worker source reads OPENAI_API_KEY from process.env", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  it.each(["services/api/src", "services/worker/src"])("%s", (rel) => {
    const offenders = walk(path.join(REPO, rel)).filter((f) =>
      /process\.env(\.OPENAI_API_KEY\b|\[\s*["']OPENAI_API_KEY["']\s*\])/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(REPO, f))).toEqual([]);
  });
});
