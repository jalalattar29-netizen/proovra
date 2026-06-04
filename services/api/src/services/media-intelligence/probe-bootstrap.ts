/**
 * Wave 3 Phase 7B — Producer-mode probe bootstrap.
 *
 * The `@proovra/shared-runtime` package can't import services/api code
 * directly because relative-path imports across packages break
 * `pnpm --filter @proovra/shared-runtime build`. Instead, shared-runtime
 * exposes a `registerProbes(...)` seam (see
 * `packages/shared-runtime/src/media-intelligence/probe-registry.ts`)
 * that this module fulfills at api process startup.
 *
 * The bootstrap MUST be imported once from `server.ts` before any
 * route handlers run. The import has a side effect (the
 * `registerProbes` call below) so the producer-mode resolver picks up
 * the real probes for every request thereafter.
 *
 * Bootstrap order:
 *   1. server.ts imports `./services/media-intelligence/probe-bootstrap.js`
 *   2. This module imports the four probe sources from services/api/src.
 *   3. Calls registerProbes({...}) on the shared-runtime seam.
 *
 * Idempotency:
 *   `registerProbes` simply replaces the registered set, so re-importing
 *   this module (e.g. in tests) is a clean overwrite.
 *
 * Why side-effect-only:
 *   No exports are required from this module — the side effect of
 *   evaluating it is the whole point. server.ts does:
 *
 *     import "./services/media-intelligence/probe-bootstrap.js";
 */

import { registerProbes } from "@proovra/shared-runtime/media-intelligence";
import { probeAzureDocumentIntelligence } from "../redaction/providers/azure-document-intelligence-client.js";
import { probeDeepgram } from "../redaction/providers/deepgram-client.js";
import {
  isSemanticReadyAtRuntime,
  resolveEmbeddingProviderFromEnv,
} from "../search/embedding-provider.js";

// Wrap each sync probe in an async returning the narrow shape expected
// by the registry (state + reason only — the resolver doesn't need
// endpoint / model-id fields).
async function probeAzureForRegistry(): Promise<{
  state: string;
  reason: string | null;
}> {
  const probe = probeAzureDocumentIntelligence();
  return { state: probe.state, reason: probe.reason };
}

async function probeDeepgramForRegistry(): Promise<{
  state: string;
  reason: string | null;
}> {
  const probe = probeDeepgram();
  return { state: probe.state, reason: probe.reason };
}

registerProbes({
  probeAzureDocumentIntelligence: probeAzureForRegistry,
  probeDeepgram: probeDeepgramForRegistry,
  isSemanticReadyAtRuntime,
  resolveEmbeddingProviderFromEnv,
});
