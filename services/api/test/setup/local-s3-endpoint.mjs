/**
 * The disposable object store's loopback endpoint.
 *
 * The HOST is fixed to 127.0.0.1 — that is the isolation property. Only the
 * PORT is selectable (`P7_HOST_S3_PORT`, default 59000), for the reason the
 * Point-7 runner already gives for Redis: on a Windows host a port can fall
 * inside a dynamic TCP exclusion range where every process gets EACCES, and
 * the proof could then not run on that machine at all. Invalid input is a hard
 * stop, never a silent fallback.
 *
 * Side-effect free: imported by the preload, the vitest setup and the canary.
 */
export function localS3Endpoint() {
  const raw = process.env.P7_HOST_S3_PORT;
  if (raw === undefined || raw.trim() === "") return "http://127.0.0.1:59000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `P7_HOST_S3_PORT must be a whole TCP port between 1 and 65535; received ${JSON.stringify(raw)}`,
    );
  }
  return `http://127.0.0.1:${port}`;
}
