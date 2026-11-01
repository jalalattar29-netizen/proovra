/**
 * THE CASE EXPORT STREAM (EVID-006).
 *
 * The route used to await `archive.finalize()` before handing the archive to
 * the response. archiver resolves finalize on the engine's `end`, and with no
 * consumer attached backpressure stops that event, so any export larger than
 * the stream buffer hung with its S3 streams open. An error handler that threw
 * inside the emitter could end the API process, and custody already said every
 * report had been downloaded.
 *
 * ORDER. The consumer is attached first. Sources are opened one at a time, so a
 * large case holds one storage stream rather than one per report.
 *
 * FAILURE. A storage error or a client that goes away ends this response: the
 * archive is aborted, every source is closed and the socket is destroyed, so
 * the client sees a broken download and never a ZIP that looks complete.
 *
 * WHAT HAPPENED. Exactly one of `onDelivered` and `onFailed` runs. Delivered
 * means every byte reached the socket: only then may a caller claim a download.
 */
import type { FastifyReply } from "fastify";
import type { Readable } from "node:stream";
import archiver from "archiver";

export type CaseExportEntry = {
  name: string;
  open: () => Promise<NodeJS.ReadableStream>;
};

export function streamCaseExport(input: {
  reply: FastifyReply;
  manifestJson: string;
  entries: readonly CaseExportEntry[];
  onDelivered: () => Promise<void>;
  onFailed: (reason: string) => Promise<void>;
}): FastifyReply {
  const { reply } = input;
  const archive = archiver("zip", { zlib: { level: 9 } });
  let settled = false;
  let current: (NodeJS.ReadableStream & { destroy?: (err?: Error) => void }) | null = null;

  const settle = (run: () => Promise<void>) => {
    if (settled) return false;
    settled = true;
    // The response has already gone: a failed record is logged, never thrown.
    void run().catch((err) => reply.log.error({ err }, "case_export.outcome_not_recorded"));
    return true;
  };
  const fail = (reason: string, err?: unknown) => {
    if (!settle(() => input.onFailed(reason))) return;
    reply.log.warn({ reason, err }, "case_export.aborted");
    current?.destroy?.();
    archive.abort();
    reply.raw.destroy();
  };

  archive.on("error", (err) => fail("archive_error", err));
  archive.on("warning", (err) => fail("archive_warning", err));
  reply.raw.once("finish", () => settle(input.onDelivered));
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) fail("client_disconnected");
  });

  void reply.send(archive);

  /** archiver takes one entry at a time and says when each is written. */
  const written = () => new Promise<void>((resolve) => archive.once("entry", () => resolve()));

  void (async () => {
    const manifest = written();
    archive.append(input.manifestJson, { name: "manifest.json" });
    await manifest;
    for (const entry of input.entries) {
      if (settled) return;
      const source = await entry.open();
      current = source;
      source.once("error", (err) => fail("storage_read_failed", err));
      const entryWritten = written();
      archive.append(source as unknown as Readable, { name: entry.name });
      await entryWritten;
    }
    current = null;
    if (!settled) await archive.finalize();
  })().catch((err) => fail("storage_read_failed", err));

  return reply;
}
