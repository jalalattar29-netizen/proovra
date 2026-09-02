/**
 * RECORD EVERY OUTBOUND CONNECTION A PROCESS ATTEMPTS.
 *
 * Loaded with `--require` so it is installed before any application module
 * runs, which matters: `services/api/src/db.ts` and the storage client both
 * act at import time, and a hook installed later would miss exactly the calls
 * that caused this to be written.
 *
 * WHY THIS EXISTS
 * ---------------
 * "The environment has no production values in it" is an argument. "The
 * process opened no socket to anything but localhost" is a measurement. The
 * incident this guards against — a boot that read a private production S3
 * bucket — would have been caught by the measurement and was not caught by
 * anybody's reading of the configuration.
 *
 * It hooks the two places every client eventually goes through:
 *   * `net.Socket.prototype.connect` — every TCP client, including the AWS
 *     SDK, Prisma, ioredis and undici.
 *   * `dns.lookup` / `dns.promises.lookup` — a name resolved is an intent to
 *     connect, and catching it names the HOST rather than an IP, which is what
 *     a person reading the report needs.
 *
 * Output goes to the file named by PROOVRA_CONNECTION_LOG, one JSON object per
 * line, so the parent can read it after the child exits. Nothing is printed to
 * stdout: the child's stdout is the application's, and interleaving would make
 * both harder to read.
 */

const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");

const LOG = process.env.PROOVRA_CONNECTION_LOG;
if (LOG) {
  const LOCAL =
    /^(localhost|127\.0\.0\.1|::1|::ffff:127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)$/i;

  const record = (kind, host, port) => {
    try {
      fs.appendFileSync(
        LOG,
        JSON.stringify({
          kind,
          host: String(host ?? ""),
          port: port ?? null,
          local: LOCAL.test(String(host ?? "")),
          at: new Date().toISOString(),
        }) + "\n",
      );
    } catch {
      /* never let recording break the process being measured */
    }
  };

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    // connect(options[, cb]) | connect(port[, host][, cb]) | connect(path[, cb])
    const first = args[0];
    if (first && typeof first === "object") {
      if (first.host || first.port) record("tcp", first.host ?? "localhost", first.port);
    } else if (typeof first === "number") {
      record("tcp", typeof args[1] === "string" ? args[1] : "localhost", first);
    }
    return realConnect.apply(this, args);
  };

  const realLookup = dns.lookup;
  dns.lookup = function lookup(hostname, ...rest) {
    record("dns", hostname, null);
    return realLookup.call(this, hostname, ...rest);
  };
  if (dns.promises && dns.promises.lookup) {
    const realPromiseLookup = dns.promises.lookup;
    dns.promises.lookup = function lookup(hostname, ...rest) {
      record("dns", hostname, null);
      return realPromiseLookup.call(this, hostname, ...rest);
    };
  }
}
