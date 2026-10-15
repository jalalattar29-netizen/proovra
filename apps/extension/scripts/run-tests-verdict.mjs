/** Shared by run-tests.mjs and its test: a summary is a PASS only when it proves something ran. */
/** The run's PASS verdict from a TAP summary: executed > 0, nothing skipped or todo. */
export function tapVerdict(tap) {
  const count = (label) => {
    const m = new RegExp(`^# ${label} (\\d+)\\s*$`, "m").exec(tap);
    return m ? Number(m[1]) : null;
  };
  const tests = count("tests");
  const skipped = count("skipped");
  const todo = count("todo");
  if (tests === null || skipped === null || todo === null) {
    return { ok: false, reason: "could not read the node --test summary — refusing to report success" };
  }
  if (tests === 0 || skipped > 0 || todo > 0) {
    return { ok: false, reason: `tests=${tests} skipped=${skipped} todo=${todo} — skipped or todo tests are not a pass` };
  }
  return { ok: true, reason: null };
}
