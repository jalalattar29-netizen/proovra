#!/usr/bin/env node
/**
 * PROOVRA — external uptime probe (OPS closure 2, 2026-11-21).
 *
 * Run by .github/workflows/uptime.yml on GitHub's runners, OUTSIDE the
 * production host, so it still works when the host, Docker, the API process or
 * its in-process watchdog are down. Probes:
 *
 *   api-health   https://api.proovra.com/health   200 and {"ok":true,"db":"up"}
 *   api-readyz   https://api.proovra.com/readyz   200
 *   web-health   https://www.proovra.com/api/health 200
 *
 * Each probe gets UPTIME_ATTEMPTS tries (default 3), UPTIME_RETRY_DELAY_MS apart
 * (default 20 s), each bounded by UPTIME_TIMEOUT_MS (default 15 s), so a single
 * blip does not page.
 *
 * Notification (OPS_ALERT_WEBHOOK_URL, a repository secret; Discord-shaped
 * when it is a Discord webhook): a DOWN message when this run fails and the
 * previous completed run of this workflow did not (or cannot be read), and
 * one RECOVERED message when this run passes and the previous run failed. A
 * failure that persists is not re-posted every run; the run itself stays red
 * (and GitHub's own failed-run notification applies). The previous run is read
 * from the Actions API with the job's GITHUB_TOKEN; unreadable means "unknown":
 * a failure is then posted (a duplicate beats silence), a pass posts nothing.
 *
 * Exit: 0 all probes passed and the secret exists; 1 a probe failed, or the
 * secret is missing (so the gap is visible), or the notification failed.
 * Never prints the webhook URL.
 */
import { pathToFileURL } from "node:url";

export const DEFAULT_PROBES = [
  { name: "api-health", url: "https://api.proovra.com/health", expectJson: { ok: true, db: "up" } },
  { name: "api-readyz", url: "https://api.proovra.com/readyz" },
  { name: "web-health", url: "https://www.proovra.com/api/health" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One probe, with retries. Returns { name, ok, status, detail }. */
export async function probeOnce(probe, { attempts = 3, retryDelayMs = 20_000, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  let last = { name: probe.name, ok: false, status: null, detail: "not attempted" };
  for (let i = 1; i <= attempts; i += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(probe.url, { headers: { "user-agent": "proovra-uptime-probe/1" }, signal: ac.signal, redirect: "manual" });
      const text = await res.text().catch(() => "");
      if (res.status !== 200) {
        last = { name: probe.name, ok: false, status: res.status, detail: `HTTP ${res.status}` };
      } else if (probe.expectJson) {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        const mismatch = Object.entries(probe.expectJson).filter(([k, v]) => !body || body[k] !== v).map(([k]) => k);
        last = mismatch.length === 0
          ? { name: probe.name, ok: true, status: 200, detail: "ok" }
          : { name: probe.name, ok: false, status: 200, detail: `unexpected body (${mismatch.join(", ")})` };
      } else {
        last = { name: probe.name, ok: true, status: 200, detail: "ok" };
      }
    } catch (err) {
      last = { name: probe.name, ok: false, status: null, detail: err && err.name === "AbortError" ? `timeout after ${timeoutMs} ms` : "connection failed" };
    } finally {
      clearTimeout(timer);
    }
    if (last.ok) return { ...last, attempts: i };
    if (i < attempts) await sleep(retryDelayMs);
  }
  return { ...last, attempts };
}

/** "success" | "failure" | "unknown" for the newest completed run before this one. */
export async function previousConclusion({ repo, workflowFile, branch, token, currentRunId, apiBase = "https://api.github.com", fetchImpl = fetch }) {
  if (!repo || !token) return "unknown";
  try {
    const u = `${apiBase}/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?status=completed&per_page=5${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`;
    const res = await fetchImpl(u, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "proovra-uptime-probe/1" } });
    if (res.status !== 200) return "unknown";
    const body = await res.json();
    const run = (body.workflow_runs ?? []).find((r) => String(r.id) !== String(currentRunId) && (r.conclusion === "success" || r.conclusion === "failure"));
    return run ? run.conclusion : "unknown";
  } catch {
    return "unknown";
  }
}

export function isDiscordWebhook(url) {
  try {
    const u = new URL(url);
    return ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"].includes(u.hostname) && u.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

export function buildMessage(kind, results, runUrl) {
  const failed = results.filter((r) => !r.ok);
  const lines =
    kind === "down"
      ? [
          `**[PROOVRA UPTIME] DOWN — ${failed.length} of ${results.length} external probe(s) failing**`,
          ...failed.map((r) => `- ${r.name}: ${r.detail} after ${r.attempts} attempt(s)`),
          "Probed from GitHub Actions, outside the production host. Check the host, Caddy, the API container and /readyz.",
        ]
      : [`**[PROOVRA UPTIME] RECOVERED — all ${results.length} external probes pass again**`];
  if (runUrl) lines.push(runUrl);
  return lines.join("\n").slice(0, 1900);
}

export async function postNotification(webhookUrl, text, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const body = isDiscordWebhook(webhookUrl) ? { content: text, username: "PROOVRA uptime", allowed_mentions: { parse: [] } } : { text, content: text };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ac.signal });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function runUptimeProbe({ env = process.env, log = (l) => console.log(l), fetchImpl = fetch, probes = DEFAULT_PROBES } = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : d);
  const opts = {
    attempts: num(env.UPTIME_ATTEMPTS, 3),
    retryDelayMs: num(env.UPTIME_RETRY_DELAY_MS, 20_000),
    timeoutMs: num(env.UPTIME_TIMEOUT_MS, 15_000),
    fetchImpl,
  };
  const results = await Promise.all(probes.map((p) => probeOnce(p, opts)));
  for (const r of results) log(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail} (status ${r.status ?? "none"}, ${r.attempts} attempt(s))`);
  const allOk = results.every((r) => r.ok);

  const webhook = (env.OPS_ALERT_WEBHOOK_URL ?? "").trim();
  if (!webhook) {
    log("::error title=OPS_ALERT_WEBHOOK_URL missing::The repository secret OPS_ALERT_WEBHOOK_URL is not set, so this uptime check cannot notify anyone. Add it under Settings > Secrets and variables > Actions.");
    return 1;
  }
  const previous = await previousConclusion({
    repo: env.GITHUB_REPOSITORY,
    workflowFile: env.UPTIME_WORKFLOW_FILE || "uptime.yml",
    branch: env.UPTIME_BRANCH || "",
    token: env.GITHUB_TOKEN,
    currentRunId: env.GITHUB_RUN_ID,
    apiBase: env.GITHUB_API_URL || "https://api.github.com",
    fetchImpl,
  });
  log(`previous run: ${previous}`);
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : "";
  let kind = null;
  if (!allOk && previous !== "failure") kind = "down";
  if (allOk && previous === "failure") kind = "recovered";
  if (kind) {
    const sent = await postNotification(webhook, buildMessage(kind, results, runUrl), { fetchImpl });
    log(`notification ${kind}: ${sent.ok ? "sent" : "FAILED"} (status ${sent.status ?? "none"})`);
    if (!sent.ok) {
      log("::error title=Uptime notification failed::The webhook did not accept the notification.");
      return 1;
    }
  } else {
    log(allOk ? "notification: none (still up)" : "notification: none (already reported down by an earlier run)");
  }
  if (!allOk) {
    log(`::error title=PROOVRA down::${results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`).join("; ")}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUptimeProbe().then(
    (code) => process.exit(code),
    () => {
      console.error("uptime-probe: FAILED — unexpected error");
      process.exit(1);
    },
  );
}
