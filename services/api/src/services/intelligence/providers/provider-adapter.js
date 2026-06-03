/**
 * PROOVRA Phase 3B — Provider Adapter abstraction.
 *
 * Single canonical contract every cloud provider implements. The
 * rest of the platform NEVER imports vendor SDK types — it imports
 * `ProviderAdapter` and `IntelligenceProviderResult` from this
 * file. New vendors are added by writing a new adapter — no other
 * surface changes.
 *
 * Hard rules:
 *   * Every adapter call returns the bounded
 *     `IntelligenceProviderResult` shape (operation outcome +
 *     usage event for cost controls + bounded record rows for the
 *     media-intelligence ingest pipeline).
 *   * Adapters NEVER persist anything themselves; they return data
 *     for the orchestrator to ingest.
 *   * Adapters honestly report `NOT_CONFIGURED` instead of
 *     throwing when credentials are absent.
 *   * Bounded operations from `PROVIDER_ADAPTER_OPERATIONS` —
 *     anything else is a code error.
 */
// ---------------------------------------------------------------------------
// Adapter registry — bounded set of bound providers
// ---------------------------------------------------------------------------
const REGISTRY = new Map();
export function registerAdapter(adapter) {
    REGISTRY.set(adapter.provider, adapter);
}
export function getAdapter(provider) {
    return REGISTRY.get(provider) ?? null;
}
export function listAdapters() {
    return Array.from(REGISTRY.values());
}
export function listAdapterProbes() {
    return Array.from(REGISTRY.values()).map((a) => a.probe());
}
// Test hook — bounded reset for closure tests.
export function __clearAdapterRegistryForTests() {
    REGISTRY.clear();
}
