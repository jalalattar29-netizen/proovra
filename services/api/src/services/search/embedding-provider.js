/**
 * Phase 15 — Embedding provider abstraction.
 * Phase 16 — Real OpenAI embedding provider replaces the Phase 15 stub.
 *
 * Three providers ship in this file; the runtime picks one at startup
 * based on env. None of them log raw chunk text — only chunk id,
 * evidence id, workspace id, status, and a short error code.
 *
 *   1. DisabledStub             — default. Returns null on every call so
 *                                 the hybrid ranker silently falls back to
 *                                 keyword-only.
 *   2. LocalDeterministic       — non-cryptographic, in-process hash-based
 *                                 embedding for tests + local dev. NEVER
 *                                 used in production.
 *   3. OpenAIEmbeddingProvider  — real OpenAI binding (Phase 16). Gated
 *                                 behind {SEMANTIC_SEARCH_ENABLED=true,
 *                                 SEMANTIC_EMBEDDINGS_PROVIDER=openai,
 *                                 SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=true,
 *                                 OPENAI_API_KEY present}.
 *
 * Hard rules satisfied:
 *   - Default state is DISABLED. No embeddings, no outbound traffic.
 *   - The `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=false` gate is
 *     enforced INSIDE every provider that would talk to an external
 *     service — never relied on at a single call site.
 *   - Provider failures throw a typed EmbeddingProviderError with a
 *     bounded code so callers can degrade to keyword-only cleanly.
 *   - Per-text path delegates to `embedBatch` so retry / backoff /
 *     timeout logic lives in one place.
 *   - Never logs raw input text. Bounded error codes only.
 */
import { createHash } from "node:crypto";
export class EmbeddingProviderError extends Error {
    code;
    status;
    retryable;
    constructor(code, message, options = {}) {
        super(message);
        this.name = "EmbeddingProviderError";
        this.code = code;
        this.status = options.status ?? null;
        this.retryable = options.retryable ?? false;
    }
}
export function logEmbeddingFailure(ctx) {
    // Bounded structured log — no chunk text, no embedding bytes.
    // Falls back to console.warn so we don't pull a pino dependency
    // into the abstraction (the service layer is responsible for
    // forwarding to whatever logger it uses).
    try {
        const payload = {
            kind: "semantic.embedding",
            status: ctx.status,
            errorCode: ctx.errorCode.slice(0, 64),
            chunkId: ctx.chunkId?.slice(0, 64) ?? null,
            evidenceId: ctx.evidenceId?.slice(0, 64) ?? null,
            workspaceId: ctx.workspaceId?.slice(0, 64) ?? null,
        };
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify(payload));
    }
    catch {
        /* logging best-effort */
    }
}
// -----------------------------------------------------------------------------
// 1. DisabledStub — semantic disabled. Default.
// -----------------------------------------------------------------------------
export class DisabledEmbeddingProvider {
    name = "disabled";
    model = "disabled";
    dimensions = 0;
    async embedText(_text) {
        return null;
    }
    async embedBatch(texts) {
        return texts.map(() => null);
    }
}
// -----------------------------------------------------------------------------
// 2. LocalDeterministic — test + local dev only. NON-CRYPTOGRAPHIC.
// -----------------------------------------------------------------------------
/**
 * Hash-bucket pseudo-embedding. Stable for a given input string so
 * tests can assert "similar query → similar vector" without binding
 * to an external provider. The vector is L2-normalised so cosine
 * similarity behaves well.
 *
 * NOT FIT FOR PRODUCTION. Wire the OpenAI / Anthropic provider for
 * any real semantic-quality work.
 */
