/**
 * Deterministic fixture server for the UC-1 browser E2E. Serves the pages under
 * e2e/fixtures on a fixed localhost port. No network dependency; every page is
 * static and reproducible.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "fixtures");
const PORT = Number(process.env.FIXTURE_PORT ?? 4599);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    let name = url.pathname === "/" ? "/index" : url.pathname;
    if (!name.endsWith(".html")) name += ".html";
    const file = normalize(join(ROOT, name));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`fixture server on http://127.0.0.1:${PORT}`);
});
