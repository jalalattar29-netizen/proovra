import type {
  AlertDispatchResult,
  AlertInput,
  AlertProvider,
} from "./provider.js";

export class NoopAlertProvider implements AlertProvider {
  readonly name = "noop" as const;
  isReady(): boolean {
    return false;
  }
  async dispatch(_input: AlertInput): Promise<AlertDispatchResult> {
    return { ok: false, provider: "noop", reason: "no_alert_provider_configured" };
  }
}
