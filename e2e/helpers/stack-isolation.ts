/**
 * NO ACCOUNT IS CREATED AGAINST A STACK THAT COULD REACH A LIVE SERVICE.
 *
 * 2026-10-22: a local mirror of this suite's stack inherited the developer's
 * repo-root `.env`, and every `createGuestSession` registration sent a real
 * verification email through PROOVRA's Resend account (and the stack made live
 * timestamp-authority calls). The API and worker now isolate themselves
 * whenever they carry a test-stack marker (`E2E_AUTH_BYPASS_SECRET`,
 * `PROOVRA_TEST_STACK=1`, or `PROOVRA_ENV=test`), and the API states the
 * isolation of itself AND of every live worker on `/health`.
 *
 * This is the suite's half of the contract, checked before EVERY registration
 * (one GET — so a worker started after the first check is still caught):
 *
 *   - the API is an isolated test stack that can only record email, never asks
 *     AWS Secrets Manager, read no `.env` file and holds no live credential;
 *   - at least one worker is live, and EVERY live worker reports the same.
 *
 * Anything else — including a /health that cannot be read — stops the run
 * before a single request could leave the machine. Fail closed.
 */

// The same base api-client.ts uses (it imports this module, so no import back).
const API_BASE = process.env.API_BASE ?? "http://localhost:8081";

type IsolationFacts = {
  isolated: boolean;
  markers: string[];
  emailTransport: string;
  secretsMode: string;
  envFilesLoaded: number;
  liveCredentialNames: string[];
};

type IsolationReport = IsolationFacts & {
  workers?: Array<{ workerId: string; isolation: IsolationFacts | null }>;
};

function factProblems(who: string, facts: IsolationFacts): string[] {
  const problems: string[] = [];
  if (facts.isolated !== true) problems.push(`${who} is not an isolated test stack`);
  if (facts.emailTransport !== "recording") problems.push(`${who}: email transport is "${facts.emailTransport}", not "recording"`);
  if (facts.secretsMode !== "disabled") problems.push(`${who}: AWS Secrets Manager mode is "${facts.secretsMode}", not "disabled"`);
  if (facts.envFilesLoaded !== 0) problems.push(`${who} loaded ${facts.envFilesLoaded} .env file(s)`);
  if ((facts.liveCredentialNames ?? []).length > 0) {
    problems.push(`${who}: live-service credentials are present: ${facts.liveCredentialNames.join(", ")}`);
  }
  return problems;
}

export function isolationProblems(report: IsolationReport | undefined): string[] {
  if (!report) return ["the API reports no test-stack isolation (start it with PROOVRA_TEST_STACK=1)"];
  const problems = factProblems("the API", report);
  const workers = report.workers;
  if (!Array.isArray(workers)) {
    problems.push("the API does not report its workers' isolation");
  } else if (workers.length === 0) {
    problems.push("no live worker — start the worker with PROOVRA_TEST_STACK=1 before registering accounts");
  } else {
    for (const w of workers) {
      if (!w.isolation) problems.push(`worker ${w.workerId} reports no test-stack isolation (start it with PROOVRA_TEST_STACK=1)`);
      else problems.push(...factProblems(`worker ${w.workerId}`, w.isolation));
    }
  }
  return problems;
}

/** Resolves when the stack — API and every live worker — is proven isolated; rejects otherwise. */
export async function assertIsolatedStack(): Promise<void> {
  let body: { isolation?: IsolationReport };
  try {
    const res = await fetch(`${API_BASE}/health`);
    body = (await res.json()) as { isolation?: IsolationReport };
  } catch (err) {
    throw new Error(`E2E isolation preflight: cannot read ${API_BASE}/health (${String(err)}) — refusing to register accounts`);
  }
  const problems = isolationProblems(body.isolation);
  if (problems.length > 0) {
    throw new Error(
      "E2E isolation preflight FAILED — refusing to register accounts against a stack that could reach live services:\n  - " +
        problems.join("\n  - "),
    );
  }
}
