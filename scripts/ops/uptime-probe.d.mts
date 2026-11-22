export type UptimeProbe = { name: string; url: string; expectJson?: Record<string, unknown> };
export type UptimeAttempt = {
  attempt: number;
  status: number | null;
  ms: number;
  detail?: string;
  server?: string | null;
  cfMitigated?: string | null;
  cfRay?: string | null;
  body?: string;
};
export type UptimeResult = { name: string; ok: boolean; status: number | null; detail: string; attempts: number; tries: UptimeAttempt[] };
export type UptimeOutcome = "UP" | "DOWN" | "CONFIG_MISSING" | "CONFIG_INVALID" | "NOTIFY_FAILED" | "SELFTEST";
export declare const DEFAULT_PROBES: UptimeProbe[];
export declare const SELFTEST_PROBE: UptimeProbe;
export declare const OUTCOMES: UptimeOutcome[];
export declare const OUTCOME_TITLE: string;
export declare function sanitizeSnippet(text: unknown, max?: number): string;
export declare function probeOnce(
  probe: UptimeProbe,
  options?: { attempts?: number; retryDelayMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch; clock?: () => number },
): Promise<UptimeResult>;
export declare function formatAttempt(name: string, attempt: UptimeAttempt): string;
export declare function previousOutcome(input: {
  repo?: string;
  workflowFile: string;
  branch?: string;
  token?: string;
  currentRunId?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  maxRuns?: number;
}): Promise<{ outcome: Exclude<UptimeOutcome, "SELFTEST"> | "UNKNOWN"; runId?: number; via: string }>;
export declare function decideNotification(previous: string, allOk: boolean): "down" | "recovered" | "configured" | null;
export declare function isDiscordWebhook(url: string): boolean;
export declare function checkWebhook(
  url: string | undefined,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ state: "missing" | "invalid" | "ok" | "unverified"; reason: string }>;
export declare function buildMessage(
  kind: "down" | "recovered" | "configured",
  results: UptimeResult[],
  runUrl?: string,
  options?: { test?: boolean },
): string;
export declare function postNotification(
  webhookUrl: string,
  text: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: boolean; status: number | null }>;
export declare function runUptimeProbe(input?: {
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  probes?: UptimeProbe[] | null;
  clock?: () => number;
}): Promise<number>;
