#!/usr/bin/env node
/**
 * PROOVRA — external uptime probe (OPS closure 2, 2026-11-21; outcome
 * semantics and per-attempt evidence, closure 3, 2026-11-22).
 *
 * Run by .github/workflows/uptime.yml on GitHub's runners, OUTSIDE the
 * production host, so it still works when the host, Docker, the API process or
 * its in-process watchdog are down. A scheduled run of this monitor is not a
 * push and not an application change: its colour says what production and the
 * monitor's own configuration looked like at that moment, nothing else.
 *
 *   api-health   https://api.proovra.com/health   200 and {"ok":true,"db":"up"}
 *   api-readyz   https://api.proovra.com/readyz   200
 *   web-health   https://www.proovra.com/api/health 200
 *
 * Each probe gets UPTIME_ATTEMPTS tries (default 3), UPTIME_RETRY_DELAY_MS apart
 * (default 20 s), each bounded by UPTIME_TIMEOUT_MS (default 15 s). EVERY attempt
 * is logged and written to the job summary — HTTP status and time, and for a
 * non-200 attempt the `server`, `cf-mitigated` and `cf-ray` headers and the
 * first 80 characters of the body (sanitized) — so a retry that hides a
 * systematic first-attempt failure (a Cloudflare challenge, say) is visible.
 *
 * OUTCOME — exactly one per run, as the line `uptime-outcome: <X>` in the log,
 * in the job summary and as a notice annotation titled `uptime-outcome: <X>`
 * (what the next run reads back):
 *   UP             every probe passed, the webhook is configured, any message was sent
 *   DOWN           a probe failed (webhook configured)
 *   CONFIG_INVALID OPS_ALERT_WEBHOOK_URL is malformed, or a Discord webhook
 *                  answers 401/403/404 to GET (revoked) — checked every run
 *   CONFIG_MISSING OPS_ALERT_WEBHOOK_URL is not set (a probe failure is still
 *                  annotated "PROOVRA down"; production state is in the summary)
 *   NOTIFY_FAILED  a message was due and the webhook refused it
 *   SELFTEST       a manual self-test run (ignored by later runs)
 * Exit 1 for everything but UP (and a SELFTEST whose real probes pass).
 *
 * MESSAGES — from the previous run's OUTCOME, read from its annotations
 * (Actions API, checks:read + actions:read). Cancelled / timed-out / skipped
 * runs and self-tests have no outcome and are passed over:
 *   previous DOWN:            failing -> silent;  passing -> RECOVERED
 *   previous UP:              failing -> DOWN;    passing -> nothing
 *   previous CONFIG_MISSING / CONFIG_INVALID:  failing -> DOWN;    passing -> one "monitoring
 *                             configured; production up" message, explicitly
 *                             NOT an outage recovery
 *   previous NOTIFY_FAILED / unknown: failing -> DOWN; passing -> nothing
 * A run made before outcomes existed is read from its annotation titles
 * ("PROOVRA down" = DOWN, "OPS_ALERT_WEBHOOK_URL missing" = CONFIG_MISSING) or
 * its conclusion (success = UP).
 *
 * SELF-TEST (UPTIME_SELFTEST=1, the workflow_dispatch input `selftest`): adds a
 * probe of https://api.proovra.com/__uptime_selftest_404, which must fail, and
 * posts "[TEST]"-labelled DOWN and RECOVERED messages to the configured webhook
 * whatever the previous outcome. Its outcome SELFTEST never feeds a later
 * transition.
 *
 * Never prints the webhook URL.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_PROBES = [
  { name: "api-health", url: "https://api.proovra.com/health", expectJson: { ok: true, db: "up" } },
  { name: "api-readyz", url: "https://api.proovra.com/readyz" },
  { name: "web-health", url: "https://www.proovra.com/api/health" },
];
export const SELFTEST_PROBE = { name: "selftest-404", url: "https://api.proovra.com/__uptime_selftest_404" };
export const OUTCOMES = ["UP", "DOWN", "CONFIG_MISSING", "CONFIG_INVALID", "NOTIFY_FAILED", "SELFTEST"];
export const OUTCOME_TITLE = "uptime-outcome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Printable, single-line, no workflow-command or table syntax, at most `max` characters. */
export function sanitizeSnippet(text, max = 80) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/::/g, ": ")
    .replace(/[|%`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** One probe, with retries. Returns { name, ok, status, detail, attempts, tries: [...] }. */
export async function probeOnce(probe, { attempts = 3, retryDelayMs = 20_000, timeoutMs = 15_000, fetchImpl = fetch, clock = () => performance.now() } = {}) {
  let last = { name: probe.name, ok: false, status: null, detail: "not attempted" };
  const tries = [];
  for (let i = 1; i <= attempts; i += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = clock();
    const attempt = { attempt: i, status: null, ms: 0 };
    try {
      const res = await fetchImpl(probe.url, { headers: { "user-agent": "proovra-uptime-probe/1" }, signal: ac.signal, redirect: "manual" });
      const text = await res.text().catch(() => "");
      attempt.status = res.status;
      if (res.status !== 200) {
        const h = (n) => res.headers?.get?.(n) ?? null;
        attempt.server = sanitizeSnippet(h("server"), 40) || null;
        attempt.cfMitigated = sanitizeSnippet(h("cf-mitigated"), 40) || null;
        attempt.cfRay = sanitizeSnippet(h("cf-ray"), 40) || null;
        attempt.body = sanitizeSnippet(text, 80);
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
    attempt.ms = Math.max(0, Math.round(clock() - t0));
    attempt.detail = last.detail;
    tries.push(attempt);
    if (last.ok) return { ...last, attempts: i, tries };
    if (i < attempts) await sleep(retryDelayMs);
  }
  return { ...last, attempts, tries };
}

/** One log line per attempt. */
export function formatAttempt(name, a) {
  const head = `attempt ${name} #${a.attempt}: ${a.status === null ? a.detail : `HTTP ${a.status}`} in ${a.ms} ms`;
  if (a.status === 200 || a.status === null) return a.status === 200 && a.detail !== "ok" ? `${head} (${a.detail})` : head;
  return `${head} server=${a.server ?? "-"} cf-mitigated=${a.cfMitigated ?? "-"} cf-ray=${a.cfRay ?? "-"} body="${a.body ?? ""}"`;
}

/**
 * The previous run's outcome: { outcome: UP|DOWN|CONFIG_MISSING|NOTIFY_FAILED|UNKNOWN, runId, via }.
 * Runs without an outcome (cancelled, timed out, skipped, self-tests) are passed over.
 */
export async function previousOutcome({ repo, workflowFile, branch, token, currentRunId, apiBase = "https://api.github.com", fetchImpl = fetch, maxRuns = 10 }) {
  if (!repo || !token) return { outcome: "UNKNOWN", via: "no repository or token" };
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "proovra-uptime-probe/1" };
  const get = async (u) => {
    const res = await fetchImpl(u, { headers });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  try {
    const list = await get(`${apiBase}/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?status=completed&per_page=${maxRuns}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`);
    const passedOver = [];
    for (const run of list.workflow_runs ?? []) {
      if (String(run.id) === String(currentRunId)) continue;
      if (run.conclusion !== "success" && run.conclusion !== "failure") {
        passedOver.push(`${run.id}:${run.conclusion}`);
        continue;
      }
      const jobs = await get(`${apiBase}/repos/${repo}/actions/runs/${run.id}/jobs?per_page=20`);
      const titles = [];
      for (const job of jobs.jobs ?? []) {
        const anns = await get(`${apiBase}/repos/${repo}/check-runs/${job.id}/annotations?per_page=50`);
        for (const a of anns ?? []) titles.push(String(a.title ?? ""));
      }
      const marker = titles.map((t) => new RegExp(`^${OUTCOME_TITLE}: ([A-Z_]+)$`).exec(t)?.[1]).find(Boolean);
      const via = `run ${run.id}${passedOver.length ? ` (passed over ${passedOver.join(", ")})` : ""}`;
      if (marker === "SELFTEST") {
        passedOver.push(`${run.id}:selftest`);
        continue;
      }
      if (marker && OUTCOMES.includes(marker)) return { outcome: marker, runId: run.id, via: `${via} outcome annotation` };
      // Runs made before outcomes existed.
      if (titles.includes("PROOVRA down")) return { outcome: "DOWN", runId: run.id, via: `${via} legacy annotation` };
      if (titles.includes("OPS_ALERT_WEBHOOK_URL missing")) return { outcome: "CONFIG_MISSING", runId: run.id, via: `${via} legacy annotation` };
      if (titles.includes("Uptime notification failed")) return { outcome: "NOTIFY_FAILED", runId: run.id, via: `${via} legacy annotation` };
      if (run.conclusion === "success") return { outcome: "UP", runId: run.id, via: `${via} conclusion` };
      return { outcome: "UNKNOWN", runId: run.id, via: `${via} failed without an outcome` };
    }
    return { outcome: "UNKNOWN", via: passedOver.length ? `only runs without an outcome (${passedOver.join(", ")})` : "no completed run" };
  } catch (e) {
    return { outcome: "UNKNOWN", via: `unreadable (${e?.message ?? e})` };
  }
}

/** The message this run owes: "down" | "recovered" | "configured" | null. */
export function decideNotification(previous, allOk) {
  if (!allOk) return previous === "DOWN" ? null : "down";
  if (previous === "DOWN") return "recovered";
  // Neither configuration failure says anything about production: never a RECOVERED.
  if (previous === "CONFIG_MISSING" || previous === "CONFIG_INVALID") return "configured";
  return null;
}

const DISCORD_HOSTS = ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"];
const DISCORD_WEBHOOK_PATH = /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export function isDiscordWebhook(url) {
  try {
    const u = new URL(url);
    return DISCORD_HOSTS.includes(u.hostname) && u.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

/**
 * Is the alert destination usable? Checked EVERY run, so a malformed or
 * revoked webhook is a visible CONFIG_INVALID now, not a NOTIFY_FAILED at the
 * first real outage. { state: "missing" | "invalid" | "ok" | "unverified", reason }.
 *  - shape: https (plain http only for a loopback test receiver), no
 *    credentials; a Discord host must carry /api/webhooks/<id>/<token>;
 *  - a Discord-shaped webhook is fetched with GET, which Discord answers 200
 *    for a live webhook and 401/404 for a revoked one or a wrong token. The
 *    response body (it contains the token) is never read or printed;
 *  - any other answer (5xx, 429, network) is "unverified": warned, not failed.
 * Never prints the URL.
 */
export async function checkWebhook(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const raw = String(url ?? "").trim();
  if (!raw) return { state: "missing", reason: "not set" };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { state: "invalid", reason: "not a URL" };
  }
  if (!(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.includes(u.hostname)))) {
    return { state: "invalid", reason: `scheme ${u.protocol} is not https` };
  }
  if (u.username || u.password) return { state: "invalid", reason: "the URL carries credentials" };
  const discordPath = DISCORD_WEBHOOK_PATH.test(u.pathname);
  if (DISCORD_HOSTS.includes(u.hostname) && !discordPath) {
    return { state: "invalid", reason: "a Discord URL that is not a webhook URL (/api/webhooks/<id>/<token>)" };
  }
  if (!discordPath) return { state: "ok", reason: "shape valid (this webhook type cannot be verified by GET)" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(raw, { method: "GET", headers: { "user-agent": "proovra-uptime-probe/1" }, signal: ac.signal, redirect: "manual" });
    try {
      await res.body?.cancel?.();
    } catch {
      /* body discarded */
    }
    if (res.status === 200) return { state: "ok", reason: "webhook answered 200" };
    if ([401, 403, 404].includes(res.status)) return { state: "invalid", reason: `the webhook was rejected (HTTP ${res.status}): revoked, deleted or wrong token` };
    return { state: "unverified", reason: `webhook check inconclusive (HTTP ${res.status})` };
  } catch {
    return { state: "unverified", reason: "webhook check inconclusive (no answer)" };
  } finally {
    clearTimeout(timer);
  }
}

export function buildMessage(kind, results, runUrl, { test = false } = {}) {
  const tag = test ? "[TEST] " : "";
  const failed = results.filter((r) => !r.ok);
  let lines;
  if (kind === "down") {
    lines = [
      `**${tag}[PROOVRA UPTIME] DOWN — ${failed.length} of ${results.length} external probe(s) failing**`,
      ...failed.map((r) => `- ${r.name}: ${r.detail} after ${r.attempts} attempt(s)`),
      test
        ? "Self-test: this failure is deliberate (a 404 path). Production was not affected."
        : "Probed from GitHub Actions, outside the production host. Check the host, Caddy, the API container and /readyz.",
    ];
  } else if (kind === "configured") {
    lines = [
      `**${tag}[PROOVRA UPTIME] Monitoring configured — production up (all ${results.length} external probes pass)**`,
      "This is not an outage recovery: earlier runs failed only because the alert destination was missing or invalid.",
    ];
  } else {
    lines = [`**${tag}[PROOVRA UPTIME] RECOVERED — all ${results.length} external probes pass again**`];
    if (test) lines.push("Self-test message: no outage happened.");
  }
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

function summaryMarkdown({ outcome, results, previous, notified, selftest }) {
  const rows = results.flatMap((r) =>
    r.tries.map((a) => {
      const cf = a.status !== 200 && a.status !== null ? `server=${a.server ?? "-"} cf-mitigated=${a.cfMitigated ?? "-"} cf-ray=${a.cfRay ?? "-"} body="${a.body ?? ""}"` : "";
      return `| ${r.name} | ${a.attempt === r.tries.length ? (r.ok ? "PASS" : "FAIL") : ""} | #${a.attempt} | ${a.status ?? a.detail} | ${a.ms} | ${cf} |`;
    }),
  );
  return [
    `### External uptime check${selftest ? " (SELF-TEST)" : ""}`,
    "",
    `uptime-outcome: ${outcome}`,
    "",
    "A scheduled monitor run, not a push or an application change.",
    "",
    "| probe | result | attempt | HTTP | ms | non-200 detail |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `Previous outcome: ${previous.outcome} (${previous.via}). Notification: ${notified}.`,
    "",
  ].join("\n");
}

export async function runUptimeProbe({ env = process.env, log = (l) => console.log(l), fetchImpl = fetch, probes = null, clock } = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : d);
  const selftest = env.UPTIME_SELFTEST === "1" || env.UPTIME_SELFTEST === "true";
  const opts = {
    attempts: num(env.UPTIME_ATTEMPTS, 3),
    retryDelayMs: num(env.UPTIME_RETRY_DELAY_MS, 20_000),
    timeoutMs: num(env.UPTIME_TIMEOUT_MS, 15_000),
    fetchImpl,
    ...(clock ? { clock } : {}),
  };
  const real = probes ?? DEFAULT_PROBES;
  const selfProbe = selftest ? [{ ...SELFTEST_PROBE, ...(env.UPTIME_SELFTEST_URL ? { url: env.UPTIME_SELFTEST_URL } : {}) }] : [];
  const all = await Promise.all([...real, ...selfProbe].map((p) => probeOnce(p, opts)));
  const results = all.slice(0, real.length);
  const selfResults = all.slice(real.length);
  for (const r of all) {
    for (const a of r.tries) log(formatAttempt(r.name, a));
    log(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail} (status ${r.status ?? "none"}, ${r.attempts} attempt(s))`);
  }
  const allOk = results.every((r) => r.ok);
  const downText = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`).join("; ");
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : "";

  const webhook = (env.OPS_ALERT_WEBHOOK_URL ?? "").trim();
  const hook = await checkWebhook(webhook, { fetchImpl });
  let outcome;
  let notified = "none";
  let previous = { outcome: "UNKNOWN", via: "not read" };

  if (!allOk) log(`::error title=PROOVRA down::${downText}`);
  if (hook.state === "missing") {
    log("::error title=OPS_ALERT_WEBHOOK_URL missing::The repository secret OPS_ALERT_WEBHOOK_URL is not set, so this uptime check cannot notify anyone. Add it under Settings > Secrets and variables > Actions. This is a monitor configuration failure; production state is in the probe lines and the job summary.");
    outcome = selftest ? "SELFTEST" : "CONFIG_MISSING";
    notified = "impossible (no webhook)";
  } else if (hook.state === "invalid") {
    log(`::error title=OPS_ALERT_WEBHOOK_URL invalid::The repository secret OPS_ALERT_WEBHOOK_URL is set but unusable: ${hook.reason}. Replace it under Settings > Secrets and variables > Actions. This is a monitor configuration failure; production state is in the probe lines and the job summary.`);
    outcome = selftest ? "SELFTEST" : "CONFIG_INVALID";
    notified = "impossible (webhook invalid)";
  } else if (selftest) {
    const selfFailed = selfResults.every((r) => !r.ok);
    const msgs = [buildMessage("down", selfResults, runUrl, { test: true }), buildMessage("recovered", results, runUrl, { test: true })];
    const sent = [];
    for (const m of msgs) sent.push(await postNotification(webhook, m, { fetchImpl }));
    notified = `[TEST] down ${sent[0].ok ? "sent" : "FAILED"}, [TEST] recovered ${sent[1].ok ? "sent" : "FAILED"}`;
    log(`notification: ${notified}`);
    if (!selfFailed) log("::error title=Uptime self-test invalid::the deliberately failing self-test probe passed");
    if (!sent.every((s) => s.ok)) log("::error title=Uptime notification failed::The webhook did not accept the [TEST] notification.");
    outcome = "SELFTEST";
    if (!selfFailed || !sent.every((s) => s.ok)) notified += " (self-test FAILED)";
  } else {
    if (hook.state === "unverified") log(`::warning title=Uptime webhook check inconclusive::${hook.reason}`);
    previous = await previousOutcome({
      repo: env.GITHUB_REPOSITORY,
      workflowFile: env.UPTIME_WORKFLOW_FILE || "uptime.yml",
      branch: env.UPTIME_BRANCH || "",
      token: env.GITHUB_TOKEN,
      currentRunId: env.GITHUB_RUN_ID,
      apiBase: env.GITHUB_API_URL || "https://api.github.com",
      fetchImpl,
    });
    log(`previous outcome: ${previous.outcome} (${previous.via})`);
    const kind = decideNotification(previous.outcome, allOk);
    if (kind) {
      const sent = await postNotification(webhook, buildMessage(kind, results, runUrl), { fetchImpl });
      notified = `${kind} ${sent.ok ? "sent" : "FAILED"} (status ${sent.status ?? "none"})`;
      log(`notification ${notified}`);
      if (!sent.ok) {
        log("::error title=Uptime notification failed::The webhook did not accept the notification.");
        outcome = "NOTIFY_FAILED";
      }
    } else {
      notified = allOk ? "none (still up)" : "none (already reported down by an earlier run)";
      log(`notification: ${notified}`);
    }
    outcome ??= allOk ? "UP" : "DOWN";
  }

  log(`uptime-outcome: ${outcome}`);
  log(`::notice title=${OUTCOME_TITLE}: ${outcome}::${allOk ? "all probes passed" : downText}${outcome === "CONFIG_MISSING" ? " (monitor not configured)" : outcome === "CONFIG_INVALID" ? " (alert destination invalid)" : ""}`);
  log(`webhook check: ${hook.state} (${hook.reason})`);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown({ outcome, results: all, previous, notified, selftest }));
    } catch {
      /* best effort */
    }
  }
  if (outcome === "SELFTEST") return allOk && !/FAILED/.test(notified) && (hook.state === "ok" || hook.state === "unverified") ? 0 : 1;
  return outcome === "UP" ? 0 : 1;
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
