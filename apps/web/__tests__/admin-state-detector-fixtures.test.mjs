/**
 * THE STATE DETECTOR MUST STILL SAY NO.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `scripts/admin-ledger/visual/states.mjs` decides, per admin route, whether
 * each of nineteen visual states is HANDLED. Gate B corrected three of its
 * rules because they were measuring the wrong thing:
 *
 *   ACTION_FAILED    matched four page-local state VARIABLE NAMES
 *                    (`setRowResult`, `setActionResult`, …), so it reported
 *                    twelve routes as having no failed-mutation state while
 *                    every one of them reports through the product's
 *                    sanctioned path.
 *   PARTIAL          matched the WORD "partial", i.e. a page saying it rather
 *                    than a page doing it.
 *   workspaceScoped  matched `?teamId=` anywhere — including inside an
 *                    outbound `href` — so the platform's workspace directory
 *                    was classified as reading one workspace and then owed
 *                    STALE, DENIED and PLAN_GATED states it cannot reach.
 *
 * A correction that only ever makes a checker say YES is not a correction, it
 * is a mute button. So every rule is exercised against a fixture that MUST
 * still fail it, and against one that must pass — and the failing fixtures are
 * the real defect shapes, taken from what the corrected rules actually found:
 * `Promise.all` behind one `.catch`, and a mutation whose error is swallowed.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const DETECTOR = resolve(REPO, "scripts/admin-ledger/visual/states.mjs");

/**
 * Read the rules out of the sweep rather than restating them.
 *
 * The sweep is a script with side effects (it visits routes and writes an
 * artifact), so it cannot simply be imported. Its `EVIDENCE` map and the
 * `workspaceScoped` expression are extracted and evaluated on their own —
 * which is also what keeps this test honest: a hand-copied duplicate of the
 * rule would pass forever after the rule changed underneath it.
 */
function loadRules() {
  const src = readFileSync(DETECTOR, "utf8");

  // The helpers the rules call. `DENIED` disqualifies through
  // `silentApiFailure`, so evaluating the map without it is evaluating a
  // different rule than the one the sweep runs.
  const helpersStart = src.indexOf("function stripComments(src) {");
  assert.ok(helpersStart > 0, "stripComments not found in the detector");
  const helpersEnd = src.indexOf("const EVIDENCE = {");
  assert.ok(helpersEnd > helpersStart, "helpers do not precede EVIDENCE");
  const helpersSrc = src.slice(helpersStart, helpersEnd);

  const evidenceStart = src.indexOf("const EVIDENCE = {");
  assert.ok(evidenceStart > 0, "EVIDENCE map not found in the detector");
  // To the line that closes the object literal at column 0.
  const evidenceEnd = src.indexOf("\n};", evidenceStart);
  assert.ok(evidenceEnd > evidenceStart, "EVIDENCE map is not terminated");
  const evidenceSrc = src.slice(evidenceStart, evidenceEnd + 3);

  const wsMatch = /workspaceScoped:\s*([\s\S]*?),\n\s{4}\/\*\*/.exec(src);
  const wsAlt = /workspaceScoped:\s*([\s\S]*?),\n\s{4}\/\*/.exec(src);
  const wsExpr = (wsMatch ?? wsAlt)?.[1];
  assert.ok(wsExpr, "the workspaceScoped expression could not be extracted");

  // eslint-disable-next-line no-new-func
  const EVIDENCE = new Function(
    `${helpersSrc}\n${evidenceSrc}\nreturn EVIDENCE;`,
  )();
  // eslint-disable-next-line no-new-func
  const stripComments = new Function(
    `${helpersSrc}\nreturn stripComments;`,
  )();
  // eslint-disable-next-line no-new-func
  const workspaceScoped = new Function("src", `return ${wsExpr};`);
  return { EVIDENCE, workspaceScoped, stripComments };
}

const { EVIDENCE, workspaceScoped, stripComments } = loadRules();

const handled = (state, src) =>
  EVIDENCE[state].some((p) => (typeof p === "function" ? p(src) : p.test(src)));

// ===========================================================================
// ACTION_FAILED
// ===========================================================================

/** A mutation whose failure is reported. The canonical shape. */
const MUTATION_REPORTED = `
  const save = useCallback(async () => {
    try {
      await apiFetch("/v1/admin/thing", {
        method: "POST",
        body: JSON.stringify({ a: 1 }),
      });
      addToast("Saved.", "success");
    } catch (err) {
      notifyApiError(addToast, err, { message: "We couldn't save that." });
    }
  }, []);
`;

/** A mutation whose failure is SWALLOWED. This must still fail. */
const MUTATION_SWALLOWED = `
  const save = useCallback(async () => {
    try {
      await apiFetch("/v1/admin/thing", {
        method: "POST",
        body: JSON.stringify({ a: 1 }),
      });
      addToast("Saved.", "success");
    } catch {
      // the reader is told nothing
    }
  }, []);
`;

/** A READ failure reported, with no mutation at all. Must not count. */
const READ_ONLY_REPORTED = `
  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/v1/admin/thing");
      setData(res);
    } catch (err) {
      notifyApiError(addToast, err, { message: "We couldn't load that." });
    }
  }, []);
`;

