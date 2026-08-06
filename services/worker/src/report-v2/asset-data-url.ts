// D:\digital-witness\services\worker\src\report-v2\asset-data-url.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * PHASE 12 POINT 5 — assets are located relative to THIS MODULE, not the cwd.
 *
 * Both candidate paths used to start at `process.cwd()`, which quietly made
 * the report renderer depend on the working directory a process happened to
 * be launched from. `sections/cover.ts` calls `reportAssetDataUrl` at module
 * scope, so the failure is an IMPORT-time throw: any entry point started from
 * a directory other than `services/worker` — a monorepo script, a container
 * whose WORKDIR is the repo root, a test importing the processor — cannot
 * load the processor module at all, and the error names a missing PNG rather
 * than the actual cause.
 *
 * The module's own directory is stable under every launcher, and holds both
 * the compiled and the source asset directories. The cwd candidates are kept
 * LAST so any existing deployment that relied on them still resolves.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function resolveReportAssetPath(fileName: string): string {
  const candidates = [
    // Alongside this module: `dist/report-v2/assets` when compiled,
    // `src/report-v2/assets` when running from source.
    path.resolve(HERE, "assets", fileName),
    // Source assets, reached from a compiled module in `dist/`.
    path.resolve(HERE, "../../src/report-v2/assets", fileName),
    path.resolve(process.cwd(), "dist/report-v2/assets", fileName),
    path.resolve(process.cwd(), "src/report-v2/assets", fileName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `[report-v2] Asset not found: ${fileName} (looked in ${candidates.join(", ")})`,
  );
}

export function reportAssetDataUrl(fileName: string): string {
  const filePath = resolveReportAssetPath(fileName);
  const ext = path.extname(fileName).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const base64 = fs.readFileSync(filePath).toString("base64");

  return `data:${mime};base64,${base64}`;
}