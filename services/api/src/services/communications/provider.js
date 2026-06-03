/**
 * Phase 18 — Messaging provider abstraction.
 *
 * The communication service NEVER imports a vendor SDK directly. It
 * calls one of the provider implementations behind this interface:
 *
 *   - TwilioMessagingProvider — production provider (SMS / WhatsApp /
 *     Verify start+check / webhook signature validation + parsing).
 *   - NoopMessagingProvider   — used when COMMUNICATIONS_ENABLED is
 *     false OR Twilio configuration is incomplete. Returns structured
 *     "skipped" results so the calling flow can never receive a raw
 *     vendor exception.
 *
 * Provider failures are returned as structured `ProviderSendResult`
 * objects with `ok: false` and a `reason` enum — never thrown.
 *
 * Adding a second vendor (Vonage / MessageBird / Sinch) means
 * implementing this interface and wiring it in `resolveMessagingProvider`.
 * The communication service code does not change.
 */
export {};
