/**
 * Phase 21 — Noop observability provider.
 *
 * Used when OBSERVABILITY_ENABLED is not "true" OR when both Sentry
 * and OTEL providers are unconfigured. Every method returns immediately
 * without raising. Tests inject this directly via
 * `setObservabilityProviderForTests`.
 */
class NoopSpan {
    addEvent(_name, _attributes) {
        /* noop */
    }
    setAttribute(_key, _value) {
        /* noop */
    }
    recordException(_err, _context) {
        /* noop */
    }
    end() {
        /* noop */
    }
}
const SINGLETON_SPAN = new NoopSpan();
export class NoopObservabilityProvider {
    name = "noop";
    isReady() {
        return false;
    }
    startSpan(_name, _attributes) {
        return SINGLETON_SPAN;
    }
    captureException(_input) {
        /* noop */
    }
    setUserContext(_input) {
        /* noop */
    }
}