test("ACTION_FAILED counts a reported mutation failure", () => {
  assert.equal(handled("ACTION_FAILED", MUTATION_REPORTED), true);
});

test("ACTION_FAILED still REFUSES a mutation that swallows its error", () => {
  assert.equal(
    handled("ACTION_FAILED", MUTATION_SWALLOWED),
    false,
    "a page that mutates and tells the reader nothing must not pass",
  );
});

test("ACTION_FAILED is not satisfied by a reported READ failure", () => {
  assert.equal(
    handled("ACTION_FAILED", READ_ONLY_REPORTED),
    false,
    "a failed read is ERROR; ACTION_FAILED needs a mutation",
  );
});

// ===========================================================================
// PARTIAL
// ===========================================================================

/** Per-source outcomes. The canonical shape. */
const PARTIAL_ALLSETTLED = `
  const [a, setA] = useState(null);
  const [b, setB] = useState(null);
  Promise.allSettled([apiFetch("/v1/a"), apiFetch("/v1/b")]).then(([x, y]) => {
    if (x.status === "fulfilled") setA(x.value);
    if (y.status === "fulfilled") setB(y.value);
  });
`;

/** Two reads, two independent failure containers. Also canonical. */
const PARTIAL_TWO_CATCHES = `
  const loadA = async () => {
    try { setA(await apiFetch("/v1/a")); }
    catch (err) { setAError(safeMessage(err, "no a")); }
  };
  const loadB = async () => {
    try { setB(await apiFetch("/v1/b")); }
    catch (err) { setBError(safeMessage(err, "no b")); }
  };
`;

/**
 * `Promise.all` behind ONE catch. This must still fail — it is the exact
 * shape found on /admin/platform/exports and /admin/platform/automation,
 * where one source failing discarded the other's answer.
 */
const PARTIAL_SHARED_CATCH = `
  const [state, setState] = useState(null);
  Promise.all([apiFetch("/v1/a"), apiFetch("/v1/b")])
    .then(([x, y]) => setState({ x, y }))
    .catch((err) => setState({ error: safeMessage(err, "could not load") }));
`;

test("PARTIAL counts per-source outcomes", () => {
  assert.equal(handled("PARTIAL", PARTIAL_ALLSETTLED), true);
  assert.equal(handled("PARTIAL", PARTIAL_TWO_CATCHES), true);
});

test("PARTIAL still REFUSES Promise.all behind a single catch", () => {
  assert.equal(
    handled("PARTIAL", PARTIAL_SHARED_CATCH),
    false,
    "one shared failure container means one failed source blanks the others",
  );
});

// ===========================================================================
// workspaceScoped — the shape behind STALE / DENIED / PLAN_GATED
// ===========================================================================

const READS_ACTIVE_WORKSPACE = `const teamId = useTeamId();`;
const READS_ACTIVE_SPACE = `const teamId = useActiveSpaceId();`;
/** A teamId the OPERATOR supplied, used as a filter. Not the active one. */
const FILTERS_BY_TEAM_ID = `
  const [teamId, setTeamId] = useState(params.get("teamId") ?? "");
  const qs = new URLSearchParams();
  if (teamId) qs.set("teamId", teamId);
`;
const ONLY_LINKS_WITH_TEAM_ID =
  "<Link href={`/admin/operations?teamId=${encodeURIComponent(r.id)}`}>go</Link>";

test("a page reading the active workspace is workspace-scoped", () => {
  assert.equal(workspaceScoped(READS_ACTIVE_WORKSPACE), true);
  assert.equal(workspaceScoped(READS_ACTIVE_SPACE), true);
});

test("a page that only LINKS with a teamId is not workspace-scoped", () => {
  assert.equal(
    workspaceScoped(ONLY_LINKS_WITH_TEAM_ID),
    false,
    "an outbound href is a page sending a reader elsewhere, not a page " +
      "reading its own active workspace",
  );
});

test("a teamId FILTER is not the active workspace", () => {
  // A page can only learn the active workspace from a hook. A teamId held in
  // component state, seeded from the URL, is a filter over platform-wide
  // rows — `/admin/evidence-ops/records` — and a workspace switch cannot
  // make it stale.
  assert.equal(
    workspaceScoped(FILTERS_BY_TEAM_ID),
    false,
    "a teamId the operator supplied is a filter, not the active workspace",
  );
});

// ===========================================================================
// STALE
// ===========================================================================

/** The React idiom: a cancel flag, in an effect keyed on the workspace. */
const STALE_CANCEL_FLAG = `
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch("/v1/thing?teamId=" + teamId);
      if (cancelled) return;
      setState({ status: "ready", data: res });
    })();
    return () => { cancelled = true; };
  }, [teamId]);
`;

/** The stamp/compare idiom. */
const STALE_TENANT_GUARD = `
  const { stamp, isStale } = useTenantGuard();
  const captured = stamp();
  if (isStale(captured)) return;
`;

/**
 * A load keyed on the workspace with NOTHING to stop the previous one. This
 * must still fail — it is the exact shape found on /admin/platform/exports
 * and /admin/platform/recovery, where whichever request finished last won.
 */
