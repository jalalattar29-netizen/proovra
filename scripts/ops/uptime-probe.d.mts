export type UptimeProbe = { name: string; url: string; expectJson?: Record<string, unknown> };
export type UptimeResult = { name: string; ok: boolean; status: number | null; detail: string; attempts: number };
export declare const DEFAULT_PROBES: UptimeProbe[];
export declare function probeOnce(
  probe: UptimeProbe,
  options?: { attempts?: number; retryDelayMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<UptimeResult>;
export declare function previousConclusion(input: {
  repo?: string;
  workflowFile: string;
  branch?: string;
  token?: string;
  currentRunId?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<"success" | "failure" | "unknown">;
export declare function isDiscordWebhook(url: string): boolean;
export declare function buildMessage(kind: "down" | "recovered", results: UptimeResult[], runUrl?: string): string;
export declare function postNotification(
  webhookUrl: string,
  text: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: boolean; status: number | null }>;
export declare function runUptimeProbe(input?: {
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  probes?: UptimeProbe[];
}): Promise<number>;
