/**
 * Helpers for the Free evidence/outputs journey. Read-only against Postgres
 * (counts and facts), except the one labelled fixture write the intake expiry
 * step makes. Every account here carries the `fev-` prefix.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, type Page } from "@playwright/test";

import { API_BASE, PASSWORD, type JourneyState, type Person } from "../lib/journey";

export const ROOT = resolve(__dirname, "..", "..", "..");
export const OUT_DIR = resolve(ROOT, ".p7tmp", "free-evidence-outputs");
const PG = `acc-${process.env.ACCEPT_STACK_INSTANCE ?? "fa"}-postgres`;

export function fev(s: JourneyState, key: string, name: string): Person {
  s.people[key] ??= { email: `fev-${key}-${s.runId}@free-evidence.example.test`, password: PASSWORD, name };
  return s.people[key]!;
}

/** One SQL statement through the stack's own Postgres container; rows of '|' separated text. */
export function sql(q: string): string[][] {
  const out = execFileSync("docker", ["exec", PG, "psql", "-U", "pv", "-d", "proovra_acceptance_fixture", "-v", "ON_ERROR_STOP=1", "-AtF", "|", "-c", q], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => l.split("|"));
}

export function userIdOf(email: string): string {
  const rows = sql(`select id from users where lower(email) = lower('${email.replace(/'/g, "''")}')`);
  expect(rows.length, `user ${email}`).toBe(1);
  return rows[0]![0]!;
}

export function personalTeamOf(userId: string): string {
  const rows = sql(`select id from teams where owner_user_id = '${userId}' and is_personal order by created_at limit 1`);
  expect(rows.length, `personal team of ${userId}`).toBe(1);
  return rows[0]![0]!;
}

export type Ledger = Record<string, number>;
const LEDGER_COLS = [
  "evidence_rows",
  "evidence_parts",
  "upload_sessions",
  "evidence_upload_sessions",
  "capture_sessions",
  "capture_sessions_open",
  "credit_ledger_rows",
  "credit_ledger_sum",
  "entitlement_usage_consumed",
  "checkout_attempts",
  "entitlement_credits",
  "verification_packages",
  "reports",
] as const;

/** Every row a capture, a reservation or a charge could leave for this person. */
export function ledger(userId: string, teamId: string): Ledger {
  const [row] = sql(`select
    (select count(*) from evidence where owner_user_id = '${userId}'),
    (select count(*) from evidence_parts p join evidence e on e.id = p.evidence_id where e.owner_user_id = '${userId}'),
    (select count(*) from upload_sessions where team_id = '${teamId}'),
    (select count(*) from evidence_upload_sessions where actor_user_id::text = '${userId}'),
    (select count(*) from capture_sessions where owner_user_id::text = '${userId}'),
    (select count(*) from capture_sessions where owner_user_id::text = '${userId}' and finalized_evidence_id is null and discarded_at_utc is null),
    (select count(*) from evidence_credit_ledger_entries where user_id::text = '${userId}'),
    (select coalesce(sum(credits_delta), 0) from evidence_credit_ledger_entries where user_id::text = '${userId}'),
    (select coalesce(sum(consumed), 0) from entitlement_usage where team_id = '${teamId}'),
    (select count(*) from billing_checkout_attempts where user_id::text = '${userId}'),
    (select coalesce(max(credits), 0) from entitlements where user_id::text = '${userId}'),
    (select count(*) from verification_packages vp join evidence e on e.id = vp.evidence_id where e.owner_user_id = '${userId}'),
    (select count(*) from reports r join evidence e on e.id = r.evidence_id where e.owner_user_id = '${userId}')`);
  const out: Ledger = {};
  LEDGER_COLS.forEach((c, i) => (out[c] = Number(row![i])));
  return out;
}

export type ApiAnswer = { status: number; json: any; text: string; headers: Record<string, string> };

/** A request from the signed-in page, as the web app makes it (cookie, Origin, x-web-client). */
export async function api(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiAnswer> {
  if (!page.url().startsWith("http")) await page.goto("/home");
  return page.evaluate(
    async ({ base, method, path, body, headers }) => {
      const r = await fetch(base + path, {
        method,
        credentials: "include",
        headers: { "x-web-client": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      const h: Record<string, string> = {};
      r.headers.forEach((v, k) => (h[k] = v));
      return { status: r.status, json, text: text.slice(0, 3000), headers: h };
    },
    { base: API_BASE, method, path, body, headers },
  );
}

/** The PERSONAL billing projection the shell meter, Home and Capture read. */
export async function personalProjection(page: Page): Promise<any> {
  const list = await api(page, "GET", "/v1/billing/accounts");
  expect(list.status, list.text).toBe(200);
  const personal = (list.json.accounts as Array<{ type: string; id: string }>).find((a) => a.type === "PERSONAL");
  expect(personal, list.text).toBeTruthy();
  const p = await api(page, "GET", `/v1/billing/accounts/PERSONAL/${personal!.id}`);
  expect(p.status, p.text).toBe(200);
  return p.json;
}

export function save(name: string, bytes: Buffer): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, name);
  writeFileSync(file, bytes);
  return file;
}

export function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

export function pdfText(file: string): { pages: number; text: string } {
  return JSON.parse(execFileSync(process.execPath, [resolve(__dirname, "extract.mjs"), "pdf", file], { encoding: "utf8", maxBuffer: 64 << 20 }));
}

export function zipContents(file: string): { entries: string[]; texts: Record<string, string> } {
  return JSON.parse(execFileSync(process.execPath, [resolve(__dirname, "extract.mjs"), "zip", file], { encoding: "utf8", maxBuffer: 64 << 20 }));
}

export function readBytes(file: string): Buffer {
  return readFileSync(file);
}

/** The operator CLI the runbook names, in the stack's allowlisted environment. */
export function stackTsx(args: string[]): string {
  return execFileSync(process.execPath, ["e2e/acceptance/stack.mjs", "tsx", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      APPDATA: process.env.APPDATA ?? "",
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
      USERPROFILE: process.env.USERPROFILE ?? "",
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
      ACCEPT_STACK_INSTANCE: process.env.ACCEPT_STACK_INSTANCE ?? "",
      ACCEPT_STACK_PORTS: process.env.ACCEPT_STACK_PORTS ?? "",
    },
  });
}