const STALE_UNGUARDED = `
  const load = useCallback(() => {
    apiFetch("/v1/operations/recovery?teamId=" + teamId)
      .then((r) => setOverview(r))
      .catch((err) => setErrorMessage(safeMessage(err, "could not load")));
  }, [teamId]);
`;

test("STALE counts either idiom that drops a late response", () => {
  assert.equal(handled("STALE", STALE_CANCEL_FLAG), true);
  assert.equal(handled("STALE", STALE_TENANT_GUARD), true);
});

test("STALE still REFUSES a workspace-keyed load with no guard", () => {
  assert.equal(
    handled("STALE", STALE_UNGUARDED),
    false,
    "with nothing to stop the previous request, whichever finishes last wins",
  );
});

// ===========================================================================
// DENIED
// ===========================================================================

/** A refusal the reader is told about, through the identity classifier. */
const DENIAL_DISTINGUISHED = `
  const [failure, setFailure] = useState(null);
  try { setRows(await apiFetch("/v1/identity/access-reviews")); }
  catch (err) { setFailure(classifyFailure(err, "Unable to load the queue.")); }
  return failure ? (
    <AdmInline state="unavailable">
      {failure.kind === "denied" ? "Not permitted" : failure.message}
    </AdmInline>
  ) : <DataTable rows={rows} />;
`;

/**
 * A failed read substituted with an empty list. This must still fail — it is
 * the exact shape found on /admin/identity/runtime, where a refused
 * live-session read rendered as "No active sessions" during an incident.
 */
const DENIAL_SWALLOWED_TO_EMPTY = `
  Promise.all([
    apiFetch("/v1/admin/identity/sessions?teamId=" + teamId)
      .catch(() => ({ sessions: [] })),
  ]).then(([s]) => {
    setSessions(s.sessions ?? []);
    setError(null);
  });
  return <DataTable rows={sessions} emptyState={<EmptyState title="No active sessions" />} />;
`;

/**
 * A read whose error is caught without binding, so a 403 and a 500 set the
 * same flag. The shape found on /admin/platform/media-graph. Note that it
 * imports `toSafeUserError` for its MUTATIONS — which is why a file-level
 * "does it mention the safe path" test would have passed it.
 */
const DENIAL_ERROR_DISCARDED = `
  import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
  try {
    const res = await apiFetch("/v1/admin/platform/metrics");
    setSnapshot(res.metrics);
  } catch {
    setError("metrics_unavailable");
  }
`;

test("DENIED counts a refusal the reader is told is a refusal", () => {
  assert.equal(handled("DENIED", DENIAL_DISTINGUISHED), true);
});

test("DENIED still REFUSES a failed read swallowed into an empty list", () => {
  assert.equal(
    handled("DENIED", DENIAL_SWALLOWED_TO_EMPTY),
    false,
    "a refusal rendering as 'none' is indistinguishable from the all-clear",
  );
});

test("DENIED still REFUSES a read whose error is caught without binding", () => {
  assert.equal(
    handled("DENIED", DENIAL_ERROR_DISCARDED),
    false,
    "the safe path can only tell a 403 from a 500 if it is handed the error",
  );
});

// ===========================================================================
// Comments are not evidence
// ===========================================================================

test("a state DISCUSSED in a comment does not count as handled", () => {
  // /admin/platform/observability passed DENIED on a paragraph explaining
  // that some retired URLs "return 403 to every caller" — a sentence about
  // the API's history, in a page that distinguishes no refusal at all.
  const DISCUSSED_ONLY = stripComments(`
    /**
     * A consequence worth stating: after 1afd5e0f the old URLs return 403 to
     * every caller, and nothing here renders "No matches" or "Unavailable".
     */
    export default function Page() { return <div />; }
  `);
  for (const state of ["DENIED", "FILTERED_EMPTY", "UNAVAILABLE"]) {
    assert.equal(
      handled(state, DISCUSSED_ONLY),
      false,
      `${state} must not be satisfied by a comment about it`,
    );
  }
});

test("stripComments keeps the words a page renders", () => {
  const src = `
    // No matches for these filters — a comment, removed.
    const label = "No sessions match these filters";
  `;
  const out = stripComments(src);
  assert.match(out, /No sessions match these filters/);
  assert.doesNotMatch(out, /a comment, removed/);
});

// ===========================================================================
// The rules the corrections must not have weakened
// ===========================================================================

test("the untouched state classes still refuse an empty page", () => {
  // A bare component handles none of these. If a correction had loosened one
  // of them into a tautology, this is where it would show.
  const EMPTY_PAGE = `export default function Page() { return <div />; }`;
  for (const state of [
    "LOADING", "EMPTY", "FILTERED_EMPTY", "NOT_MEASURED", "ERROR",
    "DENIED", "PLAN_GATED", "UNAVAILABLE", "STEP_UP_REQUIRED",
    "ACTION_FAILED", "PARTIAL",
  ]) {
    assert.equal(
      handled(state, EMPTY_PAGE),
      false,
      `${state} must not match a page that renders nothing`,
    );
  }
});
