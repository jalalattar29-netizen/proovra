/**
 * ET-OTS-04 / ET-OTS-05 — what `createOpenTimestamp` may claim at
 * initialization.
 *
 * On a40ca76f:
 *   ET-OTS-04 — any error from `ots stamp` (timeout, DNS, calendar 5xx, missing
 *     binary) was RETURNED as status FAILED with the raw error text as the
 *     reason; the initializer persisted it as a per-record integrity failure
 *     that nothing retried, and that text reached public Verify.
 *   ET-OTS-05 — upgrade output containing "timestamp complete" or "bitcoin
 *     transaction" was promoted to ANCHORED with no hash or attestation check.
 *
 * `ots` is simulated at the execFile boundary: the stamp writes the proof file
 * exactly as the real client does.
 */
import { writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sim = vi.hoisted(() => ({
  stamp: "ok" as "ok" | "timeout" | "missing",
  upgradeStdout: "",
  upgradeFails: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    execFile: (
      _bin: string,
      args: string[],
      _opts: unknown,
      cb: (err: unknown, out?: { stdout: string; stderr: string }) => void,
    ) => {
      if (args[0] === "stamp") {
        if (sim.stamp === "timeout") return cb(Object.assign(new Error("Command failed: ots stamp -c https://calendar /tmp/ots-abc/fingerprint-x.json\nTimed out"), { killed: true }));
        if (sim.stamp === "missing") return cb(Object.assign(new Error("spawn ots ENOENT: ots not found"), { code: "ENOENT" }));
        writeFileSync(`${args[args.length - 1]}.ots`, Buffer.from("proof-bytes"));
        return cb(null, { stdout: "", stderr: "Submitting to remote calendar" });
      }
      if (args[0] === "upgrade") {
        if (sim.upgradeFails) return cb(new Error("Command failed: ots upgrade: calendar 503"));
        return cb(null, { stdout: sim.upgradeStdout, stderr: "" });
      }
      return cb(new Error(`unexpected ots ${args[0]}`));
    },
  };
});

const { createOpenTimestamp, OtsStampCallFailed } = await import("../src/ots.service.js");

const TXID = "a".repeat(64);
const content = Buffer.from('{"v":1}', "utf8");

describe("OTS initialization (ET-OTS-04 / ET-OTS-05)", () => {
  const saved = process.env.OTS_ENABLED;
  beforeEach(() => {
    process.env.OTS_ENABLED = "true";
    sim.stamp = "ok";
    sim.upgradeStdout = "";
    sim.upgradeFails = false;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OTS_ENABLED;
    else process.env.OTS_ENABLED = saved;
  });

  it("ET-OTS-04: a stamp-call timeout is THROWN (bounded code), never returned as a FAILED record", async () => {
    sim.stamp = "timeout";
    const err = await createOpenTimestamp({ content }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OtsStampCallFailed);
    expect((err as InstanceType<typeof OtsStampCallFailed>).code).toBe("stamp_call_failed");
    expect((err as Error).message).toBe("ots_stamp_call_failed");
  });

  it("ET-OTS-04: a missing binary is thrown as binary_missing", async () => {
    sim.stamp = "missing";
    const err = await createOpenTimestamp({ content }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof OtsStampCallFailed>).code).toBe("binary_missing");
  });

  it("ET-OTS-05: 'timestamp complete' + a Bitcoin transaction at init is PENDING with no txid", async () => {
    sim.upgradeStdout = `Success! Timestamp complete\nBitcoin transaction: ${TXID}`;
    const r = await createOpenTimestamp({ content });
    expect(r.status).toBe("PENDING");
    expect(r.bitcoinTxid).toBeNull();
    expect(r.anchoredAtUtc).toBeNull();
    expect(r.proofBase64).toBe(Buffer.from("proof-bytes").toString("base64"));
  });

  it("ET-OTS-04: a failed first upgrade after a successful stamp is PENDING, not FAILED", async () => {
    sim.upgradeFails = true;
    const r = await createOpenTimestamp({ content });
    expect(r.status).toBe("PENDING");
    expect(r.proofBase64).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain("calendar 503");
  });
});
