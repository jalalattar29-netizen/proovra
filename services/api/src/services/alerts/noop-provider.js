export class NoopAlertProvider {
    name = "noop";
    isReady() {
        return false;
    }
    async dispatch(_input) {
        return { ok: false, provider: "noop", reason: "no_alert_provider_configured" };
    }
}
