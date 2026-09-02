/**
 * A GUARD THAT ALREADY REPLIED MUST NOT BE FOLLOWED BY ANOTHER ONE.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * `requireAuth` REPLIES on failure rather than throwing. Two call sites ran a
 * second guard straight afterwards:
 *
 *     await requireAuth(req, reply);
 *     await requireLegalAcceptance(req, reply);   // runs even after a 401
 *
 * The second guard finds no `req.user`, sends its own 401, and Fastify raises
 * FST_ERR_REP_ALREADY_SENT — logged at ERROR level. Seen live: a token
 * invalidated by an API restart turned every poll of `/v1/me/inbox/summary`
 * into an internal-error log entry:
 *
 *     Reply was already sent, did you forget to "return reply" in
 *     "/v1/me/inbox/summary?workspaceId=…" (GET)?
 *
 * The client saw a correct 401 either way, which is why this survived: nothing
 * user-visible broke. What broke was the error log, and a log that fills with
 * errors that are not errors is a log nobody reads during the incident that
 * matters.
 *
 * ===========================================================================
 * WHY A SCAN RATHER THAN TWO FIXES
 * ===========================================================================
 * `if (reply.sent) return;` was already the idiom in this codebase —
 * require-platform-admin, ai, billing, cases, enterprise, evidence and
 * organizations all use it. Two files missed it. A convention that is followed
 * almost everywhere is exactly the kind that gets missed again, so it is
 * checked rather than remembered.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Comments are BLANKED IN PLACE, not deleted.
 *
 * Deleting them shifts every following line, and a finding then names a line
 * number that points at unrelated code — which cost a round trip here before
 * the numbers were checked against the file.
 */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^(\s*)\/\/.*$/gm, (_m, s: string) => s);
}

const GUARD = /await\s+require[A-Za-z]*\s*\(\s*req\w*\s*,\s*reply\w*/;

describe("no guard runs after another guard may have replied", () => {
  it("finds no unguarded consecutive guard calls", () => {
    const hits: string[] = [];

    for (const file of tsFiles(SRC)) {
      const lines = blankComments(readFileSync(file, "utf8")).split("\n");

      for (let i = 0; i < lines.length; i += 1) {
        if (!GUARD.test(lines[i])) continue;
        // A ternary runs exactly one branch, so it is not this shape.
        if (/\?\s*await|:\s*await/.test(lines[i])) continue;

        for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
          if (/reply\w*\.sent/.test(lines[j])) break;
          if (/^\s*$/.test(lines[j])) continue;
          if (GUARD.test(lines[j])) {
            hits.push(
              `${relative(SRC, file).split("\\").join("/")}:${i + 1}→${j + 1}  ` +
                `${lines[i].trim()}  THEN  ${lines[j].trim()}`,
            );
          }
          break; // only the next line of code matters
        }
      }
    }

    expect(
      hits,
      "each of these must check `if (reply.sent) return;` between the two guards",
    ).toEqual([]);
  });

  it("the two sites that had the defect now carry the check", () => {
    for (const rel of [
      "routes/me-inbox.routes.ts",
      "routes/organization-domains.routes.ts",
    ]) {
      const src = blankComments(readFileSync(resolve(SRC, rel), "utf8"));
      const fn = src.slice(src.indexOf("async function requireAuthAndLegal"));
      expect(fn.slice(0, 400), `${rel} lost its guard`).toMatch(
        /if \(reply\.sent\) return;/,
      );
    }
  });
});
