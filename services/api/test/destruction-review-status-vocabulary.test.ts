/**
 * NO QUERY MAY ASK FOR A DESTRUCTION-REVIEW STATUS THAT CANNOT EXIST.
 *
 * `DestructionReview.status` is a `VARCHAR(16)`, not a database enum. A query
 * for a status nothing ever writes is therefore not an error — it is a count
 * of zero, returned instantly, forever, and zero is a perfectly plausible
 * number for a destruction queue.
 *
 * FIVE read sites across three services asked for `PROPOSED` and
 * `PENDING_APPROVAL`. Neither is in `DESTRUCTION_REVIEW_STATUSES`; creation
 * writes `PENDING`. So "Pending destruction reviews", "Retention candidates"
 * and the workspace-admin governance snapshot reported zero to every
 * workspace, always — and the LISTS behind two of those counts carried the
 * same dead status, so the surfaces agreed with each other and looked right.
 *
 * Nothing failed, nothing logged, and no test caught it, because every test
 * asserted the code called the query rather than that the query could match.
 * This is the guard that closes the class: it reads the source of every
 * service that queries destruction reviews and requires each literal status to
 * be one a writer can actually persist.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESTRUCTION_REVIEW_AWAITING_DECISION,
  DESTRUCTION_REVIEW_PROPOSED,
  DESTRUCTION_REVIEW_STATUSES,
} from "@proovra/shared";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Source with comments removed — a comment may legitimately name a dead value. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

describe("DESTRUCTION REVIEW — status vocabulary", () => {
  const canonical = new Set<string>(DESTRUCTION_REVIEW_STATUSES);

  it("the canonical sets contain only statuses a writer can persist", () => {
    for (const status of [
      ...DESTRUCTION_REVIEW_AWAITING_DECISION,
      ...DESTRUCTION_REVIEW_PROPOSED,
    ]) {
      expect(
        canonical.has(status),
        `"${status}" is not in DESTRUCTION_REVIEW_STATUSES — a counter on it can only ever be zero`,
      ).toBe(true);
    }
  });

  it("the statuses the dead reads asked for still do not exist", () => {
    // Pinned so that if either is ever ADDED to the vocabulary, someone has to
    // decide deliberately what it means rather than inheriting this history.
    expect(canonical.has("PROPOSED")).toBe(false);
    expect(canonical.has("PENDING_APPROVAL")).toBe(false);
  });

  it("no service queries a destruction-review status that cannot exist", () => {
    const offenders: string[] = [];

    for (const file of tsFiles(SRC)) {
      const src = code(readFileSync(file, "utf8"));
      if (!/\bdestructionReview\b/.test(src)) continue;

      // Every string literal in the same statement as a `status:` key, within
      // a `destructionReview` query. Deliberately broad: it is better to make
      // someone name a legitimate exception than to miss a dead status.
      const windows = src.split(/\bprisma\.destructionReview\b/).slice(1);
      for (const window of windows) {
        const stmt = window.slice(0, 600);
        const statusPart = /status:\s*(\{[^}]*\}|"[A-Z_]+")/.exec(stmt);
        if (!statusPart) continue;
        for (const m of statusPart[1].matchAll(/"([A-Z_]{3,})"/g)) {
          if (!canonical.has(m[1]!)) {
            offenders.push(
              `${file.slice(SRC.length + 1).replace(/\\/g, "/")}: "${m[1]}"`,
            );
          }
        }
      }
    }

    expect(
      offenders,
      "these queries name a destruction-review status no writer can persist, " +
        "so they return zero forever; import DESTRUCTION_REVIEW_AWAITING_DECISION " +
        "or DESTRUCTION_REVIEW_PROPOSED from @proovra/shared instead",
    ).toEqual([]);
  });

  it("a deferred review is not counted as waiting on a person", () => {
    // DEFERRED is non-terminal but is waiting on a DATE. Counting it as queue
    // depth tells an operator to act on something already postponed.
    expect(
      DESTRUCTION_REVIEW_AWAITING_DECISION as readonly string[],
    ).not.toContain("DEFERRED");
    expect(canonical.has("DEFERRED")).toBe(true);
  });

  it("a terminal review is never counted as pending", () => {
    for (const terminal of ["EXECUTED", "CANCELLED", "RESTORED"]) {
      expect(
        DESTRUCTION_REVIEW_AWAITING_DECISION as readonly string[],
      ).not.toContain(terminal);
    }
  });
});
