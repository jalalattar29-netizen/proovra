/**
 * AUD-0002 — graceful shutdown closes every worker it registered and every
 * queue handle it holds. The redaction-derivative worker and queue and the
 * media-intelligence DLQ queue were registered at start-up and never closed.
 *
 * Read from the source so a new worker or queue cannot be added without its
 * close: every `safeRegisterWorker` result and every imported `…Queue` handle
 * must appear in `shutdown()`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/index.ts"), "utf8");
const SHUTDOWN = SRC.slice(SRC.indexOf("async function shutdown("));

describe("AUD-0002 — shutdown closes every registered worker and queue", () => {
  it("every safeRegisterWorker result is closed", () => {
    const workers = [...SRC.matchAll(/const (\w+) = safeRegisterWorker\(/g)].map((m) => m[1]!);
    expect(workers.length).toBeGreaterThan(0);
    const missing = workers.filter(
      (w) => !new RegExp(`\\b${w}\\b\\]\\s*as const|\\b${w}\\??\\.close\\(`).test(SHUTDOWN),
    );
    expect(missing).toEqual([]);
  });

  it("every imported queue handle is closed", () => {
    const imported = new Set<string>();
    for (const block of SRC.matchAll(/import \{([^}]*)\} from "\.\/[^"]*queue[^"]*"/g)) {
      for (const raw of block[1]!.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
        if (/Queue$/.test(name)) imported.add(name);
      }
    }
    expect(imported.size).toBeGreaterThan(0);
    const missing = [...imported].filter((q) => !new RegExp(`\\b${q}\\.close\\(`).test(SHUTDOWN));
    expect(missing).toEqual([]);
  });
});

describe("AUD-0001 — archive restore is not coupled to the trash-grace switch", () => {
  it("restore has its own switch and is not behind the trash-grace one", () => {
    expect(SRC).toContain('const archiveRestoreEnabled = envBoolean("ARCHIVE_RESTORE_ENABLED", true);');
    const launcher = SRC.slice(SRC.indexOf("function startTrashGraceReconcilerScheduler()"));
    const body = launcher.slice(0, launcher.indexOf("\n}\n"));
    // No early return: the trash-grace switch cannot skip what follows it.
    expect(body).not.toMatch(/if \(!trashGraceReconcilerEnabled\)\s*\{[^}]*return;/);
    expect(body).toMatch(/if \(archiveRestoreEnabled\) \{\s*archiveRestoreTimer = setInterval/);
  });
});
