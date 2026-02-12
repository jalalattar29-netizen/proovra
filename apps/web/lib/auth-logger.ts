/**
 * AUTH DEBUG LOGGER - PHASE 1 Evidence Capture
 * 
 * Captures runtime auth flow events:
 * - Provider URLs and parameters
 * - Callback received and parsed
 * - Token exchange results
 * - Session validation
 * - Errors and cancellations
 * 
 * Evidence is logged with timestamps and can be copied to clipboard
 */

interface AuthLogEntry {
  timestamp: string;
  stage: string;
  event: string;
  data?: Record<string, any>;
  provider?: string;
}

class AuthLogger {
  private logs: AuthLogEntry[] = [];
  private isEnabled = true;

  constructor() {
    if (typeof window !== "undefined") {
      // Export globally for console access
      (window as any).__authLogs = this;
    }
  }

  enable() {
    this.isEnabled = true;
  }

  disable() {
    this.isEnabled = false;
  }

  log(stage: string, event: string, data?: Record<string, any>, provider?: string) {
    if (!this.isEnabled) return;

    const entry: AuthLogEntry = {
      timestamp: new Date().toISOString(),
      stage,
      event,
      data,
      provider
    };

    this.logs.push(entry);
    console.log(`[AuthLogger] ${stage}/${event}`, data);

    // Also log to performance marker for DevTools
    if (typeof window?.performance?.mark === "function") {
      window.performance.mark(`auth-${stage}-${event}`);
    }
  }

  logUrlBuilt(provider: string, url: string, params: Record<string, any>) {
    this.log("URL_BUILD", provider, {
      url_length: url.length,
      has_client_id: url.includes("client_id="),
      has_redirect_uri: url.includes("redirect_uri="),
      has_state: url.includes("state="),
      params: params
    }, provider);
  }

  logCallbackReceived(params: Record<string, any>, provider?: string) {
    this.log("CALLBACK", "received", {
      has_code: "code" in params,
      has_id_token: "id_token" in params,
      has_state: "state" in params,
      param_keys: Object.keys(params),
      state_matches_expected: params.state ? "verify manually" : "no state"
    }, provider);
  }

  logTokenExchangeStart(provider: string, endpoint: string) {
    this.log("TOKEN_EXCHANGE", "start", {
      endpoint,
      provider
    }, provider);
  }

  logTokenExchangeSuccess(provider: string, response: Record<string, any>) {
    this.log("TOKEN_EXCHANGE", "success", {
      provider,
      has_token: "token" in response,
      has_user: "user" in response,
      user_id: response.user?.id ? "redacted" : "missing",
      user_email: response.user?.email ? "redacted" : "missing"
    }, provider);
  }

  logTokenExchangeError(provider: string, error: Error | string) {
    this.log("TOKEN_EXCHANGE", "error", {
      provider,
      error: error instanceof Error ? error.message : String(error)
    }, provider);
  }

  logSessionValidation(endpoint: string, response: Record<string, any>) {
    this.log("SESSION", "validation", {
      endpoint,
      has_user: "user" in response,
      user_id: response.user?.id ? "redacted" : "missing"
    });
  }

  logCancel(provider: string, reason: string) {
    this.log("CANCEL", provider, { reason }, provider);
  }

  logError(stage: string, error: Error | string) {
    this.log("ERROR", stage, {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  getLogs(): AuthLogEntry[] {
    return [...this.logs];
  }

  getLogsAsJSON(): string {
    return JSON.stringify(this.logs, null, 2);
  }

  getLogsAsMarkdown(): string {
    let md = "# Auth Flow Evidence Log\n\n";
    md += `Generated: ${new Date().toISOString()}\n\n`;

    const stages = new Set(this.logs.map(log => log.stage));
    stages.forEach(stage => {
      md += `## ${stage}\n\n`;
      const stageLogs = this.logs.filter(log => log.stage === stage);
      stageLogs.forEach(log => {
        md += `**${log.event}** [${log.timestamp}]`;
        if (log.provider) md += ` [${log.provider}]`;
        md += "\n";
        if (log.data) {
          md += "```json\n";
          md += JSON.stringify(log.data, null, 2);
          md += "\n```\n";
        }
        md += "\n";
      });
    });

    return md;
  }

  copyToClipboard() {
    const text = this.getLogsAsMarkdown();
    if (typeof window?.navigator?.clipboard?.writeText === "function") {
      navigator.clipboard
        .writeText(text)
        .then(() => console.log("[AuthLogger] Logs copied to clipboard"))
        .catch(() => console.log("[AuthLogger] Failed to copy logs"));
    }
  }

  clear() {
    this.logs = [];
    console.log("[AuthLogger] Logs cleared");
  }
}

export const authLogger = new AuthLogger();

// Commands for dev console:
// window.__authLogs.getLogs()  -- get raw logs array
// window.__authLogs.getLogsAsJSON()  -- get formatted JSON
// window.__authLogs.getLogsAsMarkdown()  -- get markdown formatted
// window.__authLogs.copyToClipboard()  -- copy markdown to clipboard
// window.__authLogs.clear()  -- clear all logs
