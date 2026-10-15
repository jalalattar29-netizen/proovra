/** Types for the test-only AUD-022 Sentry matrix (telemetry-scrub-fixtures.mjs). */
export declare const SENSITIVE_KINDS: ReadonlyArray<{ kind: string; text: string; needles: string[] }>;
export declare const KEYED_SECRETS: Readonly<Record<string, string>>;
export declare const KEYED_NEEDLES: string[];
export declare function eventsCarrying(text: string): Array<[string, Record<string, unknown>]>;
export declare function leaks(scrubbed: unknown, needles: readonly string[]): string[];
