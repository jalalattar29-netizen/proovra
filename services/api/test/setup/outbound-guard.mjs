/**
 * PHASE 12 — POINT 7 CORRECTIVE PASS: the outbound-network deny guard.
 *
 * WHY THIS EXISTS, AND WHY IT IS A SOCKET GUARD RATHER THAN AN ENV CHECK
 * ---------------------------------------------------------------------------
 * The first Point-7 run reported "Production was never contacted". That claim
 * was verified for the BROWSER, by watching what the page requested, and it was
 * true there. It was never verified for the vitest processes, and for those it
 * was false: `services/api/src/db.ts` opens with `import "dotenv/config"`, so
 * every test process that touches the database also loads `services/api/.env` —
 * which on this machine carries the production Sentry DSN, an Upstash Redis
 * URL, the production evidence bucket, live AWS/KMS, Stripe, Resend, PayPal and
 * OpenAI credentials. `dotenv` does not overwrite variables that are already
 * set, so the previous run's safety depended entirely on having remembered to
 * set each one. Two Sentry issues are the proof that the memory was incomplete,
 * and the startup object-lock verifier reached the production bucket for the
 * same reason.
 *
 * An env allowlist alone cannot fix that, because it fails the same way: it is
 * a list somebody has to keep complete. A socket guard does not care how a
 * destination was configured. Every outbound client in this stack — pg,
 * ioredis, undici/fetch, http/https, the AWS SDK, the Sentry transport —
 * ultimately calls `net.Socket.prototype.connect`, and TLS wraps the same
 * socket. So one interception point covers all of them, and anything that does
 * reach out announces itself.
 *
 * FAIL LOUD, NOT QUIET
 * ---------------------------------------------------------------------------
 * A denied destination THROWS. It is not silently dropped: a test that would
 * have contacted a production service must fail, visibly, naming the host — not
 * pass while quietly having its request eaten.
 */

import net from "node:net";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Hosts that are always local. */
const LOOPBACK = new Set([
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "localhost",
  "::ffff:127.0.0.1",
]);

/**
 * Additional destinations this run explicitly started.
 *
 * Supplied as `P7_ALLOWED_HOSTS` (comma-separated). Deliberately NOT a
 * wildcard: "the disposable services I started" is a list of three, and it is
 * the operator's job to say which three.
 */
function extraAllowed() {
  return new Set(
    (process.env.P7_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Where the attempted-destination ledger is written. */
const LEDGER = process.env.P7_NETWORK_LEDGER ?? "";

function record(entry) {
  if (!LEDGER) return;
  try {
    mkdirSync(dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // The ledger is evidence, not a dependency. A run must not fail because
    // the evidence file could not be appended to — the guard itself still
    // denies, which is the safety property.
  }
}

function isAllowed(host) {
  if (!host) return true; // a unix socket or an already-connected handle
  const h = String(host).toLowerCase();
  if (LOOPBACK.has(h)) return true;
  if (h.endsWith(".localhost")) return true;
  return extraAllowed().has(h);
}

let installed = false;

export function installOutboundGuard() {
  if (installed) return;
  // PHASE 12 — POINT 7 (final pass): DEFER to the `--import` preload.
  //
  // This module predates the preload. Once the preload existed there were two
  // guards recording to one file in two different shapes, and the ledger — the
  // artifact the closure gate reasons about — became unreadable: entries with
  // no `runId`, no `phase` and no `category`, including `host: "null"` and the
  // testcontainers port, which the gate then had to treat as unclassified
  // external traffic.
  //
  // The preload installs the same four interceptions (fetch, http, https, raw
  // sockets) strictly earlier, so deferring loses no coverage and leaves ONE
  // recorder. If the preload is absent — a process started without
  // `NODE_OPTIONS` — this guard still installs and is still the safety net.
  if (globalThis.__point7GuardInstalled) {
    installed = true;
    return;
  }
  installed = true;

  const originalConnect = net.Socket.prototype.connect;

  net.Socket.prototype.connect = function guardedConnect(...args) {
    // `connect` has three shapes: (options[, cb]), (port[, host][, cb]) and
    // (path[, cb]). Only the first two can name a remote host.
    let host = null;
    let port = null;
    const first = args[0];
    if (first && typeof first === "object") {
      if (typeof first.path === "string") {
        // Unix domain socket / named pipe — never remote.
        return originalConnect.apply(this, args);
      }
      host = first.host ?? null;
      port = first.port ?? null;
    } else if (typeof first === "number" || typeof first === "string") {
      port = first;
      host = typeof args[1] === "string" ? args[1] : "localhost";
    }

    const scenario = process.env.P7_SCENARIO ?? "";
    const proc = process.env.P7_PROCESS ?? "node";

    if (!isAllowed(host)) {
      record({
        outcome: "DENIED",
        host: String(host),
        port: port ?? null,
        process: proc,
        scenario,
        atUtc: new Date().toISOString(),
        // Opt-in origin capture. Off by default: a stack in an evidence file
        // is a place absolute paths accumulate, and the ledger's job is to say
        // WHICH destinations were attempted, not to be a debugger.
        stack:
          process.env.P7_GUARD_STACKS === "1"
            ? new Error("origin").stack?.split("\n").slice(1, 10).join(" | ")
            : undefined,
      });
      const err = new Error(
        `POINT7_OUTBOUND_DENIED: refused a connection to "${host}:${port}". ` +
          "Local runs may only reach loopback and the disposable services " +
          "listed in P7_ALLOWED_HOSTS. This is the guard that would have " +
          "caught the production Sentry, S3 and Redis contact in the first " +
          "Point-7 run.",
      );
      err.code = "POINT7_OUTBOUND_DENIED";
      throw err;
    }

    record({
      outcome: "ALLOWED",
      host: String(host),
      port: port ?? null,
      process: proc,
      scenario,
      atUtc: new Date().toISOString(),
    });
    return originalConnect.apply(this, args);
  };
}

// Importing this module installs the guard. That is the point: it is used as a
// `--import` preload for the API and worker processes and as a vitest setup
// file, and in both cases it has to be active before the first client is
// constructed.
installOutboundGuard();
