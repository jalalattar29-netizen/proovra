/**
 * PHASE 12 — POINT 7 CORRECTIVE PASS (2026-08-05): the observability
 * environment authority.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The first Point-7 run produced two real Sentry issues from a local Windows
 * test process, tagged `environment=test`. That tag is the whole point: the
 * SDK knew it was a test and shipped the events anyway, because the only thing
 * gating transport was "is a DSN present". A DSN was present, because
 * `services/api/src/db.ts` opens with `import "dotenv/config"` and the
 * machine's `.env` carries the production DSN.
 *
 * So `environment` was never a control. This module makes it one, and makes
 * the control EXPLICIT rather than a side effect of which variables happened
 * to be set:
 *
 *   production  the real configured transport. Unchanged. If production
 *               requires Sentry and the configuration is invalid, readiness
 *               says so honestly rather than starting blind.
 *   staging     the real transport, but ONLY against an explicitly configured
 *               staging DSN, and never the production project implicitly.
 *   test        a RECORDING transport. Never opens a socket. The full
 *               `beforeSend` pipeline still runs, so what a test asserts on is
 *               the real capture decision rather than a stub of it.
 *
 * WHY RECORDING RATHER THAN DISABLED
 * ---------------------------------------------------------------------------
 * Disabling Sentry in tests would have prevented both incidents and taught us
 * nothing. The requirement is stronger than "no network": a test has to be able
 * to prove that an expected plan denial produced NO error event AND that a real
 * database failure on the same path still produced one. You cannot assert the
 * second against a disabled SDK.
 */

export type ObservabilityMode = "production" | "staging" | "recording" | "off";

/** One recorded event, bounded. Never carries a payload body. */
export type RecordedObservabilityEvent = {
  level: string;
  /** Sentry's mechanism.handled, when the event carries one. */
  handled: boolean | null;
  /** The error's public/machine code, when it has one. */
  errorCode: string | null;
  errorType: string | null;
  transaction: string | null;
  environment: string | null;
  atUtc: string;
};

const RECORDED: RecordedObservabilityEvent[] = [];

export function recordObservabilityEvent(event: RecordedObservabilityEvent): void {
  RECORDED.push(event);
}

export function getRecordedObservabilityEvents(): ReadonlyArray<RecordedObservabilityEvent> {
  return RECORDED;
}

export function clearRecordedObservabilityEvents(): void {
  RECORDED.length = 0;
}

/**
 * Resolve the mode.
 *
 * `OBSERVABILITY_TRANSPORT` is the explicit override the test harness sets
 * before any import. Without it the mode follows `NODE_ENV`, and — critically —
 * a `test` NODE_ENV can NEVER resolve to a networked mode, whatever DSN is
 * lying around in the environment. That inversion is the fix: transport is
 * decided by what this process IS, not by what it happens to have been handed.
 */
export function resolveObservabilityMode(): ObservabilityMode {
  const explicit = (process.env.OBSERVABILITY_TRANSPORT ?? "").trim().toLowerCase();
  if (explicit === "recording") return "recording";
  if (explicit === "off") return "off";
  if (explicit === "production") return "production";
  if (explicit === "staging") return "staging";

  const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "test") return "recording";
  if (nodeEnv === "production") return "production";
  if (nodeEnv === "staging") return "staging";
  return "off";
}

/**
 * The DSN this mode is permitted to use.
 *
 * `recording` and `off` are handed nothing, so there is no path by which a
 * present DSN can be used by a process that is not supposed to ship events.
 * `staging` requires its OWN variable: falling back to `SENTRY_DSN` is exactly
 * how a staging deployment ends up polluting the production project, so it is
 * refused rather than defaulted.
 */
export function resolveObservabilityDsn(mode: ObservabilityMode): string | null {
  if (mode === "recording" || mode === "off") return null;
  if (mode === "staging") {
    const staging = (process.env.SENTRY_STAGING_DSN ?? "").trim();
    return staging.length > 0 ? staging : null;
  }
  const dsn = (process.env.SENTRY_DSN ?? "").trim();
  return dsn.length > 0 ? dsn : null;
}

/** The `environment` tag events carry. */
export function resolveObservabilityEnvironmentTag(mode: ObservabilityMode): string {
  const explicit = (process.env.SENTRY_ENVIRONMENT ?? "").trim();
  if (explicit.length > 0) return explicit;
  if (mode === "staging") return "staging";
  if (mode === "recording") return "test";
  return process.env.NODE_ENV || "development";
}

/**
 * A Sentry transport that records and never connects.
 *
 * Shaped to Sentry's `Transport` contract: `send` resolves, `flush` resolves
 * true. The envelope is inspected for the bounded fields a test needs and then
 * DROPPED — no body, no request payload, no breadcrumb contents, so a recorded
 * event can never become a place secrets accumulate.
 */
export function createRecordingTransport() {
  return () => ({
    send: async (
      envelope: unknown,
    ): Promise<{ statusCode: number }> => {
      try {
        const items = (envelope as [unknown, Array<[unknown, unknown]>])[1] ?? [];
        for (const [header, payload] of items) {
          // ONLY error events. An envelope also carries performance
          // transactions, spans, sessions and client reports, and none of them
          // have a `level` — so defaulting the missing field to "error"
          // labelled every trace as a failure. The first version of this
          // transport did exactly that, and a test asserting "no error events"
          // was really asserting "no traces", which is neither true nor the
          // property anyone wanted.
          const itemType = (header as { type?: string } | undefined)?.type;
          if (itemType !== undefined && itemType !== "event") continue;
          const event = payload as {
            level?: string;
            transaction?: string;
            environment?: string;
            exception?: {
              values?: Array<{
                type?: string;
                value?: string;
                mechanism?: { handled?: boolean };
              }>;
            };
            extra?: Record<string, unknown>;
            tags?: Record<string, unknown>;
          };
          if (!event || typeof event !== "object") continue;
          const first = event.exception?.values?.[0];
          recordObservabilityEvent({
            level: String(event.level ?? "error"),
            handled:
              typeof first?.mechanism?.handled === "boolean"
                ? first.mechanism.handled
                : null,
            errorCode:
              typeof event.tags?.errorCode === "string"
                ? (event.tags.errorCode as string)
                : typeof event.extra?.errorCode === "string"
                  ? (event.extra.errorCode as string)
                  : null,
            errorType: first?.type ?? null,
            transaction: event.transaction ?? null,
            environment: event.environment ?? null,
            atUtc: new Date().toISOString(),
          });
        }
      } catch {
        // A malformed envelope must not fail the request that produced it.
        // The event is lost from the ledger, which a test will notice as a
        // missing expected capture — never as a silent network call.
      }
      // The SDK's `Transport` contract wants a request response. 200 is the
      // honest answer for "recorded": nothing was rejected, and nothing left
      // the process.
      return { statusCode: 200 };
    },
    flush: async (): Promise<boolean> => true,
  });
}