export class LocalDeterministicEmbeddingProvider {
    name = "local-deterministic";
    model = "sha256-bucket";
    dimensions;
    constructor(dimensions = 384) {
        if (dimensions < 32 || dimensions > 4096) {
            throw new Error("LocalDeterministicEmbeddingProvider dimensions out of range");
        }
        this.dimensions = dimensions;
    }
    async embedText(text) {
        const safe = text.slice(0, 8 * 1024);
        const vec = new Float32Array(this.dimensions);
        // Bucket each word into a hash slot; accumulate term-frequency
        // weighted by token length so longer tokens carry more signal.
        const tokens = safe
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
        for (const tok of tokens) {
            const h = createHash("sha256").update(tok).digest();
            // Take 4 bytes → uint32 → bucket index.
            const bucket = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
            const idx = bucket % this.dimensions;
            vec[idx] += Math.min(8, tok.length);
        }
        // L2 normalise so cosine ≈ dot product downstream.
        let norm = 0;
        for (let i = 0; i < vec.length; i += 1)
            norm += vec[i] * vec[i];
        const denom = Math.sqrt(norm);
        if (denom > 0) {
            for (let i = 0; i < vec.length; i += 1)
                vec[i] /= denom;
        }
        return vec;
    }
    async embedBatch(texts) {
        return Promise.all(texts.map((t) => this.embedText(t)));
    }
}
export class OpenAIEmbeddingProvider {
    name = "openai";
    model;
    dimensions;
    apiKey;
    timeoutMs;
    maxBatchSize;
    maxAttempts;
    baseBackoffMs;
    clientPromise = null;
    constructor(opts) {
        if (!opts.apiKey || !opts.apiKey.trim()) {
            throw new EmbeddingProviderError("AUTH", "openai_embeddings_missing_api_key");
        }
        this.apiKey = opts.apiKey;
        this.model = opts.model?.trim() || "text-embedding-3-small";
        const dim = Number.isFinite(opts.dimensions) && (opts.dimensions ?? 0) > 0
            ? Math.min(opts.dimensions ?? 1536, 3072)
            : 1536;
        this.dimensions = dim;
        this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 30_000);
        this.maxBatchSize = Math.max(1, Math.min(opts.maxBatchSize ?? 96, 512));
        this.maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 3, 6));
        this.baseBackoffMs = Math.max(50, opts.baseBackoffMs ?? 500);
    }
    /**
     * Dual gate. Throws BEFORE any network call so callers can degrade
     * to keyword-only without sending chunk text outbound.
     */
    gate() {
        if (process.env.SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND !== "true") {
            throw new EmbeddingProviderError("OUTBOUND_NOT_ALLOWED", "openai_embeddings_outbound_disabled");
        }
        if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.trim()) {
            throw new EmbeddingProviderError("AUTH", "openai_embeddings_missing_api_key");
        }
    }
    async client() {
        if (!this.clientPromise) {
            this.clientPromise = (async () => {
                // Lazy import so the SDK only loads when this provider is
                // actually selected. The factory below caches the provider
                // singleton so this dynamic import is at most a one-time cost.
                const mod = (await import("openai"));
                const Ctor = mod.default ?? mod.OpenAI;
                if (!Ctor) {
                    throw new EmbeddingProviderError("PROVIDER_NOT_CONFIGURED", "openai_sdk_missing_constructor");
                }
                return new Ctor({ apiKey: this.apiKey });
            })();
        }
        return this.clientPromise;
    }
    /**
     * Per-text path delegates to embedBatch so retry/timeout/backoff
     * logic lives in a single place. Returns `null` on transient
     * failure; throws EmbeddingProviderError on configuration errors.
     */
    async embedText(text) {
        const out = await this.embedBatch([text]);
        return out[0] ?? null;
    }
    async embedBatch(texts) {
        this.gate();
        if (texts.length === 0)
            return [];
        const results = new Array(texts.length).fill(null);
        // Split into bounded batches so a single API call cannot blow
        // the 8192-token-per-input or 2048-input-array limits OpenAI
        // enforces.
        for (let i = 0; i < texts.length; i += this.maxBatchSize) {
            const slice = texts.slice(i, i + this.maxBatchSize);
            const vectors = await this.callWithRetry(slice, i / this.maxBatchSize);
            for (let j = 0; j < vectors.length; j += 1) {
                results[i + j] = vectors[j];
            }
        }
        return results;
    }
    async callWithRetry(inputs, batchIndex) {
        let attempt = 0;
        let lastError = null;
        while (attempt < this.maxAttempts) {
            attempt += 1;
            try {
                return await this.callOnce(inputs);
            }
            catch (err) {
                lastError = err;
                const code = isEmbeddingProviderError(err) ? err.code : "UNKNOWN";
                const retryable = isEmbeddingProviderError(err) ? err.retryable : false;
                // Bounded log — no chunk text, only counts + codes.
                logEmbeddingFailure({
                    status: "failed",
                    errorCode: `OPENAI:${code}:attempt_${attempt}_of_${this.maxAttempts}_batch_${batchIndex}`,
                });
                if (!retryable || attempt >= this.maxAttempts)
                    break;
                await sleep(this.baseBackoffMs * Math.pow(2, attempt - 1));
            }
        }
        // Final failure — for batch-call failures we return `null` per
        // input so the caller can degrade per-chunk. Configuration errors
        // (AUTH, OUTBOUND_NOT_ALLOWED) bubble up because the caller can't
        // make progress until those are fixed.
        if (isEmbeddingProviderError(lastError)) {
            if (lastError.code === "AUTH" ||
                lastError.code === "OUTBOUND_NOT_ALLOWED" ||
                lastError.code === "PROVIDER_NOT_CONFIGURED") {
                throw lastError;
            }
        }
        return inputs.map(() => null);
    }
    async callOnce(inputs) {
        const client = await this.client();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await client.embeddings.create({
                model: this.model,
                input: inputs,
                dimensions: this.dimensions,
            }, { signal: controller.signal });
            const out = new Array(inputs.length).fill(null);
            for (let i = 0; i < response.data.length && i < inputs.length; i += 1) {
                const vec = response.data[i]?.embedding;
                if (Array.isArray(vec) && vec.length > 0) {
                    out[i] = Float32Array.from(vec);
                }
            }
            return out;
        }
        catch (err) {
            throw normaliseOpenAIError(err);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isEmbeddingProviderError(err) {
    return err instanceof EmbeddingProviderError;
}
/**
 * Normalise heterogeneous OpenAI SDK errors into the bounded
 * EmbeddingProviderError vocabulary. Retains the HTTP status if
 * available so log lines remain debuggable.
 */
function normaliseOpenAIError(err) {
    if (err instanceof EmbeddingProviderError)
        return err;
    // AbortError fired by AbortController on timeout.
    if (err instanceof Error &&
        (err.name === "AbortError" || /aborted/i.test(err.message))) {
        return new EmbeddingProviderError("TIMEOUT", "openai_embeddings_timeout", { retryable: true });
    }
    const status = readStatus(err);
    if (status === 429) {
        return new EmbeddingProviderError("RATE_LIMITED", "openai_embeddings_rate_limited", { status, retryable: true });
    }
    if (status && status >= 500 && status <= 599) {
        return new EmbeddingProviderError("UPSTREAM_5XX", "openai_embeddings_upstream_5xx", { status, retryable: true });
    }
    if (status === 401 || status === 403) {
        return new EmbeddingProviderError("AUTH", "openai_embeddings_auth_failure", { status, retryable: false });
    }
    if (status && status >= 400 && status <= 499) {
        return new EmbeddingProviderError("BAD_REQUEST", "openai_embeddings_bad_request", { status, retryable: false });
    }
    return new EmbeddingProviderError("UNKNOWN", err instanceof Error ? err.message.slice(0, 200) : "openai_unknown_error", { status, retryable: false });
}
function readStatus(err) {
    if (err && typeof err === "object") {
        const e = err;
        if (typeof e.status === "number")
            return e.status;
        if (e.response && typeof e.response.status === "number") {
            return e.response.status;
        }
    }
    return null;
}
// -----------------------------------------------------------------------------
// Factory — reads env, returns the configured provider.
// -----------------------------------------------------------------------------
let cachedProvider = null;
let startupLogged = false;
export function resolveEmbeddingProviderFromEnv() {
    if (cachedProvider)
        return cachedProvider;
    cachedProvider = buildEmbeddingProviderFromEnv();
    return cachedProvider;
}
/**
 * Phase 16 — builder used by the cached resolver. Exposed so the
 * worker side (which doesn't share the API process cache) can
 * construct its own provider with identical semantics.
 *
 * Selection rules:
 *   1. SEMANTIC_SEARCH_ENABLED !== "true" → Disabled.
 *   2. SEMANTIC_EMBEDDINGS_PROVIDER === "local" → LocalDeterministic.
 *   3. SEMANTIC_EMBEDDINGS_PROVIDER === "openai" + outbound flag +
 *      API key present → OpenAIEmbeddingProvider.
 *   4. Otherwise → Disabled + a one-time startup warn line
 *      explaining the fallbackReason.
 */
export function buildEmbeddingProviderFromEnv() {
    const enabled = process.env.SEMANTIC_SEARCH_ENABLED === "true";
    const raw = (process.env.SEMANTIC_EMBEDDINGS_PROVIDER ?? "disabled")
        .trim()
        .toLowerCase();
    const dim = Number.parseInt(process.env.SEMANTIC_EMBEDDING_DIMENSIONS ?? "1536", 10);
    const model = process.env.SEMANTIC_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
    if (!enabled) {
        logStartupOnce("DISABLED_FEATURE_FLAG");
        return new DisabledEmbeddingProvider();
    }
    if (raw === "local" || raw === "local-deterministic" || raw === "test") {
        return new LocalDeterministicEmbeddingProvider(Number.isFinite(dim) && dim > 0 ? Math.min(dim, 1536) : 384);
    }
    if (raw === "openai") {
        const outbound = process.env.SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND === "true";
        const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
        if (!outbound) {
            logStartupOnce("OPENAI_OUTBOUND_DISABLED");
            return new DisabledEmbeddingProvider();
        }
        if (!apiKey) {
            logStartupOnce("OPENAI_API_KEY_MISSING");
            return new DisabledEmbeddingProvider();
        }
        try {
            return new OpenAIEmbeddingProvider({
                apiKey,
                model,
                dimensions: Number.isFinite(dim) && dim > 0 ? dim : 1536,
                timeoutMs: Number.parseInt(process.env.SEMANTIC_EMBEDDINGS_TIMEOUT_MS ?? "30000", 10),
                maxBatchSize: Number.parseInt(process.env.SEMANTIC_EMBEDDINGS_BATCH_SIZE ?? "96", 10),
                maxAttempts: Number.parseInt(process.env.SEMANTIC_EMBEDDINGS_MAX_ATTEMPTS ?? "3", 10),
            });
        }
        catch (err) {
            logStartupOnce(err instanceof EmbeddingProviderError
                ? `OPENAI_INIT_${err.code}`
                : "OPENAI_INIT_FAILED");
            return new DisabledEmbeddingProvider();
        }
    }
    logStartupOnce(`UNKNOWN_PROVIDER:${raw.slice(0, 32)}`);
    return new DisabledEmbeddingProvider();
}
function logStartupOnce(reason) {
    if (startupLogged)
        return;
    startupLogged = true;
    try {
        // eslint-disable-next-line no-console
        console.info(JSON.stringify({
            kind: "semantic.embedding.startup",
            fallbackReason: reason.slice(0, 96),
        }));
    }
    catch {
        /* logging best-effort */
    }
}
/**
 * Test/seam — reset the cached provider so a test can flip env and
 * pick a different provider. Not for production use.
 */
export function _resetEmbeddingProviderForTests() {
    cachedProvider = null;
    startupLogged = false;
}
/**
 * Convenience predicate. True when ALL three conditions are met:
 *   1. SEMANTIC_SEARCH_ENABLED=true
 *   2. The resolved provider is not the DisabledEmbeddingProvider
 *   3. (Implicitly) the provider doesn't immediately throw at probe
 */
export function isSemanticReadyAtRuntime() {
    if (process.env.SEMANTIC_SEARCH_ENABLED !== "true")
        return false;
    const p = resolveEmbeddingProviderFromEnv();
    return p.name !== "disabled";
}
// -----------------------------------------------------------------------------
// Back-compat — Phase 15 callers imported `OpenAIEmbeddingProviderStub`.
// Phase 16 replaces the stub with the real provider but preserves the
// legacy export name so any external import keeps building. New code
// should use `OpenAIEmbeddingProvider`.
// -----------------------------------------------------------------------------
export { OpenAIEmbeddingProvider as OpenAIEmbeddingProviderStub };
