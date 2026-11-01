/**
 * EVID-006 — the case export stream, on a real socket with incompressible data.
 *
 * The defect only appears past the stream buffer, so these payloads are random
 * and above the measured threshold. A storage failure and a departed client
 * must end the response, leave the process alive, and never claim a download.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { streamCaseExport, type CaseExportEntry } from "../src/services/cases/case-export-stream.js";

const MiB = 1024 * 1024;

async function serve(entries: readonly CaseExportEntry[]) {
  const outcome = { delivered: 0, failed: [] as string[] };
  const app: FastifyInstance = Fastify();
  app.get("/export", (_req, reply) =>
    streamCaseExport({
      reply,
      manifestJson: JSON.stringify({ ok: true }),
      entries,
      onDelivered: async () => {
        outcome.delivered += 1;
      },
      onFailed: async (reason) => {
        outcome.failed.push(reason);
      },
    }),
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, outcome, port: (app.server.address() as AddressInfo).port };
}

/** Reads the whole response; resolves `aborted` when the server cuts it short. */
function fetchAll(port: number, onChunk?: (req: http.ClientRequest, bytes: number) => void) {
  return new Promise<{ status: number; bytes: number; aborted: boolean }>((resolve) => {
    const req = http.get({ port, host: "127.0.0.1", path: "/export" }, (res) => {
      let bytes = 0;
      res.on("data", (b: Buffer) => {
        bytes += b.length;
        onChunk?.(req, bytes);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, bytes, aborted: !res.complete }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, bytes, aborted: true }));
      res.on("close", () => resolve({ status: res.statusCode ?? 0, bytes, aborted: !res.complete }));
    });
    req.on("error", () => resolve({ status: 0, bytes: 0, aborted: true }));
  });
}

async function settled(outcome: { delivered: number; failed: string[] }) {
  await vi.waitFor(() => expect(outcome.delivered + outcome.failed.length).toBeGreaterThan(0));
}

describe("case export stream", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("delivers an export far past the buffer, and only then reports delivery", async () => {
    const entries = [0, 1, 2].map((i) => ({
      name: `reports/${i}.pdf`,
      open: async () => Readable.from([randomBytes(3 * MiB)]),
    }));
    const served = await serve(entries);
    app = served.app;
    expect(served.outcome.delivered).toBe(0);
    const res = await fetchAll(served.port);
    expect(res.status).toBe(200);
    expect(res.aborted).toBe(false);
    expect(res.bytes).toBeGreaterThan(9 * MiB);
    await settled(served.outcome);
    expect(served.outcome).toEqual({ delivered: 1, failed: [] });
  });

  it("opens sources one at a time, so a case holds one storage stream", async () => {
    let open = 0;
    let peak = 0;
    const entries = [0, 1, 2, 3].map((i) => ({
      name: `reports/${i}.pdf`,
      open: async () => {
        open += 1;
        peak = Math.max(peak, open);
        const s = Readable.from([randomBytes(MiB)]);
        s.once("close", () => {
          open -= 1;
        });
        return s;
      },
    }));
    const served = await serve(entries);
    app = served.app;
    await fetchAll(served.port);
    await settled(served.outcome);
    expect(peak).toBe(1);
  });

  it("a storage read that fails midway breaks the download, keeps the process alive and claims nothing", async () => {
    const entries = [
      { name: "reports/good.pdf", open: async () => Readable.from([randomBytes(3 * MiB)]) },
      {
        name: "reports/bad.pdf",
        open: async () => {
          const s = new PassThrough();
          s.write(randomBytes(MiB));
          setTimeout(() => s.destroy(new Error("InternalError: S3 read failed")), 20);
          return s;
        },
      },
    ];
    const served = await serve(entries);
    app = served.app;
    const res = await fetchAll(served.port);
    expect(res.aborted).toBe(true);
    await settled(served.outcome);
    expect(served.outcome).toEqual({ delivered: 0, failed: ["storage_read_failed"] });
    // The server still answers.
    const again = await served.app.inject({ method: "GET", url: "/missing" });
    expect(again.statusCode).toBe(404);
  });

  it("a source that cannot be opened ends the response the same way", async () => {
    const served = await serve([
      {
        name: "reports/gone.pdf",
        open: async () => {
          throw new Error("NoSuchKey");
        },
      },
    ]);
    app = served.app;
    const res = await fetchAll(served.port);
    expect(res.aborted).toBe(true);
    await settled(served.outcome);
    expect(served.outcome.delivered).toBe(0);
    expect(served.outcome.failed).toEqual(["storage_read_failed"]);
  });

  it("a client that leaves is not a delivery, and the source is released", async () => {
    let released = false;
    const served = await serve([
      {
        name: "reports/big.pdf",
        open: async () => {
          const s = new PassThrough();
          s.on("close", () => {
            released = true;
          });
          s.write(randomBytes(4 * MiB));
          return s;
        },
      },
    ]);
    app = served.app;
    // Past the manifest, so the report's source is open when the client goes.
    await fetchAll(served.port, (req, bytes) => {
      if (bytes > MiB) req.destroy();
    });
    await settled(served.outcome);
    expect(served.outcome.delivered).toBe(0);
    expect(served.outcome.failed).toEqual(["client_disconnected"]);
    await vi.waitFor(() => expect(released).toBe(true));
  });
});
