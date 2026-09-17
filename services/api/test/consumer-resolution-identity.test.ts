/**
 * A reviewed consumer resolution survives its call moving.
 *
 * `consumer-resolutions.json` answered each ambiguous call by `file:line`.
 * Batch G added import lines above two answered calls; both moved, both
 * became AmbiguousConsumerSites again, and the audit engine check failed —
 * though neither call changed. An entry's `match` block names the call by
 * file, enclosing function, method and path shape, so the answer follows the
 * call instead of the line.
 */

import { describe, expect, it } from "vitest";

import {
  attachConsumers,
  buildConsumerResolutions,
  consumerIdentity,
} from "../scripts/capability-authority/consumers.mjs";

const ROUTES = [
  "POST /v1/reviewer-ops/escalations/:id/acknowledge",
  "POST /v1/reviewer-ops/escalations/:id/resolve",
];
const FILE = "apps/web/app/(app)/reviewer-ops/escalations/page.tsx";
const call = (line: number) => ({
  file: FILE,
  line,
  method: "POST",
  caller: "EscalationsConsolePageInner",
  path: "/v1/reviewer-ops/escalations/<interp>/<interp>",
  candidates: ["/v1/reviewer-ops/escalations/<interp>/<interp>"],
});
// The analyzer's real matcher refuses <interp> for a literal segment; this
// stand-in does the same, so every call here is ambiguous until resolved.
const matches = (pattern: string, cand: string) => pattern === cand;

describe("consumer resolutions are keyed by what the call is, not where it is", () => {
  it("a call that moved is still credited through its match identity", () => {
    const resolutions = buildConsumerResolutions([
      {
        site: `${FILE}:136`,
        match: {
          method: "POST",
          caller: "EscalationsConsolePageInner",
          path: "/v1/reviewer-ops/escalations/<interp>/<interp>",
        },
        routes: ROUTES,
      },
    ]);
    const { byRoute, ambiguous } = attachConsumers(ROUTES, [call(138)], matches, resolutions);
    expect(ambiguous).toEqual([]);
    for (const id of ROUTES) expect(byRoute.get(id)).toHaveLength(1);
  });

  it("without a match block only the exact line resolves — the old behaviour", () => {
    const resolutions = buildConsumerResolutions([{ site: `${FILE}:136`, routes: ROUTES }]);
    expect(attachConsumers(ROUTES, [call(136)], matches, resolutions).ambiguous).toEqual([]);
    expect(attachConsumers(ROUTES, [call(138)], matches, resolutions).ambiguous).toHaveLength(1);
  });

  it("the identity does not stretch to a different call in the same file", () => {
    const resolutions = buildConsumerResolutions([
      {
        site: `${FILE}:136`,
        match: { method: "POST", caller: "EscalationsConsolePageInner", path: "/v1/reviewer-ops/escalations/<interp>/<interp>" },
        routes: ROUTES,
      },
    ]);
    const other = { ...call(300), caller: "SomeOtherComponent" };
    expect(attachConsumers(ROUTES, [other], matches, resolutions).ambiguous).toHaveLength(1);
    expect(consumerIdentity(other)).not.toBe(consumerIdentity(call(138)));
  });
});
