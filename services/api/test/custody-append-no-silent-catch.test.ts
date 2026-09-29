/**
 * ET-CUS-11 — no custody append may fail silently.
 *
 * A material mutation appends its custody event in the SAME transaction
 * (appendCustodyEventTx), or — for a non-mutating fact such as a refused
 * attempt or an access — through a handler that logs, counts and reports the
 * failure (noteCustodyFailure / swallowCustodyAppendError). A bare
 * `.catch(() => null)` / `.catch(() => undefined)` / `.catch(() => {})` left
 * the mutation done and the chain missing it with no signal anywhere.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TREES = ["services/api/src", "services/worker/src", "packages/shared-runtime/src"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Every appendCustodyEvent(...) call immediately followed by a silent catch. */
export function silentCustodyCatches(files: Array<{ path: string; source: string }>): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const s = f.source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
    let i = 0;
    while ((i = s.indexOf("appendCustodyEvent(", i)) >= 0) {
      let depth = 0;
      let j = i + "appendCustodyEvent".length;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      if (/^\s*\.catch\(\s*\(\s*\)\s*=>\s*(null|undefined|\{\s*\})\s*\)/.test(s.slice(j + 1, j + 80))) {
        hits.push(`${f.path}:${s.slice(0, i).split("\n").length}`);
      }
      i = j;
    }
    // ET-CUS-13: the same silence spelled as try { appendCustodyEvent(...) } catch {}.
    const tryRe = /\btry\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = tryRe.exec(s)) !== null) {
      let depth = 0;
      let k = m.index + m[0].length - 1;
      for (; k < s.length; k++) {
        if (s[k] === "{") depth++;
        else if (s[k] === "}" && --depth === 0) break;
      }
      const tryBody = s.slice(m.index, k + 1);
      const after = s.slice(k + 1, k + 120);
      if (/appendCustodyEvent\(/.test(tryBody) && /^\s*catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/.test(after)) {
        hits.push(`${f.path}:${s.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  return hits;
}

describe("custody appends never fail silently", () => {
  const files = TREES.flatMap((t) => walk(join(ROOT, t))).map((p) => ({
    path: relative(ROOT, p).replace(/\\/g, "/"),
    source: readFileSync(p, "utf8"),
  }));

  it("no appendCustodyEvent(...) ends in a silent catch", () => {
    expect(silentCustodyCatches(files)).toEqual([]);
  });

  it("negative control: the detector finds each silent form, and ignores observable handlers", () => {
    expect(
      silentCustodyCatches([
        { path: "a.ts", source: "await appendCustodyEvent({ x: f(1) }).catch(() => null);" },
        { path: "b.ts", source: "void appendCustodyEvent({}).catch(() => undefined);" },
        { path: "c.ts", source: "appendCustodyEvent({}).catch(() => {});" },
        { path: "d.ts", source: "await appendCustodyEvent({}).catch(noteCustodyFailure);" },
        { path: "e.ts", source: "await appendCustodyEvent({}).catch((err) => swallowCustodyAppendError(err, {}));" },
        { path: "f.ts", source: "try {\n  await appendCustodyEvent({});\n} catch {\n  /* quiet */\n}" },
        { path: "g.ts", source: "try {\n  await appendCustodyEvent({});\n} catch (err) {\n  noteCustodyFailure(err);\n}" },
      ]),
    ).toEqual(["a.ts:1", "b.ts:1", "c.ts:1", "f.ts:1"]);
  });
});
